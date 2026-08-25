# API tokens

## What it is

A credential for scripts, CI, an [MCP agent](mcp-server.md) or anything else
that talks to Deplo without a browser.

**Settings -> Tokens**.

## How it works

A token is **a principal with its own capabilities**, not an impersonation of
the person who made it. You choose what it can do when you mint it, and you can
change that afterwards without reissuing it.

Its **effective** power is the live intersection of two things:

```
what the token was granted   AND   what its creator can still do
```

So removing somebody's capabilities immediately blunts every token they created,
and removing them from the team blunts them completely. There is no forgotten
credential quietly holding powers its owner lost a year ago.

The secret is shown **once**, at creation. Only its hash is stored.

## Create one

1. **Settings -> Tokens**, then **New token**.
2. **Start from a template** or **Start from scratch**. The templates, least
   powerful first:

   | Template             | For                       |
   | -------------------- | ------------------------- |
   | **Read only**        | Dashboards and reporting  |
   | **Deploy hook & CI** | A pipeline that deploys   |
   | **MCP & AI agents**  | An agent driving the team |
   | **Root access**      | Everything you can do     |

   Everything stays editable on the next step.

3. Name it, and set an expiry. **A new token defaults to 90 days**, and
   **Never** is available if you accept what that means.
4. Tick the capabilities. Sensitive ones are marked.
5. Set the **scope**, which is a tree: whole **Teams**, whole **Projects**,
   whole **Folders** (subtrees included) or individual **Apps**. Ticking nothing
   means every team you belong to.
6. Instance admins may also set the **Instance admin** bit, which is mutually
   exclusive with a scope.
7. Copy the token. You will not see it again.

## Use one

Send it as a bearer token, and name the team you are acting in:

```bash
curl -s https://deplo.example.com/api/graphql \
  -H "Authorization: Bearer deplo_xxxxxxxxxxxxxxxxxxxx" \
  -H "X-Deplo-Team: team_1a2b3c" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ apps { id name status } }"}'
```

A bearer request acts in **one** team. The full surface is in the
[API reference](../reference/api.md).

## Scope, and the rule that surprises people

**Naming a project or an app drops every team-wide capability in that team.**

That is deliberate. A token scoped to one app should not also be able to manage
the team's members, and a scope that silently kept team-level powers would be a
scope in name only.

If you need both, mint two tokens.

## Connected clients and OAuth

A web AI application (claude.ai, chatgpt.com) cannot be handed a pasted token,
so Deplo acts as an OAuth authorization server for exactly this one purpose.

Approving on the consent screen **mints an ordinary API token** with the team,
capabilities and scope you picked there. The access token the client holds is
only a pointer at that row, which means:

- It appears in **Settings -> Tokens**, marked as such.
- Revoking it there stops the client immediately.
- The OAuth _scopes_ decide nothing. The token's capabilities do.

Approving needs both `manage_mcp` and `manage_tokens`.

## Expiry

`api_tokens.expires_at` is checked **before the team is picked and before the
membership is read**, so one comparison covers GraphQL, MCP and the deploy hook
at once.

Nothing sweeps an expired token away, on purpose: the list has to be able to
tell you _why_ a credential stopped working.

Tokens minted before expiry existed have none, and stay that way until you edit
them.

## Limits and gotchas

- **Shown once.** Lost means revoke and mint again.
- **A token cannot transfer team ownership.** That action needs a human with a
  password and a second factor.
- **A token cannot reveal a secret** through MCP, whatever it holds.
- **Two-factor policy applies.** If the team requires it and the token's creator
  has not enrolled, the token resolves nothing.
- **Any team the token reaches can revoke it**, not just the team it was created
  in.

## If it does not work

- **401** - missing, revoked, or expired.
- **403 on one field** - the token lacks that capability, or the scope excludes
  that resource.
- **It worked yesterday** - its creator's capabilities changed, it expired, or
  the team turned on two-factor.

## See also

- [API reference](../reference/api.md)
- [MCP server](mcp-server.md)
- [Automatic deployments](../guides/automatic-deployments.md) - the deploy hook uses one
- [`docs/adr/0015`](../adr/0015-an-api-token-is-a-principal-with-its-own-capabilities.md)
