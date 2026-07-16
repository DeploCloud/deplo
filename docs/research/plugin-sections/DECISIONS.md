# Plugin sections + dev mode as a plugin — settled decisions

Status: **charting** (wayfinder map). Settled 2026-07-13 in a grilling session with the owner.
These are **constraints**, not open questions — every ticket session must respect them. The open
questions live as tickets on the wayfinder map.

Destination: an agreed **spec + ADR** (superseding parts of ADR-0005), ready to hand to
`/to-spec` → `/to-tickets`.

---

## Vocabulary (post-rename — use these exact terms)

| Term | Meaning | Where it lives |
| --- | --- | --- |
| **Plugin** | Installable catalog container (ADR-0005; the MCP one is the first) | `lib/plugins/*`, `lib/data/plugins.ts`, `/plugins/<slug>`, `installed_plugins`, gated on `manage_infra` |
| **App** | The deployable unit (was "Service"/"Project") | `lib/apps/*`, `lib/data/apps.ts`, `/apps/[slug]/*`, `appNav()`, `app_dev` |
| **Project** | The container-folder (ADR-0009) | `prc_` prefix; no page of its own |

The plugin repository lives at `../deplo-app-repository` and still speaks the **old** vocabulary
throughout (README, `apps/<id>/`, "installable apps") — it needs a vocabulary pass.

---

## The organising principle

> **Core keeps the security-critical renderers and the host trust.
> The plugin keeps the state, the lifecycle, the orchestration, and the UI.**

This is what lets dev mode relocate into a plugin **without** breaking ADR-0001, ADR-0002,
ADR-0003, or ADR-0006.

---

## 1. Plugin trust (amends ADR-0005)

1. **Trusted tier.** Plugins may exercise host power. ADR-0005's "powerless relay" model is
   superseded.
2. **Trust = origin.** Every plugin served from the configured `DEPLO_PLUGIN_REPO_URL` is trusted.
   No per-plugin allowlist, no signatures, no manifest-declared tier. The operator vouches for the
   repository by configuring it.
3. **A plugin never holds the agent CA.** It reaches agents through a **control-plane agent-proxy**,
   inheriting `connectAgent(serverId)`'s multi-agent routing — so it reaches *every* server without
   holding any server's credentials, and adding a server just works.
   **ADR-0003 and ADR-0006 decision 10 are preserved:** the `DEPLO_SECRET`-derived CA key stays in
   exactly one process.

## 2. Auth — two mechanisms, both already proven

4. **Attended work → cookie relay.** A plugin is served on Deplo's own host
   (`/plugins/<slug>`), so the browser sends the viewer's `deplo_session` cookie to the plugin
   automatically. The plugin forwards it to Deplo's GraphQL — exactly the MCP relay pattern — and
   the **viewer's own capabilities and folder-access are enforced natively**. The confused-deputy
   problem dissolves: the plugin *is* the viewer.
5. **Unattended work → service token.** A standing, team-scoped, **`deploy`**-capable `deplo_`
   token minted at install. Used only where no viewer is present (deletion teardown, reconciliation).
6. **No signed grant.** An earlier design minted a per-render `(viewer, app, exp)` HMAC grant. It is
   **dropped as redundant** — a plugin holding the session cookie can bypass any grant.

### Accepted risk (must be recorded in the ADR)

**Same-origin exposure.** Because a plugin section is same-origin with the dashboard, the plugin
container **receives the session cookie of every viewer who opens its section** and can impersonate
them with full authority for the life of that cookie. This is **knowingly accepted**, justified by
trust-by-origin. It is why the iframe is *not* sandboxed to an opaque origin.

## 3. Plugin-injected sections

7. Plugins inject sections into the **App left-nav** (`appNav`), *not* the Project drill-in
   (ADR-0009 gave Projects no page).
8. **Declared statically in the manifest**: `sections[] { id, label, icon, path, visibleWhen? }`,
   validated by zod at install. The nav is therefore known without calling the plugin.
