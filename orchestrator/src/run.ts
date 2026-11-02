import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Spec } from "./project.js";
import { builder, log, reviewer, runSession, type SessionOptions, type SessionResult } from "./session.js";

export interface RunOptions extends SessionOptions {
  maxAttempts: number;
  allowDirty: boolean;
}

interface Phase {
  name: string;
  session?: SessionResult;
  verdict: "ok" | "failed" | "skipped";
  note: string;
}

export interface RunRecord {
  spec: string;
  startedAt: string;
  finishedAt?: string;
  outcome: "freigegeben" | "abgebrochen" | "gescheitert";
  reason: string;
  phases: Phase[];
  costUsd: number;
  changedFiles: string[];
}

/**
 * Runs one approved spec end to end: tests → (implement → verify → review)*.
 * Each phase is a fresh agent session, so no agent sees the reasoning of another.
 * The orchestrator checks every outcome itself instead of trusting the agent's report.
 */
export async function run(project: Project, specId: string, options: RunOptions): Promise<RunRecord> {
  const spec = project.spec(specId);
  const record: RunRecord = {
    spec: spec.id, startedAt: new Date().toISOString(), outcome: "abgebrochen", reason: "", phases: [], costUsd: 0, changedFiles: [],
  };
  const finish = (outcome: RunRecord["outcome"], reason: string) => {
    record.outcome = outcome;
    record.reason = reason;
    record.finishedAt = new Date().toISOString();
    record.costUsd = record.phases.reduce((sum, p) => sum + (p.session?.costUsd ?? 0), 0);
    record.changedFiles = project.dirtyFiles();
    save(project, record);
    return record;
  };

  // Preconditions
  if (spec.status !== "freigegeben") {
    return finish("abgebrochen", `Spec ${spec.id} hat den Status "${spec.status}", nicht "freigegeben".`);
  }
  const dirty = project.dirtyFiles();
  if (dirty.length && !options.allowDirty) {
    return finish("abgebrochen", "Uncommittete Änderungen – erst committen, damit die Änderungen des Laufs eindeutig sind " +
      `(oder --allow-dirty):\n${dirty.join("\n")}`);
  }
  const base = project.head();
  log("run", `Spec ${spec.id} – ${spec.title}`);

  // Phase 1: acceptance tests
  if (project.acceptanceTests(spec).length) {
    record.phases.push({ name: "tests", verdict: "skipped", note: "Akzeptanztests vorhanden." });
  } else {
    const session = await runSession(project, "tests", `/werkstatt:derive-tests ${spec.id}`, builder(project), options);
    const tests = project.acceptanceTests(spec);
    const phase: Phase = { name: "tests", session, verdict: "ok", note: "" };
    record.phases.push(phase);
    if (!tests.length) {
      phase.verdict = "failed";
      phase.note = session.finalText;
      return finish("abgebrochen", `Keine Akzeptanztests für Spec ${spec.id} entstanden.\n\n${session.finalText}`);
    }
    const unlocked = tests.filter((t) => !project.locks().locked.includes(t));
    phase.note = `${tests.length} Testdatei(en)` + (unlocked.length ? `, NICHT gesperrt: ${unlocked.join(", ")}` : ", gesperrt.");
    if (unlocked.length) {
      phase.verdict = "failed";
      return finish("gescheitert", `Akzeptanztests wurden nicht gesperrt – läuft das Plugin mit seinen Hooks?\n${unlocked.join("\n")}`);
    }
  }

  const before = project.verify();
  if (before.ok) log("run", "verify ist bereits grün – die Tests prüfen evtl. zu wenig, oder die Spec ist schon umgesetzt.");

  // Phase 2+3: implement, check, review – retried with the findings as feedback
  let feedback = "";
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const of = `${attempt}/${options.maxAttempts}`;
    const session = await runSession(project, `impl ${of}`, implementPrompt(project, spec, feedback), builder(project, "implement"), options);
    const phase: Phase = { name: `implement-${attempt}`, session, verdict: "failed", note: "" };
    record.phases.push(phase);

    const locks = project.locks();
    const verify = project.verify();
    const problems = [
      locks.tampered.length && `Gesperrte Akzeptanztests verändert: ${locks.tampered.join(", ")}`,
      !verify.ok && `verify ist rot:\n${verify.output}`,
    ].filter(Boolean) as string[];
    if (problems.length) {
      phase.note = problems.join("\n\n");
      log("run", `Versuch ${attempt}: ${problems.map((p) => p.split("\n")[0]).join(" | ")}`);
      if (session.outcome !== "success") {
        return finish("gescheitert", `Session endete mit ${session.outcome}.\n\n${phase.note}`);
      }
      feedback = `${phase.note}\n\nLetzte Nachricht des vorigen Versuchs:\n${session.finalText}`;
      continue;
    }
    phase.verdict = "ok";
    phase.note = "verify grün, Akzeptanztests unverändert.";

    const review = await runSession(project, `review ${of}`, reviewPrompt(project, spec, base), reviewer(), options);
    const verdict = /URTEIL:\s*(BESTANDEN|NACHBESSERN)/i.exec(review.finalText)?.[1].toUpperCase();
    record.phases.push({
      name: `review-${attempt}`, session: review, verdict: verdict === "BESTANDEN" ? "ok" : "failed", note: review.finalText,
    });
    if (verdict === "BESTANDEN") {
      return finish("freigegeben", `Spec ${spec.id} umgesetzt, verify grün, Review bestanden.`);
    }
    if (!verdict) {
      return finish("gescheitert", `Der Reviewer hat kein Urteil geliefert (Session: ${review.outcome}).`);
    }
    log("run", `Versuch ${attempt}: Review verlangt Nachbesserung.`);
    feedback = `Das Review verlangt Nachbesserungen:\n\n${review.finalText}`;
  }
  return finish("gescheitert", `Nach ${options.maxAttempts} Versuchen nicht freigegeben.\n\n${feedback}`);
}

function implementPrompt(project: Project, spec: Spec, feedback: string): string {
  const tests = project.acceptanceTests(spec).map((t) => `- ${t}`).join("\n");
  return `Setze Spec ${spec.id} um: ${spec.path}

Die Akzeptanztests dazu sind gesperrt und legen fest, wann du fertig bist:
${tests}

Halte dich an AGENTS.md. Setze nur um, was die Spec verlangt. Ändere keine Akzeptanztests.
Du bist erst fertig, wenn \`${project.config.commands.verify}\` grün ist. Danach prüft ein
unabhängiges Review deine Änderung gegen die Spec.
${feedback ? `\nEin vorheriger Versuch ist nicht abgeschlossen worden. Befund:\n\n${feedback}\n` : ""}`;
}

function reviewPrompt(project: Project, spec: Spec, base: string): string {
  const changed = project.dirtyFiles().map((line) => `- ${line}`).join("\n");
  return `Prüfe die Umsetzung von Spec ${spec.id}: ${spec.path}

Ausgangs-Commit: ${base}
Geänderte Dateien (git status):
${changed}

\`${project.config.commands.verify}\` ist grün, die Akzeptanztests sind unverändert.`;
}

function save(project: Project, record: RunRecord) {
  const state = join(project.root, ".werkstatt", "state");
  const dir = join(state, "runs");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(state, ".gitignore"))) writeFileSync(join(state, ".gitignore"), "*\n");
  const name = `${record.startedAt.replace(/[:.]/g, "-")}-spec${record.spec}.json`;
  writeFileSync(join(dir, name), JSON.stringify(record, null, 2) + "\n");
}
