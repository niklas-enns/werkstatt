---
id: NNN
title: <short title>
status: draft     # draft | approved
depends-on: []    # IDs of other specs
---

# NNN – <short title>

## Goal

<One to three sentences: which problem, for whom, why now.>

## Terms

- **<term>**: <meaning in this project>

## Rules

1. <business rule, phrased unambiguously>

## Interface

<How the behaviour is triggered and observed from the outside – concrete enough to write
acceptance tests against. E.g. for HTTP:>

| Call | Input | Response |
|------|-------|----------|
| `POST /…` | `{ … }` | `201`, `{ … }` |

<Error responses: status code and what the caller learns.>

## Acceptance criteria

### AC-1: <short name>
- **Given** <starting state with concrete values>
- **When** <action>
- **Then** <observable result>

## Out of scope

- <what is explicitly not part of this spec>

## Open questions

- <what the user still has to decide; empty if nothing is open>

<!-- The "## Decisions" section is appended by `werkstatt run` when the user answers
     open questions from the review. Don't create it by hand. -->
