import { query, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute, relative, resolve } from "node:path";
import { loadAgents } from "./agents.js";
import { guard } from "./guard.js";
import { READ_ONLY, summarize, type SessionOptions } from "./session.js";
import { prompt } from "./terminal.js";

export interface ConversationResult {
  outcome: string;
  costUsd: number;
}

/**
 * An agent session the user takes turns with in the terminal: the agent works and asks
 * (AskUserQuestion goes through canUseTool), the user replies in free text, and an empty
 * reply ends the conversation. Read-only shell commands are allowed; canUseTool decides
 * every other tool call – including Read, since a bare "Read" rule would bypass it.
 */
export async function converse(
  root: string,
  agent: string,
  firstMessage: string,
  canUseTool: CanUseTool,
  options: SessionOptions,
): Promise<ConversationResult> {
  const result: ConversationResult = { outcome: "no_result", costUsd: 0 };
  let sessionId: string | undefined;
  let message = firstMessage;

  while (message) {
    const sdkOptions: Options = {
      cwd: root,
      agent,
      agents: loadAgents(),
      hooks: guard(root, { stop: false }, (text) => console.log(`  ! ${text}`)),
      settingSources: ["project", "local"],
      permissionMode: "default",
      allowedTools: READ_ONLY.filter((tool) => tool !== "Read"),
      canUseTool,
      model: options.model,
      maxBudgetUsd: options.maxBudgetUsd,
      maxTurns: options.maxTurns,
      resume: sessionId,
    };
    for await (const m of query({ prompt: message, options: sdkOptions })) {
      if (m.type === "assistant" && m.parent_tool_use_id === null) {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text.trim()) console.log(`\n${block.text.trim()}`);
          if (block.type === "tool_use" && block.name !== "AskUserQuestion") {
            console.log(`  · ${block.name} ${summarize(block.input)}`);
          }
        }
      }
      if (m.type === "result") {
        sessionId = m.session_id;
        result.outcome = m.subtype;
        result.costUsd += m.total_cost_usd;
      }
    }
    if (result.outcome !== "success") break;
    message = await prompt("\nYour reply (empty to finish) > ");
  }
  return result;
}

/** The path of a file tool call, resolved against root. */
export function targetPath(root: string, input: Record<string, unknown>): string {
  return resolve(root, String(input.file_path ?? ""));
}

/** True if path lies strictly inside dir. */
export function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
