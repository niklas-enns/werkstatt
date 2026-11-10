import type { HookCallbackMatcher, HookEvent, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { Project } from "./project.js";

/** How often the verify gate sends the implementer back before letting the session end. */
export const MAX_VERIFY_BLOCKS = 3;

const MUTATING_SHELL = new RegExp([
  String.raw`\b(rm|mv|cp|truncate|tee|chmod|unlink|install)\b`,
  String.raw`\bsed\b[^|;&]*\s-i`,
  String.raw`\bperl\b[^|;&]*\s-[a-z]*i`,
  String.raw`\bgit\s+(checkout|restore|rm|mv|stash|reset|clean)\b`,
  String.raw`(^|[^0-9&<>])>{1,2}(?!&)`,
].join("|"));

/**
 * The reason to deny a tool call, or null to let it through: agents may not change locked
 * acceptance tests, werkstatt.json or .werkstatt/ – also not through obvious shell detours.
 */
export function denyReason(project: Project, tool: string, input: Record<string, unknown>): string | null {
  const { locked } = project.locks();
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    if (/\bwerkstatt\s+unlock\b/.test(command)) return "werkstatt: Only the user may unlock acceptance tests.";
    const touches = [project.acceptanceDir, ".werkstatt", "werkstatt.json"].filter((x) => command.includes(x));
    touches.push(...locked.filter((path) => command.includes(basename(path))));
    if (touches.length && MUTATING_SHELL.test(command)) {
      return `werkstatt: This command would change protected files (${[...new Set(touches)].sort().join(", ")}). ` +
        "Acceptance tests are not adapted to make them pass. If a test is wrong: stop and tell the user.";
    }
    return null;
  }
  const file = input.file_path ?? input.notebook_path;
  if (typeof file !== "string" || !file) return null;
  const path = relative(project.root, resolve(project.root, file));
  if (path.startsWith("..") || isAbsolute(path)) return null;
  if (path === "werkstatt.json" || path === ".werkstatt" || path.startsWith(".werkstatt/")) {
    return `werkstatt: ${path} is managed by werkstatt and locked for agents.`;
  }
  if (locked.includes(path)) {
    return `werkstatt: ${path} is a locked acceptance test. Change the implementation, not the test. ` +
      "If the test is wrong: stop and tell the user – only they can unlock it.";
  }
  return null;
}

/**
 * Hooks for werkstatt sessions. PreToolUse denies changes to protected files in every session;
 * the project is looked up on each call, because werkstatt.json may only come into being
 * during the session (werkstatt init).
 *
 * The Stop hook belongs to the sessions of `werkstatt run`: it restores tampered tests and
 * locks new ones. With verifyGate, the session may also only end once verify is green – at
 * most MAX_VERIFY_BLOCKS times, since the orchestrator checks verify itself and endless
 * blocking only burns turns.
 */
export function guard(
  root: string,
  mode: { stop: boolean; verifyGate?: boolean },
  report: (text: string) => void = () => {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  let blocks = 0;

  const preToolUse = async (input: { tool_name?: string; tool_input?: unknown }): Promise<HookJSONOutput> => {
    const project = Project.find(root);
    const reason = project && denyReason(project, input.tool_name ?? "", (input.tool_input ?? {}) as Record<string, unknown>);
    if (!reason) return {};
    report(`denied ${input.tool_name}: ${reason.split("\n")[0].slice(0, 160)}`);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  };

  const stop = async (): Promise<HookJSONOutput> => {
    const project = Project.find(root);
    if (!project) return {};
    const restored = project.restoreTampered();
    project.lock();
    if (restored.length) {
      report(`restored locked tests: ${restored.join(", ")}`);
      return {
        decision: "block",
        reason: "werkstatt: Locked acceptance tests were changed and have been restored:\n" +
          restored.map((path) => `- ${path}`).join("\n") +
          "\nChange the implementation, not the tests. If a test is wrong: explain why – only the user can unlock it.",
      };
    }
    if (!mode.verifyGate) return {};
    const { ok, output } = await project.verify();
    if (ok) {
      blocks = 0;
      return {};
    }
    const verify = project.config.commands.verify;
    if (++blocks > MAX_VERIFY_BLOCKS) {
      blocks = 0;
      report(`verify still red after ${MAX_VERIFY_BLOCKS} blocks – letting the session end`);
      return { systemMessage: `werkstatt: \`${verify}\` is still red after ${MAX_VERIFY_BLOCKS} blocks – the session may end.` };
    }
    report(`verify red – sent back (${blocks}/${MAX_VERIFY_BLOCKS})`);
    return {
      decision: "block",
      reason: `werkstatt: \`${verify}\` is red (${blocks}/${MAX_VERIFY_BLOCKS}). Fix the cause without touching ` +
        "acceptance tests. If you can't continue without a decision by the user, describe exactly what needs " +
        `to be decided.\n\n${output}`,
    };
  };

  return {
    PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [(input) => safely("PreToolUse", () => preToolUse(input as never))] }],
    // verify may take long; the orchestrator's own timeout applies inside Project.verify.
    ...(mode.stop ? { Stop: [{ hooks: [() => safely("Stop", stop)], timeout: 31 * 60 }] } : {}),
  };
}

/** A broken hook must not trap the session: report the error and let the agent continue. */
async function safely(name: string, hook: () => Promise<HookJSONOutput>): Promise<HookJSONOutput> {
  try {
    return await hook();
  } catch (error) {
    return { systemMessage: `werkstatt: hook ${name} failed: ${error instanceof Error ? error.message : error}` };
  }
}
