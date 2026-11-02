#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Project } from "./project.js";
import { run } from "./run.js";

const USAGE = `Aufruf: werkstatt run <Spec-ID> [Optionen]

Führt eine freigegebene Spec ohne Zutun durch: Akzeptanztests ableiten (falls
noch keine da sind), implementieren, verify und Review – jeweils in eigenen
Agent-Sessions. Committet nicht.

Optionen:
  --project <dir>       Projektverzeichnis (Standard: aktuelles Verzeichnis)
  --attempts <n>        Implementierungsversuche (Standard: 2)
  --budget <usd>        Kostenobergrenze je Session in USD
  --max-turns <n>       Turn-Obergrenze je Session
  --model <id>          Modell für alle Sessions
  --allow-dirty         Auch mit uncommitteten Änderungen starten`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string", default: process.cwd() },
      attempts: { type: "string", default: "2" },
      budget: { type: "string" },
      "max-turns": { type: "string" },
      model: { type: "string" },
      "allow-dirty": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, specId] = positionals;
  if (values.help || command !== "run" || !specId) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const project = Project.load(values.project);
  const record = await run(project, specId, {
    maxAttempts: Number(values.attempts),
    maxBudgetUsd: values.budget ? Number(values.budget) : undefined,
    maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
    model: values.model,
    allowDirty: values["allow-dirty"],
  });

  console.log(`\n=== Spec ${record.spec}: ${record.outcome.toUpperCase()} ===`);
  console.log(record.reason);
  console.log(`\nKosten: $${record.costUsd.toFixed(2)}`);
  for (const phase of record.phases) {
    const cost = phase.session ? ` ($${phase.session.costUsd.toFixed(2)}, ${phase.session.turns} Turns)` : "";
    console.log(`  ${phase.name}: ${phase.verdict}${cost}`);
  }
  if (record.changedFiles.length) {
    console.log(`\nGeänderte Dateien:\n${record.changedFiles.join("\n")}`);
    if (record.outcome === "freigegeben") console.log("\nNächster Schritt: Diff ansehen und committen.");
  }
  process.exit(record.outcome === "freigegeben" ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
