"""Tests for hooks/werkstatt.py. Run with: python3 -m unittest discover tests"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "hooks" / "werkstatt.py"
TEST = "tests/acceptance/Spec001FooTest.java"


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.write("werkstatt.json", json.dumps({
            "version": 1, "specs": "docs/specs", "acceptanceTests": "tests/acceptance",
            "commands": {"verify": "test -f green"},
        }))
        self.write(TEST, "original")

    def tearDown(self):
        self.tmp.cleanup()

    # helpers

    def write(self, rel: str, text: str):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def read(self, rel: str) -> str:
        return (self.root / rel).read_text()

    def hook(self, name: str, phase: str | None = None, **data) -> dict | None:
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDE_PROJECT_DIR", "WERKSTATT_PHASE")}
        if phase:
            env["WERKSTATT_PHASE"] = phase
        r = subprocess.run([sys.executable, str(SCRIPT), name], input=json.dumps(
            {"cwd": str(self.root), "session_id": "s1", **data}),
            capture_output=True, text=True, env=env, check=True)
        return json.loads(r.stdout) if r.stdout.strip() else None

    def command(self, *args: str) -> str:
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=self.root,
                              capture_output=True, text=True, check=True).stdout

    def locked(self) -> list[str]:
        return json.loads(self.command("check"))["locked"]

    def pre_tool(self, tool: str, **tool_input) -> bool:
        """True if the tool call is denied."""
        out = self.hook("pre-tool", tool_name=tool, tool_input=tool_input)
        return bool(out) and out["hookSpecificOutput"]["permissionDecision"] == "deny"

    # locking

    def test_stop_locks_new_tests(self):
        self.assertEqual(self.locked(), [])
        self.assertIsNone(self.hook("stop"))
        self.assertEqual(self.locked(), [TEST])

    def test_stop_restores_tampered_test_and_blocks(self):
        self.hook("stop")
        self.write(TEST, "changed")
        out = self.hook("stop")
        self.assertEqual(out["decision"], "block")
        self.assertIn(TEST, out["reason"])
        self.assertEqual(self.read(TEST), "original")

    def test_lock_command_locks_without_stop(self):
        self.assertEqual(json.loads(self.command("lock"))["locked"], [TEST])
        self.assertEqual(json.loads(self.command("lock"))["locked"], [])

    def test_unlock_then_stop_relocks_current_content(self):
        self.hook("stop")
        self.command("unlock", "Spec001")
        self.assertEqual(self.locked(), [])
        self.write(TEST, "fixed by hand")
        self.hook("stop")
        self.assertEqual(self.locked(), [TEST])
        self.assertEqual(self.read(TEST), "fixed by hand")

    # pre-tool

    def test_pre_tool_denies_writes_to_locked_and_managed_files(self):
        self.hook("stop")
        self.assertTrue(self.pre_tool("Edit", file_path=str(self.root / TEST)))
        self.assertTrue(self.pre_tool("Write", file_path="werkstatt.json"))
        self.assertTrue(self.pre_tool("Write", file_path=".werkstatt/locks/manifest.json"))
        self.assertFalse(self.pre_tool("Write", file_path="src/Main.java"))

    def test_pre_tool_denies_obvious_shell_writes_and_unlock(self):
        self.hook("stop")
        self.assertTrue(self.pre_tool("Bash", command=f"sed -i s/a/b/ {TEST}"))
        self.assertTrue(self.pre_tool("Bash", command="rm -r .werkstatt"))
        self.assertTrue(self.pre_tool("Bash", command="werkstatt unlock Spec001"))
        self.assertFalse(self.pre_tool("Bash", command=f"cat {TEST}"))

    # verify gate

    def test_verify_gate_only_in_implement_phase(self):
        self.assertIsNone(self.hook("stop"))

    def test_verify_gate_blocks_three_times_then_lets_session_end(self):
        for n in range(1, 4):
            out = self.hook("stop", phase="implement")
            self.assertEqual(out["decision"], "block")
            self.assertIn(f"({n}/3)", out["reason"])
        out = self.hook("stop", phase="implement")
        self.assertNotIn("decision", out)
        self.assertIn("systemMessage", out)

    def test_green_verify_resets_block_counter(self):
        self.hook("stop", phase="implement")
        self.hook("stop", phase="implement")
        self.write("green", "")
        self.assertIsNone(self.hook("stop", phase="implement"))
        (self.root / "green").unlink()
        self.assertIn("(1/3)", self.hook("stop", phase="implement")["reason"])

    def test_block_counter_is_per_session_and_git_ignored(self):
        self.hook("stop", phase="implement")
        self.assertIn("(1/3)", self.hook("stop", phase="implement", session_id="s2")["reason"])
        self.assertEqual(self.read(".werkstatt/state/.gitignore"), "*\n")


if __name__ == "__main__":
    unittest.main()
