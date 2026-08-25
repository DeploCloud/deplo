# Account security

## What it is

Your own account: the password, two-factor authentication, passkeys, and the
devices you are signed in on. All of it is in **Settings -> Security**, which is
personal and has no team context.

## How it works

**Passwords** are hashed with scrypt, and the cost is stored inside each hash,
so raising it later re-hashes people in place on their next sign-in rather than
locking anybody out.

**Every password a person chooses is checked against Have I Been Pwned**, using
the k-anonymous range API: a prefix of the hash leaves this instance, never the
password. The check **fails open**, so an instance with no outbound access still
works. It runs on account creation, password changes, admin resets, HTTP basic
auth credentials, the Traefik dashboard password and a database engine password.

A password Deplo generates for you is exempt, since it is random by
construction.

## Change your password

**Settings -> Security -> Password**, then **Change password**. You enter the
current one, then the new one. It is checked for length, character mix and
breach exposure before it is accepted.

Changing it does not sign out your other devices. Do that deliberately with
**Sign out everywhere else**.

## Two-factor authentication

**Settings -> Security**, then **Turn on two-factor authentication**. Four
steps:

1. Scan the QR code with an authenticator app, or type the **Setup key** by
   hand. Click **I have scanned it**.
2. Enter the six-digit code to prove it works.
3. Save the **recovery codes**. **Copy** or **Download** them, then confirm **I
   have saved my recovery codes somewhere safe**. They are your way in when the
   phone is not.
4. **Turn on**.

At sign-in you then get a second screen taking either the six-digit code or a
recovery code in `xxxxx-xxxxx` form.

**Turn off** removes it, unless a team or a role you hold requires it.

## Passkeys

**Beta.** A passkey is a **full sign-in method**, not a second step: **Sign in
with a passkey** replaces the password entirely, and a session that presented
one **satisfies a two-factor requirement**.

- **Add passkey** asks for your current password first.
- **Rename** does not.
- **Remove** asks again.

A passkey is bound to the hostname you registered it on. If the panel moves to a
different address, every passkey shows **Not usable here** and the password
still signs you in, so you can register a new one. This is how the standard
works and cannot be worked around.

## Signed-in devices

**Signed-in devices** lists each session with when it was last seen. **Sign
out** ends one. **Sign out everywhere else** ends all but the one you are using,
which is the right button after losing a laptop.

## When your team requires two-factor

A team, or a role inside it, can require it. If you have not enrolled, that team
shows a lock screen instead of the dashboard, offering to turn it on, switch to
another team, or sign out.

The requirement is total while it is unmet: you resolve nothing in that team
through the interface, through the API, or through any token you created.

## Limits and gotchas

- **The breach check fails open, deliberately.** An instance with no internet
  should still let people sign up. It is a warning system, not a gate.
- **Recovery codes are shown once.**
- **A password change does not revoke sessions.** Use **Sign out everywhere
  else**.
- **External credentials are not breach-checked** (registry, SMTP, S3, git
  tokens). Deplo cannot rotate them, so a hit would only break a working
  integration.
- **Losing both the authenticator and the recovery codes** means an instance
  admin has to reset your account.

## If it does not work

- **The six-digit code is rejected** - the phone's clock has drifted. TOTP is
  time-based.
- **Passkeys all say Not usable here** - the panel is on a different hostname
  than when you registered them. Sign in with your password and add a new one.
- **You are locked out of a team** - it requires two-factor. Enrol from the lock
  screen.
- More in [Sign-in and access](../troubleshooting/sign-in-and-access.md).

## See also

- [Teams and members](teams-and-members.md)
- [API tokens](../advanced/api-tokens-and-oauth.md)
- [`docs/adr/0024`](../adr/0024-a-passkey-is-a-full-sign-in-method-and-satisfies-the-2fa-mandate.md)
