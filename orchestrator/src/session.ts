import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { PLUGIN_ROOT, type Project } from "./project.js";

export interface SessionOptions {
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
}

/** What distinguishes the phases: who works, with which tools, in which mode. */
export interface Role {
  /** Plugin agent for the main thread, e.g. `werkstatt:reviewer`. */
  agent?: string;
  tools: string[];
  /** Value of WERKSTATT_PHASE, read by the stop hook. */
  phase?: string;
  /** JSON schema the session's final answer must match. */
  outputSchema?: Record<string, unknown>;
}

export interface SessionResult {
  sessionId: string | null;
  outcome: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  finalText: string;
  structured?: unknown;
}

const READ_ONLY = [
  "Read", "Glob", "Grep",
  ...["status", "diff", "log", "show", "ls-files"].map((cmd) => `Bash(git ${cmd} *)`),
  "Bash(ls *)", "Bash(cat *)", "Bash(find *)", "Bash(grep *)", "Bash(head *)", "Bash(tail *)",
];

export function reviewer(outputSchema: Record<string, unknown>): Role {
  return { agent: "werkstatt:reviewer", tools: READ_ONLY, outputSchema };
}

/** File tools, subagents, the verify command and its build tool, plus read-only shell. */
export function builder(project: Project, phase?: string): Role {
  const verify = project.config.commands.verify;
  const program = verify.split(/\s+/)[0];
  return {
    phase,
    tools: [...READ_ONLY, "Write", "Edit", "MultiEdit", "Agent", "Task", "TodoWrite", `Bash(${verify})`, `Bash(${program} *)`],
  };
}

export async function runSession(
  project: Project,
  label: string,
  prompt: string,
  role: Role,
  options: SessionOptions,
): Promise<SessionResult> {
  log(label, "Start");
  const started = Date.now();
  let result: SessionResult = {
    sessionId: null, outcome: "no_result", costUsd: 0, turns: 0, durationMs: 0, finalText: "",
  };

  const sdkOptions: Options = {
    cwd: project.root,
    plugins: [{ type: "local", path: PLUGIN_ROOT }],
    skills: "all",
    settingSources: ["project", "local"],
    // Nobody is there to answer a permission prompt: anything not listed is denied.
    permissionMode: "dontAsk",
    allowedTools: role.tools,
    env: { ...process.env, ...(role.phase ? { WERKSTATT_PHASE: role.phase } : {}) },
    model: options.model,
    maxBudgetUsd: options.maxBudgetUsd,
    maxTurns: options.maxTurns,
  };
  if (role.outputSchema) sdkOptions.outputFormat = { type: "json_schema", schema: role.outputSchema };
  if (role.agent) sdkOptions.agent = role.agent;
  else sdkOptions.systemPrompt = { type: "preset", preset: "claude_code", append: UNATTENDED };

  for await (const message of query({ prompt, options: sdkOptions })) {
    report(label, message);
    if (message.type === "result") {
      result = {
        sessionId: message.session_id,
        outcome: message.subtype,
        costUsd: message.total_cost_usd,
        turns: message.num_turns,
        durationMs: Date.now() - started,
        finalText: message.subtype === "success" ? message.result : "",
        structured: message.subtype === "success" ? message.structured_output : undefined,
      };
    }
  }
  log(label, `Ende: ${result.outcome}, ${result.turns} Turns, $${result.costUsd.toFixed(2)}`);
  return result;
}

const UNATTENDED = `
Du arbeitest unbeaufsichtigt im werkstatt-Orchestrator. Niemand beantwortet Rückfragen.
Wenn du ohne eine Entscheidung des Nutzers nicht weiterkommst (z. B. die Spec ist
unklar oder ein Akzeptanztest widerspricht ihr), hör auf und beschreibe in deiner
letzten Nachricht genau, was entschieden werden muss.`;

function report(label: string, message: SDKMessage) {
  if (message.type === "assistant" && message.parent_tool_use_id === null) {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim()) log(label, block.text.trim().split("\n")[0]);
      if (block.type === "tool_use") log(label, `→ ${block.name} ${summarize(block.input)}`);
    }
  }
  if (message.type === "system" && message.subtype === "hook_response" && message.output.includes("werkstatt")) {
    log(label, `[hook ${message.hook_event}] ${message.output.trim().slice(0, 200)}`);
  }
}

function summarize(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.file_path ?? record.pattern ?? record.subagent_type ?? record.skill ?? "";
  return String(value).split("\n")[0].slice(0, 100);
}

export function log(label: string, text: string) {
  const time = new Date().toLocaleTimeString("de-DE");
  console.log(`${time} [${label}] ${text}`);
}
