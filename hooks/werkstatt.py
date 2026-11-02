#!/usr/bin/env python3
"""werkstatt hooks and user commands.

Hooks (called by Claude Code with JSON on stdin):
    session-start   record the current code state as baseline if none exists
    pre-tool        deny writes to locked acceptance tests and werkstatt files
    stop            restore tampered tests, lock new ones, require green verify + review
    subagent-stop   record the reviewer's verdict

User commands (run via `! python3 <plugin>/hooks/werkstatt.py <cmd>`):
    status                 show locks, baseline and review state
    check                  same as JSON, without changing anything (used by the orchestrator)
    unlock <path|text>...  unlock acceptance tests whose path contains <text>
    pause | resume         switch the stop gate off / on
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REVIEWER = "werkstatt:reviewer"
MAX_BLOCKS = 8
VERIFY_TIMEOUT = 540
OUTPUT_TAIL = 80
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

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
        self.config = config
        self.specs = config.get("specs", "docs/specs").rstrip("/")
        self.acceptance = config["acceptanceTests"].rstrip("/")
        self.verify = config["commands"]["verify"]
        self.dir = root / ".werkstatt"
        self.locks_dir = self.dir / "locks"
        self.manifest_path = self.locks_dir / "manifest.json"
        self.state_dir = self.dir / "state"
        self.state_path = self.state_dir / "state.json"

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

    def is_acceptance(self, rel: str) -> bool:
        return rel == self.acceptance or rel.startswith(self.acceptance + "/")

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

    def state(self) -> dict:
        if self.state_path.is_file():
            return json.loads(self.state_path.read_text())
        return {}

    def save_state(self, s: dict):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        ignore = self.state_dir / ".gitignore"
        if not ignore.exists():
            ignore.write_text("*\n")
        self.state_path.write_text(json.dumps(s, indent=2) + "\n")

    def git(self, *args, env=None) -> str:
        r = subprocess.run(["git", *args], cwd=self.root, env=env,
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
        return r.stdout.strip()

    def has_git(self) -> bool:
        try:
            self.git("rev-parse", "--git-dir")
            return True
        except (RuntimeError, FileNotFoundError):
            return False

    def code_excludes(self) -> list[str]:
        return [f":(exclude){p}" for p in (self.acceptance, self.specs, ".werkstatt")]

    def code_tree(self) -> str:
        """Tree hash of the working copy without tests, specs and werkstatt files.

        Uses a throwaway index, so the user's staging area stays untouched.
        """
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "GIT_INDEX_FILE": os.path.join(tmp, "index")}
            self.git("add", "-A", "--", ".", *self.code_excludes(), env=env)
            return self.git("write-tree", env=env)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def acceptance_files(p: Project) -> list[str]:
    base = p.root / p.acceptance
    if not base.is_dir():
        return []
    return sorted(f.relative_to(p.root).as_posix()
                  for f in base.rglob("*") if f.is_file() and f.name != ".gitkeep")


# --- output ----------------------------------------------------------------

def emit(obj: dict):
    print(json.dumps(obj, ensure_ascii=False))


def deny(reason: str):
    emit({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }})


def block(p: Project, state: dict, reason: str):
    state["blocks"] = state.get("blocks", 0) + 1
    p.save_state(state)
    if state["blocks"] > MAX_BLOCKS:
        state["blocks"] = 0
        p.save_state(state)
        emit({"systemMessage": f"werkstatt: Nach {MAX_BLOCKS} Versuchen aufgegeben. "
                               "Der aktuelle Stand ist NICHT geprüft und freigegeben. "
                               f"Letzter Grund: {reason.splitlines()[0]}"})
        return
    emit({"decision": "block", "reason": reason})


def allow(p: Project, state: dict, message: str | None = None):
    if state.get("blocks"):
        state["blocks"] = 0
        p.save_state(state)
    if message:
        emit({"systemMessage": message})


# --- hooks -----------------------------------------------------------------

def hook_session_start(p: Project, data: dict):
    state = p.state()
    if "approved" not in state and p.has_git():
        state["approved"] = p.code_tree()
        p.save_state(state)


def hook_pre_tool(p: Project, data: dict):
    tool = data.get("tool_name", "")
    inp = data.get("tool_input") or {}
    locked = p.manifest()

    if tool == "Bash":
        cmd = inp.get("command", "")
        if "werkstatt.py" in cmd and re.search(r"\b(unlock|pause|resume)\b", cmd):
            return deny("werkstatt: Entsperren und Pausieren ist dem Nutzer vorbehalten.")
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


def check_locks(p: Project) -> list[str]:
    """Restore tampered locked tests, lock new ones. Returns restored paths."""
    locked = p.manifest()
    restored = []
    for rel, digest in locked.items():
        f = p.root / rel
        if f.is_file() and sha256(f) == digest:
            continue
        copy = p.locked_copy(rel)
        f.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(copy, f)
        restored.append(rel)
    new = [rel for rel in acceptance_files(p) if rel not in locked]
    for rel in new:
        copy = p.locked_copy(rel)
        copy.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p.root / rel, copy)
        locked[rel] = sha256(p.root / rel)
    if new:
        p.save_manifest(locked)
    return restored


def run_verify(p: Project) -> tuple[bool, str]:
    try:
        r = subprocess.run(p.verify, shell=True, cwd=p.root, capture_output=True,
                           text=True, timeout=VERIFY_TIMEOUT)
    except subprocess.TimeoutExpired:
        return False, f"Zeitüberschreitung nach {VERIFY_TIMEOUT}s"
    out = (r.stdout + r.stderr).splitlines()
    return r.returncode == 0, "\n".join(out[-OUTPUT_TAIL:])


def write_review_request(p: Project, base: str, tree: str) -> Path:
    excludes = " ".join(f"'{e}'" for e in p.code_excludes())
    diff_cmd = f"git diff {base} {tree} -- . {excludes}"
    stat = p.git("diff", "--stat", base, tree, "--", ".", *p.code_excludes())
    path = p.state_dir / "review-request.md"
    path.write_text(f"""# Review-Anfrage

