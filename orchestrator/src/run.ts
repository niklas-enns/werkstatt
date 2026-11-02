import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Project, Spec } from "./project.js";
import { builder, log, reviewer, runSession, type SessionOptions, type SessionResult } from "./session.js";

export interface RunOptions extends SessionOptions {
  maxAttempts: number;
  allowDirty: boolean;
  /** Asks the user about open questions from a passed review; absent when nobody can answer. */
  decide?: (questions: string[]) => Promise<Decision[]>;
}

export interface Decision {
  question: string;
  kind: "bestätigt" | "geändert" | "später";
  /** The user's decision, for kind "geändert". */
  text?: string;
}

interface Phase {
  name: string;
  session?: SessionResult;
  verdict: "ok" | "failed" | "skipped";
  note: string;
}

interface Review {
  verdict: "BESTANDEN" | "NACHBESSERN";
  summary: string;
  findings: { location: string; reference: string; problem: string; blocking: boolean }[];
  questions: string[];
}

const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "questions"],
  properties: {
    verdict: { type: "string", enum: ["BESTANDEN", "NACHBESSERN"] },
    summary: { type: "string", description: "Gesamteinschätzung in wenigen Sätzen" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["location", "reference", "problem", "blocking"],
        properties: {
          location: { type: "string", description: "Datei:Zeile" },
          reference: { type: "string", description: "AK-ID, Regel der Spec oder Abschnitt der AGENTS.md" },
          problem: { type: "string", description: "Problem und was stattdessen erwartet wird" },
          blocking: { type: "boolean", description: "true, wenn eine Nachbesserung nötig ist" },
        },
      },
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "Punkte, die die Spec offen lässt und der Nutzer entscheiden muss. Jede Frage für sich verständlich: " +
        "was die Spec offen lässt, wie es jetzt umgesetzt ist, welche Alternative es gäbe.",
    },
  },
};

export interface RunRecord {
  spec: string;
  startedAt: string;
  finishedAt?: string;
  outcome: "freigegeben" | "abgebrochen" | "gescheitert";
  reason: string;
  phases: Phase[];
  costUsd: number;
  changedFiles: string[];
  decisions: Decision[];
  openQuestions: string[];
}

/**
 * Runs one approved spec end to end: tests → (implement → verify → review)*.
 * Each phase is a fresh agent session, so no agent sees the reasoning of another.
 * The orchestrator checks every outcome itself instead of trusting the agent's report.
 */
