import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Project } from "./project.js";

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
  write("docs/specs/001-termine.md", "---\nid: 001\ntitel: Termine\nstatus: freigegeben   # entwurf | freigegeben\n---\n\n# 001\n");
  write(TEST, "original");
  project = Project.load(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("spec reads id, title and status from the front matter", () => {
  assert.deepEqual(project.spec("1"), { id: "001", path: "docs/specs/001-termine.md", title: "Termine", status: "freigegeben" });
});

test("spec reads front matter with CRLF line endings", () => {
  write("docs/specs/002-crlf.md", "---\r\nid: 002\r\ntitel: Crlf\r\nstatus: entwurf\r\n---\r\n");
  assert.deepEqual(project.spec("002"), { id: "002", path: "docs/specs/002-crlf.md", title: "Crlf", status: "entwurf" });
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
