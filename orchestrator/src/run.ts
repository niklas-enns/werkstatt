import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Project, Spec } from "./project.js";
import { implementer, log, reviewer, runSession, testWriter, type SessionOptions, type SessionResult } from "./session.js";

export interface RunOptions extends SessionOptions {
  maxAttempts: number;
  allowDirty: boolean;
  /** Asks the user about open questions from a passed review; absent when nobody can answer. */
  decide?: (questions: string[]) => Promise<Decision[]>;
}

export interface Decision {
  question: string;
  kind: "confirmed" | "changed" | "later";
  /** The user's decision, for kind "changed". */
  text?: string;
}

interface Phase {
  name: string;
  session?: SessionResult;
  verdict: "ok" | "failed" | "skipped";
  note: string;
}

interface Review {
  verdict: "PASSED" | "NEEDS_WORK";
  summary: string;
  findings: { location: string; reference: string; problem: string; blocking: boolean }[];
  questions: string[];
}

const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "questions"],
  properties: {
    verdict: { type: "string", enum: ["PASSED", "NEEDS_WORK"] },
    summary: { type: "string", description: "Overall assessment in a few sentences" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["location", "reference", "problem", "blocking"],
        properties: {
          location: { type: "string", description: "file:line" },
          reference: { type: "string", description: "AC ID, rule of the spec, or section of AGENTS.md" },
          problem: { type: "string", description: "The problem and what is expected instead" },
          blocking: { type: "boolean", description: "true if the implementation must be reworked" },
        },
      },
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "Points the spec leaves open that the user has to decide. Each question must stand on its own: " +
        "what the spec leaves open, how it is implemented now, and what the alternative would be.",
    },
  },
};

interface TestsResult {
  ok: boolean;
  reason: string;
  tests: { criterion: string; test: string; redBecause: string }[];
}

const TESTS_SCHEMA = {
  type: "object",
  required: ["ok", "reason", "tests"],
  properties: {
    ok: { type: "boolean", description: "false if the spec cannot be translated cleanly into tests" },
    reason: { type: "string", description: "If ok=false: the gap in the spec and a proposal. Otherwise a short summary." },
    tests: {
      type: "array",
      description: "One entry per acceptance criterion",
      items: {
        type: "object",
        required: ["criterion", "test", "redBecause"],
        properties: {
          criterion: { type: "string", description: "AC ID, e.g. AC-3" },
          test: { type: "string", description: "Test class and method" },
          redBecause: { type: "string", description: "Why the test fails without an implementation, in a few words" },
        },
      },
    },
  },
};

export interface RunRecord {
  spec: string;
  startedAt: string;
  finishedAt?: string;
  outcome: "done" | "aborted" | "failed";
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
    spec: spec.id, startedAt: new Date().toISOString(), outcome: "aborted", reason: "", phases: [], costUsd: 0, changedFiles: [], decisions: [], openQuestions: [],
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
  if (spec.status !== "approved") {
    return finish("aborted", `Spec ${spec.id} has status "${spec.status}", not "approved".`);
  }
  const dirty = project.dirtyFiles();
  if (dirty.length && !options.allowDirty) {
    return finish("aborted", "Uncommitted changes – commit first so the changes of this run are clear " +
      `(or use --allow-dirty):\n${dirty.join("\n")}`);
  }
  // Locked tests changed outside a werkstatt session would otherwise become the new baseline.
  const { tampered } = project.locks();
  if (tampered.length) {
    return finish("aborted", "Locked acceptance tests were changed since they were locked:\n" +
      tampered.map((path) => `  ${path}`).join("\n") +
      "\nTo keep the change: werkstatt unlock <path> (it is locked again with its new content). " +
      "To undo it: git checkout -- <path>.");
  }
  const base = project.head();
  log("run", `Spec ${spec.id} – ${spec.title}`);

