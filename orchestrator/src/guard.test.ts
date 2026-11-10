import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { denyReason, guard } from "./guard.js";
import { Project } from "./project.js";

const TEST = "tests/acceptance/Spec001FooTest.java";
let root: string;
let project: Project;

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const denied = (tool: string, input: Record<string, unknown>) => denyReason(project, tool, input) !== null;

/** Runs the Stop hook of a guard like the SDK would. */
const stop = (hooks: ReturnType<typeof guard>) =>
  hooks.Stop![0].hooks[0]({} as never, undefined, { signal: new AbortController().signal }) as Promise<Record<string, unknown>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "werkstatt-"));
  write("werkstatt.json", JSON.stringify({
    specs: "docs/specs", acceptanceTests: "tests/acceptance", commands: { verify: "test -f green" },
  }));
  write(TEST, "original");
  project = Project.load(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("writes to locked tests and werkstatt's own files are denied", () => {
  project.lock();
  assert.ok(denied("Edit", { file_path: join(root, TEST) }));
  assert.ok(denied("Write", { file_path: "werkstatt.json" }));
  assert.ok(denied("Write", { file_path: ".werkstatt/locks/manifest.json" }));
  assert.ok(!denied("Write", { file_path: "src/Main.java" }));
  assert.ok(!denied("Write", { file_path: "/elsewhere/werkstatt.json" }));
});

test("obvious shell writes to protected files and unlock are denied", () => {
  project.lock();
  assert.ok(denied("Bash", { command: `sed -i s/a/b/ ${TEST}` }));
  assert.ok(denied("Bash", { command: "rm -r .werkstatt" }));
  assert.ok(denied("Bash", { command: "echo {} > werkstatt.json" }));
  assert.ok(denied("Bash", { command: "werkstatt unlock Spec001" }));
  assert.ok(!denied("Bash", { command: `cat ${TEST}` }));
  assert.ok(!denied("Bash", { command: "rm -rf build" }));
});

test("the PreToolUse hook denies through the SDK's output format", async () => {
  project.lock();
  const hooks = guard(root, { stop: false });
  const output = await hooks.PreToolUse![0].hooks[0](
    { tool_name: "Edit", tool_input: { file_path: TEST } } as never, "t", { signal: new AbortController().signal });
  assert.equal((output as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "deny");
});

test("conversations get no Stop hook – a test changed by hand is not silently undone", () => {
  assert.equal(guard(root, { stop: false }).Stop, undefined);
  assert.ok(guard(root, { stop: false }).PreToolUse);
});

test("the hooks do nothing in a directory without werkstatt.json", async () => {
  const empty = mkdtempSync(join(tmpdir(), "werkstatt-"));
  try {
    assert.deepEqual(await stop(guard(empty, { stop: true, verifyGate: true })), {});
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("Stop locks new tests", async () => {
  assert.deepEqual(await stop(guard(root, { stop: true })), {});
  assert.deepEqual(project.locks().locked, [TEST]);
});

test("Stop restores a tampered test and sends the agent back", async () => {
  project.lock();
  write(TEST, "changed");
  const output = await stop(guard(root, { stop: true }));
  assert.equal(output.decision, "block");
  assert.match(String(output.reason), new RegExp(TEST));
  assert.equal(readFileSync(join(root, TEST), "utf8"), "original");
});

test("the verify gate only applies when switched on", async () => {
  assert.deepEqual(await stop(guard(root, { stop: true, verifyGate: false })), {});
});

test("the verify gate blocks three times, then lets the session end", async () => {
  const hooks = guard(root, { stop: true, verifyGate: true });
  for (const n of [1, 2, 3]) {
    const output = await stop(hooks);
    assert.equal(output.decision, "block");
    assert.match(String(output.reason), new RegExp(`\\(${n}/3\\)`));
  }
  const last = await stop(hooks);
  assert.equal(last.decision, undefined);
  assert.match(String(last.systemMessage), /still red/);
});

test("a green verify resets the count, and each session counts for itself", async () => {
  const hooks = guard(root, { stop: true, verifyGate: true });
  await stop(hooks);
  await stop(hooks);
  write("green", "");
  assert.deepEqual(await stop(hooks), {});
  rmSync(join(root, "green"));
  assert.match(String((await stop(hooks)).reason), /\(1\/3\)/);
  assert.match(String((await stop(guard(root, { stop: true, verifyGate: true }))).reason), /\(1\/3\)/);
});

test("a failing hook reports instead of trapping the session", async () => {
  write("werkstatt.json", "{ broken");
  const output = await stop(guard(root, { stop: true }));
  assert.match(String(output.systemMessage), /hook Stop failed/);
});
