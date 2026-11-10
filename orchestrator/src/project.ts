import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The werkstatt checkout: agents/ and templates/ live here. */
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_TAIL = 80;

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

export interface Locks {
  locked: string[];
  /** Locked tests that were changed or deleted since they were locked. */
  tampered: string[];
}

/**
 * A project set up for werkstatt. Locked acceptance tests are recorded in
 * .werkstatt/locks/manifest.json ({path: sha256}) with a copy of each file under
 * .werkstatt/locks/files/ – the directory belongs in the repository.
 */
export class Project {
  constructor(readonly root: string, readonly config: WerkstattConfig) {}

  static load(root: string): Project {
    const project = Project.find(root);
    if (!project) throw new Error(`No werkstatt.json in ${root} – run "werkstatt init" first.`);
    return project;
  }

  /** The project in root, or undefined if root has no werkstatt.json (yet). */
  static find(root: string): Project | undefined {
    const file = join(root, "werkstatt.json");
    return existsSync(file) ? new Project(root, JSON.parse(readFileSync(file, "utf8"))) : undefined;
  }

  spec(id: string): Spec {
    const number = id.padStart(3, "0");
    const dir = join(this.root, this.config.specs);
    const file = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${number}-`) && f.endsWith(".md")) : undefined;
    if (!file) throw new Error(`No spec ${number} in ${this.config.specs}/.`);
    const path = join(dir, file);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
    const field = (name: string) => new RegExp(`^${name}:[ \\t]*([^#\\r\\n]*)`, "m").exec(frontmatter)?.[1].trim() ?? "";
    return { id: number, path: relative(this.root, path), title: field("title"), status: field("status") };
  }

  /** The acceptance test directory without a trailing slash. */
  get acceptanceDir(): string {
    return this.config.acceptanceTests.replace(/\/+$/, "");
  }

  /** All files in the acceptance test directory, relative to the root. */
  acceptanceFiles(): string[] {
    const base = join(this.root, this.acceptanceDir);
    if (!existsSync(base)) return [];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : name === ".gitkeep" ? [] : [path];
      });
    return walk(base).map((path) => relative(this.root, path)).sort();
  }

  /** Acceptance test files belonging to a spec, identified by `Spec<NNN>` in the file name, in any case. */
  acceptanceTests(spec: Spec): string[] {
    return this.acceptanceFiles().filter((path) => basename(path).toLowerCase().includes(`spec${spec.id}`));
  }

  async verify(): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.config.commands.verify, { cwd: this.root, shell: true, timeout: VERIFY_TIMEOUT_MS });
      let output = "";
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-256 * 1024);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const done = (ok: boolean, note?: string) => {
        const lines = output.split("\n");
        if (note) lines.push(`werkstatt: verify aborted – ${note}`);
        resolve({ ok, output: lines.slice(-OUTPUT_TAIL).join("\n") });
      };
      child.on("error", (error) => done(false, error.message));
      child.on("close", (code, signal) => done(code === 0, signal ? `killed by ${signal}` : undefined));
    });
  }

  // --- locks ---------------------------------------------------------------

  private get locksDir(): string {
    return join(this.root, ".werkstatt", "locks");
  }

  private manifest(): Record<string, string> {
    const file = join(this.locksDir, "manifest.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  private saveManifest(manifest: Record<string, string>) {
    mkdirSync(this.locksDir, { recursive: true });
    const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(this.locksDir, "manifest.json"), JSON.stringify(sorted, null, 2) + "\n");
  }

  private lockedCopy(path: string): string {
    return join(this.locksDir, "files", path);
  }

  locks(): Locks {
    const manifest = this.manifest();
    const tampered = Object.entries(manifest)
      .filter(([path, digest]) => {
        const file = join(this.root, path);
        return !existsSync(file) || sha256(file) !== digest;
      })
      .map(([path]) => path);
    return { locked: Object.keys(manifest), tampered };
  }

  /** Locks acceptance tests that aren't locked yet; returns the newly locked paths. */
  lock(): string[] {
    const manifest = this.manifest();
    const fresh = this.acceptanceFiles().filter((path) => !(path in manifest));
    for (const path of fresh) {
      mkdirSync(dirname(this.lockedCopy(path)), { recursive: true });
      copyFileSync(join(this.root, path), this.lockedCopy(path));
      manifest[path] = sha256(join(this.root, path));
    }
    if (fresh.length) this.saveManifest(manifest);
    return fresh;
  }

  /** Unlocks locked tests whose path contains one of the given parts; returns their paths. */
  unlock(...parts: string[]): string[] {
    const manifest = this.manifest();
    const hits = Object.keys(manifest).filter((path) => parts.some((part) => path.includes(part)));
    for (const path of hits) {
      delete manifest[path];
      rmSync(this.lockedCopy(path), { force: true });
    }
    if (hits.length) this.saveManifest(manifest);
    return hits;
  }

  /** Restores tampered locked tests from their locked copy; returns their paths. */
  restoreTampered(): string[] {
    const { tampered } = this.locks();
    for (const path of tampered) {
      mkdirSync(dirname(join(this.root, path)), { recursive: true });
      copyFileSync(this.lockedCopy(path), join(this.root, path));
    }
    return tampered;
  }

  /** Unlocks and deletes acceptance test files, e.g. after an aborted test phase. */
  discard(paths: string[]) {
    if (!paths.length) return;
    this.unlock(...paths);
    for (const path of paths) rmSync(join(this.root, path), { force: true });
  }

  /** Copies of files, independent of the lock manifest that agents could tamper with. */
  snapshot(paths: string[]): Map<string, Buffer> {
    return new Map(paths.map((path) => [path, readFileSync(join(this.root, path))]));
  }

  /** Restores files that differ from the snapshot or are missing; returns their paths. */
  restore(snapshot: Map<string, Buffer>): string[] {
    const restored: string[] = [];
    for (const [path, content] of snapshot) {
      const file = join(this.root, path);
      if (existsSync(file) && readFileSync(file).equals(content)) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      restored.push(path);
    }
    return restored;
  }

  // --- git -----------------------------------------------------------------

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

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
