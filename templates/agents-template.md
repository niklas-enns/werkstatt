# AGENTS.md – <project name>

This document is for coding agents. It describes what the project is, how to build and
check it, and which rules apply.

## What is it about?

<Two to four sentences: what the system does and for whom.>

Business requirements live **exclusively** in `<spec directory>/`. Whatever isn't there
hasn't been requested. When in doubt: ask instead of guessing.

## Build and check

| Purpose                  | Command             |
|--------------------------|---------------------|
| Build and run all tests  | `<verify command>`  |
| Start the application    | `<run command>`     |
| <more, if useful>        | `<…>`               |

A task is only done when `<verify command>` is green.

## Structure

- `<spec directory>/` – specs, one file per feature. Only humans approve specs.
- `<acceptance test directory>/` – acceptance tests, derived from specs.
  **Don't change them** to make them pass. If an acceptance test seems wrong: stop and
  report it.
- `<production code>/` – production code.
- <other important places>

## Conventions

- <language, framework version, central libraries>
- <rules backed up by linter, CI, existing docs, or named by the user>
