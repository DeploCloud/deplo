# Teams and capabilities

## What it is

Deplo assumes several people share one instance and that whoever takes an action
is not the person who owns the box. Everything is scoped to a **team**, every
mutating action is checked against a **capability**, and a **role** is just a
named set of capabilities.

If you are the only person here, none of this gets in your way: your account
lands on the Owner role of your own team and holds everything.

## Team

An isolated workspace. It owns apps, domains, environment variables, databases,
backup destinations, registries, git connections, API tokens, activity, members
and notification settings. A person can belong to several teams and switches
between them from the top bar. The one you are looking at is the **active
team**, and every list you see is filtered by it.

**Servers are the single exception.** They are instance-wide infrastructure that
any team may be allowed to deploy to, never team-owned. Which teams may target a
given server is a setting on the server.

### The primary owner

The account that founded the team wears a crown. It is immutable to every other
hand: no other owner and no instance admin can remove, demote or edit them.

It transfers, from **Settings -> Members -> the member -> Advanced**, only by
the primary owner, only to a member of the same team, and only with their
password re-entered and their second factor. An API token can never do it.

## Capability

**One capability is one action.** `create_apps`, `deploy_apps`, `delete_apps`,
`open_app_console`, `restore_backups`, `manage_tokens`, and so on. There are 46
of them, catalogued with labels, descriptions and search keywords.

They are deliberately fine-grained. If a name would cover two actions an admin
might want to separate, it is two capabilities: deleting an app is
`delete_apps`, not `deploy_apps`. `view` is the always-on floor that everybody
holds.

Three grants sit slightly apart:

- **`instanceAdmin`** is instance-wide, not a team capability. It unlocks
  Servers, Users and the Deplo instance settings.
- **`canExposePorts`** allows publishing a port on the host.
- **`canMountHostVolumes`** allows every route out of a container: bind mounts,
  `privileged`, added kernel capabilities, devices, host namespaces, foreign
  networks and foreign volumes. See
  [Host access and privileges](../advanced/host-access-and-privileges.md).

The full list is in [Capabilities](../reference/capabilities.md).

## Role

A role is a **row owned by a team**, not a fixed preset. Every team gets three
defaults it can rename, re-scope and later reset to what Deplo ships: **Owner**,
**Member**, **Viewer**. You can author as many more as you like.

- **Owner is locked at full access**, so a team can never edit its way out of
  administering itself.
- **A role is its members' capabilities.** Editing one rewrites them for
  everyone holding it, in the same transaction.
- No edit may leave the team with nobody holding `manage_members`,
  `manage_roles` or `manage_team`.
- A member with no role carries a hand-picked **Custom** set.

## Access inside one folder

A capability set can also be attached to a **folder or a single app** instead of
the whole team. Inside that node it **replaces** the team role's set, and it
**may exceed it**. Most specific wins.

This is what makes real delegation possible: someone with a read-only team role
can be the person who deploys everything in one folder, without gaining that
power anywhere else.

## API tokens

A token is a **principal with its own capabilities**, not an impersonation of
the person who made it. You pick what it can do when you mint it, and you can
edit that later.

Its effective power is the live intersection of what it was granted and what its
creator can still do, so taking capabilities away from a person immediately
blunts every token they created. A token can be scoped to whole teams, whole
projects, whole folders or individual apps, and it can carry an expiry. It is
shown once, at creation, and only its hash is stored.

## Two-factor is a policy, not a capability

A team, or a role inside it, can **require** two-factor authentication. A member
who has not enrolled resolves nothing at all in that team: not in the dashboard,
not over the API, and their tokens resolve nothing either. They see a lock
screen with the option to enrol, switch team or sign out.

A passkey counts. Signing in with one satisfies the requirement for that
session, because it is a full sign-in method rather than a second step.

## The two gates

Every mutating action is checked twice, and only one of them matters.

- **In the interface**, capabilities hide or disable buttons. This is cosmetic.
- **In the data layer**, `requireCapability` runs before the write. This is the
  real boundary, and it is the one the API and the MCP server pass through too.

A resource that lives in a folder is checked a second time against that folder's
grant. An id belonging to another team resolves to nothing rather than to an
error that would confirm it exists.

## Instance admin and instance owner

**Instance admin** is a flat flag that unlocks the system-wide pages: Servers,
Users, and the instance settings. It is not a team capability and does not grant
team capabilities.

**Instance owner** is the tier above it, held by the account created at first-run
setup. No other admin can demote, suspend or reset the owner, and the owner
cannot drop their own admin flag. It transfers only by the owner, only to an
active instance admin, with the password re-entered. The only way back from a
locked-out owner is a command run on the host.

## See also

- [Teams and members](../guides/teams-and-members.md) - adding people
- [Roles and permissions](../guides/roles-and-permissions.md) - building a role, sharing a folder
- [Capabilities](../reference/capabilities.md) - all 46, by category
- [API tokens](../advanced/api-tokens-and-oauth.md)
