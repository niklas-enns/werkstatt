import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { converse, inside, targetPath, type ConversationResult } from "./conversation.js";
import { PLUGIN_ROOT, type Project } from "./project.js";
import type { SessionOptions } from "./session.js";
import { askQuestions, type Question } from "./terminal.js";

export interface InterviewResult extends ConversationResult {
  /** Spec files created or changed during the interview, relative to the project root. */
  specs: string[];
}

const TEMPLATE = join(PLUGIN_ROOT, "templates", "spec-template.md");

/**
 * Interviews the user in the terminal until a spec is written.
 * The orchestrator, not the agent, decides what may be written: Markdown in the spec directory.
 */
export async function interview(project: Project, idea: string, options: SessionOptions): Promise<InterviewResult> {
  const before = specFiles(project);
  const result = await converse(project.root, "werkstatt:interviewer", interviewPrompt(project, idea), decide(project), options);
  const after = specFiles(project);
  const specs = [...after].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path).sort();
  return { ...result, specs };
}

function interviewPrompt(project: Project, idea: string): string {
  return `Specify this idea:

${idea}

Spec directory: ${project.config.specs}

Spec template:

${readFileSync(TEMPLATE, "utf8")}`;
}

/** Answers AskUserQuestion in the terminal and allows writes only to Markdown in the spec directory. */
export function decide(project: Project): CanUseTool {
  const specDir = resolve(project.root, project.config.specs);
  return async (tool, input) => {
    if (tool === "Read") return { behavior: "allow", updatedInput: input };
    if (tool === "AskUserQuestion") {
      const answers = await askQuestions(input.questions as Question[]);
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    if (tool === "Write" || tool === "Edit") {
      const path = targetPath(project.root, input);
      if (!inside(specDir, path) || !path.endsWith(".md")) {
        return { behavior: "deny", message: `Only Markdown files in ${project.config.specs}/ may be written.` };
      }
      if (/^status:[ \t]*approved\b/m.test(String(input.content ?? input.new_string ?? ""))) {
        return { behavior: "deny", message: "Only the user approves a spec, by editing it themselves. Keep the status at draft." };
      }
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `${tool} is not available in the interview.` };
  };
}

/** Markdown files in the spec directory with their modification time. */
function specFiles(project: Project): Map<string, number> {
  const dir = join(project.root, project.config.specs);
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => [join(project.config.specs, name), statSync(join(dir, name)).mtimeMs]));
}
