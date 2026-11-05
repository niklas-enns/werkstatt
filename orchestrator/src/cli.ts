#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { HOOK_SCRIPT, Project } from "./project.js";
import { run, type Decision } from "./run.js";

const USAGE = `Aufruf:
  werkstatt run <Spec-ID> [Optionen]   Spec umsetzen
  werkstatt status                     gesperrte Akzeptanztests anzeigen
  werkstatt unlock <Pfad-Teil>...      Akzeptanztests entsperren (nur für Menschen)

\`run\` führt eine freigegebene Spec ohne Zutun durch: Akzeptanztests ableiten (falls
noch keine da sind), implementieren, verify und Review – jeweils in eigenen
Agent-Sessions. Committet nicht.

Optionen für run:
  --project <dir>       Projektverzeichnis (Standard: aktuelles Verzeichnis)
  --attempts <n>        Implementierungsversuche (Standard: 2)
  --budget <usd>        Kostenobergrenze je Session in USD
  --max-turns <n>       Turn-Obergrenze je Session (Standard: 150)
  --model <id>          Modell für alle Sessions
  --allow-dirty         Auch mit uncommitteten Änderungen starten`;

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
  console.log(`\nKosten: $${record.costUsd.toFixed(2)}`);
  for (const phase of record.phases) {
    const cost = phase.session ? ` ($${phase.session.costUsd.toFixed(2)}, ${phase.session.turns} Turns)` : "";
    console.log(`  ${phase.name}: ${phase.verdict}${cost}`);
  }
  const decided = record.decisions.filter((d) => d.kind !== "später");
  if (decided.length) console.log(`\n${decided.length} Entscheidung(en) in ${project.spec(record.spec).path} festgehalten.`);
  if (record.openQuestions.length) {
    console.log("\nOffene Fragen an dich:");
    record.openQuestions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  }
  if (record.changedFiles.length) {
    console.log(`\nGeänderte Dateien:\n${record.changedFiles.join("\n")}`);
    if (record.outcome === "freigegeben") console.log("\nNächster Schritt: Diff ansehen und committen.");
  }
  process.exit(record.outcome === "freigegeben" ? 0 : 1);
}

function positive(option: string, value: string, integer: boolean): number {
  const n = Number(value);
  if (!(n > 0) || (integer && !Number.isInteger(n))) {
    console.error(`--${option} erwartet ${integer ? "eine ganze Zahl" : "eine Zahl"} größer 0, nicht "${value}".`);
    process.exit(2);
  }
  return n;
}

async function askUser(questions: string[]): Promise<Decision[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nDas Review ist bestanden, lässt aber ${questions.length} Frage(n) offen, die die Spec nicht regelt.`);
  const decisions: Decision[] = [];
  for (const [i, question] of questions.entries()) {
    console.log(`\nFrage ${i + 1}/${questions.length}: ${question}`);
    let choice = "";
    while (!["a", "e", "s"].includes(choice)) {
      choice = (await rl.question("  [a] so lassen, wie umgesetzt   [e] anders entscheiden   [s] später > ")).trim().toLowerCase();
    }
    if (choice === "a") decisions.push({ question, kind: "bestätigt" });
    if (choice === "s") decisions.push({ question, kind: "später" });
    if (choice === "e") {
      let text = "";
      while (!text) text = (await rl.question("  Deine Entscheidung: ")).trim();
      decisions.push({ question, kind: "geändert", text });
    }
  }
  rl.close();
  return decisions;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
