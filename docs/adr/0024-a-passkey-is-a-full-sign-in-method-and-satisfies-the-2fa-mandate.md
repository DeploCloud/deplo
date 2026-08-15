# ADR-0024: A passkey is a full sign-in method, and it satisfies the two-factor mandate

- **Status**: Accepted - 2026-08-15.
- **Constrains**: `lib/auth/better-auth.ts`, `lib/auth.ts`, `lib/passkey-policy.ts`,
  `lib/membership.ts`, `lib/data/passkeys.ts`, `lib/data/two-factor.ts`,
  `lib/graphql/types/{passkey,auth,member}.ts`, `app/(auth)/login/*`,
  `app/(dashboard)/settings/security/*`, and the `passkey` / `session` tables (migrations 0102, 0103 and 0104).
- **Amends**: ADR-0014 §2 and §3, which defined a two-factor mandate as satisfied by enrolling
  an authenticator app.

## Context

Since ADR-0014 an account proves itself with a password, optionally plus a TOTP code, and a team
or a role can make that second factor mandatory. The mandate works - an unmet one resolves
nothing - but it has a cost the policy owner pays in other people's time: every member has to
install an authenticator app, scan a QR code and keep ten recovery codes somewhere, and the ones
who lose the phone end up at an instance admin's desk.

Meanwhile the credential the rest of the industry moved to does both jobs at once. A passkey is a
WebAuthn key pair the device holds and biometry or a PIN unlocks: possession and inherence in one
gesture, unphishable because the browser will not present it to any origin but the one it was
minted for, and one click instead of a password plus six digits.

Two facts about the platform shape everything below. A passkey is welded to **one rpID** - a
hostname - and the browser refuses the ceremony from anywhere else, silently, before any request
is sent. And WebAuthn requires a **secure context**: https, or `http://localhost`.

## Decision

### 1. A passkey is a way to sign in, not a second step

`/login` offers "Sign in with a passkey" beside the password form, and the ceremony uses
discoverable credentials - no email is typed, the browser offers the passkeys it holds for this
site. The password stays and cannot be turned off: it is the fallback that keeps a lost device
from being a lockout, and there is no account-recovery flow to fall back to instead.

### 2. Holding a passkey satisfies `require_two_factor`

`twoFactorMandate` is satisfied by `users.two_factor_enabled` **or** by a `passkey` row for that
user that was minted for THIS panel's address (§4). This is the point of the feature: a team can
require two factors without requiring an app.

It is only honest because deplo enforces user verification. The plugin hardcodes
`requireUserVerification: false` in both verifiers, and `authenticatorSelection.userVerification:
"required"` is a request the authenticator may ignore, so `requireUserVerified` (an
`afterVerification` guard in `lib/auth/better-auth.ts`) refuses a ceremony the authenticator did
not mark verified. A key that unlocks with no PIN is one factor wearing the badge of two. **Remove
that guard and this section becomes false.**

There is no `users.has_passkey` column. The row is the fact; a denormalized copy is one more thing
that can still say yes after the credential is gone.

### 3. A passkey counts for the session that presented one

`twoFactorMandate` asks two questions, not one: does the account hold a usable passkey (§4), and
did THIS request sign in with one. The second is `session.auth_method` (migration 0104), stamped by
`verifyPasskeyLogin` and by `finishPasskeyRegistration` - registering a passkey is a user-verified
ceremony on the device holding the session, which is the same proof a sign-in gives.

Without the second question, §2 would let one factor clear a two-factor policy: register a passkey,
never use it, and sign in with a password forever.

**The password always opens a session.** An earlier version of this decision refused it instead,
and that was wrong: it reached past the policy and took away what ADR-0014 §4 guarantees. A blocked
member is stopped INSIDE the mandated team and nowhere else - their own account settings stay
reachable, and other teams are untouched - which is what lets them enrol an authenticator app, or
add a passkey on the device in front of them, and unblock themselves. Refusing the sign-in meant
somebody whose passkey was on a device they did not have with them could reach none of that, and for
the instance owner, whose row no other admin may touch, the way back in was a database prompt.

Three shapes, all deliberate:

- **A password session** on an account that owns a passkey: blocked in mandated teams, free
  everywhere else, and holding its own account settings.
- **A passkey session**: satisfied, like an enrolled authenticator app.
- **A bearer token**: no session, so the question does not apply and the ACCOUNT's standing
  decides, exactly as it already does with `two_factor_enabled`. Load-bearing mechanically too:
  `identityForTokenRow` calls `membershipFor` before any identity is installed.

NULL `auth_method` is a password session, and so is a session from before the column existed.

### 4. rpID is the panel URL, and nothing else

`passkeyRelyingParty()` (`lib/public-url.ts`) derives the rpID and origin from `publicBaseUrl()`,
returning null on plain http or with no address configured. Deriving it from the request host
instead would mint credentials that work on one of an instance's addresses and fail on the others,
with no way to tell which.

`origin` is passed to the plugin explicitly. Both verifiers fall back to the `Origin` header and
throw on an empty string, and `authHeaders()` strips that header on purpose
(`lib/auth/request-headers.ts`) - so without the option every ceremony would 400.

**Every credential records the rpID it was minted for** (`passkey.rp_id`, migration 0103), and both
predicates in `lib/passkey-policy.ts` ask two questions rather than one: does this instance have a
relying party at all, and was this credential minted for it. A credential that fails either stops
counting as a second factor.