  // Phase 1: acceptance tests
  if (project.acceptanceTests(spec).length) {
    // Tests not written by the test-writer (or never locked) must be locked before anyone implements.
    const locked = project.lock();
    record.phases.push({
      name: "tests", verdict: "skipped", note: "Acceptance tests exist" + (locked.length ? `, now locked: ${locked.join(", ")}` : "."),
    });
  } else {
    const session = await runSession(project, "tests", testsPrompt(project, spec), testWriter(project, TESTS_SCHEMA), options);
    const result = session.structured as TestsResult | undefined;
    const tests = project.acceptanceTests(spec);
    const phase: Phase = { name: "tests", session, verdict: "ok", note: "" };
    record.phases.push(phase);
    if (!result?.ok || !tests.length) {
      // Partial tests would be locked and make the next run skip this phase.
      project.discard(tests);
      phase.verdict = "failed";
      phase.note = (result?.reason ?? session.finalText) + (tests.length ? `\n\nDiscarded test files: ${tests.join(", ")}` : "");
      return finish("aborted", `No acceptance tests for spec ${spec.id}:\n\n${phase.note}`);
    }
    log("tests", result.tests.map((t) => `${t.criterion} → ${t.test}`).join(" | "));
    const { locked } = project.locks();
    const unlocked = tests.filter((t) => !locked.includes(t));
    phase.note = `${tests.length} test file(s)` + (unlocked.length ? `, NOT locked: ${unlocked.join(", ")}` : ", locked.");
    if (unlocked.length) {
      phase.verdict = "failed";
      return finish("failed", `Acceptance tests were not locked – did the test-writer session end without its Stop hook?\n${unlocked.join("\n")}`);
    }
  }

  // Our own copy: the lock manifest lives in the project, where an agent could delete it.
  const tests = project.snapshot(project.acceptanceTests(spec));
  const before = await project.verify();
  if (before.ok) log("run", "verify is already green – the tests may check too little, or the spec is already implemented.");

  // Phase 2+3: implement, check, review – retried with the findings as feedback.
  // The user's answers to open review questions may add one more round.
  let feedback = "";
  let limit = options.maxAttempts;
  for (let attempt = 1; attempt <= limit; attempt++) {
    const of = `${attempt}/${limit}`;
    const session = await runSession(project, `impl ${of}`, implementPrompt(project, spec, feedback), implementer(project), options);
    const phase: Phase = { name: `implement-${attempt}`, session, verdict: "failed", note: "" };
    record.phases.push(phase);

    const tampered = project.restore(tests);
    if (tampered.length) project.lock();
    const verify = await project.verify();
    const problems = [
      tampered.length && `Locked acceptance tests were changed or deleted (restored): ${tampered.join(", ")}`,
      !verify.ok && `verify is red:\n${verify.output}`,
    ].filter(Boolean) as string[];
    if (problems.length) {
      phase.note = problems.join("\n\n");
      log("run", `Attempt ${attempt}: ${problems.map((p) => p.split("\n")[0]).join(" | ")}`);
      if (session.outcome !== "success") {
        return finish("failed", `Session ended with ${session.outcome}.\n\n${phase.note}`);
      }
      feedback = `${phase.note}\n\nLast message of the previous attempt:\n${session.finalText}`;
      continue;
    }
    phase.verdict = "ok";
    phase.note = "verify green, acceptance tests unchanged.";

    const reviewSession = await runSession(project, `review ${of}`, reviewPrompt(project, spec, base), reviewer(REVIEW_SCHEMA), options);
    const review = reviewSession.structured as Review | undefined;
    const report = review ? formatReview(spec, attempt, review) : reviewSession.finalText;
    const file = saveReview(project, record, attempt, report);
    record.phases.push({
      name: `review-${attempt}`, session: reviewSession, verdict: review?.verdict === "PASSED" ? "ok" : "failed", note: file,
    });
    if (!review) {
      return finish("failed", `The reviewer delivered no verdict (session: ${reviewSession.outcome}). Text: ${file}`);
    }
    if (review.verdict === "PASSED") {
      record.openQuestions = review.questions;
      if (review.questions.length && options.decide && !record.decisions.length) {
        const decisions = await options.decide(review.questions);
        record.decisions = decisions;
        record.openQuestions = decisions.filter((d) => d.kind === "later").map((d) => d.question);
        addDecisionsToSpec(project, spec, decisions);
        const changes = decisions.filter((d) => d.kind === "changed");
        if (changes.length) {
          limit = attempt + 1;
          feedback = "The user has decided open questions (see the \"Decisions\" section of the spec). " +
            "Adapt the implementation accordingly:\n\n" + changes.map((d) => `- ${d.question}\n  Decision: ${d.text}`).join("\n");
          log("run", `${changes.length} decision(s) require another round.`);
          continue;
        }
      }
      return finish("done", `Spec ${spec.id} implemented, verify green, review passed. Review: ${file}`);
    }
    log("run", `Attempt ${attempt}: the review requires rework.`);
    // A NEEDS_WORK without blocking findings still needs something to act on.
    const blocking = review.findings.filter((f) => f.blocking);
    const findings = blocking.length ? blocking : review.findings;
    feedback = `The review requires rework:\n\n${review.summary}\n\n` +
      findings.map((f) => `- ${f.location} (${f.reference}): ${f.problem}`).join("\n");
  }
  return finish("failed", `Not done after ${limit} attempts.\n\n${feedback}`);
}

