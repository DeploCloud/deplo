# Shared variables

## What it is

One variable, owned by the team, that several apps can use. Change it once and
every app that uses it gets the new value on its next deploy.

Typical cases: an API key three services all call, an S3 bucket name, a
`SENTRY_DSN`.

## How it works

A shared variable has two independent parts, and confusing them is the single
most common mistake here.

**Availability scopes say who it is offered to.** A scope is a suggestion. There
are three, and a variable can carry several:

| Scope              | Suggested to                                |
| ------------------ | ------------------------------------------- |
| **The whole team** | Every app in the team                       |
| **Projects**       | Every app inside the chosen projects        |
| **Environments**   | Every app living in the chosen environments |
| **Specific apps**  | Exactly the apps you pick                   |

**The per-app link is what actually injects it.** Until an app links the
variable, the value reaches nothing, whatever its scopes say.

That is deliberate. A variable that appeared in every app the moment somebody
ticked "the whole team" would make a shared secret a footgun, and would make
"why does this app have that value" unanswerable.

At deploy time a linked shared variable folds **above** the app's own variable
of the same name, and below a preview override.

## Create one

1. Open **Variables** in the sidebar, then the **Shared** tab.
2. Click the button to add one and give it a name and a value.
3. Pick **Plain** or **Secret**. The same rules apply as anywhere else: a secret
   is write-only and immutable.
4. Choose at least one availability scope, or pick specific apps. One of the two
   is required.

## Use one in an app

1. Open the app, then **Environment**.
2. The shared variables offered to this app are listed as such. Link the one you
   want.
3. Redeploy.

A linked row in an app shows two different removals, and they mean very
different things:

- **Remove from this app** unlinks it here. The variable and every other app
  keep it.
- **Delete everywhere** deletes the variable for the whole team.

## Limits and gotchas

- **Scope is not injection.** Worth repeating: the link is the only mechanism.
- **The app's own variable loses to a linked shared one** of the same name. If
  an app needs its own value, unlink the shared one rather than fighting it.
- **Shared variables belong to the team**, so an app transferred to another team
  leaves them behind.
- **Deleting one affects every app that links it**, on their next deploy. The
  dialog says how many.
- **Secrets follow the same fork rule**: a preview of a fork never receives a
  secret-typed shared value.

## If it does not work

- **The app does not see the value** - it is scoped but not linked. Link it on
  the app's **Environment** tab.
- **The value changed and the app still has the old one** - it applies on the
  next deploy. Redeploy.
- **A different value than expected** - the app defines the same name itself, or
  a preview override does.

## See also

- [Environment variables](environment-variables.md) - the four layers and their order
- [Apps, projects and environments](../concepts/apps-projects-and-environments.md) - what a scope refers to
- [`docs/adr/0012`](../adr/0012-shared-variables-are-opt-in-per-app.md) - why opt-in
