import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { PLUGIN_ROOT, type Project } from "./project.js";

export interface SessionOptions {
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
}

export interface SessionResult {
  sessionId: string | null;
  outcome: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  finalText: string;
}

const READ_ONLY_GIT = ["status", "diff", "log", "show", "ls-files"].map((cmd) => `Bash(git ${cmd} *)`);

/**
 * Tools the agent may use without a human present. Everything else is denied
 * (permission mode `dontAsk`), so a run never hangs on a permission prompt.
 */
function allowedTools(project: Project): string[] {
  const verify = project.config.commands.verify;
  const program = verify.split(/\s+/)[0];
  return [
    "Read", "Glob", "Grep", "Write", "Edit", "MultiEdit", "Agent", "Task", "TodoWrite",
    `Bash(${verify})`, `Bash(${program} *)`,
    ...READ_ONLY_GIT,
    "Bash(ls *)", "Bash(cat *)", "Bash(find *)", "Bash(grep *)", "Bash(head *)", "Bash(tail *)",
  ];
}

export async function runSession(
  project: Project,
  label: string,
  prompt: string,
  options: SessionOptions,
): Promise<SessionResult> {
  log(label, "Start");
  const started = Date.now();
  let result: SessionResult = {
    sessionId: null, outcome: "no_result", costUsd: 0, turns: 0, durationMs: 0, finalText: "",
  };

  const messages = query({
    prompt,
    options: {
      cwd: project.root,
      plugins: [{ type: "local", path: PLUGIN_ROOT }],
      skills: "all",
      settingSources: ["project", "local"],
      permissionMode: "dontAsk",
      allowedTools: allowedTools(project),
      systemPrompt: { type: "preset", preset: "claude_code", append: UNATTENDED },
      model: options.model,
      maxBudgetUsd: options.maxBudgetUsd,
      maxTurns: options.maxTurns,
    },
  });

  for await (const message of messages) {
    report(label, message);
    if (message.type === "result") {
      result = {
        sessionId: message.session_id,
        outcome: message.subtype,
        costUsd: message.total_cost_usd,
        turns: message.num_turns,
        durationMs: Date.now() - started,
        finalText: message.subtype === "success" ? message.result : "",
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
