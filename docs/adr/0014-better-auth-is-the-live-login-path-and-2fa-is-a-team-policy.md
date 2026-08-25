# ADR-0014: Better Auth becomes the live login path; 2FA is a team/role policy, not a capability

- **Status**: Accepted - 2026-08-02.
- **Replaces**: the hand-rolled stateless HMAC session (`deplo_session`) that `lib/auth.ts` owned
  since the first commit. The cookie, `SessionPayload`, `signSession`/`verifySession` and the
  `users.token_version` revocation scheme are all retired by this decision.
- **Constrains**: `lib/auth.ts`, `lib/auth/better-auth.ts`, `lib/membership.ts`, `proxy.ts`,
  migration `0055_two_factor_on_better_auth.sql`.

## Context

deplo had **no second factor anywhere**. A stolen password was total account compromise: apps,
databases, secrets, servers. For a platform whose whole promise is that a non-expert can run
production infrastructure without a shell, "your password is the only lock" is not a defensible
posture, and a team lead who wants to _mandate_ 2FA for their team had nothing to mandate.

Better Auth (`better-auth`) had been in `package.json` and configured in `lib/auth/better-auth.ts`
since the beginning, with a `drizzleAdapter`, its four tables in migration `0000`, and a route at
`/api/auth/[...all]`. It was **completely dead**: `plugins: []`, not one row ever written to
`user`/`session`/`account`/`verification`, and no caller anywhere but that route. Login was a
parallel, hand-rolled implementation: a stateless HMAC cookie carrying `{uid, exp, v}` over the
control-plane `users` table, revoked by bumping an integer.

That left exactly two ways to get TOTP:

1. **Hand-roll it too**: a `two_factor` table, a TOTP verify, backup-code hashing, a challenge
   token between the password step and the code step, and a lockout counter. Perhaps 400 lines of
   security-critical code we would own forever, sitting next to a maintained library that already
   does it.
2. **Make the library we already ship actually run**, and use its `twoFactor` plugin.

The second is cheaper to own, but it is not free: Better Auth's plugin binds to Better Auth's user
and session models, so adopting it means adopting its login path. That is the decision this ADR
records, and it was taken deliberately with the cost on the table.

## Decision

### 1. Better Auth owns authentication. `users` stays the identity.

`user: { modelName: "users" }`. Better Auth's `user` model **is** the control-plane `users` table,
remapped rather than duplicated. Every FK in the control plane already points at `users.id`, so
this is a configuration change instead of a data migration; there is no second user table to
reconcile, and no id to translate. The empty `user` table is dropped and `session`/`account`/
`verification` are recreated against `users(id)`.

Three settings hold this together and must not drift:

- **`password: { hash, verify }`** wired to deplo's own scrypt pair (`lib/crypto.ts`). Every
  `scrypt$salt$hash` written before the migration still verifies, so **nobody reset a password**.
- **`disableSignUp: true`.** `users` has NOT NULL columns Better Auth knows nothing about
  (`username`, `role`, `avatar_color`), so it must never INSERT there. `createAccountWithTeam`
  keeps creating accounts and now writes the matching `account` row itself.
- **`nextCookies()` last in the plugin list.** It is the `after` hook that forwards `Set-Cookie`
  into Next's cookie store, which is what lets the GraphQL auth resolvers mint sessions.

`account.password` becomes the only stored credential; `users.password_hash` is dropped.
Revocation stops being a version bump and becomes "delete the user's session rows"
(`revokeAllSessions`). `users.token_version` is left in place, unread, for one release.

**What it costs, stated plainly:** the session cookie changes name and becomes a DB row, so every
user is signed out once when this lands. And `DEPLO_SECRET` now also seals the stored TOTP secrets
(via `deriveKey("better-auth")`), widening what rotating it destroys.

**What stays deplo's:** teams, memberships, capabilities, the `deplo_team` active-team cookie, and
the `deplo_*` bearer tokens. Better Auth's `organization` plugin is **not** adopted - the
authorization model is the product, and handing it to a library would be the tail wagging the dog.

