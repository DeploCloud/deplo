# ADR-0032: An API token is personal, and a team governs it through the member

- **Status**: Accepted - 2026-09-04. Migration `0155`.
- **Amends**: [ADR-0015](0015-an-api-token-is-a-principal-with-its-own-capabilities.md)
  (the "home team" that could edit a token, and "any reaching team may revoke");
  [ADR-0021](0021-the-mcp-server-is-a-first-party-route-not-a-plugin.md) §5 (`manage_mcp`
  as the team switch's capability); [ADR-0022](0022-the-oauth-consent-screen-mints-an-api-token.md)
  §3-§4 (a connection defaults to the team it was approved from, and needs
  `manage_mcp` + `manage_tokens` in it) and its rejected "switch team" option.

## Context

A token had a home team (`api_tokens.team_id`): that team could edit it, any team it
reached could revoke it, and Settings → MCP Server listed every member's agents with a
Revoke button beside each. So a member could kill a colleague's credential, an admin
could re-author a token they did not own, and deleting the home team cascaded a
personal credential away. Meanwhile a connection minted by the consent screen or the
connect wizard reached exactly one team, so an agent that could see three teams was
told it had one and had "no way to switch".

## Decision

1. **A token belongs to the person who minted it.** `team_id` is dropped. Only its owner
   lists, edits or revokes it - an instance admin included. `apiTokens` answers your own
   tokens; a bearer request sees only the token it is made with.

2. **Where a token acts is the team's decision, per member, read live.** Two existing
   capabilities change meaning and label:
   - `manage_tokens` → **Use API tokens**: the member's tokens reach this team at all
     (`tokenReach`, read by the identity builder on every request).
   - `manage_mcp` → **Connect AI agents**: the member's tokens may drive this team over
     MCP (`listMcpTeams`, read at the MCP door and on every `team` argument).
     Any member may mint a token; it needs no capability of its own, because it can never
     exceed what its owner holds where it reaches (`ownerCeiling` at mint, `clampToToken`
     live). Losing `manage_tokens` in the last team stops the token resolving.

3. **A team takes access away through the member, never the token.** Remove them, or take
   a capability away. Settings → Members shows how many tokens and agents each member has
   reaching the team - counts only. Settings → MCP Server shows the agents connected as a
   number and offers no revoke; the "Connected clients" list is gone.

4. **The team's MCP switch is a team setting**: `setMcpSettings` needs `manage_team`,
   and lives in the menu beside the agents count. It is no longer what `manage_mcp` means.

5. **A new token or connection is unscoped by default**: every team where its owner may
   use tokens, now and later. The scope picker stays, as the way to narrow it.

6. **The `team` argument is advertised on every tool, always**, `list_teams` names every
   team the connection can act in and why one is off limits, and the server's own
   instructions say the argument is the switch. There is still no remembered team and no
   `switch_team` tool - ADR-0022's reasoning stands - but an agent is never left without
   the way to name one. A team named by argument is strict; the header keeps its lenient
   fallback.

7. **The trail lands in every team the token reaches.** Created, updated, revoked,
   connected over MCP: one entry per reached team, since no team sees the token itself.

## Consequences

- Tokens minted before this ADR keep working; they lose nothing but the home team. A
  token whose owner lacks `manage_tokens` in a team stops reaching it from the first
  request after the upgrade - which is the new rule applied, not a regression.
- The MCP tool table grows from 86 to 183 rows (structure, team, app and database
  settings, fleet, integrations, the panel), still one GraphQL document each.