/** Records the user's decisions in the spec, so later reviews don't raise them again. */
export function addDecisionsToSpec(project: Project, spec: Spec, decisions: Decision[]) {
  const decided = decisions.filter((d) => d.kind !== "later");
  if (!decided.length) return;
  const date = new Date().toISOString().slice(0, 10);
  const lines = decided.map((d) =>
    `- ${d.question}\n  **Decision (${date}):** ${d.kind === "confirmed" ? "As implemented." : d.text}`).join("\n");
  const path = join(project.root, spec.path);
  const text = readFileSync(path, "utf8").trimEnd();
  const heading = "## Decisions";
  const at = text.indexOf(`\n${heading}\n`);
  if (at < 0) {
    writeFileSync(path, `${text}\n\n${heading}\n\n${lines}\n`);
    return;
  }
  const next = text.indexOf("\n## ", at + heading.length + 1);
  const end = next < 0 ? text.length : next;
  writeFileSync(path, `${text.slice(0, end).trimEnd()}\n${lines}\n${text.slice(end)}\n`);
}

function testsPrompt(project: Project, spec: Spec): string {
  return `Derive the acceptance tests for spec ${spec.id}: ${spec.path}

Test directory: ${project.config.acceptanceTests}
Every file name contains: Spec${spec.id}
Verify command: ${project.config.commands.verify}`;
}

function implementPrompt(project: Project, spec: Spec, feedback: string): string {
  const tests = project.acceptanceTests(spec).map((t) => `- ${t}`).join("\n");
  return `Implement spec ${spec.id}: ${spec.path}

Locked acceptance tests:
${tests}

Verify command: ${project.config.commands.verify}
${feedback ? `\nThe current state has not been accepted yet. Feedback:\n\n${feedback}\n` : ""}`;
}

function reviewPrompt(project: Project, spec: Spec, base: string): string {
  const changed = project.dirtyFiles().map((line) => `- ${line}`).join("\n");
  return `Review the implementation of spec ${spec.id}: ${spec.path}

Base commit: ${base}
Changed files (git status):
${changed}

\`${project.config.commands.verify}\` is green, the acceptance tests are unchanged.`;
}

function formatReview(spec: Spec, attempt: number, review: Review): string {
  const findings = (blocking: boolean) =>
    review.findings.filter((f) => f.blocking === blocking)
      .map((f) => `- **${f.location}** (${f.reference}): ${f.problem}`).join("\n") || "- none";
  return `# Review spec ${spec.id}, attempt ${attempt}: ${review.verdict}

${review.summary}

## Findings that require rework
${findings(true)}

## Notes
${findings(false)}

## Open questions for the user
${review.questions.map((q) => `- ${q}`).join("\n") || "- none"}
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
