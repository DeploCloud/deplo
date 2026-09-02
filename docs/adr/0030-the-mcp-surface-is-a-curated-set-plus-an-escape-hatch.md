# ADR-0030: The MCP surface is a curated set plus an escape hatch

- **Status**: Accepted - 2026-09-02.
- **Amends**: [ADR-0021](0021-the-mcp-server-is-a-first-party-route-not-a-plugin.md). Its
  "Considered options" rejected a `graphql` passthrough _as the only surface_ and left it open
  "as an _additional_ escape hatch if the curated set proves too narrow". This takes that option.
  Its counts (76 tools, 306 root fields) are stale; the numbers live in the table and the schema,
  not here.

## Context

The curated set reached 78 tools against ~350 GraphQL root fields, so an agent could not do what a
person can. Two symptoms were reported: **an agent picking the wrong tool**, and **context cost**.
Both were blamed on the tool count. Measured, one of those is wrong.

A `tools/list` for a token holding every Capability was **56,858 characters, about 15,400 tokens**.
The largest single line item was not a tool: it was the optional `team` argument, added centrally
to every row, at **12,024 characters - 21% of the payload** - for an argument that has exactly one
legal value on a connection granted one team. Emitting `readOnlyHint` and `idempotentHint` when
they already default to `false`, and the tool's `title` twice, accounted for thousands more.

So the count is not what context costs. What the count does explain is the wrong-tool picking: the
table held families that differed only in which id they took (`app_metrics` / `database_metrics` /
`server_metrics`), which is the shape a model gets wrong.

## Decision

1. **A merge needs the same Capability AND the same `destructive` flag.** `app_metrics` and its two
   siblings become `metrics(kind, id)`; `set_database_running` and `restart_database` become
   `control_database(action)`. `stop_app` does NOT join `control_app`, and `bulk_app_action` joins
   nothing: they are `destructive`, and a merged tool inherits the strictest hint it contains, so
   folding them in would make an MCP client prompt before every `start`. A hint that fires on a
   harmless action is a hint people learn to click through.

2. **A merged tool branches with `@include(if:)` on one document, and its `variables` mapper must
   throw on a combination that lights nothing.** With every branch off, `execute` answers `{}` with
   no errors, which reads to a model as success. The refusal has to happen before the document runs.
   Variable coercion runs over every declared variable regardless of `@include`, so a placeholder
   for an unused branch must be a real value - and a non-null input object may only be one where the
   input type has no required fields.

3. **The escape hatch is TWO tools, `graphql_query` and `graphql_mutate`.** One tool covering both
   could not carry an honest `destructiveHint`, and ADR-0021's whole answer to "no confirmation step
   of Deplo's own" rests on that hint being true. Splitting also pins the operation kind, which is
   what keeps a subscription - which would otherwise execute here with no transport - out.

4. **The passthrough refuses a root field that returns a credential or runs a command, derived from
   the schema and read off the AST.** ADR-0021 rule 4 was enforced by a regex over the tool table;
   a document the caller writes walks straight past it. The `reveal*` family is derived (`/^reveal[A-Z]/`
   over the root types) so a new one is refused the day it lands, plus a short list of irregulars -
   `execConsole`, `createToken`, `reissueServerBootstrap` and the rest. It is judged on the PARENT
   TYPE, so a field named `login` on some object stays readable. `deleteTeam` and `deleteApp` pass:
   those are the token's Capabilities, and the client asks.

5. **The passthrough carries `/api/graphql`'s own limits and its validation.** `maxDepthRule(12)`,
   `maxAliasesRule(30)`, `costLimitRule(5000)` - the rule exports of the armor packages already in
   the tree, at the numbers `lib/graphql/yoga.ts` uses. And `validate()`, which the constant
   documents never needed: unvalidated, graphql-js drops an unknown field silently, so a misspelling
   comes back as `{"apps":[{}]}` rather than "Cannot query field".

6. **`team` is advertised only to a connection granted more than one team, and accepted always.**
   Advertising is what costs tokens; accepting costs nothing and is what lets a single-team
   connection that names another team hear "no access to that team" instead of "no such argument".

## Consequences

- A `view`-only token now SEES `graphql_mutate` and can attempt a write, which the data layer
  refuses exactly as before. ADR-0021's "filtering is cosmetic, the data layer is the boundary"
  still holds, but the incidental property that a model never saw what it could not do is gone.
  There is no Capability meaning "may write", so there is no honest `requires` for it.
- `lib/mcp/tools.test.ts`'s reveal/exec scan covers the table only. The passthrough's guard is
  covered by its own tests in `lib/mcp/execute.test.ts`, and that is now where rule 4 is enforced.
- The parsed-document memo in `execute.ts` stays a memo of the constants: a caller's document is
  handed to `runGraphql` already parsed, never keyed into the map.
- Descriptions are capped at 220 characters by a test. The list is read whole, by a model, on every
  connection.
