import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkSetup, decide, type Approval } from "./init.js";

let root: string;
let answers: Approval[];
let asked: string[];
let canUseTool: ReturnType<typeof decide>;
const ask = (tool: string, input: Record<string, unknown>) =>
  canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: "t" } as never);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "werkstatt-"));
  answers = [];
  asked = [];
  canUseTool = decide(root, async (command) => {
    asked.push(command);
    return answers.shift() ?? { allow: false };
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the initializer may create files inside the project", async () => {
  assert.equal((await ask("Write", { file_path: join(root, "AGENTS.md") })).behavior, "allow");
  assert.equal((await ask("Write", { file_path: "docs/specs/.gitkeep" })).behavior, "allow");
});

test("the initializer may not write outside the project, in .git/ or in .werkstatt/", async () => {
  for (const path of ["/tmp/x.md", join(root, "../x.md"), join(root, ".git/config"), join(root, ".werkstatt/locks/x")]) {
    assert.equal((await ask("Write", { file_path: path })).behavior, "deny", path);
  }
});

test("Write may not replace an existing file, Edit may change it", async () => {
  writeFileSync(join(root, "AGENTS.md"), "# Existing");
  assert.equal((await ask("Write", { file_path: join(root, "AGENTS.md") })).behavior, "deny");
  assert.equal((await ask("Edit", { file_path: join(root, "AGENTS.md") })).behavior, "allow");
});

test("Write may replace a file it created itself in this session", async () => {
  const file_path = join(root, "werkstatt.json");
  assert.equal((await ask("Write", { file_path })).behavior, "allow");
  writeFileSync(file_path, "{}");
  assert.equal((await ask("Write", { file_path })).behavior, "allow");
});

test("shell commands need the user's approval, and a reason for no is passed on", async () => {
  answers = [{ allow: true }, { allow: false, reason: "use Gradle instead" }];
  assert.equal((await ask("Bash", { command: "npm init -y" })).behavior, "allow");
  const denied = await ask("Bash", { command: "mvn archetype:generate" });
  assert.equal(denied.behavior, "deny");
  assert.match((denied as { message: string }).message, /use Gradle instead/);
  assert.deepEqual(asked, ["npm init -y", "mvn archetype:generate"]);
});

test("a command approved with always is not asked again", async () => {
  answers = [{ allow: true, always: true }];
  await ask("Bash", { command: "./mvnw verify" });
  assert.equal((await ask("Bash", { command: "./mvnw verify" })).behavior, "allow");
  assert.deepEqual(asked, ["./mvnw verify"]);
});

test("other tools are denied", async () => {
  assert.equal((await ask("WebFetch", { url: "https://example.com" })).behavior, "deny");
});

const config = (overrides: Record<string, unknown> = {}) => writeFileSync(join(root, "werkstatt.json"), JSON.stringify({
  version: 1, specs: "docs/specs", acceptanceTests: "tests/acceptance", commands: { verify: "true" }, ...overrides,
}));

test("a complete setup has no problems", () => {
  config();
  mkdirSync(join(root, "docs/specs"), { recursive: true });
  mkdirSync(join(root, "tests/acceptance"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Agents");
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
  const { project, problems } = checkSetup(root);
  assert.deepEqual(problems, []);
  assert.ok(project);
});

test("the setup check finds what's missing", () => {
  assert.deepEqual(checkSetup(root).problems, ["werkstatt.json is missing."]);
  config({ acceptanceTests: "<path to the acceptance test directory>", commands: { verify: "" } });
  const { project, problems } = checkSetup(root);
  assert.equal(project, undefined);
  assert.deepEqual(problems, [
    "The directory docs/specs/ (\"specs\") is missing.",
    "werkstatt.json: \"acceptanceTests\" is not set.",
    "werkstatt.json: \"commands.verify\" is not set.",
    "AGENTS.md is missing.",
    "CLAUDE.md doesn't import AGENTS.md (a line \"@AGENTS.md\").",
  ]);
});

test("broken JSON is a problem, not a crash", () => {
  writeFileSync(join(root, "werkstatt.json"), "{ nope");
  assert.match(checkSetup(root).problems[0], /can't be read/);
});
