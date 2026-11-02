import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Spec } from "./project.js";
import { log, runSession, type SessionOptions, type SessionResult } from "./session.js";

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
 * Runs one approved spec end to end. Each phase is a fresh agent session, so the
 * implementing agent never sees the reasoning of the one that wrote the tests.
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
  if (project.gate().paused) {
    return finish("abgebrochen", "Das Stop-Gate ist pausiert – ohne Gate prüft niemand verify und Review.");
  }
  log("run", `Spec ${spec.id} – ${spec.title}`);

  // Phase 1: acceptance tests
  if (project.acceptanceTests(spec).length) {
    record.phases.push({ name: "tests", verdict: "skipped", note: "Akzeptanztests vorhanden." });
  } else {
    const session = await runSession(project, "tests", `/werkstatt:derive-tests ${spec.id}`, options);
    const tests = project.acceptanceTests(spec);
    const phase: Phase = { name: "tests", session, verdict: "ok", note: "" };
    record.phases.push(phase);
    if (!tests.length) {
      phase.verdict = "failed";
      phase.note = session.finalText;
      return finish("abgebrochen", `Keine Akzeptanztests für Spec ${spec.id} entstanden.\n\n${session.finalText}`);
    }
    const unlocked = tests.filter((t) => !project.gate().locked.includes(t));
    phase.note = `${tests.length} Testdatei(en)` + (unlocked.length ? `, NICHT gesperrt: ${unlocked.join(", ")}` : ", gesperrt.");
    if (unlocked.length) {
      phase.verdict = "failed";
      return finish("gescheitert", `Akzeptanztests wurden nicht gesperrt – läuft das Plugin mit seinen Hooks?\n${unlocked.join("\n")}`);
    }
  }

  const before = project.verify();
  if (before.ok) log("run", "verify ist bereits grün – die Tests prüfen evtl. zu wenig, oder die Spec ist schon umgesetzt.");

  // Phase 2: implementation, retried with the orchestrator's own findings as feedback
  let feedback = "";
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const label = `impl ${attempt}/${options.maxAttempts}`;
    const session = await runSession(project, label, implementPrompt(project, spec, feedback), options);
    const phase: Phase = { name: `implement-${attempt}`, session, verdict: "failed", note: "" };
    record.phases.push(phase);

    const gate = project.gate();
    const verify = project.verify();
    const problems = [
      gate.tampered.length && `Gesperrte Akzeptanztests verändert: ${gate.tampered.join(", ")}`,
      !verify.ok && `verify ist rot:\n${verify.output}`,
      verify.ok && !gate.isApproved && "verify ist grün, aber der aktuelle Stand hat kein bestandenes Review.",
    ].filter(Boolean) as string[];

    if (!problems.length) {
      phase.verdict = "ok";
      phase.note = "verify grün, Review bestanden.";
      return finish("freigegeben", `Spec ${spec.id} umgesetzt, verify grün, Review bestanden.`);
    }
    phase.note = problems.join("\n\n");
    log("run", `Versuch ${attempt} nicht abgeschlossen: ${problems.map((p) => p.split("\n")[0]).join(" | ")}`);
    if (session.outcome !== "success") {
      return finish("gescheitert", `Session endete mit ${session.outcome}.\n\n${phase.note}`);
    }
    feedback = `${phase.note}\n\nLetzte Nachricht des vorigen Versuchs:\n${session.finalText}`;
  }
  return finish("gescheitert", `Nach ${options.maxAttempts} Versuchen nicht freigegeben.\n\n${feedback}`);
}

function implementPrompt(project: Project, spec: Spec, feedback: string): string {
  const tests = project.acceptanceTests(spec).map((t) => `- ${t}`).join("\n");
  return `Setze Spec ${spec.id} um: ${spec.path}

Die Akzeptanztests dazu sind gesperrt und legen fest, wann du fertig bist:
${tests}

Halte dich an AGENTS.md. Setze nur um, was die Spec verlangt. Ändere keine Akzeptanztests.
Bevor du aufhörst, verlangt die werkstatt, dass \`${project.config.commands.verify}\` grün ist
und der Subagent werkstatt:reviewer die Änderung abgenommen hat – folge ihren Hinweisen.
${feedback ? `\nEin vorheriger Versuch ist nicht abgeschlossen worden. Befund des Orchestrators:\n\n${feedback}\n` : ""}`;
}

function save(project: Project, record: RunRecord) {
  const state = join(project.root, ".werkstatt", "state");
  const dir = join(state, "runs");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(state, ".gitignore"))) writeFileSync(join(state, ".gitignore"), "*\n");
  const name = `${record.startedAt.replace(/[:.]/g, "-")}-spec${record.spec}.json`;
  writeFileSync(join(dir, name), JSON.stringify(record, null, 2) + "\n");
}