- Stand: `{tree}`
- Verglichen mit: `{base}`
- Specs: `{p.specs}/`
- Akzeptanztests: `{p.acceptance}/` (gesperrt, `{p.verify}` ist grün)

## Geänderte Dateien

```
{stat}
```

Vollständiger Diff:

```
{diff_cmd}
```
""")
    return path


def hook_stop(p: Project, data: dict):
    state = p.state()
    if state.get("paused"):
        return
    if not data.get("stop_hook_active"):
        # A fresh stop, not a retry after our own block: start counting anew.
        state["blocks"] = 0

    restored = check_locks(p)
    if restored:
        return block(p, state, "werkstatt: Gesperrte Akzeptanztests wurden verändert und "
                     "wiederhergestellt:\n" + "\n".join(f"- {r}" for r in restored) +
                     "\nPasse die Implementierung an, nicht die Tests. Ist ein Test falsch: "
                     "dem Nutzer erklären, warum – nur er kann entsperren.")

    if not p.has_git():
        ok, out = run_verify(p)
        if not ok:
            return block(p, state, f"werkstatt: `{p.verify}` ist rot. Behebe die Ursache, "
                         f"bevor du aufhörst.\n\n{out}")
        return allow(p, state, "werkstatt: Kein git-Repository – Review-Pflicht ist aus.")

    tree = p.code_tree()
    if "approved" not in state:
        state["approved"] = tree
        p.save_state(state)
        return allow(p, state, "werkstatt: Aktueller Stand als Ausgangspunkt übernommen.")
    if tree == state["approved"]:
        return allow(p, state)

    verified = state.setdefault("verified", {})
    if tree not in verified:
        ok, out = run_verify(p)
        if not ok:
            return block(p, state, f"werkstatt: Der Code wurde geändert und `{p.verify}` ist "
                         f"rot. Behebe die Ursache, ohne Akzeptanztests anzufassen.\n\n{out}")
        state["verified"] = {tree: True}
        p.save_state(state)

    review = state.get("reviews", {}).get(tree)
    if review == "bestanden":
        state["approved"] = tree
        state["reviews"] = {}
        state["verified"] = {}
        p.save_state(state)
        return allow(p, state, "werkstatt: verify grün, Review bestanden – Stand freigegeben.")
    if review == "nachbessern":
        report = p.state_dir / "reviews" / f"{tree}.md"
        return block(p, state, f"werkstatt: Das Review verlangt Nachbesserungen "
                     f"(siehe {report.relative_to(p.root)}). Behebe die Punkte; danach "
                     "laufen verify und Review erneut.")

    request = write_review_request(p, state["approved"], tree)
    state["pending_review"] = tree
    p.save_state(state)
    block(p, state, f"werkstatt: `{p.verify}` ist grün. Vor dem Abschluss ist ein Review "
          f"nötig: Starte den Subagent `{REVIEWER}` mit dem Auftrag, die Review-Anfrage in "
          f"{request.relative_to(p.root)} zu bearbeiten. Ändere bis zum Urteil keinen Code.")


VERDICT = re.compile(r"URTEIL:\s*(BESTANDEN|NACHBESSERN)", re.IGNORECASE)


def hook_subagent_stop(p: Project, data: dict):
    if data.get("agent_type") != REVIEWER:
        return
    state = p.state()
    tree = state.get("pending_review")
    if not tree:
        return
    message = data.get("last_assistant_message") or ""
    matches = VERDICT.findall(message)
    if not matches:
        emit({"decision": "block", "reason": "Beende das Review mit einer letzten Zeile "
              "`URTEIL: BESTANDEN` oder `URTEIL: NACHBESSERN`."})
        return
    reviews_dir = p.state_dir / "reviews"
    reviews_dir.mkdir(parents=True, exist_ok=True)
    (reviews_dir / f"{tree}.md").write_text(message + "\n")
    state.setdefault("reviews", {})[tree] = matches[-1].lower()
    state.pop("pending_review", None)
    p.save_state(state)


# --- user commands ---------------------------------------------------------

def cmd_status(p: Project, args: list[str]):
    s = p.state()
    print(f"Projekt:     {p.root}")
    print(f"Gate:        {'pausiert' if s.get('paused') else 'aktiv'}")
    print(f"Freigegeben: {s.get('approved', '-')}")
    if p.has_git():
        print(f"Aktuell:     {p.code_tree()}")
    print(f"Review:      {s.get('pending_review') and 'angefordert' or '-'}")
    print("Gesperrt:")
    for rel in p.manifest():
        print(f"  {rel}")


def cmd_check(p: Project, args: list[str]):
    s = p.state()
    tampered = [rel for rel, digest in p.manifest().items()
                if not (p.root / rel).is_file() or sha256(p.root / rel) != digest]
    current = p.code_tree() if p.has_git() else None
    print(json.dumps({
        "paused": bool(s.get("paused")),
        "locked": list(p.manifest()),
        "tampered": tampered,
        "approved": s.get("approved"),
        "current": current,
        "isApproved": current is not None and current == s.get("approved"),
    }, indent=2))


def cmd_unlock(p: Project, args: list[str]):
    if not args:
        sys.exit("Aufruf: unlock <Pfad oder Namensteil>...")
    locked = p.manifest()
    hits = [r for r in locked if any(a in r for a in args)]
    for rel in hits:
        del locked[rel]
        p.locked_copy(rel).unlink(missing_ok=True)
        print(f"entsperrt: {rel}")
    p.save_manifest(locked)
    if not hits:
        print("Nichts gefunden.")


def cmd_pause(p: Project, args: list[str], paused=True):
    s = p.state()
    s["paused"] = paused
    p.save_state(s)
    print("Stop-Gate " + ("pausiert" if paused else "aktiv"))


HOOKS = {
    "session-start": hook_session_start,
    "pre-tool": hook_pre_tool,
    "stop": hook_stop,
    "subagent-stop": hook_subagent_stop,
}
COMMANDS = {
    "status": cmd_status,
    "check": cmd_check,
    "unlock": cmd_unlock,
    "pause": cmd_pause,
    "resume": lambda p, a: cmd_pause(p, a, paused=False),
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
