# ADR-0021: The MCP server is a first-party route, not a plugin

- **Status**: Accepted - 2026-08-12.
- **Amends**: [ADR-0013](0013-plugins-are-deferred-and-the-mcp-plugin-is-withdrawn.md), decision 3
  ("the MCP plugin is withdrawn entirely"). That withdrawal stands: the _plugin_ is gone and is not
  coming back in that shape. This ADR records what replaces it and why the four objections that
  killed it do not apply to a route.
- **Builds on**: [ADR-0015](0015-an-api-token-is-a-principal-with-its-own-capabilities.md) - the
  MCP server introduces no credential of its own.
- **Constrains**: `lib/mcp/*`, `app/api/mcp/route.ts`, `app/(dashboard)/settings/mcp/*`.

## Context

Every AI coding agent now speaks the Model Context Protocol, and Deplo already has the API an agent
needs - 306 GraphQL root fields behind bearer tokens with 45 fine-grained Capabilities. What it did
not have was a way for an agent to _find_ them: every client had to hand-write GraphQL against a
4,000-line schema.

An MCP server shipped once, in August 2026, and was withdrawn eleven days before this one. It was a
**Plugin**: a relay container running on the control-plane host, installed from a catalog that
defaulted to a private dev box, reached through a nav entry every `manage_infra` holder saw on first
run. ADR-0013 named four reasons it did not hold up. None of them is about MCP:

| ADR-0013's objection                     | Why it does not apply here                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A settings surface on the first-run path | One entry inside `/settings`, gated on a Capability most members do not hold. Nothing on the first-run path, no nav section, no catalog.                           |
| Nobody was going to install it           | Nothing to install. The endpoint exists; connecting is one copied line.                                                                                            |
| The catalog defaulted to a private host  | There is no catalog and no outbound call.                                                                                                                          |
| The runtime owned the Docker socket      | No container and no socket. The route runs in the control plane and reaches hosts the way everything else does - `lib/data/*` → `connectAgent`, ADR-0006 unbroken. |

The remaining ADR-0013 constraint, "who is it for", is answered plainly: **the expert audience**,
behind an opt-in surface, off the first-run path - while the connect flow itself is built to the
non-expert bar, because copying one line is the whole product here.

## Decision

0. **It ships as BETA.** The chip on Settings → MCP Server is a promise about support, not a
   warning label: the endpoint works and is gated like everything else, but the protocol revision
   it targets is weeks old, the client ecosystem is still moving under it, and the tool surface
   will change as real use shows which of the seventy-six earn their place. Drop the chip when a
   revision of the spec has passed without breaking us.

1. **The MCP server is a first-party route at `/api/mcp`, speaking protocol revision 2026-07-28.**
   That revision is stateless (no session, no `initialize` handshake, no `Mcp-Session-Id`), which
   is why it fits a Next route handler with nothing kept between calls. The official v2 SDK
   (`@modelcontextprotocol/server`) owns every protocol mechanic; Deplo writes no JSON-RPC.

2. **A tool is data, and the data layer is still the only boundary.** Each of the 76 tools is a
   row in `lib/mcp/tools.ts`: a name, a zod schema and a GraphQL document. `lib/mcp/execute.ts`
   runs the document **in-process** against the same schema `/api/graphql` serves, inside
   `runWithIdentity`, with a real `GraphQLContext`. Every `authScopes` check, every
   `requireCapability`, every folder grant, the token scope clamp and the 2FA policy therefore
   apply unchanged and cannot drift. **There is no second authorization path, and there must never
   be one** - a check a tool needs belongs in `lib/data/*`, where the dashboard gets it too.

   Corollary, learned the expensive way: **never derive a tool's safety from `authScopes`.**
   `{ loggedIn: true }` sits on `deleteTeam` and on every folder mutation.

3. **No credential of its own.** An agent authenticates with an ordinary `deplo_` API token
   (ADR-0015), sent as `Authorization: Bearer`, with `X-Deplo-Team` selecting the team exactly as
   the GraphQL API does. "How do I take this access away" keeps having one answer: revoke the
   token. A stateless protocol also means there is nothing for a "switch team" tool to switch -
   one endpoint serves one team, chosen when the agent is connected.

