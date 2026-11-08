import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Project } from "./project.js";
import { addDecisionsToSpec } from "./run.js";

const TEST = "tests/acceptance/Spec001FooTest.java";
let root: string;
let project: Project;

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (path: string) => readFileSync(join(root, path), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "werkstatt-"));
  write("werkstatt.json", JSON.stringify({
    specs: "docs/specs", acceptanceTests: "tests/acceptance", commands: { verify: "true" },
  }));
  write("docs/specs/001-appointments.md", "---\nid: 001\ntitle: Appointments\nstatus: approved   # draft | approved\n---\n\n# 001\n");
  write(TEST, "original");
  project = Project.load(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("spec reads id, title and status from the front matter", () => {
  assert.deepEqual(project.spec("1"), { id: "001", path: "docs/specs/001-appointments.md", title: "Appointments", status: "approved" });
});

test("spec reads front matter with CRLF line endings", () => {
  write("docs/specs/002-crlf.md", "---\r\nid: 002\r\ntitle: Crlf\r\nstatus: draft\r\n---\r\n");
  assert.deepEqual(project.spec("002"), { id: "002", path: "docs/specs/002-crlf.md", title: "Crlf", status: "draft" });
});

test("acceptance tests are found by Spec<NNN> in the file name, ignoring case", () => {
  write("tests/acceptance/test_spec001_python.py", "");
  write("tests/acceptance/Spec002OtherTest.java", "");
  assert.deepEqual(project.acceptanceTests(project.spec("001")).sort(), [TEST, "tests/acceptance/test_spec001_python.py"]);
});

test("restore brings back changed and deleted files from the snapshot", () => {
  const snapshot = project.snapshot([TEST]);
  assert.deepEqual(project.restore(snapshot), []);
  write(TEST, "changed");
  assert.deepEqual(project.restore(snapshot), [TEST]);
  assert.equal(read(TEST), "original");
  rmSync(join(root, "tests"), { recursive: true });
  assert.deepEqual(project.restore(snapshot), [TEST]);
  assert.equal(read(TEST), "original");
});

test("lock and discard manage the hook's locks", () => {
  assert.deepEqual(project.lock(), [TEST]);
  assert.deepEqual(project.locks().locked, [TEST]);
  project.discard([TEST]);
  assert.deepEqual(project.locks().locked, []);
  assert.equal(existsSync(join(root, TEST)), false);
});

test("decisions are appended under a Decisions heading, later ones are skipped", () => {
  const spec = project.spec("001");
  addDecisionsToSpec(project, spec, [
    { question: "Round half up?", kind: "confirmed" },
    { question: "Reject negative amounts?", kind: "changed", text: "Yes, exit code 2." },
    { question: "Currency symbol?", kind: "later" },
  ]);
  addDecisionsToSpec(project, spec, [{ question: "Max amount?", kind: "changed", text: "1,000,000" }]);
  const text = read(spec.path);
  assert.equal(text.match(/## Decisions/g)?.length, 1);
  assert.match(text, /- Round half up\?\n  \*\*Decision \(\d{4}-\d{2}-\d{2}\):\*\* As implemented\./);
  assert.match(text, /Reject negative amounts\?\n  \*\*Decision .*:\*\* Yes, exit code 2\./);
  assert.match(text, /Max amount\?/);
  assert.doesNotMatch(text, /Currency symbol/);
});
