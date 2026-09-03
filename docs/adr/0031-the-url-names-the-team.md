# ADR-0031: The URL names the team, and it outranks the cookie

- **Status**: Accepted - 2026-09-03.
- **Relates to**: ADR-0029 (an app's slug is the deploy key), whose `/apps/b5-wiki`
  becomes `/<team>/apps/b5-wiki`, and ADR-0014, which left the `deplo_team` cookie
  as Deplo's own.

## Context

Every dashboard address was flat - `/apps/b5-wiki`, `/storage/databases/db_x`,
`/settings/members` - and the team came from the `deplo_team` cookie. So **no link
to a resource was self-contained**: the clickable link in a notification, an email,
a push or a bookmark opened with whatever team the reader's browser last had. Land
in the wrong one and the page 404s, or - worse for the reader - shows a different
team's resource under the address they were sent.

It also blocked the managed service: an address whose meaning depends on
browser-side state cannot be shared between the members of a team.

## Decision

**The team is the first path segment, and it is what the request operates in.**
`teams.slug` (already unique, already the API's `X-Deplo-Team` value) is the
address, so the whole dashboard lives under `/<team>/…`.

- `getActiveTeamId()` resolves, in order: the token's team (a bearer request), the
  team the URL names, the last one visited (the cookie), the user's first. Both
  middle sources are validated against the memberships, so neither can name a team
  the viewer is not in - an invented header is worth exactly what an invented
  cookie always was.
- The URL reaches the data layer as a request header (`x-deplo-team`), set by
  `proxy.ts` from the first segment and by the browser's GraphQL client from
  `location.pathname` - `/api/graphql` is flat, so the header is the only carrier.
- **The cookie retreats to "the last team visited"**: it answers a bare `/` and a
  flat legacy address, and the proxy keeps it in step with the URL.
- **Paths stay FLAT in the code** (`/apps/web`). The prefix is a property of the
  navigation boundary, not of the data: `withTeam()` applies it inside the `Link`
  and `useRouter` wrappers, and eslint refuses the raw imports. The nav model, the
  breadcrumbs, the command palette and the notification payloads keep speaking
  flat.
- **A first segment that already means something can never be a team's slug**
  (`lib/team-path.ts`), enforced when a team is minted and by a one-off migration
  for the teams that predate the rule.

## Consequences

- **The slug stays FROZEN**, as ADR-0029's deploy key is: it is now an address as
  well as an API value, and a rename would break links already sent. A team cannot
  correct an unfortunate slug - deliberate, and the cheaper half of "no link ever
  dies".
- **Every flat address still resolves, for good.** A stub per legacy section
  redirects it, resolving the team that OWNS the app or database (instance-unique
  by 0029) rather than assuming the active one - which is exactly what makes
  yesterday's notification open the right team today.
- **A link to a team the viewer is not in gets one answer**, the same one a team
  that does not exist gets, so the address reveals nothing.
- **Switching team is a navigation.** The switcher, the 2FA lock screen and the
  create-team dialog all move the address rather than writing a cookie and
  refreshing.
