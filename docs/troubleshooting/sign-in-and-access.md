# Sign-in and access

## You cannot sign in

| Symptom                                    | Cause                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| The password is rejected                   | Wrong password, or the account is suspended. An instance admin can reset it             |
| The six-digit code is rejected             | The phone's clock has drifted. TOTP is time-based                                       |
| Neither the code nor a recovery code works | Recovery codes are single-use. An instance admin has to reset two-factor on the account |
| Every passkey says **Not usable here**     | The panel is on a different hostname than when they were registered. See below          |
| The page will not load at all              | Try `http://<server-ip>:3000`, which always answers                                     |

## Passkeys stopped working

A passkey is bound by the standard to the hostname it was registered on. Moving
the panel to a different address invalidates all of them at once.

The password still signs people in, which is the escape hatch: sign in, then
register a new passkey on the new address. Everybody on the instance has to do
this once. There is no way around it.

## A team shows a lock screen

That team requires two-factor authentication and your account has not enrolled.
While that is unmet you resolve **nothing** in that team: not in the dashboard,
not over the API, and neither do any tokens you created.

The screen offers to turn it on, switch to another team, or sign out.

## A button is missing or greyed out

In order of likelihood:

1. **Your role does not include that capability.** The interface hides or
   disables what you cannot do.
2. **A folder share is narrowing you.** Inside a folder, a share **replaces**
   your team role, and it can be smaller as well as larger. Your member page
   shows the scope tree.
3. **It needs a separate grant.** Publishing a port needs one; anything that
   reaches the host needs **Bind server folders**.
4. **It is an instance-admin surface.** Servers, Users and the Deplo settings
   are not team capabilities.
5. **The feature is off.** Console needs a one-time acknowledgement, and cron
   jobs and previews need their switch.

## An API token returns 401

Missing, revoked, or **expired**. Expiry is checked before anything else, so one
comparison covers GraphQL, MCP and the deploy hook.

Nothing sweeps an expired token away, on purpose: the list has to be able to
tell you why a credential stopped.

## An API token returns 403

| Cause                                                         | Fix                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The token lacks that capability                               | Edit it in **Settings -> Tokens**                                        |
| Its creator lost that capability                              | A token can never do more than its creator can do **right now**          |
| The scope excludes the resource                               | Naming a project or an app drops every team-wide capability in that team |
| The team requires two-factor and its creator has not enrolled | The token resolves nothing                                               |

## An id returns 404 and you are sure it exists

It belongs to another team, or it is outside the token's scope. Deplo resolves a
cross-team id to nothing rather than to an error that would confirm it exists.

A deleted app behaves the same way from the moment deletion starts.

## You are the owner and locked out

The instance owner cannot be demoted, suspended or reset by any other admin,
which is the point of the crown. If that account is genuinely lost, the only way
back is a command run on the host that runs the control plane.

## Somebody left the company

1. **Settings -> Members**, open them, **Advanced**, remove them.
2. Every token they created immediately loses whatever it inherited from them.
3. If they were the primary owner, ownership must be transferred **first**, by
   them. Plan this before the last day.
4. Check **Activity** for what they did recently.

## See also

- [Account security](../guides/account-security.md)
- [Teams and members](../guides/teams-and-members.md)
- [Roles and permissions](../guides/roles-and-permissions.md)
- [API tokens](../advanced/api-tokens-and-oauth.md)
