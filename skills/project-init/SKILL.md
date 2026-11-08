---
name: project-init
description: Sets up a project for working with coding agents and werkstatt – creates a basic skeleton in an empty directory, and adds only what's missing to existing projects (AGENTS.md, werkstatt.json, spec and acceptance test directories). Use when a project starts or is used with werkstatt for the first time.
argument-hint: "[short description of the project]"
---

# Project initialisation

Goal: after this skill, a coding agent can work in the project on its own – it knows
what the project is about, how to build and check it, where specs and acceptance tests
live, and a single command tells it whether everything is green.

Description from the user (optional): $ARGUMENTS

Talk to the user in the language they write in, and write `AGENTS.md` in that language.

## Result

| File / directory           | Purpose                                                       |
|----------------------------|---------------------------------------------------------------|
| `AGENTS.md`                | Context and rules for agents, based on [agents-template.md](agents-template.md) |
| `CLAUDE.md`                | Contains `@AGENTS.md`, so Claude Code uses the same source    |
| `werkstatt.json`           | Machine-readable settings for the werkstatt tools, based on [werkstatt-template.json](werkstatt-template.json) |
| `docs/specs/`              | Specs, one file per feature                                   |
| Acceptance test directory  | Tests derived from specs, path matching the stack             |
| Smoke test                 | At least one test, so the verify command checks something     |

## Procedure

### 1. Determine the starting point

Check the current directory:
- **Empty** (at most `.git`, a README or similar) → *new project*, continue with step 2a.
- **Code present** → *existing project*, continue with step 2b.
- If there is already a `werkstatt.json`, the project is set up: only check that
  everything still fits, and report deviations.

### 2a. New project

1. Ask (AskUserQuestion, one round): purpose of the project (unless given in
   `$ARGUMENTS`), stack, project/package name. Propose a stack if the user names none.
2. Generate the skeleton with the stack's **official generator** (e.g.
   `quarkus-maven-plugin:create`, Spring Initializr, `npm create vite`, `uv init`)
   instead of writing files by hand. Only the extensions needed to get started – more
   come later through specs.
3. Add a smoke test (e.g. a health endpoint or a trivial unit test).
4. `git init` if there is no repository yet. Don't commit.

### 2b. Existing project

Find out yourself, without asking:
- **Stack and build tool** from build files (`pom.xml`, `build.gradle*`, `package.json`,
  `pyproject.toml`, `go.mod`, `Cargo.toml`, …).
- **Verify command**: the one command that builds and runs all tests (prefer wrappers
  like `./mvnw`, `./gradlew`). If there are several candidates, the most comprehensive.
- **Run command** for the running application, if there is one.
- **Structure**: where production code and tests live, how packages are cut.
- **Conventions** that can be backed up: linter/formatter configuration, CI files,
  existing `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.editorconfig`.

Don't write conventions into `AGENTS.md` that you only suspect.

### 3. Run the verify command

Run the verify command once.
- **Green** → continue.
- **Red** → don't repair anything. Show the user what fails and ask whether to continue
  anyway. A red starting state goes into the summary.

### 4. Ask about what can't be determined

One round of AskUserQuestion, at most 4 questions, only about real gaps. Typically:
- Purpose of the project and the most important domain terms (for existing projects, if
  no README answers that).
- Where acceptance tests should live – with a proposal that fits the stack.
- Rules that aren't in the code (e.g. "no new dependencies without a reason", time zone
  handling, language of identifiers).

### 5. Write the files

- **Don't overwrite anything.** If `AGENTS.md` or `CLAUDE.md` already exists: add the
  missing sections and show the user the change.
- `CLAUDE.md`: if it doesn't exist, only `@AGENTS.md`; if it exists, add the line
  `@AGENTS.md` at the top if it's missing.
- `AGENTS.md` based on [agents-template.md](agents-template.md). Keep it short: agents
  read it for every task. What doesn't help to do a task right doesn't belong in it.
- `werkstatt.json` based on [werkstatt-template.json](werkstatt-template.json). All paths
  relative to the project root.
- Create empty directories with a `.gitkeep`.

### 6. Check and report

1. Run the verify command again – it must be in the same state as in step 3.
2. Summary in a few lines: what was created or added, the verify command and its result,
   open points.
3. Name the next step: specify the first feature with `/werkstatt:spec-interview`.