export async function run(project: Project, specId: string, options: RunOptions): Promise<RunRecord> {
  const spec = project.spec(specId);
  const record: RunRecord = {
    spec: spec.id, startedAt: new Date().toISOString(), outcome: "abgebrochen", reason: "", phases: [], costUsd: 0, changedFiles: [], decisions: [], openQuestions: [],
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

  // Phase 2+3: implement, check, review – retried with the findings as feedback.
  // The user's answers to open review questions may add one more round.
  let feedback = "";
  let limit = options.maxAttempts;
  for (let attempt = 1; attempt <= limit; attempt++) {
    const of = `${attempt}/${limit}`;
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

    const reviewSession = await runSession(project, `review ${of}`, reviewPrompt(project, spec, base), reviewer(REVIEW_SCHEMA), options);
    const review = reviewSession.structured as Review | undefined;
    const report = review ? formatReview(spec, attempt, review) : reviewSession.finalText;
    const file = saveReview(project, record, attempt, report);
    record.phases.push({
      name: `review-${attempt}`, session: reviewSession, verdict: review?.verdict === "BESTANDEN" ? "ok" : "failed", note: file,
    });
    if (!review) {
      return finish("gescheitert", `Der Reviewer hat kein Urteil geliefert (Session: ${reviewSession.outcome}). Text: ${file}`);
    }
    if (review.verdict === "BESTANDEN") {
      record.openQuestions = review.questions;
      if (review.questions.length && options.decide && !record.decisions.length) {
        const decisions = await options.decide(review.questions);
        record.decisions = decisions;
        record.openQuestions = decisions.filter((d) => d.kind === "später").map((d) => d.question);
        addDecisionsToSpec(project, spec, decisions);
        const changes = decisions.filter((d) => d.kind === "geändert");
        if (changes.length) {
          limit = attempt + 1;
          feedback = "Der Nutzer hat offene Fragen entschieden (siehe Abschnitt „Entscheidungen“ der Spec). " +
            "Passe die Umsetzung daran an:\n\n" + changes.map((d) => `- ${d.question}\n  Entscheidung: ${d.text}`).join("\n");
          log("run", `${changes.length} Entscheidung(en) erfordern eine weitere Runde.`);
          continue;
        }
      }
      return finish("freigegeben", `Spec ${spec.id} umgesetzt, verify grün, Review bestanden. Review: ${file}`);
    }
    log("run", `Versuch ${attempt}: Review verlangt Nachbesserung.`);
    const blocking = review.findings.filter((f) => f.blocking);
    feedback = "Das Review verlangt Nachbesserungen:\n\n" +
      blocking.map((f) => `- ${f.location} (${f.reference}): ${f.problem}`).join("\n");
  }
  return finish("gescheitert", `Nach ${limit} Versuchen nicht freigegeben.\n\n${feedback}`);
}

/** Records the user's decisions in the spec, so later reviews don't raise them again. */
export function addDecisionsToSpec(project: Project, spec: Spec, decisions: Decision[]) {
  const decided = decisions.filter((d) => d.kind !== "später");
  if (!decided.length) return;
  const date = new Date().toISOString().slice(0, 10);
  const lines = decided.map((d) =>
    `- ${d.question}\n  **Entscheidung (${date}):** ${d.kind === "bestätigt" ? "So, wie umgesetzt." : d.text}`).join("\n");
  const path = join(project.root, spec.path);
  const text = readFileSync(path, "utf8").trimEnd();
  const heading = "## Entscheidungen";
  const at = text.indexOf(`\n${heading}\n`);
  if (at < 0) {
    writeFileSync(path, `${text}\n\n${heading}\n\n${lines}\n`);
    return;
  }
  const next = text.indexOf("\n## ", at + heading.length + 1);
  const end = next < 0 ? text.length : next;
  writeFileSync(path, `${text.slice(0, end).trimEnd()}\n${lines}\n${text.slice(end)}\n`);
}

function implementPrompt(project: Project, spec: Spec, feedback: string): string {
  const tests = project.acceptanceTests(spec).map((t) => `- ${t}`).join("\n");
  return `Setze Spec ${spec.id} um: ${spec.path}

Die Akzeptanztests dazu sind gesperrt und legen fest, wann du fertig bist:
${tests}

Halte dich an AGENTS.md. Setze nur um, was die Spec verlangt. Ändere keine Akzeptanztests.
Du bist erst fertig, wenn \`${project.config.commands.verify}\` grün ist. Danach prüft ein
unabhängiges Review deine Änderung gegen die Spec.
${feedback ? `\nDer bisherige Stand ist noch nicht abgenommen. Rückmeldung:\n\n${feedback}\n` : ""}`;
}

function reviewPrompt(project: Project, spec: Spec, base: string): string {
  const changed = project.dirtyFiles().map((line) => `- ${line}`).join("\n");
  return `Prüfe die Umsetzung von Spec ${spec.id}: ${spec.path}

Ausgangs-Commit: ${base}
Geänderte Dateien (git status):
${changed}

\`${project.config.commands.verify}\` ist grün, die Akzeptanztests sind unverändert.`;
}

function formatReview(spec: Spec, attempt: number, review: Review): string {
  const findings = (blocking: boolean) =>
    review.findings.filter((f) => f.blocking === blocking)
      .map((f) => `- **${f.location}** (${f.reference}): ${f.problem}`).join("\n") || "- keine";
  return `# Review Spec ${spec.id}, Versuch ${attempt}: ${review.verdict}

${review.summary}

## Befunde, die eine Nachbesserung erfordern
${findings(true)}

## Hinweise
${findings(false)}

## Offene Fragen an den Nutzer
${review.questions.map((q) => `- ${q}`).join("\n") || "- keine"}
`;
}

function runsDir(project: Project): string {
  const state = join(project.root, ".werkstatt", "state");
  const dir = join(state, "runs");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(state, ".gitignore"))) writeFileSync(join(state, ".gitignore"), "*\n");
  return dir;
}

function runName(record: RunRecord): string {
  return `${record.startedAt.replace(/[:.]/g, "-")}-spec${record.spec}`;
}

/** Writes the review as Markdown next to the run record; returns its path relative to the project. */
function saveReview(project: Project, record: RunRecord, attempt: number, report: string): string {
  const path = join(runsDir(project), `${runName(record)}-review-${attempt}.md`);
  writeFileSync(path, report);
  return relative(project.root, path);
}

function save(project: Project, record: RunRecord) {
  writeFileSync(join(runsDir(project), `${runName(record)}.json`), JSON.stringify(record, null, 2) + "\n");
}
