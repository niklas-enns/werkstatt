import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./project.js";

const AGENTS_DIR = join(PACKAGE_ROOT, "agents");

/**
 * The agents in agents/*.md: front matter with name, description and a comma-separated
 * tools list (lines starting with # are comments), followed by the system prompt.
 */
export function loadAgents(dir = AGENTS_DIR): Record<string, AgentDefinition> {
  return Object.fromEntries(readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => parseAgent(readFileSync(join(dir, file), "utf8"), file)));
}

export function parseAgent(text: string, file: string): [string, AgentDefinition] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: front matter missing.`);
  const fields = new Map(match[1].split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const;
    }));
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) throw new Error(`${file}: name and description are required.`);
  const tools = fields.get("tools")?.split(",").map((tool) => tool.trim()).filter(Boolean);
  return [name, { description, prompt: match[2].trim(), ...(tools ? { tools } : {}) }];
}
