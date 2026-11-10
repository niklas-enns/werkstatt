import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { converse, inside, targetPath, type ConversationResult } from "./conversation.js";
import { PLUGIN_ROOT, Project } from "./project.js";
import type { SessionOptions } from "./session.js";
import { askQuestions, prompt, type Question } from "./terminal.js";

export interface InitResult extends ConversationResult {
  /** What's wrong with the setup after the session; empty if it is complete. */
  problems: string[];
  verify?: { ok: boolean; output: string };
}

/** The user's answer to a shell command the agent wants to run. */
export interface Approval {
  allow: boolean;
  /** Allow this exact command for the rest of the session. */
  always?: boolean;
  /** Why not, passed on to the agent. */
  reason?: string;
}

const TEMPLATES = join(PLUGIN_ROOT, "templates");

/**
 * Sets up a project in the terminal. The agent may write inside the project but never
 * replace an existing file; every shell command that isn't read-only needs the user's approval.
 * Afterwards the orchestrator checks the setup itself and runs verify.
 */
export async function init(root: string, description: string, options: SessionOptions): Promise<InitResult> {
  const result = await converse(root, "werkstatt:initializer", initPrompt(description), decide(root, approveInTerminal), options);
  const { project, problems } = checkSetup(root);
  return { ...result, problems, verify: project?.verify() };
}

function initPrompt(description: string): string {
  const template = (name: string) => readFileSync(join(TEMPLATES, name), "utf8");
  return `Set up this project for werkstatt.

Description from the user: ${description || "(none)"}

Template for AGENTS.md:

${template("agents-template.md")}

Template for werkstatt.json:

${template("werkstatt-template.json")}`;
}

/** Answers AskUserQuestion, allows reads and writes inside the project, and asks about shell commands. */
export function decide(root: string, approve: (command: string) => Promise<Approval>): CanUseTool {
  const approved = new Set<string>();
  const written = new Set<string>();
  return async (tool, input) => {
    if (tool === "Read") return { behavior: "allow", updatedInput: input };
    if (tool === "AskUserQuestion") {
      const answers = await askQuestions(input.questions as Question[]);
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    if (tool === "Write" || tool === "Edit") {
      const path = targetPath(root, input);
      if (!inside(root, path) || [".git", ".werkstatt"].some((dir) => inside(join(root, dir), path))) {
        return { behavior: "deny", message: "Only files inside the project may be written, not in .git/ or .werkstatt/." };
      }
      if (tool === "Write" && existsSync(path) && !written.has(path)) {
        return { behavior: "deny", message: `${path} already exists – don't replace it, add to it with Edit.` };
      }
      if (tool === "Write") written.add(path);
      return { behavior: "allow", updatedInput: input };
    }
    if (tool === "Bash") {
      const command = String(input.command ?? "");
      if (approved.has(command)) return { behavior: "allow", updatedInput: input };
      const answer = await approve(command);
      if (!answer.allow) {
        return { behavior: "deny", message: `The user declined this command${answer.reason ? `: ${answer.reason}` : "."}` };
      }
      if (answer.always) approved.add(command);
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `${tool} is not available during setup.` };
  };
}

async function approveInTerminal(command: string): Promise<Approval> {
  console.log(`\nThe agent wants to run:\n  ${command.replace(/\n/g, "\n  ")}`);
  const answer = await prompt("  [y] yes   [a] always for this command   [n] no – or type why not > ");
  const choice = answer.toLowerCase();
  if (choice === "y" || choice === "yes") return { allow: true };
  if (choice === "a") return { allow: true, always: true };
  return { allow: false, reason: choice === "n" || choice === "no" || !answer ? undefined : answer };
}

/** Checks what werkstatt needs to work in the project, without trusting the agent's report. */
export function checkSetup(root: string): { project?: Project; problems: string[] } {
  if (!existsSync(join(root, "werkstatt.json"))) return { problems: ["werkstatt.json is missing."] };
  let project: Project;
  try {
    project = Project.load(root);
  } catch (error) {
    return { problems: [`werkstatt.json can't be read: ${error instanceof Error ? error.message : error}`] };
  }
  const { specs, acceptanceTests, commands } = project.config;
  const problems: string[] = [];
  const setting = (name: string, value: unknown) => {
    if (typeof value !== "string" || !value.trim() || /<[^>]*>/.test(value)) {
      problems.push(`werkstatt.json: "${name}" is not set.`);
      return false;
    }
    return true;
  };
  for (const [name, dir] of [["specs", specs], ["acceptanceTests", acceptanceTests]] as const) {
    if (setting(name, dir) && !existsSync(join(root, dir))) problems.push(`The directory ${dir}/ ("${name}") is missing.`);
  }
  setting("commands.verify", commands?.verify);
  if (!existsSync(join(root, "AGENTS.md"))) problems.push("AGENTS.md is missing.");
  const claude = join(root, "CLAUDE.md");
  if (!existsSync(claude) || !readFileSync(claude, "utf8").includes("@AGENTS.md")) {
    problems.push("CLAUDE.md doesn't import AGENTS.md (a line \"@AGENTS.md\").");
  }
  return problems.some((p) => p.includes("commands.verify")) ? { problems } : { project, problems };
}