### 2. A 2FA mandate is a POLICY, not a ninth capability.

Two flags, both default `false`: `teams.require_two_factor` and `team_roles.require_two_factor`.

Capabilities are a closed set of eight that answer _"may they do X"_. A 2FA mandate answers a
different question: _"under what condition does any of it count"_. Modelling it as a capability
would have meant a checkbox in the permission picker that grants nothing, and a capability whose
absence is a _stronger_ state than its presence. It sits outside the picker for that reason.

The Owner role keeps its edit lock and takes no per-role flag; the team-wide switch is how you
cover owners. "2FA for owners but not members" is a narrow enough policy that it does not justify
unpicking the lock that keeps a team from editing its way out of administering itself.

### 3. Unmet means nothing works - UI and API alike.

The gate lives in exactly **two** functions in `lib/membership.ts`, which between them cover every
path:

- **`membershipFor(userId, teamId)`**: behind `requireMembership`, `requireCapability`,
  `hasCapability`, `currentCapabilities`, **and `authenticateToken`**. One guard, every mutation
  and every bearer request.
- **`requireActiveTeamId()`**: every _read_ in `lib/data/*` scopes itself here and never touches
  `membershipFor`. Without this second call a blocked member could still list apps, logs and
  variables: refused a write, but not a look. Closing only one of the two is the exact bug this
  feature could have shipped with, and `lib/two-factor.test.ts` asserts all three paths separately.

A bearer token acts as its creator, so it dies with its creator's mandate. That is the point:
"niente 2FA, niente di niente" is not a UI affordance.

### 4. Blocked is recoverable, never a lockout.

`TwoFactorRequiredError` names the team and the reason. The dashboard layout catches it and returns
a full-page lock screen **instead of** rendering its children - a redirect would race the children's
own data loads and surface as an error boundary rather than an explanation. The lock screen carries
the enrolment wizard inline, plus a team switcher and a sign-out.

Enrolment itself is never team-scoped: `/settings/security` is in `NON_TEAM_SETTINGS_PREFIXES`,
and the `/api/auth/*` endpoints are session-authenticated only. Turning the mandate on is refused
while the actor has no second factor of their own - survivable in the dashboard, but a dead end
over the API, where the token making the change is the token the change kills.

### 5. Enrolment is a wizard, and the third step is not ceremony.

Confirm password → scan → **verify a live code** → save recovery codes. Better Auth does not mark
the factor verified until a generated code comes back, so a mis-scanned authenticator or a badly
skewed clock is caught while the account still logs in with a password alone. Without that step the
same fault becomes a lockout at the next sign-in.

## Consequences

- One sign-out for every user on upgrade. No password resets.
- `/api/auth/*` is now load-bearing, not an orphan. It is the second sanctioned REST exception
  after the SSE/upload routes, and `lib/auth/client.ts` is the only client that uses it.
- Rotating `DEPLO_SECRET` now also orphans enrolled authenticators.
- The reminder modal's dismissal is **localStorage**, not an account setting: a nag someone
  silenced on their laptop has no business becoming state to migrate, back up, or explain.
- One new dependency, `qrcode.react` (zero runtime deps). A hand-rolled QR encoder is ~300 lines
  and manual-key-only entry would fail the mission's bar for a non-expert.
- Rate limiting on the code step is 5 per 15 minutes per client, on top of the plugin's own
  `failed_verification_count` / `locked_until` lockout. A six-digit code is guessable in a way a
  password is not.

## Alternatives rejected

- **Hand-roll TOTP inside the existing session path.** Cheaper today (no migration, no sign-out),
  more expensive forever: backup-code storage, the login challenge token, and the lockout counter
  all become security code we own, duplicating a maintained library already in the tree.
- **Adopt Better Auth's `organization` plugin too.** Teams, memberships and capabilities are the
  product's core model, with folder grants and instance-admin semantics no library knows about.
- **Make the mandate a capability.** See §2.
- **Store the reminder preference server-side.** Turns a local nuisance-suppression into account
  state, for no gain.
