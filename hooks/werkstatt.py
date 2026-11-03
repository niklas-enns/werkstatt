#!/usr/bin/env python3
"""werkstatt hooks and user commands.

Hooks (called by Claude Code with JSON on stdin):
    pre-tool   deny writes to locked acceptance tests and werkstatt files
    stop       restore tampered tests and lock new ones; when the orchestrator runs
               the implementation phase (WERKSTATT_PHASE=implement), require green verify –
               up to MAX_VERIFY_BLOCKS times per session, so a stuck agent can still stop

User commands (usually via `werkstatt status|unlock`, which calls this script):
    status                 show locked acceptance tests
    check                  locks as JSON, without changing anything (used by the orchestrator)
    lock                   lock acceptance tests that aren't locked yet (used by the orchestrator)
    unlock <path|text>...  unlock acceptance tests whose path contains <text>
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

VERIFY_TIMEOUT = 540
MAX_VERIFY_BLOCKS = 3
OUTPUT_TAIL = 80

MUTATING_SHELL = re.compile(
    r"\b(rm|mv|cp|truncate|tee|chmod|unlink|install)\b"
    r"|\bsed\b[^|;&]*\s-i"
    r"|\bperl\b[^|;&]*\s-[a-z]*i"
    r"|\bgit\s+(checkout|restore|rm|mv|stash|reset|clean)\b"
    r"|(^|[^0-9&<>])>{1,2}(?!&)"
)


# --- project ---------------------------------------------------------------

class Project:
    def __init__(self, root: Path, config: dict):
        self.root = root
        self.acceptance = config["acceptanceTests"].rstrip("/")
        self.verify = config["commands"]["verify"]
        self.locks_dir = root / ".werkstatt" / "locks"
        self.state_dir = root / ".werkstatt" / "state"
        self.manifest_path = self.locks_dir / "manifest.json"

    @staticmethod
    def find(start: str | None) -> "Project | None":
        candidates = [os.environ.get("CLAUDE_PROJECT_DIR"), start, os.getcwd()]
        for c in candidates:
            if not c:
                continue
            for d in [Path(c).resolve(), *Path(c).resolve().parents]:
                f = d / "werkstatt.json"
                if f.is_file():
                    return Project(d, json.loads(f.read_text()))
        return None

    def rel(self, path: str) -> str | None:
        """Path relative to the project root, or None if outside."""
        p = Path(path)
        if not p.is_absolute():
            p = self.root / p
        try:
            return p.resolve().relative_to(self.root).as_posix()
        except ValueError:
            return None

    # manifest: {relpath: sha256}, with a copy of each locked file under locks/files/
    def manifest(self) -> dict:
        if self.manifest_path.is_file():
            return json.loads(self.manifest_path.read_text())
        return {}

    def save_manifest(self, m: dict):
        self.locks_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(json.dumps(dict(sorted(m.items())), indent=2) + "\n")

    def locked_copy(self, rel: str) -> Path:
        return self.locks_dir / "files" / rel

    def state(self, name: str) -> Path:
        """File under .werkstatt/state/, which is local and ignores itself in git."""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        ignore = self.state_dir / ".gitignore"
        if not ignore.is_file():
            ignore.write_text("*\n")
        return self.state_dir / name


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def acceptance_files(p: Project) -> list[str]:
    base = p.root / p.acceptance
    if not base.is_dir():
        return []
    return sorted(f.relative_to(p.root).as_posix()
                  for f in base.rglob("*") if f.is_file() and f.name != ".gitkeep")


def tampered(p: Project) -> list[str]:
    return [rel for rel, digest in p.manifest().items()
            if not (p.root / rel).is_file() or sha256(p.root / rel) != digest]


# --- output ----------------------------------------------------------------

def emit(obj: dict):
    print(json.dumps(obj, ensure_ascii=False))


def deny(reason: str):
    emit({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }})


def block(reason: str):
    emit({"decision": "block", "reason": reason})


# --- hooks -----------------------------------------------------------------

def hook_pre_tool(p: Project, data: dict):
    tool = data.get("tool_name", "")
    inp = data.get("tool_input") or {}
    locked = p.manifest()

    if tool == "Bash":
        cmd = inp.get("command", "")
        if re.search(r"werkstatt(\.py)?\s+unlock\b", cmd):
            return deny("werkstatt: Entsperren ist dem Nutzer vorbehalten.")
        touches = [x for x in [p.acceptance, ".werkstatt", "werkstatt.json"] if x in cmd]
        touches += [r for r in locked if Path(r).name in cmd]
        if touches and MUTATING_SHELL.search(cmd):
            return deny("werkstatt: Dieser Befehl würde geschützte Dateien verändern "
                        f"({', '.join(sorted(set(touches)))}). Akzeptanztests werden nicht "
                        "angepasst, um grün zu werden. Ist ein Test falsch: stoppen und "
                        "den Nutzer informieren.")
        return

    path = inp.get("file_path") or inp.get("notebook_path")
    if not path:
        return
    rel = p.rel(path)
    if rel is None:
        return
    if rel == "werkstatt.json" or rel.startswith(".werkstatt/"):
        return deny(f"werkstatt: {rel} wird von der werkstatt verwaltet und ist für "
                    "Agents gesperrt.")
    if rel in locked:
        return deny(f"werkstatt: {rel} ist ein gesperrter Akzeptanztest. Passe die "
                    "Implementierung an, nicht den Test. Ist der Test falsch: stoppen "
                    "und den Nutzer informieren – nur er kann entsperren.")


def restore_tampered(p: Project) -> list[str]:
    """Restore locked tests from their locked copy. Returns restored paths."""
    restored = tampered(p)
    for rel in restored:
        f = p.root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p.locked_copy(rel), f)
    return restored


def lock_new(p: Project) -> list[str]:
    """Lock acceptance tests that aren't locked yet. Returns newly locked paths."""
    locked = p.manifest()
    new = [rel for rel in acceptance_files(p) if rel not in locked]
    for rel in new:
        copy = p.locked_copy(rel)
        copy.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p.root / rel, copy)
        locked[rel] = sha256(p.root / rel)
    if new:
        p.save_manifest(locked)
    return new