9. `visibleWhen` uses a **closed, Deplo-defined predicate set** (`sourceBearing`, `running`,
   `hasFiles`, `requires: <capability>`), evaluated **server-side**. This reproduces dev mode's
   `devEligible` + `deploy` gate exactly. Extensible later by adding enum cases.
10. A section renders as an **`<iframe>` to `/plugins/<slug>/section/<id>`** — the plugin serves its
    own full UI. Same-origin (see the accepted risk); Deplo's CSP already permits it, since
    `frame-src` falls back to `default-src 'self'`.

## 4. Plugin runtime gains persistence

11. The manifest gains **`volumes[]` — Deplo-managed *named* volumes only.** Never host paths: zero
    path-escape surface. (Apps gate host mounts behind `canMountHostVolumes`; plugins get no such
    grant.)
12. The plugin **embeds its own store** on that volume and **generates its own encryption key**
    there. Deplo's `DEPLO_SECRET` is never shared, and SSH passwords stay encrypted under a key
    Deplo does not hold.

## 5. Dev mode relocates into a plugin

13. **The plugin owns all dev state**: dev config (including the **frozen `previewHost`**) and
    `dev_ssh_user` records with encrypted passwords.
14. **Core severs its dependence on dev state**:
    - `app_dev` leaves the App entity graph (`app-graph-load.ts`, `app-graph-rows.ts`);
    - **`portFor`'s `dev?.port` read disappears** — the dev port becomes an *input* to core's render
      op, so **ADR-0001's single port reader survives**;
    - the `devEligible` flag is removed across layout → nav-store → sidebar → breadcrumbs;
    - dev's GraphQL fields are deleted from the public schema.
    - *Smaller than first assumed:* the `App` GraphQL type never exposed `dev`, the Overview has no
      dev coupling, and `components/apps/app-tabs.tsx` is dead code (zero importers).
15. **Three core ops** the plugin calls (the app↔core seam):
    - **`renderDevCompose(appId, devConfig) → opaque YAML`.** Core decrypts env *inside* the render,
      so **the plugin never sees a plaintext secret**, and there stays exactly **one Traefik label
      grammar** (`traefikRouterLabels`) and **one port reader** (`portFor`).
      **ADR-0006 decision 6 preserved.**
    - **`deployFromDevWorkspace(appId) → Deployment`.** Production deploys stay wholly in core
      (`SOURCE_KIND_DEV_WORKSPACE`); the plugin gets back a real `Deployment` id to link to.
    - **`ensureGateway` / `provisionSshUser` / `deprovisionSshUser(users[])`.** Core keeps the
      security-critical wrapper / `sshd_config` / socket-filter renderers (**ADR-0002 and ADR-0006
      preserved**); the plugin supplies the user set. This **inverts** today's wrong-way
      `lib/infra/ssh-gateway.ts → lib/data/dev-ssh` import.
16. **Raw agent RPCs the plugin drives** through the proxy: `StartDev`, `StopDev`,
    `ResetDevWorkspace`, `TeardownDev`, `StartTunnel`, `GetTunnel`, `StopTunnel`.
17. **Proxy transport = GraphQL**: mutations for unary RPCs, subscriptions for the streaming ones
    (build/tunnel logs). **Excluded from the public introspection allow-list**
    (`lib/graphql/introspect.ts`) and gated to plugin service tokens, so internal plumbing never
    pollutes the public API.

## 6. Lifecycle

18. **Uninstall stops dev containers and tunnels but PRESERVES workspaces** (mirrors `disableDev`'s
    reversibility). Wiping workspaces is a separate, explicit, destructive action.
19. **Deletion cleanup = events + reconciliation.** Core emits lifecycle events (App deleted, team
    deleted); the plugin subscribes over SSE **and** runs a periodic reconcile against Deplo's App
    list to heal anything missed while it was down. This builds the **event-driven-plugin phase
    ADR-0005 deferred** — observe-only. **Blocking gates (a pre-deploy veto) remain out of scope.**

