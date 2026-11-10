import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAgents, parseAgent } from "./agents.js";

test("all werkstatt agents load with a prompt and their tools", () => {
  const agents = loadAgents();
  assert.deepEqual(Object.keys(agents).sort(), ["implementer", "initializer", "interviewer", "reviewer", "test-writer"]);
  for (const [name, agent] of Object.entries(agents)) {
    assert.ok(agent.description, name);
    assert.ok(agent.prompt.startsWith("# "), name);
    assert.ok(agent.tools?.includes("Read"), name);
  }
  assert.deepEqual(agents.reviewer.tools, ["Read", "Bash", "StructuredOutput"]);
});

test("comment lines in the front matter are ignored", () => {
  const [name, agent] = parseAgent("---\nname: a\n# a comment: with colon\ndescription: Does a: b\ntools: Read, Bash\n---\n\n# A\n\nBody\n", "a.md");
  assert.equal(name, "a");
  assert.deepEqual(agent, { description: "Does a: b", prompt: "# A\n\nBody", tools: ["Read", "Bash"] });
});

test("an agent without front matter is an error", () => {
  assert.throws(() => parseAgent("# no front matter", "x.md"), /front matter missing/);
});
