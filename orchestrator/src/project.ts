import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const PLUGIN_ROOT = new URL("../../", import.meta.url).pathname;
const HOOK_SCRIPT = join(PLUGIN_ROOT, "hooks", "werkstatt.py");

export interface WerkstattConfig {
  specs: string;
  acceptanceTests: string;
  commands: { verify: string; run?: string | null };
}

export interface Spec {
  id: string;
  path: string;
  title: string;
  status: string;
}

/** Output of `werkstatt.py check`. */
export interface Locks {
  locked: string[];
  tampered: string[];
}

export class Project {
  constructor(readonly root: string, readonly config: WerkstattConfig) {}

  static load(root: string): Project {
    const file = join(root, "werkstatt.json");
    if (!existsSync(file)) {
      throw new Error(`Keine werkstatt.json in ${root} – zuerst /werkstatt:project-init ausführen.`);
    }
    return new Project(root, JSON.parse(readFileSync(file, "utf8")));
  }

  spec(id: string): Spec {
    const number = id.padStart(3, "0");
    const dir = join(this.root, this.config.specs);
    const file = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${number}-`) && f.endsWith(".md")) : undefined;
    if (!file) throw new Error(`Keine Spec ${number} in ${this.config.specs}/.`);
    const path = join(dir, file);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
    const field = (name: string) => new RegExp(`^${name}:\\s*([^#\\n]*)`, "m").exec(frontmatter)?.[1].trim() ?? "";
    return { id: number, path: relative(this.root, path), title: field("titel"), status: field("status") };
  }

  /** Acceptance test files belonging to a spec, identified by `Spec<NNN>` in the file name. */
  acceptanceTests(spec: Spec): string[] {
    const base = join(this.root, this.config.acceptanceTests);
    if (!existsSync(base)) return [];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    return walk(base)
      .filter((path) => basename(path).includes(`Spec${spec.id}`))
      .map((path) => relative(this.root, path));
  }

  verify(): { ok: boolean; output: string } {
    const r = spawnSync(this.config.commands.verify, { cwd: this.root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const lines = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n");
    return { ok: r.status === 0, output: lines.slice(-80).join("\n") };
  }

  locks(): Locks {
    return JSON.parse(execFileSync("python3", [HOOK_SCRIPT, "check"], { cwd: this.root, encoding: "utf8" }));
  }

  /** Uncommitted changes, ignoring werkstatt's own local state. */
  dirtyFiles(): string[] {
    return this.git("status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .filter((line) => line && !line.slice(3).startsWith(".werkstatt/state"));
  }

  head(): string {
    return this.git("rev-parse", "HEAD");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8" }).trimEnd();
  }
}
