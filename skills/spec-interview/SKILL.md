---
name: spec-interview
description: Turns a rough ticket or idea into a testable spec by interviewing the user. Use when a new feature should be specified before any code or tests exist.
argument-hint: <ticket text or feature idea>
---

# Spec interview

Your result is **one spec file** – no code, no tests. The user decides everything about
the domain; you ask the right questions and write it down cleanly.

Task: $ARGUMENTS

## Language

Run the interview in the language the user writes in, and write the spec's content in
that language. The format keywords stay in English exactly as in the template, because
werkstatt parses them: front matter keys and status values, section headings, AC IDs
and **Given** / **When** / **Then**.

## Procedure

1. **Read the context**
   - The project's `AGENTS.md` (or `CLAUDE.md`).
   - `werkstatt.json`: the spec directory is under `specs` (default `docs/specs`).
   - Existing specs in the spec directory, to learn terms, numbering and dependencies.
   - Code only as far as needed to avoid describing existing behaviour wrongly.

2. **Find the gaps** – go through the checklist below and note for yourself what the
   task leaves open. Don't make silent assumptions about the domain.

3. **Interview** – in rounds of at most 4 questions (AskUserQuestion), most important
   first.
   - Offer concrete answer options, with a recommendation if you have one.
   - Ask for examples with real values ("What happens if …?"), not for abstractions.
   - Stop when every acceptance criterion is unambiguously testable. Better one round
     fewer, collecting what's left under "Open questions".

4. **Write the spec** to `<spec directory>/NNN-<slug>.md` (next free number, three
   digits) based on [spec-template.md](spec-template.md). The status is always `draft`.

5. **Hand over** – summarise in a few lines what is specified, what remains open and
   what the user should check before approving. Only the user sets the status to
   `approved`. Then name exactly these next steps:
   1. Review the spec and set `status: approved` in its front matter.
   2. Commit.
   3. Run `werkstatt run <number>` in a terminal – the orchestrator derives the
      acceptance tests, implements and has the result reviewed.

   Don't offer to derive tests or to implement yourself – the orchestrator does that.

## Checklist

- **Goal**: Which problem does the feature solve, and for whom?
- **Actors and permissions**: Who may do what? What happens without permission?
- **Rules**: Limits, deadlines, state transitions, calculations.
- **Edge cases**: empty input, maximum values, ties, concurrency, time zones, points in
  time in the past.
- **Error cases**: What does the caller see on invalid input?
- **Interface**: Which calls trigger and observe the behaviour (e.g. endpoints,
  payloads, status codes)? Propose a concrete design that fits existing interfaces and
  have it confirmed – the acceptance tests are written against it.
- **Out of scope**: What is explicitly *not* part of this feature.

## Rules for acceptance criteria

- Every criterion has a stable ID (`AC-1`, `AC-2`, …) that tests refer to later.
- Form: **Given** … **When** … **Then** …, with concrete values.
- A criterion checks exactly one behaviour.
- Describe observable behaviour (interface, response, state), not the implementation.
- Every criterion can be checked using only the calls in the **Interface** section.