def run_verify(p: Project) -> tuple[bool, str]:
    try:
        r = subprocess.run(p.verify, shell=True, cwd=p.root, capture_output=True,
                           text=True, timeout=VERIFY_TIMEOUT)
    except subprocess.TimeoutExpired:
        return False, f"Zeitüberschreitung nach {VERIFY_TIMEOUT}s"
    out = (r.stdout + r.stderr).splitlines()
    return r.returncode == 0, "\n".join(out[-OUTPUT_TAIL:])


def hook_stop(p: Project, data: dict):
    restored = restore_tampered(p)
    lock_new(p)
    if restored:
        return block("werkstatt: Gesperrte Akzeptanztests wurden verändert und "
                     "wiederhergestellt:\n" + "\n".join(f"- {r}" for r in restored) +
                     "\nPasse die Implementierung an, nicht die Tests. Ist ein Test falsch: "
                     "erklären, warum – nur der Nutzer kann entsperren.")

    if os.environ.get("WERKSTATT_PHASE") != "implement":
        return
    session = re.sub(r"[^A-Za-z0-9_-]", "_", str(data.get("session_id") or "unbekannt"))
    counter = p.state(f"verify-blocks-{session}")
    ok, out = run_verify(p)
    if ok:
        counter.unlink(missing_ok=True)
        return
    blocks = (int(counter.read_text()) if counter.is_file() else 0) + 1
    if blocks > MAX_VERIFY_BLOCKS:
        # The orchestrator checks verify itself; endless blocking would only burn turns.
        counter.unlink(missing_ok=True)
        return emit({"systemMessage": f"werkstatt: `{p.verify}` ist nach "
                     f"{MAX_VERIFY_BLOCKS} Sperren noch rot – die Session darf enden."})
    counter.write_text(str(blocks))
    block(f"werkstatt: `{p.verify}` ist rot ({blocks}/{MAX_VERIFY_BLOCKS}). Behebe die "
          "Ursache, ohne Akzeptanztests anzufassen. Kommst du ohne eine Entscheidung des "
          f"Nutzers nicht weiter, beschreibe genau, was entschieden werden muss.\n\n{out}")


# --- user commands ---------------------------------------------------------

def cmd_status(p: Project, args: list[str]):
    broken = set(tampered(p))
    print(f"Projekt: {p.root}")
    print("Gesperrte Akzeptanztests:")
    for rel in p.manifest():
        print(f"  {rel}{'  (VERÄNDERT)' if rel in broken else ''}")


def cmd_check(p: Project, args: list[str]):
    print(json.dumps({"locked": list(p.manifest()), "tampered": tampered(p)}, indent=2))


def cmd_lock(p: Project, args: list[str]):
    print(json.dumps({"locked": lock_new(p)}, indent=2))


def cmd_unlock(p: Project, args: list[str]):
    if not args:
        sys.exit("Aufruf: unlock <Pfad oder Namensteil>...")
    locked = p.manifest()
    hits = [r for r in locked if any(a in r for a in args)]
    for rel in hits:
        del locked[rel]
        p.locked_copy(rel).unlink(missing_ok=True)
        print(f"entsperrt: {rel}")
    if hits:
        p.save_manifest(locked)
    else:
        print("Nichts gefunden.")


HOOKS = {
    "pre-tool": hook_pre_tool,
    "stop": hook_stop,
}
COMMANDS = {
    "status": cmd_status,
    "check": cmd_check,
    "lock": cmd_lock,
    "unlock": cmd_unlock,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in {**HOOKS, **COMMANDS}:
        sys.exit(__doc__)
    name = sys.argv[1]
    if name in HOOKS:
        data = json.load(sys.stdin)
        p = Project.find(data.get("cwd"))
        if p is None:
            return
        try:
            HOOKS[name](p, data)
        except Exception as e:
            # A broken hook must not lock the user out; report and let Claude continue.
            emit({"systemMessage": f"werkstatt: Hook {name} fehlgeschlagen: {e}"})
        return
    p = Project.find(None)
    if p is None:
        sys.exit("Keine werkstatt.json gefunden.")
    COMMANDS[name](p, sys.argv[2:])


if __name__ == "__main__":
    main()
