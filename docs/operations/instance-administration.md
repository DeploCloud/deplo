# Instance administration

## What it is

The instance-wide surfaces: user accounts across every team, the instance's own
settings, and who owns the whole thing.

Only **instance admins** see these pages, and instance admin is a flag on an
account, not a team capability.

## Users

**Settings -> Users**.

| Action           | What it does                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| **Manage users** | The full list, with Admin, Owner and Suspended badges                                                  |
| **Manage user**  | Open one account: suspend, reset the password, promote to instance admin                               |
| Register a user  | Mints a single-use **registration link**. It works once and expires in 24 hours. You share it yourself |
| Pending links    | Reveal or **Revoke** a link before it is used                                                          |
| Delete a user    | Shows an impact preview first, since a person owns things                                              |

Deplo sends no email of its own, which is why account creation is a link you
hand over rather than an invitation it mails.

A person who registers through a link lands in **their own team**. Adding them
to yours is a separate step in **Settings -> Members**.

## Instance settings

**Settings -> Deplo**.

| Setting                       | What it does                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Panel address**             | Where the dashboard answers. See [The panel's own address](panel-address-and-certificates.md)                         |
| **Certificate account email** | The address Let's Encrypt has for this instance                                                                       |
| **Max log range**             | The ceiling on how far back log queries may reach. Default 7 days, 1 to 90                                            |
| Gravatar                      | Whether profile pictures may be fetched from Gravatar. Off means initials only, and no email hash leaves the instance |
| Updates                       | Whether a newer Deplo release exists, with a link to the release notes                                                |

The page also shows this instance's version and which host it runs on.

## Instance owner

The tier above instance admin, held by the account created at first-run setup.

- **No other admin can demote, suspend or reset the owner.**
- The owner cannot drop their own admin flag either.
- It exists because instance admin is a flat boolean that any admin can write on
  any other admin. Without a crown, one promoted admin could take the whole
  instance, first account included.

**Transfer ownership** is on the same page: only by the owner, only to an active
instance admin, and only with the password re-entered.

If the owner account is genuinely lost, the only way back is a command run on
the host that runs the control plane. That is the one intended shell path in the
entire product.

## Instance-wide variables

**Variables -> All teams** applies to every app of every team, at the **lowest**
priority, so any team can override one. Good for an internal registry mirror or
a proxy setting; wrong for anything one team should not see.

## Servers

Servers are instance-wide, not team-owned, so the whole of
**Settings -> Servers** is an instance-admin surface, including which teams may
deploy to which machine. See [Server settings](../guides/server-settings.md).

## Limits and gotchas

- **Instance admin is not team capabilities.** An admin still needs a membership
  and a role to act inside a team.
- **A registration link is single-use and hashed.** Even two people clicking at
  once cannot both consume it.
- **Deleting a user is not the same as removing them from a team.** Read the
  impact preview.
- **Raising Max log range does not make hosts keep more.** Docker rotates
  container logs by size.

## If it does not work

- **Settings -> Servers is not in the sidebar** - you are not an instance admin.
- **You cannot edit another admin** - they are the instance owner.
- **A registration link is rejected** - used already, or past 24 hours.

## See also

- [Teams and members](../guides/teams-and-members.md)
- [The panel's own address](panel-address-and-certificates.md)
- [Upgrade](upgrade.md)
- [Capabilities](../reference/capabilities.md)
