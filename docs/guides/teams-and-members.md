# Teams and members

## What it is

Adding people to a team, giving them a role, and being able to answer "who did
that" afterwards.

## How it works

Everything in Deplo belongs to a team, and a person reaches it through a
**membership**. A membership carries a **role**, which is a named set of
[capabilities](../reference/capabilities.md).

There is **no email invite flow**. Deplo does not send mail on its own, and a
self-hosted instance often cannot. Instead there are two paths:

- The person **already has an account here**: you add them to your team
  directly.
- The person **has no account**: an instance admin mints a **registration link**
  and sends it to them however they like.

## Add somebody who already has an account

1. Open **Settings -> Members**.
2. Click **Add member**.
3. Search by username, pick them, choose the role, then **Add to team**.

They see your team in their team switcher immediately.

## Invite somebody new

This needs an instance admin.

1. Open **Settings -> Users**, the system section.
2. Start **Create a new user** and follow the wizard.
3. Deplo mints a single-use link. **It works once and expires in 24 hours.**
4. **Share this link** with them, over whatever channel you already trust.

They open it, choose a username and a password, and land in **their own team**.
Add them to yours from **Settings -> Members**.

Pending links are listed on the same page, and can be revoked before use. Only a
hash of the link is stored, and it is consumed atomically, so it cannot be used
twice even by two people clicking at the same time.

## Roles and limited access

Each member row shows their role. Two badges are worth recognising:

- **Primary owner** is the founder's crown. Nobody can remove, demote or edit
  them, including instance admins. It transfers only from **Settings -> Members
  -> the member -> Advanced**, only by the owner, only to a member of that team,
  and only with the password and second factor re-entered.
- **Limited access** means their real reach is narrowed or widened by
  [per-folder grants](roles-and-permissions.md), so their role name alone does
  not tell the whole story.

Open a member to get three tabs: **Permissions** (their role, plus the per-node
scope tree), **Activity** (what they have done), and **Advanced** (instance
admin, transfer ownership, remove them).

## Remove somebody

From the member's **Advanced** tab. Their memberships end, their sessions in
that team stop resolving, and every API token they created loses whatever it
inherited from them. Their account and their own team are untouched.

## The activity trail

**Activity** in the sidebar. Every meaningful action, grouped by day, with the
actor's avatar: deployments, apps, projects, databases, domains, variables,
members, backups, destinations, cron jobs, cleanups, monitoring changes and MCP
access.

Actions taken by the system or by a git provider are attributed to `system` or
`github`, never to a person who happened to be nearby.

If an entry could not be written, the next successful write says so in the
trail, out loud, rather than leaving a silent gap. A hole in an audit log has to
be visible in the audit log.

## Limits and gotchas

- **A team always keeps somebody who can administer it.** No role edit and no
  removal may leave zero holders of `manage_members`, `manage_roles` or
  `manage_team`.
- **Teams are isolated.** Adding somebody to this team gives them nothing
  anywhere else.
- **Servers are shared, not team-owned.** Which teams may deploy to a server is
  set on the server, by an instance admin.
- **Two-factor can be required at the team level**, and an unenrolled member
  then resolves nothing there at all. See [Account security](account-security.md).

## If it does not work

- **The user search finds nobody** - they have no account on this instance yet.
  Use a registration link.
- **A registration link says it is used or expired** - mint a new one.
- **They are in the team but see nothing** - the team requires two-factor and
  they have not enrolled, or their role has almost no capabilities.

## See also

- [Roles and permissions](roles-and-permissions.md)
- [Teams and capabilities](../concepts/teams-and-capabilities.md)
- [Account security](account-security.md)
- [Instance administration](../operations/instance-administration.md)
