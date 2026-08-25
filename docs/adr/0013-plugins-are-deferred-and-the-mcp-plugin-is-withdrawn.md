# ADR-0013: Plugins are deferred; the MCP plugin is withdrawn

- **Status**: Accepted - 2026-08-01.
- **Supersedes in part**: [ADR-0005](0005-apps-are-host-managed-containers-not-projects.md).
  Its _shape_ decisions (a plugin is a host-managed container, never an App; it is served on a
  path under Deplo's own host; status is read live) stand and are what a revival starts from.
  Everything it says about the **MCP plugin** - the stateless relay, the caller token, the
  install flow - is withdrawn, because that plugin no longer exists.
- **Constrains**: [`plugin-sections/DECISIONS.md`](https://github.com/DeploCloud/deplo/blob/f13259bb95789df067b7fcaeafd0103069540c4a/docs/research/plugin-sections/DECISIONS.md), the
  design record for the feature's return. The `docs/research/` archive was removed from the
  tree when the manual moved out; the link is a permalink.

## Context

Plugins shipped as a full vertical slice: a nav entry, a `/plugins` page, a catalog browsed from
a remote repository, four `manage_infra` GraphQL mutations, a host-container runtime, and one
published plugin - an **MCP server** relaying Deplo's GraphQL API to an LLM client.

Measured against the core mission it does not hold up _yet_:

- **It was a settings surface on the first-run path.** A nav entry every `manage_infra` holder
  sees, leading to a page whose only content was one plugin from one repository. First launch is
  supposed to sell the price difference against Vercel/Railway, not open with an extension store.
- **Nobody was going to install it.** One plugin, and one aimed at a narrow audience (people
  driving their deploy platform from an LLM client). "a competitor has a marketplace too" is an
  argument against shipping ours, not for it.
- **The catalog defaulted to a private host.** `DEPLO_PLUGIN_REPO_URL` fell back to
  `devrepo.pixelfederico.com`: an open-source control plane making an outbound call to a
  personal dev box on every page view, with no answer for who serves the catalog in general.
- **The runtime is the wrong shape for where deplo is going.** It owns the Docker socket on the
  control-plane host (the sanctioned ADR-0006 exception). That means plugins can only ever run on
  the Deplo host, which does not survive contact with a managed, multi-tenant deplo cloud.

None of that says the feature is wrong - the plugin-sections research (trusted tier, injected
App sections, plugin-owned state) is the most promising direction deplo has for extensibility.
It says the feature is not _finished_, and an unfinished feature costs more visible than hidden.

## Decision

1. **The feature is deferred, not deleted.** No UI, no API, no catalog: the `/plugins` page, the
   `components/plugins/*` cards, the nav entry, `lib/data/plugins.ts`, `lib/graphql/types/plugins.ts`
   and the repository client are removed. There is no feature flag and no hidden route - a
   half-reachable feature is worse than an absent one, and the GraphQL schema is a public contract
   that should not advertise mutations nobody may call.

2. **The foundations stay, and they are the contract for the revival.** Kept deliberately:
   - `installed_plugins` (the table is **not** dropped - the feature returns without a migration),
     plus `InstalledPlugin` in `lib/types.ts`;
   - `lib/plugins/manifest.ts`: the catalog/manifest wire contract and the `${…}` placeholder
     grammar, pure and still tested;
   - `lib/plugins/runtime.ts`: naming, compose render, lifecycle and teardown, with its frozen
     physical identity (`deplo-app-<slug>`, `deplo.role=app`, `/data/apps/<slug>.yml`);
   - the reserved **plugin path** `/plugins/<slug>`, no dashboard route may claim it;
   - the teardown already wired into team and user deletion.

3. **The MCP plugin is withdrawn entirely.** Its connect dialog, its special-casing in the UI,
   its plan document and every mention of it in the vocabulary are gone. `MCP_BEARER` never
   existed and the **caller token** was only ever the ordinary `deplo_` API token, which survives
   under that name (CONTEXT.md → _API token_) because the external GraphQL API still uses it.

4. **A leftover install is retired automatically.** `lib/plugins/retire.ts`, called from the
   `instrumentation.ts` boot hook, tears down any installed plugin's container, stack file and
   Traefik router, then drops the row. Without it an instance that had installed one would be left
   with a container removable only from a shell on the host - exactly the "you must know Docker"
   failure the core mission forbids. A row survives a failed teardown so the next boot retries.
   **Delete that module when the feature returns.**

5. **What the revival must settle** (do not re-litigate silently - amend this ADR):
   - **Who serves the catalog.** No default may point at a private host again.
   - **Agent or socket.** ADR-0006 says every host-coupled action routes through the server
     agent; the current runtime does not. A plugin that can only run on the Deplo host is not
     multi-tenant-safe and does not survive a managed offering. Prefer the agent.
   - **Who it is for.** Under the two-audience rule a plugin catalog is an _expert_ surface: it
     belongs behind an Advanced affordance, never on the first-run path.
   - **`${secret:N}` rotates on reinstall** (`resolvePluginEnv` mints a fresh value and nothing
     persists the resolved env). Harmless for a stateless plugin, destructive for a stateful one.

## Considered options

- **Keep it, hidden behind a flag**: rejected - the mutations would stay in the public schema and
  the code would still be "live" in reviewers' minds, while nobody exercises it. Dormant-and-honest
  beats reachable-if-you-know.
- **Delete everything, rebuild from git history**: rejected - the table would need a drop and a
  re-create migration, and the design record (identity rules, the `__` injectivity constraint, the
  Traefik priority interaction) is exactly what is expensive to rediscover.
- **Leave existing plugin containers running**: rejected - an orphan container with no UI to remove
  it can only be cleaned from a shell, which the core mission forbids.
- **Ship the MCP plugin as a Template instead**: rejected for now - a template deploys into the
  user's own app surface with its own domain and cert, which is a different (and much larger)
  security question than a relay on Deplo's own path. Reconsider with the revival.

## Consequences

- The Infrastructure nav section is one entry shorter; `/plugins` is a 404 (and no longer a
  team-switch destination). `schema.graphql` loses `InstalledPlugin`, `PluginListing`,
  `pluginCatalog`, `installedPlugins`, `installPlugin`, `uninstallPlugin`, `startPlugin`, `stopPlugin`.
- `DEPLO_PLUGIN_REPO_URL` is no longer read; it is gone from `.env.example`. An instance that
  still sets it is unaffected, nothing reads the value.
- The first boot after this change destroys any installed plugin's container. On the maintainer's
  instance that is `deplo-app-mcp__neonteam`.
- `lib/plugins/*` is dormant code. It must not grow new callers, and the ADR-0006 socket exception
  it represents does not extend to anything else.
