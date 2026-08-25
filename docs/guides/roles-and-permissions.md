# Roles and permissions

## What it is

Deciding what each person can do. A **role** is a named set of
[capabilities](../reference/capabilities.md) owned by your team, and a
**folder share** is the same idea applied to one corner of the fleet.

## How it works

A capability is **one action**: `deploy_apps`, `delete_apps`, `manage_domains`,
`restore_backups`. There are 46 and they are deliberately not bundled, because
an administrator who can only grant "deploy and delete together" ends up
granting too much.

A role is a **row owned by your team**, not a fixed preset. Every team starts
with three you can rename, re-scope and later reset to what Deplo ships:

| Role       | Shipped as                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------- |
| **Owner**  | Full access, and **locked** there, so a team can never edit its way out of administering itself |
| **Member** | The normal working set                                                                          |
| **Viewer** | Read-only                                                                                       |

Editing a role **rewrites the capabilities of everyone holding it**, in the same
transaction. There is no separate "apply" step and no drift between what the
role says and what its members can do.

## Build a role

1. Open **Settings -> Roles**.
2. Click **New role**. It asks first whether to start blank or from an existing
   role.
3. Give it a **Name** and a **Description**.
4. Tick capabilities. There is a search box and browse categories, because
   forty-six checkboxes need both. Categories are for **finding** them: there is
   no category-level switch, on purpose.
5. Ones flagged **Sensitive** are the ones worth a second thought: deleting
   things, opening consoles, revealing secrets, managing tokens, managing roles.
6. Optionally turn on **Require two-factor authentication** for this role.
7. Save.

**Reset to default** restores a built-in role. **Delete role** removes one you
authored.

You cannot grant what you do not hold: capabilities beyond your own reach show
as **Out of reach** rather than pretending to be available.

## Give somebody one corner of the fleet

A role applies across the whole team. A **folder share** applies inside one
folder, and it **replaces** the team role's set there, and **may exceed it**.

That combination is the point. Somebody on **Viewer** can be the person who
deploys, configures and restarts everything inside `Marketing`, without gaining
any of that anywhere else.

1. On the Overview, open the folder's menu and choose **Share**.
2. Pick the member.
3. Choose what they get inside this folder.
4. **Change** edits an existing share, **Close** dismisses.

Most specific wins: a grant on a single app beats a grant on its folder, which
beats the team role. Members reached this way carry a **Limited access** badge
on the members list, because their role name no longer tells the whole story.

## The floor and the ceiling

- **`view`** is the always-on floor. Every member has it.
- **`instanceAdmin`** is not a team capability at all. It unlocks Servers, Users
  and the instance settings, and it is granted from the member's **Advanced**
  tab by another instance admin.
- **`canExposePorts`** and **`canMountHostVolumes`** are separate grants. The
  second one is the serious one: it covers every route out of a container, not
  just a bind mount. See
  [Host access and privileges](../advanced/host-access-and-privileges.md).

## Limits and gotchas

- **The interface only hides buttons.** The real check happens server-side
  before every write, and the API and the MCP server pass through the same code.
  A hidden button is not a security boundary and is not treated as one.
- **A role edit is immediate** for everyone holding it.
- **No edit may orphan the team.** `manage_members`, `manage_roles` and
  `manage_team` must always have a holder.
- **An id from another team resolves to nothing**, rather than to an error that
  would confirm it exists.
- **API tokens are capped by their creator.** A token can never do more than the
  person who made it can do **right now**, so narrowing somebody's role
  immediately narrows every token they minted.

## If it does not work

- **A capability is greyed out while editing a role** - you do not hold it
  yourself.
- **Somebody still cannot do the thing** - check for a folder share on that
  node, which replaces the team role there, and check whether the team requires
  two-factor.
- **They can do more than their role says** - a folder share is granting it.
  Their member page shows the scope tree.

## See also

- [Capabilities](../reference/capabilities.md) - all 46
- [Teams and capabilities](../concepts/teams-and-capabilities.md)
- [API tokens](../advanced/api-tokens-and-oauth.md)
- [`docs/adr/0016`](../adr/0016-a-node-capability-set-overrides-the-team-role-inside-that-node.md)
