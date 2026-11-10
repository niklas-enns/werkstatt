<div align="center">

# werkstatt

**Spec-driven development with coding agents – with guardrails that hold.**

You decide *what* gets built. Agents build it.
Locked acceptance tests and an independent review make sure that what comes out is what the spec says.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-orange.svg)](https://github.com/niklas-enns/werkstatt/releases)
[![Claude Agent SDK](https://img.shields.io/badge/Claude-Agent%20SDK-d97757.svg)](https://code.claude.com/docs/en/agent-sdk)

</div>

---

*Werkstatt* is German for workshop.

## Why?

Coding agents write code fast. Everything around it is the hard part:

- **What exactly should be built?** Implicit knowledge, edge cases and business rules rarely make it into the ticket.
- **Is the result right?** An agent that writes its own tests likes to confirm itself – and when in doubt, it changes the test instead of the code.
- **Who checks?** Humans can't keep up with reading generated code.

werkstatt is the harness around the agent that closes these gaps: spec first, tests before code and locked against changes, deterministic checks outside the model, and a review with fresh eyes.

## How it works

```mermaid
flowchart LR
    setup["werkstatt init"] --> idea([Idea])
    idea --> interview["werkstatt spec"]
    interview --> spec[Spec with<br/>acceptance criteria]
    spec --> release{{You approve}}
    release --> run["werkstatt run"]

    subgraph run_box [Orchestrator · every phase its own agent session]
        direction LR
        tests[test-writer<br/>derives tests] --> lock[(Tests<br/>locked)]
        lock --> impl[implementer<br/>implements]
        impl --> verify{verify<br/>green?}
        verify -- no --> impl
        verify -- yes --> review[reviewer<br/>checks against spec]
        review -- needs work --> impl
    end

    run --> tests
    review -- passed --> done([Review the diff<br/>and commit])
```

0. **Set up** – `werkstatt init` prepares the project once: it finds out stack, verify command and structure, asks about the rest, and writes `AGENTS.md` and `werkstatt.json`.
1. **Specify** – `werkstatt spec` interviews you in the terminal: the **interviewer** asks about rules, edge cases, error cases and the interface until every acceptance criterion is unambiguously testable. It may only write Markdown in the spec directory – and never approve.
2. **Approve** – Only you set a spec to `approved`.
3. **Let it be implemented** – `werkstatt run` does the rest on its own:
   - The **test-writer** turns each acceptance criterion into an executable test. The tests are **locked**.
   - The **implementer** implements. It can't stop until `verify` is green – and it can't change the locked tests.
   - The **reviewer** checks the change independently against the spec and conventions. If something is wrong, its findings go into another round.
4. **Decide** – If the spec leaves something open, werkstatt asks you in the terminal at the end. Your decision is recorded in the spec.

Everything werkstatt and its agents produce is in English – the interview, specs, tests and reviews.

## What's inside

| Component | Kind | Job |
|---|---|---|
| `initializer` | Agent | Sets up a project: `AGENTS.md`, `werkstatt.json`, directories for specs and acceptance tests – in an empty directory also the project skeleton |
| `interviewer` | Agent | Turns a rough idea into a testable spec by interviewing you |
| `test-writer` | Agent | Derives black-box acceptance tests from the spec, one per criterion |
| `implementer` | Agent | Implements the spec until the locked tests are green |
| `reviewer` | Agent | Checks the implementation against the spec and `AGENTS.md`, with a structured verdict |
| Guard | Hooks in every session | Lock acceptance tests against changes, require a green `verify` from the implementer |
| `werkstatt` | Orchestrator (TypeScript, [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)) | The one entry point: `init` and `spec` talk with you in the terminal, `run` drives the phases, checks for itself, retries, asks, keeps a log |

## Quick start

### 1. Install werkstatt

```bash
git clone https://github.com/niklas-enns/werkstatt.git
cd werkstatt/orchestrator
npm install && npm run build && npm link
```

The `werkstatt` command is then available everywhere. It uses your Claude Code login or `ANTHROPIC_API_KEY` and loads the agents from its own checkout.

### 2. Get going

Everything happens in a terminal, in the target project:

```bash
werkstatt init
werkstatt spec "A person creates a poll to find a date, with several proposed dates"
```

`init` and `spec` talk with you: answer a question with an option's number or in your own words, and when the agent hands over, reply to ask for changes or press Enter to finish. `init` shows you every shell command that changes something (generators, `git init`, the verify command) before it runs.

Read the spec, set `status: approved` in its front matter, commit. Then:

```bash
werkstatt run 001
```

## The orchestrator in detail

All commands work in the current directory; `--project <dir>` points them at another one.

```
werkstatt init [description] [--budget <usd>] [--max-turns 150] [--model <id>]
```

The initializer finds out stack, verify command and structure, asks about what it can't find out, and writes `AGENTS.md`, `CLAUDE.md`, `werkstatt.json` and the directories – in an empty directory it first generates a skeleton with the stack's official generator. It may write inside the project but never replace an existing file; read-only shell commands run directly, every other one needs your approval (`y`, `a` for always, `n` or a reason). Afterwards werkstatt checks the setup itself and runs `verify`.

```
werkstatt spec <idea> [--budget <usd>] [--max-turns 150] [--model <id>]
```

The interview is one agent session that you take turns with. werkstatt shows the interviewer's questions in the terminal and decides its tool calls itself: reading is allowed, writing only to Markdown files in the spec directory, and a write that sets `status: approved` is denied. At the end it lists the specs that were written or changed.

```
werkstatt run <spec-id> [--attempts 2] [--budget <usd>] [--max-turns 150] [--model <id>] [--allow-dirty]
```

| Step | What happens | Who checks |
|---|---|---|
| Preconditions | Spec is `approved`, working tree is clean, locked acceptance tests are unchanged | Orchestrator |
| Acceptance tests | `test-writer` writes tests (file name contains `Spec<number>`) and reports which test checks which criterion – or stops if the spec isn't testable | Orchestrator: tests exist and are locked |
| Implementation | `implementer` implements | Stop hook: `verify` green (sends it back up to three times) · Orchestrator: tests unchanged, `verify` green |
| Review | `reviewer` delivers `PASSED` / `NEEDS_WORK`, findings and open questions | Orchestrator evaluates the structured verdict |
| Rework | Blocking findings become the task for the next round | until `--attempts` is reached |
| Open questions | In the terminal: **keep**, **decide differently** or **later** – decisions are recorded in the spec's "Decisions" section | you |

werkstatt never commits. Every run is logged to `.werkstatt/state/runs/` – phases, cost, turns and outcome as JSON, plus each review as a readable Markdown file.

The sessions of `run` don't ask you anything: file tools, the verify command and read-only shell and git commands are allowed – everything else is denied.

## The spec format

A spec is a Markdown file `docs/specs/NNN-<slug>.md` with front matter (`id`, `title`, `status: draft | approved`, `depends-on`) and the sections Goal, Terms, Rules, Interface, Acceptance criteria, Out of scope and Open questions. Each acceptance criterion has an ID (`AC-1`, …) and the form **Given** / **When** / **Then** with concrete values. The template is [`templates/spec-template.md`](templates/spec-template.md).

## Protecting the acceptance tests

werkstatt registers its hooks in every agent session it starts, as soon as the project has a `werkstatt.json`:

| Hook | Sessions | Effect |
|---|---|---|
| `PreToolUse` | all | Denies writes to locked acceptance tests, `.werkstatt/` and `werkstatt.json` – including obvious detours through the shell (`rm`, `sed -i`, redirections …) |
| `Stop` | `run` | Restores changed locked tests from the locked copy and locks new test files. In the implementation phase, `verify` must also be green – after three rejections the session may end anyway, since the orchestrator checks for itself |

Between sessions, `werkstatt run` checks before it starts: if a locked test was changed since it was locked, it stops and names the file.

Only humans can unlock:

```bash
werkstatt status              # show locked acceptance tests
werkstatt unlock Spec001      # unlock tests whose path contains "Spec001"
```

Good to know:

- **Unlock first, then change.** If you change a locked test by hand, the next `werkstatt run` refuses to start until you unlock it or undo the change.
- **Unlocking is temporary.** After `unlock`, the next `werkstatt run` locks the test again with its then-current content. That's how you fix a wrong test: unlock, change, carry on.
- **To have tests derived again:** unlock *and* delete the files. As long as a spec has tests, `werkstatt run` skips the test-writer phase.

`.werkstatt/locks/` belongs in the repository, so the locks apply to everyone. `.werkstatt/state/` ignores itself.

## Configuration

`werkstatt init` creates a `werkstatt.json` in the project:

```json
{
  "version": 1,
  "specs": "docs/specs",
  "acceptanceTests": "src/test/java/com/example/acceptance",
  "commands": {
    "verify": "./mvnw verify",
    "run": "./mvnw quarkus:dev"
  }
}
```

Context and conventions for the agents live in the project's `AGENTS.md`.

## Requirements and limits

**Requirements**
- A Claude login ([Claude Code](https://code.claude.com)) or `ANTHROPIC_API_KEY`
- Node.js ≥ 20, git
- In the target project: **one** command that builds and runs all tests

**A good fit** for backend and service projects whose behaviour can be tested from the outside through an interface (HTTP, CLI, public API).

**Not a good fit yet** for
- UI-heavy applications, data analysis or infrastructure code – the "acceptance test against an interface" pattern fits worse there
- several specs in progress at once – werkstatt works through one spec after the other
- decisions changed after the review: they are implemented and reviewed, but not backed by new acceptance tests

## Project structure

```
werkstatt/
├── agents/             initializer, interviewer, test-writer, implementer, reviewer
├── templates/          templates for spec, AGENTS.md and werkstatt.json
└── orchestrator/       the werkstatt command (TypeScript, Claude Agent SDK), incl. the guard hooks
```

Run the tests:

```bash
cd orchestrator && npm test
```

## Status

werkstatt is an early experiment (v0.2). The workflow works end to end on a sample project, but interfaces and file formats may still change. Feedback and issues are welcome.

**Upgrading from 0.1:** werkstatt is no longer a Claude Code plugin – `/werkstatt:project-init` and `/werkstatt:spec-interview` are now `werkstatt init` and `werkstatt spec`. Remove the old plugin with `/plugin uninstall werkstatt@werkstatt`, then pull and rebuild the orchestrator (`npm install && npm run build`). Existing locks in `.werkstatt/locks/` keep working.

Planned: analysis of the run logs (cost, attempts, review findings across several runs).

## License

[Apache License 2.0](LICENSE)