Two ordinary product actions make a registered passkey unusable - turning the panel's HTTPS off
(`setPanelHttps(false)`) and moving it to a new hostname. Without the rpID recorded, the account
would go on looking protected by a credential no browser will offer. With it, both degrade to "this
account has no second factor here": the person is asked to add one, which is a screen they can
reach. Stale credentials stay listed in Settings → Security, marked **Not usable here**, because the
only thing to do with one is remove it and a row that vanished silently would be a credential nobody
could account for.

`rp_id` is NULL for anything minted before 0103 and is deliberately not backfilled: guessing the
address a credential was made for re-creates the lockout the moment the guess is wrong.

The cost is still stated plainly: **moving the panel to a new hostname kills every registered
passkey.** The credentials stay on the devices and simply stop matching, and people re-register.

### 5. The plugin's endpoints are closed to the network

`passkeyGate` refuses every `/passkey/*` request that arrived over HTTP, exactly as `twoFactorGate`
does for `/two-factor/*`. All seven endpoints share that prefix - the client's `signIn.passkey` is
a browser-side composite, not a route - so one matcher closes the whole plugin.

Management is closed because the plugin registers a permanent credential on a **session alone**,
which is a notch below the bar `lib/data/two-factor.ts` holds for the same class of change: deplo
asks for the password first. Login is closed because `verify-authentication` skips
`users.suspended`, skips the rate limiter and records no failed attempt - all three live in the
GraphQL resolvers with every other sign-in path, and a second front door with none of the locks is
worse than no second door.

### 6. Adding and removing need the password; renaming does not

Both mutations reuse `stepUpPassword` and its per-account limiter from `lib/data/two-factor.ts`, so
six wrong guesses buy the same pause whichever credential is being changed. Finishing a
registration does not ask again: the challenge it answers was minted behind that check, is bound to
a cookie, expires in five minutes and is consumed once.

A label is not a credential, so renaming asks for nothing.

`deletePasskey` refuses the **last usable** passkey while a mandate is in force and no TOTP is
enrolled. That is the unasked-for consequence of §2: the credential is the only thing satisfying the
policy, and removing it with one click would lock the person out of their own team. The count and
the delete share one transaction with the account's rows locked `FOR UPDATE`, so two clicks racing
each other cannot both pass the guard - which is why the delete is a Drizzle statement rather than
the plugin's endpoint, the only write here that is not.

Registration stops at 20 passkeys per account. Not a rate limit (the step-up limiter already bounds
how fast they arrive) - a ceiling, because nothing about the feature needs an unbounded list.

### 7. The escape hatches stay separate

An instance admin can clear a user's passkeys (`resetUserPasskeys`) alongside clearing their
two-factor enrolment, with the same guards: not your own, never the instance owner's, and no
password or session touched. Two controls rather than one, because the phone and the laptop are
lost independently and clearing a dead authenticator is no reason to take away a passkey that
still works.

A dead passkey is not merely clutter: while it exists it satisfies the account's mandate, so a
member whose only device is gone reads as protected and cannot be told to enrol anything.

## Consequences

- A team can turn `require_two_factor` on without asking anyone to install an app.
- Passkeys ship as **beta**: the ceremony is covered end to end by a software authenticator
  (`lib/webauthn-test-helpers.ts`), but no real fleet has carried it, and the rpID's coupling to
  the panel address is a sharp edge operators meet the first time they move it.
- An account holding a passkey may turn its authenticator app off, and the security page says why
  "Off" is allowed under an active policy.
- `bun` had to move `better-auth` 1.6.27 → 1.6.29 (the plugin is the separate package
  `@better-auth/passkey` and peers that version), and `@better-auth/oauth-provider` with it.
- A hardware key with no PIN set is refused at registration. That is the price of §2.
- The card shows "Added", not "last used": the plugin does not track it, and writing a deplo column
  onto a library-owned table to get it is not worth the coupling.

## Alternatives rejected

- **Passkeys as a second factor only** (password, then a WebAuthn challenge instead of a code).
  Safe, and it saves nobody anything: the password is still typed every time, which is the part
  worth removing.
- **Passkey-only accounts** (drop the password once a passkey exists). deplo has no account
  recovery, so losing every device would mean losing the account with no path back that is not a
  database prompt - the exact "drop to a shell" the product exists to avoid.
- **A per-team switch for whether passkeys count as two factors.** One more knob on a first-run
  path that should be selling the price tag, to express a preference nobody has: a
  user-verified passkey either is two factors or it is not, and §2 answers that once.
- **Refusing the password for an account whose mandate rests on a passkey.** This is what §3
  originally did. It closed the same hole, and it cost more than the hole: no session meant no
  account settings, no other teams, and no self-recovery for anyone whose device was elsewhere. The
  session marker closes the hole where the hole actually is.
- **Hand-rolling WebAuthn on `@simplewebauthn/server`.** Avoids a version bump and gives full
  control of the table, at the cost of owning challenge storage, counter handling and session
  minting - the last of which `lib/data/sessions.ts` already argues must stay inside Better Auth's
  adapter.
- **Conditional UI (autofill)**, where the browser offers the passkey from the email field. The
  best experience on paper; it needs a ceremony started at mount with no user gesture, which is the
  main source of spurious `NotAllowedError`. Reconsider once the button has proven itself.
