# MCP server

**Beta.**

## What it is

A way to let an AI agent drive your infrastructure: deploy an app, read logs,
check why a build failed, restart a database. It speaks the Model Context
Protocol, which is what Claude, ChatGPT and coding agents use to reach tools.

**Settings -> MCP**, visible to holders of `manage_mcp` or `manage_tokens`.

## How it works

The endpoint is `/api/mcp` on your own instance, and it exposes **78 tools**,
one per action. Each tool is a GraphQL document that runs **in-process against
the same schema** a browser session uses.

That is the whole security design: an agent goes through **the same
authorization code a person goes through**. There is no parallel permission
system to keep in sync, and no place for a check to be forgotten.

Two switches guard it:

- **A team switch**, off by default for a new team, deciding whether agents may
  drive this team at all.
- **A token**, because MCP has no credential of its own. An agent authenticates
  with an ordinary [API token](api-tokens-and-oauth.md), and **what it may do is
  that token's capabilities and nothing on top**.

## Connect an agent

1. Open **Settings -> MCP**, the **Connect** tab.
2. Pick the agent: **Claude**, **ChatGPT**, **Claude Desktop**, **Claude Code**,
   **Cursor**, **VS Code**, **Windsurf**, **Gemini CLI**, **Codex CLI**, or
   **Something else**.
3. Click **Turn on MCP for this team** if it is still off.
4. Click **Create token**. Start from a **Template** or pick capabilities
   yourself, and set an expiry.
5. Copy the configuration the page prints and paste it where that agent wants
   it.
6. Click **Check again** or **I have added it**. **Connect another** repeats for
   the next agent.

A web agent such as claude.ai or chatgpt.com does not take a pasted token.
It goes through the [OAuth consent screen](api-tokens-and-oauth.md) instead,
which mints an ordinary token after you approve it.

## See and revoke what is connected

The **Manage** tab lists **Connected clients** with a **Revoke** button, and
**What an agent can do** opens the full tool list, with destructive tools
flagged.

Revoking is immediate: the token is the access, so killing the token kills the
connection.

## What an agent can and cannot do

**Can**, if the token holds it: list and create apps, deploy, roll back, cancel,
start, stop and reload, bulk actions, environment variables, domains, databases,
logs, metrics, backups and restores, cron jobs, previews, projects, folders and
environments, members, activity, app files, and server actions including health,
readiness, agent updates, restarts and disk cleanup.

**Cannot, ever**: reveal a secret. No tool exposes one, whatever the token
holds.

Deplo adds **no confirmation step of its own**. Destructive tools are _flagged_
so the agent's own client can ask its user. If your agent does not ask, mint it
a token that cannot do the thing you would not want it doing.

## Limits and gotchas

- **Off by default for a new team.** A token alone was never what made this
  safe, but "may an AI act in this company's infrastructure" is a decision to
  make, not one to inherit.
- **A token acts in one team at a time**, chosen with a header, or on the
  consent screen for a web agent.
- **A token can never outgrow its creator.** Its power is the live intersection
  of what it was granted and what the person who made it can still do.
- **Scope it.** A token can be narrowed to one project, one folder or one app,
  which is a much better answer than trusting a prompt.
- **Everything is in the activity trail**, including who opened the door.

## If it does not work

- **The agent connects and sees no tools** - MCP is off for that team.
- **Every call is refused** - the token lacks the capability, or the team
  requires two-factor and its creator has not enrolled.
- **The agent cannot reach the endpoint** - your panel address must be reachable
  from wherever the agent runs. A local IDE agent needs a route to it.

## See also

- [API tokens](api-tokens-and-oauth.md)
- [Roles and permissions](../guides/roles-and-permissions.md)
- [API reference](../reference/api.md)
- [`docs/adr/0021`](../adr/0021-the-mcp-server-is-a-first-party-route-not-a-plugin.md)
