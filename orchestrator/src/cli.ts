#!/usr/bin/env node
import { parseArgs } from "node:util";
import { init } from "./init.js";
import { interview } from "./interview.js";
import { Project } from "./project.js";
import { run, type Decision } from "./run.js";
import type { SessionOptions } from "./session.js";
import { closeTerminal, prompt } from "./terminal.js";

const USAGE = `Usage:
  werkstatt init [description] [options]  set up the project, asking you where needed
  werkstatt spec <idea> [options]         write a spec by interviewing you
  werkstatt run <spec-id> [options]       implement a spec
  werkstatt status                        show locked acceptance tests
  werkstatt unlock <path-part>...         unlock acceptance tests (humans only)

\`run\` takes an approved spec all the way through on its own: derive acceptance tests
(unless they exist), implement, verify and review – each in its own agent session.
Never commits.

Options:
  --project <dir>       project directory (default: current directory)
  --budget <usd>        cost limit per session in USD
  --max-turns <n>       turn limit per session (default: 150)
  --model <id>          model for all sessions

Options for run:
  --attempts <n>        implementation attempts (default: 2)
  --allow-dirty         start even with uncommitted changes`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string", default: process.cwd() },
      attempts: { type: "string", default: "2" },
      budget: { type: "string" },
      "max-turns": { type: "string", default: "150" },
      model: { type: "string" },
      "allow-dirty": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, argument] = positionals;
  if (command === "status") return status(Project.load(values.project));
  if (command === "unlock") return unlock(Project.load(values.project), positionals.slice(1));
  if (values.help || !["init", "spec", "run"].includes(command) || (command !== "init" && !argument)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const session = {
    maxBudgetUsd: values.budget === undefined ? undefined : positive("budget", values.budget, false),
    maxTurns: positive("max-turns", values["max-turns"], true),
    model: values.model,
  };
  if (command === "init") return setUp(values.project, positionals.slice(1).join(" "), session);
  const project = Project.load(values.project);
  if (command === "spec") return spec(project, positionals.slice(1).join(" "), session);

  const options = {
    ...session,
    maxAttempts: positive("attempts", values.attempts, true),
    allowDirty: values["allow-dirty"],
    decide: process.stdin.isTTY ? askUser : undefined,
  };
  const record = await run(project, argument, options);

  console.log(`\n=== Spec ${record.spec}: ${record.outcome.toUpperCase()} ===`);
  console.log(record.reason);
  console.log(`\nCost: $${record.costUsd.toFixed(2)}`);
  for (const phase of record.phases) {
    const cost = phase.session ? ` ($${phase.session.costUsd.toFixed(2)}, ${phase.session.turns} turns)` : "";
    console.log(`  ${phase.name}: ${phase.verdict}${cost}`);
  }
  const decided = record.decisions.filter((d) => d.kind !== "later");
  if (decided.length) console.log(`\n${decided.length} decision(s) recorded in ${project.spec(record.spec).path}.`);
  if (record.openQuestions.length) {
    console.log("\nOpen questions for you:");
    record.openQuestions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  }
  if (record.changedFiles.length) {
    console.log(`\nChanged files:\n${record.changedFiles.join("\n")}`);
    if (record.outcome === "done") console.log("\nNext step: review the diff and commit.");
  }
  process.exit(record.outcome === "done" ? 0 : 1);
}

async function setUp(root: string, description: string, options: SessionOptions) {
  requireTerminal("init");
  const result = await init(root, description, options);
  closeTerminal();

  console.log(`\nCost: $${result.costUsd.toFixed(2)}`);
  if (result.outcome !== "success") console.log(`The session ended with ${result.outcome}.`);
  if (result.problems.length) {
    console.log(`\nThe setup is not complete:\n${result.problems.map((p) => `  - ${p}`).join("\n")}`);
    console.log("\nRun werkstatt init again, or fix it by hand.");
    process.exit(1);
  }
  if (result.verify) {
    console.log(`\nverify is ${result.verify.ok ? "green" : "RED"}.`);
    if (!result.verify.ok) console.log(result.verify.output.split("\n").slice(-20).join("\n"));
  }
  console.log(`
Next steps:
  1. Review the changes and commit.
  2. werkstatt spec "<your first feature>"`);
  process.exit(result.outcome === "success" && result.verify?.ok ? 0 : 1);
}

async function spec(project: Project, idea: string, options: SessionOptions) {
  requireTerminal("spec");
  const result = await interview(project, idea, options);
  closeTerminal();

  console.log(`\nCost: $${result.costUsd.toFixed(2)}`);
  if (result.outcome !== "success") console.log(`The interview ended with ${result.outcome}.`);
  if (!result.specs.length) {
    console.log("No spec written.");
    process.exit(1);
  }
  console.log(`\nSpec: ${result.specs.join(", ")}`);
  console.log(`
Next steps:
  1. Review the spec and set \`status: approved\` in its front matter.
  2. Commit.
  3. werkstatt run <number>`);
  process.exit(result.outcome === "success" ? 0 : 1);
}

function status(project: Project) {
  const { locked, tampered } = project.locks();
  console.log(`Project: ${project.root}`);
  console.log(locked.length ? "Locked acceptance tests:" : "No locked acceptance tests.");
  for (const path of locked) console.log(`  ${path}${tampered.includes(path) ? "  (CHANGED)" : ""}`);
}

function unlock(project: Project, parts: string[]) {
  if (!parts.length) {
    console.error("Usage: werkstatt unlock <path or part of a name>...");
    process.exit(2);
  }
  const unlocked = project.unlock(...parts);
  for (const path of unlocked) console.log(`unlocked: ${path}`);
  if (!unlocked.length) console.log("Nothing found.");
}

function requireTerminal(command: string) {
  if (!process.stdin.isTTY) {
    console.error(`werkstatt ${command} talks with you – it needs a terminal to ask you questions.`);
    process.exit(2);
  }
}

function positive(option: string, value: string, integer: boolean): number {
  const n = Number(value);
  if (!(n > 0) || (integer && !Number.isInteger(n))) {
    console.error(`--${option} expects ${integer ? "a whole number" : "a number"} greater than 0, not "${value}".`);
    process.exit(2);
  }
  return n;
}

async function askUser(questions: string[]): Promise<Decision[]> {
  console.log(`\nThe review passed but leaves ${questions.length} question(s) open that the spec doesn't settle.`);
  const decisions: Decision[] = [];
  for (const [i, question] of questions.entries()) {
    console.log(`\nQuestion ${i + 1}/${questions.length}: ${question}`);
    let choice = "";
    while (!["k", "c", "l"].includes(choice)) {
      choice = (await prompt("  [k] keep as implemented   [c] decide differently   [l] later > ")).toLowerCase();
    }
    if (choice === "k") decisions.push({ question, kind: "confirmed" });
    if (choice === "l") decisions.push({ question, kind: "later" });
    if (choice === "c") {
      let text = "";
      while (!text) text = await prompt("  Your decision: ");
      decisions.push({ question, kind: "changed", text });
    }
  }
  closeTerminal();
  return decisions;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