## 7. Migration — a clean break

20. **No state migration.** `app_dev` and `dev_ssh_user` are dropped.
    - **Workspaces survive** (they live on the agent's disk; dev seeding is clone-once into an
      *empty* workspace) — so no uncommitted work is lost.
    - **Preview URLs change** (the frozen `previewHost` is discarded and regenerated).
    - **SSH users are lost** → the removal release must **deprovision stale gateway accounts**.
    - **Orphaned `deplo-dev-*` containers** must be stopped by the removal release.
21. **Breaking API change.** Dev's 4 queries + 11 mutations leave core's public schema. The dev
    plugin serves its own dev API on its own path. (Cost: dev disappears from MCP/AI tooling and
    from API-token clients.)

---

## ADR consequences to record

**Superseded / amended — ADR-0005** on three counts: the trusted tier, UI injection, and
events + volumes + state. Its "one install per plugin per team" and "status is read live" survive.

**Preserved deliberately — say so explicitly:**
ADR-0001 (the only port reader) · ADR-0002 (the store leads, the container is a disposable
projection — the *store* just becomes the plugin's) · ADR-0003 + ADR-0006 dec. 10 (the CA stays in
one process) · ADR-0006 dec. 6 (one compose renderer, opaque YAML on the wire) · write-only secrets.

## Known defects to fold in

- **`${secret:N}` rotates on reinstall.** `resolvePluginEnv` mints a fresh random value on every
  resolve, and `installed_plugins` persists no env — so a plugin's generated secret silently
  rotates on reinstall. Harmless for MCP (which uses none); it would have destroyed a *stateful*
  plugin's encrypted data. Sidestepped by keeping the plugin's key in its own volume, but it should
  be fixed or documented.
- **A second, parallel section registry** exists at `lib/breadcrumb-model.ts` (`MAIN_SECTIONS`).
  An injected section must register there too or it appears in the sidebar but not the breadcrumb
  dropdown.
- **`NavItem.icon` is typed `LucideIcon`** — a plugin-supplied icon has no representation today.

## Amendments (ticket resolutions)

Corrections to the statements above, settled by closed wayfinder tickets — the ticket's
resolution comment is authoritative; these lines only point at it.

- **[#26 — Plugin manifest v2](https://github.com/DeploCloud/deplo/issues/26)** (2026-07-16):
  - Decision 8's `sections[]` sketch loses the `path` field — the section **id is** the dashboard
    URL segment; the iframe src derives from `(pluginSlug, id)`.
  - Decision 9's "reproduces dev mode's `devEligible` + `deploy` gate exactly" is wrong as
    written: today's Dev nav gate is source-bearing **only** (`deploy` is enforced in the
    mutations). The dev Plugin declares `{ sourceBearing: true, requires: "deploy" }` — a
    deliberate tightening. "Evaluated server-side" holds for **authority** (and the section route
    itself); the `running` predicate additionally re-evaluates client-side against the live
    status store, like every core nav flag.
  - Decision 11's `volumes[]` = `{ name, mountPath }` with the host name
    `deplo-plugin-<slug>-<name>` **pinned via an explicit compose `name:` key** — plugin compose
    runs under `-p deplo-app-<slug>`, so an un-pinned top-level volume would be project-namespaced
    and invisible to the agreed prefix scan.
  - Decision 14's severing list is incomplete: it must also **delete the route dir**
    `app/(dashboard)/apps/[slug]/dev/` (until then `dev` stays a reserved section id) and
    **re-home `isDevEligible`** out of `lib/data/dev.ts`.
  - Known-defects addendum: the parallel registries are **three**, not two — `UNSAFE_SECTIONS`
    in `lib/breadcrumb-model.ts` holds `console`/`dev`/`files` as string literals; and
    `components/apps/app-tabs.tsx` is dead (zero importers — delete it).
