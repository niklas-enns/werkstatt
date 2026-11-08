#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { HOOK_SCRIPT, Project } from "./project.js";
import { run, type Decision } from "./run.js";

const USAGE = `Usage:
  werkstatt run <spec-id> [options]    implement a spec
  werkstatt status                     show locked acceptance tests
  werkstatt unlock <path-part>...      unlock acceptance tests (humans only)

\`run\` takes an approved spec all the way through on its own: derive acceptance tests
(unless they exist), implement, verify and review – each in its own agent session.
Never commits.

Options for run:
  --project <dir>       project directory (default: current directory)
  --attempts <n>        implementation attempts (default: 2)
  --budget <usd>        cost limit per session in USD
  --max-turns <n>       turn limit per session (default: 150)
  --model <id>          model for all sessions
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
  const [command, specId] = positionals;
  if (command === "status" || command === "unlock") {
    execFileSync("python3", [HOOK_SCRIPT, ...positionals], { cwd: values.project, stdio: "inherit" });
    return;
  }
  if (values.help || command !== "run" || !specId) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const options = {
    maxAttempts: positive("attempts", values.attempts, true),
    maxBudgetUsd: values.budget === undefined ? undefined : positive("budget", values.budget, false),
    maxTurns: positive("max-turns", values["max-turns"], true),
    model: values.model,
    allowDirty: values["allow-dirty"],
    decide: process.stdin.isTTY ? askUser : undefined,
  };
  const project = Project.load(values.project);
  const record = await run(project, specId, options);

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

function positive(option: string, value: string, integer: boolean): number {
  const n = Number(value);
  if (!(n > 0) || (integer && !Number.isInteger(n))) {
    console.error(`--${option} expects ${integer ? "a whole number" : "a number"} greater than 0, not "${value}".`);
    process.exit(2);
  }
  return n;
}

async function askUser(questions: string[]): Promise<Decision[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nThe review passed but leaves ${questions.length} question(s) open that the spec doesn't settle.`);
  const decisions: Decision[] = [];
  for (const [i, question] of questions.entries()) {
    console.log(`\nQuestion ${i + 1}/${questions.length}: ${question}`);
    let choice = "";
    while (!["k", "c", "l"].includes(choice)) {
      choice = (await rl.question("  [k] keep as implemented   [c] decide differently   [l] later > ")).trim().toLowerCase();
    }
    if (choice === "k") decisions.push({ question, kind: "confirmed" });
    if (choice === "l") decisions.push({ question, kind: "later" });
    if (choice === "c") {
      let text = "";
      while (!text) text = (await rl.question("  Your decision: ")).trim();
      decisions.push({ question, kind: "changed", text });
    }
  }
  rl.close();
  return decisions;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
