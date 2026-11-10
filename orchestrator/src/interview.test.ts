import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { decide } from "./interview.js";
import { Project } from "./project.js";
import { parseAnswer } from "./terminal.js";

const options = [
  { label: "Anyone", description: "" },
  { label: "Logged-in users", description: "" },
  { label: "Admins", description: "" },
];
const single = { options, multiSelect: false };
const multi = { options, multiSelect: true };

test("an option number becomes its label", () => {
  assert.equal(parseAnswer(" 2 ", single), "Logged-in users");
});

test("several option numbers are allowed only for multi-select", () => {
  assert.equal(parseAnswer("1, 3,1", multi), "Anyone, Admins");
  assert.equal(parseAnswer("1,3", single), "1,3");
});

test("text and numbers that aren't options are the user's own answer", () => {
  assert.equal(parseAnswer("only the organiser", single), "only the organiser");
  assert.equal(parseAnswer("50", single), "50");
  assert.equal(parseAnswer("0", single), "0");
});

test("empty input is no answer", () => {
  assert.equal(parseAnswer("   ", single), null);
});

let root: string;
let canUseTool: ReturnType<typeof decide>;
const ask = (tool: string, input: Record<string, unknown>) =>
  canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: "t" } as never);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "werkstatt-"));
  writeFileSync(join(root, "werkstatt.json"), JSON.stringify({
    specs: "docs/specs", acceptanceTests: "tests/acceptance", commands: { verify: "true" },
  }));
  canUseTool = decide(Project.load(root));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the interviewer may write and edit Markdown in the spec directory", async () => {
  for (const tool of ["Write", "Edit"]) {
    for (const path of [join(root, "docs/specs/001-poll.md"), "docs/specs/002-vote.md"]) {
      assert.equal((await ask(tool, { file_path: path })).behavior, "allow", `${tool} ${path}`);
    }
  }
});

test("the interviewer may not write anywhere else", async () => {
  for (const path of [
    join(root, "src/Main.java"),
    join(root, "docs/specs/notes.txt"),
    join(root, "docs/specs/../README.md"),
    join(root, "docs/specs-old/001-poll.md"),
    join(root, "docs/specs"),
    "/tmp/001-poll.md",
  ]) {
    assert.equal((await ask("Write", { file_path: path })).behavior, "deny", path);
  }
});

test("the interviewer may not approve a spec", async () => {
  const file_path = "docs/specs/001-poll.md";
  const write = await ask("Write", { file_path, content: "---\nid: 001\nstatus: approved\n---\n" });
  const edit = await ask("Edit", { file_path, old_string: "status: draft", new_string: "status: approved   # draft | approved" });
  assert.equal(write.behavior, "deny");
  assert.equal(edit.behavior, "deny");
  assert.equal((await ask("Write", { file_path, content: "---\nstatus: draft     # draft | approved\n---\n" })).behavior, "allow");
});

test("the interviewer may read anything", async () => {
  assert.equal((await ask("Read", { file_path: join(root, "src/Main.java") })).behavior, "allow");
});

test("other tools are denied", async () => {
  assert.equal((await ask("WebFetch", { url: "https://example.com" })).behavior, "deny");
  assert.equal((await ask("Bash", { command: "rm -rf docs" })).behavior, "deny");
});
