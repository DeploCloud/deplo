# Environment variables

## What it is

The configuration your app reads from its environment: API keys, database URLs,
feature flags, `NODE_ENV`. Deplo stores them encrypted, injects them at build
time and at run time, and never shows a secret back to anybody.

## How it works

Four layers stack, and the deploy folds them together in this order, lowest
priority first:

```
instance-wide variables      set by an instance admin, every team, every app
   <  the app's own variables
        <  a shared variable the app has linked
             <  a preview override           previews only
```

A name defined twice takes the value from the highest layer that defines it.

**Every value carries a type**, `plain` or `secret`, on every layer. The type is
not decoration:

- A **secret** is write-only. It is never returned by the API, never rendered
  into a stack shown back to you, and there is no reveal path anywhere in the
  product.
- A **secret is immutable**. Not the value, not the name, not the type. Changing
  one means deleting it and adding it again, which is the honest description of
  what rotating a credential is anyway.
- Promoting `plain` to `secret` is always allowed. The other direction is not.
- A pull request preview of a **fork** never receives a secret-typed value,
  whatever the settings say. The code in that pull request is a stranger's.

**Build time and run time are the same set.** Every resolved variable is passed
to the build as a build argument and declared in the generated Dockerfile, so
build-time inlined configuration such as `NEXT_PUBLIC_*` or `VITE_*` works with
no extra toggle.

## Set variables on one app

1. Open the app, then **Environment**.
2. Click **Add variable**.
3. Type the name and the value, and pick **Plain** or **Secret**.
4. Save, then **Redeploy**. Variables apply on the next deploy.

To bring over a whole `.env` file, paste it into the add dialog: Deplo parses
`KEY=value` lines in bulk instead of making you add twenty rows by hand.

Each row records who created it and who last changed it, with an avatar, so a
surprising value has a name attached to it.

## See everything at once

The **Variables** page in the sidebar has three tabs:

| Tab           | What it shows                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| **All**       | Every app's variables, grouped by app, expandable, filterable. The fastest way to find which app has the stale key |
| **Shared**    | The team's [shared variables](shared-variables.md)                                                                 |
| **All teams** | Instance-wide variables. Instance admins only                                                                      |

## Instance-wide variables

**Variables -> All teams**, for instance admins. They apply to every app of
every team and sit at the **lowest** priority, so any team can override one with
its own value. Good for a corporate proxy setting or an internal registry
mirror; wrong for anything one team should not see.

## Preview overrides

**Settings -> Pull requests** has a collapsed **Preview overrides** section
where one variable can take a different value in previews only. It folds above
everything else.

The normal use is pointing previews at a scratch database instead of the real
one. Most apps never need it, which is why it is collapsed and empty by default.

## Limits and gotchas

- **Nothing applies until the next deploy.** Setting a variable does not restart
  anything. Click **Redeploy**.
- **A secret cannot be edited, only replaced.** By design.
- **`reveal_secrets` does not reveal secret-typed variables.** That capability
  unmasks plain-but-masked values, connection strings and passwords. Nothing
  unmasks a secret.
- **Names are not validated against your framework.** A typo is a missing
  variable at run time, not an error at save time.
- **Ticking a shared variable's scope does not inject it.** Only the per-app
  link does. See [Shared variables](shared-variables.md).
- **Compose apps get their variables injected into every service** as
  pass-through entries, with the values riding in a `0600` env file next to the
  stack.

## If it does not work

- **The app cannot see a variable it should have** - it was added after the last
  deploy. Redeploy.
- **The value is right in Deplo and wrong in the app** - something above it in
  the precedence list defines the same name. Check the app's own variables
  first, then its linked shared variables.
- **A build-time variable is empty in the browser bundle** - the framework
  inlines only prefixed names (`NEXT_PUBLIC_`, `VITE_`). The prefix is the
  framework's rule, not Deplo's.
- More in [Deploys and builds](../troubleshooting/deploys-and-builds.md).

## See also

- [Shared variables](shared-variables.md)
- [Databases](databases.md) - the connection string is a variable you paste
- [Pull request previews](pull-request-previews.md)
- [Capabilities](../reference/capabilities.md) - `manage_env`, `reveal_secrets`