4. **`reveal*` is never a tool, whatever the token holds.** This is the single deliberate exception
   to "the Capability decides", and it is not a hedge: a secret that reaches a model's context
   window has left Deplo for a third party's logs, and nobody can revoke it from there. Masked
   reads (`list_env`) are the whole story. A test enforces it rather than trusting the table.
   `execConsole` is excluded on the same footing - it is arbitrary code execution in a live
   container, which the token preset's own threat model calls "RCE by another name".

5. **One team switch, one new Capability, and no gate of Deplo's own.** `teams.mcp_enabled`,
   defaulting to **true**, governed by the new fine-grained Capability `manage_mcp` (migration 0099
   seeds it wherever `manage_tokens` already is: deciding whether an agent may drive the team is
   the same class of decision as minting the token that lets it in). That switch answers a question
   no token can - whether a company allows AI agents at all. **What an agent may DO is the token's
   Capabilities and nothing on top.**

   A per-team "ask before destructive actions" switch shipped first and was removed two commits
   later (migration 0100). It was a second permission system beside Capabilities, and a second one
   can only ever drift from the first: if an agent should not delete an App, the answer is to not
   grant `delete_apps`, not to grant it and then ask again at the door. Nothing is lost - every
   tool still advertises `destructiveHint` in `tools/list`, and MCP clients ask their own user
   before running one. The prompt still happens; it belongs to the only party that can render it.

6. **Bounded on purpose.** A rate limit keyed on the token (the bearer path never had one, and an
   agent in a loop is exactly the client that needs it), 50-item pages on list tools, and truncated
   log reads. An agent's context window is the scarce resource; a 50 MB log firehose helps nobody.

## Considered options

- **Revive the plugin**: rejected - it is the shape ADR-0013 withdrew, and the objections about the
  socket and the catalog are structural, not cosmetic.
- **One `graphql` passthrough tool** (query string in, JSON out): rejected as the _only_ surface -
  it never goes stale, but it makes the model author GraphQL against a 4,000-line schema, burns
  context on the SDL and produces bad errors on smaller models. Reconsider as an _additional_
  escape hatch if the curated set proves too narrow.
- **Generating tools from the schema** (`lib/graphql/introspect.ts` already lifts every field's
  description and scope): rejected - it would expose all 306 root fields, `reveal*` and
  `deleteTeam` included, and tool descriptions written for an API reference are not tool
  descriptions written for a model choosing between seventy-six of them.
- **OAuth 2.1 / Protected Resource Metadata**: deferred, not rejected. It is what claude.ai and
  ChatGPT web connectors require, and the spec's own `MUST` for a protected MCP server. Every CLI
  and IDE agent works with a header today, and standing up an authorization server next to Better
  Auth is a whole subsystem. The 401 already carries a `WWW-Authenticate: Bearer` challenge, so the
  discovery flow can be added without breaking a single existing client.
- **A per-token "allow MCP writes" switch**: rejected - a second permission system beside
  Capabilities, which would drift from them within two releases.

## Consequences

- `manage_mcp` makes 45 Capabilities 46. Migration 0098 backfills it from `manage_tokens` on
  `team_role_capabilities` and `membership_capabilities`, **not** the node-grant tables (it is
  team-wide, like the capability it is seeded from) and **not** `api_token_capabilities` (widening
  an existing secret is privilege escalation, not a backfill).
- `ActivityType` gains `mcp`, so "who let AI agents into this team, and when" is answerable in the
  Activity trail rather than in the database.
- `lib/data/logs-snapshot.ts` is new, and closes a real gap that predates MCP: the log SSE routes
  are cookie-only, so before this an API token holding `view_logs` could list containers and read
  nothing. A snapshot is also the right shape for a caller that wants an answer, not a
  subscription.
- The tool table must be kept valid against `schema.graphql`. `lib/mcp/tools.test.ts` validates
  every document against the generated SDL, which is how a renamed field becomes a failing test
  rather than every tool at once quietly answering "Cannot query field" - the exact failure mode
  `docs/api/graphql.md` had been living with.
- ADR-0013's `lib/plugins/*` remains dormant. Nothing here touches it, and the reserved
  `/plugins/<slug>` path is untouched.
