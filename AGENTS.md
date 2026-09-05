# AGENTS.md

Agent-facing guide for **Deplo** - a self-hosted deploy platform that turns repos and
templates into Docker stacks fronted by Traefik. Read this before writing code, then lean on
the deeper docs it links (this file points; it does not restate them).

- **`CONTEXT.md`** (repo root): authoritative glossary / ubiquitous language. Single-context repo.
- **`docs/adr/`**: numbered decisions (0001-0027). Contradicting one? Surface it, don't silently override.
- **`schema.graphql`** (root): generated SDL, the API contract.
- **The USER manual is NOT in this repo.** It is [`DeploCloud/docs`](https://github.com/DeploCloud/docs),
  served at <https://deplo.build/docs>. Never add a user-facing page here.
- **`docs/agents/`**: `issue-tracker.md`, `triage-labels.md`, `domain.md`, `releasing.md`,
  `fleet-rollout.md`.

## Core mission - the north star every feature answers to

**Deplo exists to make self-hosting exhaustively simple.** The experience to match is the one the
big cloud platforms give: push, and it is live, with the platform doing the operations. The user
must **never be required to know Docker or SSH** to get full value out of Deplo - that
non-requirement is the whole differentiator from the other self-hosted platforms, which assume the
operator lives in a shell.

The audience is everyone who wants that experience on their own infrastructure: people leaving a
cloud over the bill, teams that never self-hosted at all, and people already running a competing
open-source platform who are tired of the shell. Winning the last group matters, but designing only
for it would aim the product far too low.

Consequences that bind every design and review decision:

- **No feature may push Docker/SSH/YAML knowledge onto the user as a prerequisite.** If a flow
  only works when the user drops to a shell or hand-edits compose, it is unfinished, not done.
  The escape hatch may exist for experts; the _happy path_ must not need it.
- **Every feature is tested exhaustively and judged on UX/DX**, not just "does it function."
  "Generally useful, obvious, and safe for a non-expert" is the bar. Half a feature that assumes
  operator expertise is a regression against the mission.
- **Favor derived / live / automatic over manual.** Disaster recovery, backups, secrets, status,
  URLs - the platform should do the operator's job for them, using infrastructure they already
  have (e.g. the fleet itself), not ask them to stand up more (an S3 bucket, an external DB) as a
  precondition.
- **Every feature must earn its place in the UX and name its audience - one of exactly two.**
  Either it is **for the non-expert** (on by default, obvious, safe, delivers value with zero
  configuration) or it is **for the expert** (_advanced mode_: opt-in, behind an "Advanced"
  affordance, never on the first-run path). If you can't say which of the two a feature is for,
  it isn't designed yet.
- **Design for a team, not a lone operator.** Deplo's users are teams and companies as much as the
  solo developer. Assume several people with different Capabilities share one instance, and that
  whoever takes an action is not the instance owner. A flow that only works when you own the
  instance, or that expects someone to fix it by hand out of band, is broken for the audience Deplo
  wants. This axis is orthogonal to non-expert/expert: every feature answers both.
- **Don't build what nobody will realistically use.** Losing focus on Deplo's principles looks
  exactly like a stream of individually-defensible features that, long-term, almost no one turns
  on. Breadth is not the goal - being _far simpler than every competing self-hosted platform_ is.
  "another platform has that setting too" is an argument _against_ shipping it, not for.

When weighing a design, ask: _would a competent developer who has never touched Docker or SSH
succeed on the happy path, with the platform doing the operational heavy lifting?_ If not,
reconsider.

### First run should sell the price tag, not a settings audit

Someone moving off a cloud platform to self-hosting must, on first launch, be struck by **the
pricing difference**, not by having to inspect and configure a mountain of options, with advanced settings
staring at them by default. Ship opinionated defaults, keep the default surface as small as it can
be while still useful, and put everything else behind advanced mode. Every knob visible at first
run is a tax on the one thing that makes the switch worth it.

### Teams and companies are first-class, not an afterthought

The other self-hosted platforms are shaped around one operator on one box, with sharing bolted on
afterwards; the clouds Deplo measures itself against are not. Deplo aims at the collaboration case
from the start: a team, up to a whole company, working in the same instance under least privilege.
Concretely:

- **Multi-person is the default assumption, never a later plan.** Everything is scoped to the
  active team, every mutating action is Capability-gated server-side, and per-folder grants let a
  member hold exactly one corner of the fleet. Never ship a feature whose happy path needs
  instance ownership.
- **The collaboration surfaces are product, not plumbing.** Roles, members, folders and grants,
  Activity, API tokens, the 2FA policy: same UX bar as deploying an App, obvious to a non-expert,
  no shell, no hand-edited config.
- **A company's questions must be answerable in the UI:** who did what and when, who can do what,
  how to take access away, how ownership moves when someone leaves. If the honest answer is "look
  in the database" or "ask whoever runs the box", the feature is unfinished.

The solo developer stays first-class: the team case must never make the single-user path heavier,
so anything only a company needs obeys the first-run rule above and stays out of the way by default.

### Everything must be easy to turn into a managed service

Beyond self-hosted, where Deplo aims at enterprise-grade, more scalable features than the
competition - the intent is to eventually run **Deplo's own proprietary cloud**. The idea is still
rough, but the constraint it puts on today's code is concrete: **whatever we build should one day be
easy to offer as a managed service.** In practice that means multi-tenant-safe by construction, no
assumption that the operator and the end user are the same person, and no dependence on the user
having shell/root on the box (which the core mission already forbids). This never displaces the
priorities: **self-hosted and open source stay first-class**, and the cloud is an additional
distribution of the same system, never a fork, never a reason to starve the self-hosted path.

### Flag a mission conflict once, then build it

If a request - the user's or a feature you are proposing yourself - conflicts with the mission
above, say so **before** writing code, in **at most three lines**, then build the thing as asked.
The default is always to deliver: the flag is information, not a veto, and never a reason to stop
and wait for an answer.

A conflict is one of these, named explicitly:

- The happy path needs Docker, SSH, or hand-edited YAML.
- You cannot say which of the two audiences it serves (non-expert default-on / expert advanced mode).
- It adds surface to the first-run path that a new user must read past.
- It only works when the actor owns the instance, or it breaks under active-team scoping.
- The honest answer to "who did this, and how do I take the access away" is "look in the database".

If none of those applies, do **not** flag it. "Feels like scope creep" is not a mission conflict,
and a warning fired on every request is the same as no warning at all.

Say: what it collides with, the cheaper thing that covers the same need, then proceed. If the user
reaffirms, that is the decision: build the full version and never raise it again in that thread.

## This is NOT the Next.js you know

APIs, conventions, and file structure may all differ from your training data. **Read the
relevant guide under `node_modules/next/dist/docs/` before writing any code** and heed
deprecation notices. When instinct disagrees with the installed docs, the docs win. For
**Next.js 16 App Router + React 19** specifically:

- `params` / `searchParams` are **async** - `const { slug } = await props.params;`.
- Route components use the generated `PageProps<"/route">` / `LayoutProps<"/route">` types.
- Start from `01-app`, `03-architecture`, and `index.md` under `node_modules/next/dist/docs/`.

## Architecture: two planes, one inviolable boundary

- **Control plane** (this repo, TypeScript): UI, GraphQL API, data layer, deploy rendering.
- **deplo-agent** (Go binary, one per host, separate repo `DeploCloud/deplo-agent`): the ONLY
  thing that runs `docker` / shell / `fs` on any host. Reached over **gRPC + mTLS**.

**THE RULE (ADR-0006): the control plane NEVER touches a Docker socket or the host directly for
a per-app / host-coupled action.** Deploy, build, logs, console, metrics, files, stack
lifecycle, backups, backup destinations, volume copy and DB provisioning all
route `UI → GraphQL → lib/data/* → connectAgent(serverId) → agent`.

- `lib/infra/agent-client.ts` `connectAgent(serverId)` is the sole entry (mTLS, cert-fingerprint
  pinned at bootstrap). The Deplo host is itself "agent 0", **no in-process localhost shortcut**;
  local and remote take the identical path.
- **A backup destination is a bucket OR a server's disk** (ADR-0019). Which agent handles one
  is the single seam `destinationServerId` in `lib/data/destinations.ts`: the DESTINATION's
  server for `kind: "server"`, the workload's for `s3`. Getting it wrong is silent - retention
  would dial the app's host for an artifact living elsewhere. Bytes for a cross-host store
  relay THROUGH the control plane (agents are a star, they cannot dial each other), as
  **ciphertext**: the age wrap happens in the SOURCE agent's pipeline next to gzip, so nothing
  here ever holds plaintext. `lib/data/backup-transport.ts` owns all three shapes.
- Compose is rendered control-plane-side as **opaque YAML** and shipped to the agent:
  `renderCompose` (single-image) / `buildComposeStack` (multi) / `traefikRouterLabels` (the only
  Traefik label grammar) / `portFor` (ADR-0001, the only port reader). **Never port routing /
  compose / gateway logic into Go.**
- The **agent never holds the encryption key** - the control plane decrypts secrets and sends
  plaintext inside the mTLS RPC (single-image YAML) or a 0600 `--env-file` (compose stack).
- **Fails clearly, no in-process fallback**: a mandatory `Hello` pre-flight; an unreachable agent
  is a hard error, never a silent local build. New RPCs are additive (contract stays `V1`); gate
  host features behind Hello `capabilities[]`.
- **Don't generalize the exceptions:** installed **Plugins** (ADR-0005) are host-managed containers
  where Deplo _does_ own the socket (`lib/plugins/runtime.ts`) - a Plugin is not an App. That
  code is **dormant**: the feature is deferred (**ADR-0013**), so nothing installs a plugin and
  the only live caller is the boot sweep that removes ones an older version left behind. Don't
  wire anything new to it, and read ADR-0013 before reviving it - the return is expected to go
  through the agent, not the socket.
  `lib/deploy/build.ts` also retains a now-dead local build path + host `ensureNetwork`/`mkdir`;
  the live path passes `skipBuild:true → runAgentDeploy`. Don't mistake the dead path for a
  violation and don't revive it.

## Tech stack

Next.js 16 App Router · React 19 · TypeScript (strict) · Tailwind v4 (CSS-first) · shadcn/ui
(new-york) · Pothos code-first GraphQL over graphql-yoga · Drizzle ORM · Postgres · **Bun**
(package manager + runtime). **Better Auth IS the live login path** (ADR-0014) - its `user` model
is remapped onto the control-plane `users` table. Deploy execution is the Go agent over gRPC/mTLS.

## Project layout

- `app/(dashboard)/[team]/`: RSC pages, ALL of them under the team's slug (ADR-0031). Overview
  `page.tsx` is the one grid (projects → folders → apps) with drill-ins via
  `?project=&env=&folder=&q=&view=`. Sections: `apps/[slug]`, `deployments`, `logs`,
  `monitoring`, `storage`, `variables`, `members`, `activity`, `apps`, `templates`, `servers`,
  `settings/*`, plus `app/(focus)/[team]/new`. `app/(auth)/` - login/setup. Flat and outside the
  prefix: `/login`, `/setup`, `/register/*`, `/oauth/*`, `/welcome`, `/takeover`, `/api/*`, and
  `app/<section>/[[...rest]]` - one stub per legacy section, which redirects a pre-team address
  into the team that owns the resource (`lib/legacy-redirect.ts`).
- `app/api/graphql/route.ts`: the single API endpoint. Other `app/api/*/route.ts` are the REST exceptions (below).
- `lib/data/*`: data layer (`import "server-only"`), **the security boundary**.
- `lib/graphql/*`: Pothos builder, context, schema, and `types/*` domain modules.
- `lib/deploy/*`: compose/label/port rendering · `lib/infra/*` - agent client ·
  `lib/agent/*`: mTLS PKI + generated ts-proto stubs.
- `lib/db/*`: Drizzle client + `schema/` (`control-plane`, `auth`, `scheduler`, `columns`).
- `components/`: UI: `ui/` (shadcn primitives), `layout/`, feature folders.

## Commands (Bun) & environment

- `bun install` · `bun run dev` · `bun run build` · `bun run lint` (eslint).
- **Formatting is Prettier, and it is automatic** - `bun run format` / `format:check`. The
  pre-commit hook (`.githooks/pre-commit` → lint-staged, wired by `bun install`) formats what
  you stage, and CI's lint job re-checks it, so **never hand-align code to match a file**: write
  it and let the hook settle the wrapping. `prettier-plugin-tailwindcss` also sorts the classes
  in `className`, `cn()` and `cva()`. Generated output is out of scope (`.prettierignore`:
  `schema.graphql`, `lib/agent/gen/`, `lib/db/migrations/`), and the one-time sweep that
  reformatted the tree is listed in `.git-blame-ignore-revs`.
- **Required env to boot:** `DEPLO_DATABASE_URL` (Postgres - the app **fail-fasts at module
  load** if unset), `DEPLO_SECRET` (≥16 chars; derives every crypto key), `DEPLO_PUBLIC_URL`
  (sets the cookie `secure` flag + Better Auth https). See `.env.example`.
- **Tests:** `bun run test` - `node --test` + `tsx`, in-process against **pglite** (not
  Jest/Vitest, not real Postgres). Seed via `makeTestDb` + `__setTestDb`/`__resetTestDb`, drive
  inside `runWithIdentity({userId, teamId})`, use `*-test-helpers.ts` seeders (named to dodge the
  `*.test.ts` glob). `server-only-shim.cjs` no-ops the `server-only` guard.
- **DB (drizzle-kit, needs `DEPLO_DATABASE_URL`):** `bun run db:push` (dev, apply directly),
  `db:generate` (emit SQL + snapshot + `_journal.json` - commit all three; tests replay the
  journal), `db:migrate` (prod). Migrations **auto-apply at boot** via the `instrumentation.ts`
  hook (`lib/db/migrate.ts` → Drizzle migrator, idempotent, re-throws on failure); `db:migrate`
  stays available to apply them out-of-band.
- **CI is `.github/workflows/ci.yml`** - lint, tests, `tsc --noEmit` and `bun audit
--audit-level=high` on every push/PR, plus a weekly audit run so a newly-published advisory
  turns the repo red on its own. The tests job must keep `DEPLO_DATABASE_URL` **unset** (the
  suite is pglite in-process; a real URL makes the lease/scheduler tests bind to it and fail).
  The types job runs **`bunx next typegen` first**: `PageProps` / `LayoutProps` / `RouteContext`
  are GENERATED globals under `.next/types` (which `tsconfig.json` includes), so they exist on
  any machine that has run the dev server and on none that has not - a bare `tsc --noEmit` on a
  fresh checkout reports ~65 phantom "Cannot find name" errors while every local run is green.
  `typegen` emits them without a build and needs no environment. Run it before `tsc` in a clean
  tree too.
  `docker-image.yml` is separate and still fires only on a `v*` tag.
- **`overrides` in `package.json` are security pins, not preferences.** Three are left:
  `esbuild` (the only one still stopping a live advisory - `drizzle-kit` and `tsx` both pin
  ranges at or below 0.24.2), plus `postcss` and `js-yaml`, which still pull older copies into
  the tree when removed. `graphql` is a different animal: a FUNCTIONAL pin, because
  `graphql-yoga@5` peers `^15 || ^16` and will not take 17.
  **Re-check every pin when you bump anything** - the rule is empirical, not historical: drop the
  override, `bun install`, and read `bun audit` (bare, not `--audit-level=high`, or a moderate
  hides). If nothing appears and no lower copy reappears, delete the entry rather than leaving a
  stale one. That is how `nanoid`, `sharp`, `protobufjs` and `brace-expansion` were removed in
  August 2026: upstream had moved past all four, and the `brace-expansion` pin had become
  actively harmful - it held v1 while `eslint@10`'s minimatch needs the v2 `expand` export.

## API layer (Pothos + yoga)

Single endpoint `app/api/graphql/route.ts` (thin) → `lib/graphql/yoga.ts`. One `SchemaBuilder`
(`lib/graphql/builder.ts`) with `@pothos/plugin-scope-auth`.

- **Add a query/mutation** in `lib/graphql/types/<domain>.ts` via `builder.queryFields` /
  `mutationFields`; object types via `builder.objectRef<DTO>(...).implement(...)`, inputs via
  `builder.inputType(...)`. **Resolvers stay THIN** - delegate straight to a `lib/data/*`
  function. There is **no `lib/actions` dir and no `"use server"`**; former server actions were
  folded into resolvers.
- **A new module registers only if you add `import "./types/<name>";` to `lib/graphql/schema.ts`**
  (alphabetical, side-effect import).
- **Regenerate SDL after touching any `types/*`: `bun run gen:schema`**, which is
  `NODE_TEST_CONTEXT=1 node --require ./lib/test/server-only-shim.cjs --import tsx
scripts/gen-schema.ts`. Both halves of that prefix are load-bearing: the shim
  answers `MODULE_NOT_FOUND: server-only` (the builder pulls in `lib/data/*`, whose
  real entrypoint throws outside a Next build, and it is the same shim the test
  runner preloads), and `NODE_TEST_CONTEXT` answers the fail-fast in `lib/db/pg.ts`,
  which throws at module load without a database URL.
  `schema.graphql` is generated output, **never hand-edit**, and nothing auto-runs it (no hook,
  no CI drift check).
- Validation = **Pothos arg requiredness** + hand-rolled cleaners (`cleanName`,
  `normalizeHexColor`, `validateUsername`). Zod lives in only two files (`types/auth.ts`,
  `lib/plugins/manifest.ts`) - don't spread it.
- Auth mutations (`login`/`logout`/`completeSetup`, `types/auth.ts`) are intentionally **public**
  (no `authScopes`) and keep their rate-limiting; the route owns cookie writes.
- graphql-armor limits (depth 12 / aliases 30 / cost 5000) live only in `yoga.ts`.
- **Stays REST** (`app/api/*/route.ts`, cookie auth via `getCurrentUser()`, no bearer token):
  `apps/[id]/upload` (raw archive), `.../logs` (SSE), `.../attach`, `databases/[id]/logs` (SSE),
  `databases/[id]/attach` (SSE siblings of the app routes - reuse `lib/logs/session.ts` +
  `lib/attach/session.ts`), `github/webhook|callback|setup`, `auth/[...all]`, `agent/bootstrap`,
  `health`, `node-versions`, `railpack-versions`, `registry/images`.
  `avatar/[style]/[preset]/[seed]` is REST and **unauthenticated**: it renders a
  deterministic picture from the path and reads nothing, and onboarding shows the picker
  before an account exists. The styles and their presets are a FIXED list
  (`lib/apps/avatar-shared.ts`): four packs plus `initials`, each preset one of DiceBear's
  own published option sets - never a free-form option, never a style off the list.
  **Two exceptions to the cookie rule**, both authenticating with an API token
  (`Authorization: Bearer deplo_…`) and both re-entering the normal gates via `runWithIdentity`,
  never bypass them with a hand-rolled capability check:
  - `apps/[id]/deploy-hook/[token]` (the **deploy hook**): a webhook sender can't compose a
    GraphQL query, so it POSTs a URL and lets `redeploy` apply the gates.
  - `mcp` (the **MCP server**, ADR-0021): JSON-RPC, not GraphQL, because that is what AI agents
    speak. Every tool is a row in `lib/mcp/tools.ts` whose GraphQL document runs **in-process**
    against the same schema via `lib/mcp/execute.ts`, so the gates are literally the same code.
    Adding a tool is adding a row; adding an authorization check there is a bug - it belongs in
    `lib/data/*`. Regenerate nothing, but keep `lib/mcp/tools.test.ts` green: it validates every
    document against `schema.graphql`, which is what stops a renamed field from silently
    breaking sixty tools.

## Data & mutations (the security boundary)

- **Reads:** `lib/data/*`, wrapped in React `cache(async …)`, call `requireActiveTeamId()` and
  filter every query by `teamId`. **Never accept `teamId` or `userId` as a parameter** - resolve
  internally. Never select `*_enc` / `*_hash` columns into a DTO.
- **Mutations:** `const { teamId, userId } = await requireCapability(cap);` (don't also call
  `requireActiveTeamId`). Scope every row-targeting `UPDATE`/`DELETE` with
  `and(eq(t.id, id), eq(t.teamId, teamId))` so a cross-team id hits 0 rows; confirm via
  `.returning()` length or an `xInTeam` probe. ids via `newId("prefix")`, timestamps via
  `nowIso()`; multi-row writes in `getDb().transaction`.
- **Keep BOTH gates (defense in depth):** the field `authScopes` (introspectable contract) AND the
  `requireCapability` / `requireInstanceAdmin` call inside the `lib/data` function (the real
  boundary - `lib/graphql/context.ts` is a convenience snapshot, not the boundary). Resources
  under a **folder** need a second gate: `await requireFolderCapabilityForApp(appId, cap)`.
- Auth helpers: `getCurrentUser()` (nullable), `assertUser()` (**throws** - resolvers/data),
  `requireUser()` (**redirects** - RSC/pages). `recordActivity(...)` runs **outside** any open
  transaction (own connection; deadlocks pglite otherwise) and is fire-and-forget - but not
  silently lossy: it retries the insert once, and an entry it still could not write becomes a
  visible "N activity entries could not be recorded" row on the next successful write. A gap in an
  audit trail has to be legible **in the trail**, not only in stderr.
- **Capabilities are FINE-GRAINED (44)**: one action each, catalogued with labels,
  descriptions, search keywords and browse categories in **`lib/capabilities.ts`**
  (`create_apps`, `deploy_apps`, `delete_apps`, `open_app_console`, `rollback_apps` vs
  `control_apps`, `create_databases`, `restore_backups`, `manage_tokens`, `manage_mcp`,
  `organize_folders`, `manage_previews`, `view_logs`, `manage_roles`, `delete_team`, …). `view` is the always-on
  floor; plus instance-wide `instanceAdmin` and the orthogonal grants `canExposePorts` /
  `canMountHostVolumes`. **Never add a capability that covers two actions**, if an admin
  might want them apart, they are two. Picking the right one at a call site is the whole
  point: `deleteApp` is `delete_apps`, not `deploy_apps`.
  The eight coarse names (`deploy`, `manage_infra`, …) are RETIRED - migration 0056 expanded
  every stored row via `LEGACY_CAPABILITY_EXPANSION` (which is also what still translates an
  old name arriving from an API client). Never reintroduce one. `manage_files` is off that
  list since the Files browser went: both halves it expanded to are gone, so an API client
  sending it now gets an enum error rather than a silent nothing.
- **`canMountHostVolumes` gates EVERY way out of the container, not only a path.** A compose
  stack is user-written YAML shipped to the agent almost verbatim, so `privileged`, `cap_add`,
  `devices`, `pid|ipc|uts: host`, `userns_mode`, an unconfining `security_opt`, `cgroup_parent`
  and `device_cgroup_rules` reach the host exactly like a bind mount of `/` does, and for a while
  only the bind mount was gated, which made a plain **Member** one YAML key away from root on the
  server. `composeNeedsHostPrivileges` (lib/deploy/compose-lint.ts) is the detector, and both
  compose write paths (`createApp`, `updateAppSource`) put it behind the same grant as
  `composeHasHostBindMount`. Adding a compose key that escapes the sandbox means adding it to
  that list, and HARDENING is never gated (`no-new-privileges`, `cap_drop`, `read_only`), because
  a permission prompt in front of the safer choice is one people learn to route around.
- **An Environment owns a network, and nothing crosses it** (ADR-0028). A stack deploys onto
  `deplo-env-<environmentId>`, or `deplo-team-<teamId>` when the app has no Environment (top
  level or in a folder - folders never change the network). A preview gets its own. The name
  comes from ONE seam, `lib/deploy/network.ts` (`appNetwork` / `previewNetwork` /
  `deployNetwork`); never re-derive it. A managed database takes the same placement
  (`databases.environment_id`), so one rule covers both.
  **The compose KEY stays `deplo` and only its `name:` changes**, so a hand-written
  `networks: [deplo]` needs no rewriting of the service. `buildComposeStack` is still THE
  choke point: `aliases:` dropped, and every top-level key that RESOLVES to a network DEPLO
  OWNS - the platform's own OR another tenant's `deplo-env-*` / `deplo-team-*` /
  `deplo-preview-*`, by key or by `name:`/`external.name` (`sharedNetworkKeys`) - COLLAPSES
  onto the single `deplo` key. Rewriting beats refusing: the same YAML arrives from an import.
  **A service that declares no `networks:` joins `default`**, so a `default` aimed at another
  Environment's network is a join like any other - it read as no join at all, and that put a
  whole stack on a stranger's network past every gate. Every rule here reads that shape.
  **`network_mode:` is an ALLOWLIST (`none`, `default`), because every other value is a
  network NAME** - `network_mode: deplo-env-<id>` joins with DNS while `networks:` stays
  empty, and a denylist of the three keywords let every network on the host through. It is
  refused AT THE RENDER when it names a network Deplo manages (the platform's own with a
  compose project prefix included, so `traefik_deplo-socket` counts) or when it interpolates
  `$VAR` (braces optional - `$$` is compose's own escape and interpolates nothing): the
  value can come from the env-file, so no reading of the authored text sees it. A network
  Deplo manages includes another tenant's `deplo-<slug>_default` and the proxy's
  `<project>_deplo-socket`, but NOT somebody's own `myapp_deplo`.
  **EVERY service joins the stack's network, not only the routed ones** - a worker with no
  domain is still the app and still has to reach its Environment's database. Declaring
  your OWN networks does not opt out (`frontend`/`backend` is organisation, and reading it
  as "leave me alone" cut most stacks off from their own database); they are kept AND the
  Environment's is added. Exactly three stay off: a network marked `internal: true` (the
  one real request to be sealed), a `network_mode:` service (nothing to join), and one
  holding a RESERVED name - left off rather than refusing a render, since `postgres` is an
  ordinary name for a stack's own database, and the stack then keeps a private `default`
  so it is not split in two. A ROUTED service is wired regardless, or its domain answers
  nothing. **`composeNamesOnNetwork` is what a clash guard must ask** - not
  `composeClaimedNames`, which counts services the renderer never puts on the network and
  refused moves naming a container that is not there.
  **The reserved-name list is what Traefik still resolves by DNS.** It sits on every tenant
  network and dials `tcp://docker-socket-proxy:2375` and `http://deplo:3000`, so those names
  stay claimable and stay refused (`composeClaimsReservedName` early at save,
  `serviceReservedClaim` at render). The claim is case-insensitive and covers `hostname:`,
  because Docker's DNS registers it exactly like a service name. A managed database's
  `db-<slug>` is checked against the databases sharing that NETWORK, not the whole server.
  Inside one Environment two stacks may still claim one name; the deploy warns
  (`nameClashes`), it does not refuse.
  **The agent has no fallback**: it creates the network the request names - refusing a name
  that is not a tenant's - and connects Traefik to it, including after the `--force-recreate`
  a Traefik config apply does. The control plane gates the deploy on the agent's
  `deploy.network` capability, so an old agent is named rather than failing at `compose up`.
- **`canMountHostVolumes` gates the top-level `volumes:` block too**
  (`composeMountsForeignStorage`). `composeHasHostBindMount` reads SERVICE mounts and calls a source
  a host bind when it starts with `/` or climbs with `..`; a NAMED volume is neither, so
  `external: true` (or a pinned `name:`) attached an EXISTING volume by host name - the volume names
  are deterministic (`deplo-<slug>-<vol>`, and the control plane's own `…_deplo-postgres`), which
  reached another team's data and the control-plane DATABASE at rest - and
  `driver_opts: {type: none, device: /, o: bind}` was a bind mount of the host declared one level up
  from where the check was looking. Read on the AUTHORED compose, so Deplo's own render-time entries
  never trip it.
- **A preview base domain belongs to one team too.** A preview host never enters `domains`
  (`previewHost` builds `<slug>-pr-<n>.<base>` straight into a router, `letsencrypt` by default), so
  `assertHostnameNotAnotherTeams` cannot see it. `assertPreviewBaseNotAnotherTeams` is its twin, and
  it compares the whole ZONE in both directions: equal, ancestor or descendant is one team's claim.
- **A HOSTNAME belongs to one team.** `domains` is unique on `(name, coalesce(path_prefix,''))`,
  not on `name`, so one team can serve `app.com` on `/` and `app.com` on `/api` from two apps -
  that is a feature and it stays. Across teams it was a takeover: `servers.all_teams` defaults to
  true (so the attacker picks the victim's host), the victim's DNS already points there (so the row
  is born `valid`), and `traefikRouterLabels` pins a path router ABOVE the whole-host one on
  purpose - same-origin content under someone else's name. `assertHostnameNotAnotherTeams`
  (lib/data/domains.ts) is the refusal, on `addDomain` AND on the rename in `updateDomain`. Any new
  writer of `domains.name` needs it too.
- **Roles are per-team ROWS** (`team_roles`, `lib/data/roles.ts`), not TS presets: three
  editable/resettable defaults (Owner locked at full access) plus the team's own. A role edit
  re-writes `membership_capabilities` for its members in the same transaction, so **every
  authorization check stays a read of the member's effective capabilities**, never resolve a
  role at check time. `memberships.role` is the RANK (`owner` outranks); `role_id` NULL =
  hand-picked "Custom" set. New teams need no seeding call: `ensureTeamRoles` is lazy.
- **An API token may EXPIRE** (`api_tokens.expires_at`, NULL = never, which is what every token
  minted before it existed still is). Enforced in `identityForTokenRow` - before the team is
  picked, before the membership read, before the usage stamp, so one comparison covers GraphQL,
  MCP and the deploy hook at once. A new token defaults to 90 days in the editor; nothing sweeps
  an expired row, because the list has to be able to say _why_ a credential stopped.
- **`teams.mcp_enabled` defaults to TRUE for a new team** (migration 0146, reverting 0106;
  existing teams keep whatever they have). A token is required either way, so the switch was
  never what made `/api/mcp` safe - it is the team's kill switch, one click away on the MCP
  screen.
- **id prefixes not to confuse:** `prc_` = Project _container_, `prj_` = **App** (the deployable
  app, legacy mint); `environ_` = Environment, `env_` = env-**var** row; `role_` = a team Role;
  `deplo_` = raw bearer secret (sha256 at rest).

## Persistence, secrets, auth

- **Postgres is the only control-plane store** (`lib/db/pg.ts`, one bounded pool). There is **no
  JSON/document store** - the old `deplo_state` JSONB was fully normalized into ~55 tables; **never
  add a JSONB column** (nested → child table, list → ordered/junction table). `*_at` columns use
  the `isoTimestamptz` custom type, never plain `timestamp` (Better Auth tables aside).
- **`DEPLO_SECRET` derives every key** via `deriveKey(purpose)`: `secrets` (AES-256-GCM), `session`
  (HMAC), `state` (CSRF), `agent-mtls-ca` (CA seed), `better-auth`. Rotating it is destructive -
  all `*_enc` become undecryptable, all sessions invalid, every agent cert re-mints. No key
  versioning.
- **Three decrypt entry points, and picking the wrong one is silent.** `decryptSecret` is
  best-effort and answers `""` for BOTH "empty value" and "will not open" - fine for a masked
  display, wrong anywhere the answer is acted on. Use **`decryptSecretOrThrow(payload, what)`**
  wherever `""` would be used as a real value (the deploy edge, cron env, destination credentials,
  a git token), and `tryDecryptSecret` when you need to branch on the difference yourself.
- **Secrets are write-only / masked with no reveal path for the client.** `*_enc` ciphertext is
  never projected into DTOs; masked values decrypt only via `manage_env`-gated `reveal*` calls or
  at the deploy edge. **Never add a "show secret" affordance.** Anything RESOLVED into a rendered
  stack is masked on the way out by `redactComposeForDisplay` (`lib/deploy/compose-redact.ts`) -
  env values AND the basic-auth htpasswd label, which rides a Traefik label rather than
  `environment:` and so was readable at the `view` floor for as long as only the env pass existed.
- **Every env layer carries its `plain`/`secret` type, and the type is REQUIRED**
  (`EnvEntryType` in `lib/deploy/env-resolve.ts`). A preview of a FORK drops every secret-typed
  value, because the pull request's code is a stranger's; the filter reads `type`, and the two
  loaders that did not project the column (`loadSharedVarsForApp` and the instance-global
  one, now `loadAutoInjectedVarsForApp`) silently passed a whole team's shared secrets and
  every cross-team secret through it. Requiredness is the guard: a new loader that forgets
  does not compile.
- **Passwords are `scrypt$<N>$<r>$<p>$<salt>$<hash>`, async, with the cost as a stored parameter.**
  Raising `SCRYPT_PARAMS` in `lib/crypto.ts` is a one-line change: `verifyPassword` reads each
  hash's own parameters, the pre-parameter 3-field form still verifies, and `login()` re-hashes a
  weaker one in place on the next successful sign-in (`passwordNeedsRehash`). Both helpers are
  **async on purpose** - scrypt at this cost must not run on the event loop.
- **Every password a person CHOOSES gets two gates:** `assertPasswordPolicy` (sync, shared with
  the strength meter) and `await assertPasswordNotPwned` (`lib/pwned-password.ts`, the Have I Been
  Pwned range API, k-anonymous and **failing open** so no-egress instances still work). Both run on
  account creation, change-password, the admin reset, basic auth and a database's engine
  password - the last two only since the audit that found the doc claiming it and the code
  doing only half. The one carve-out is a GENERATED credential: a database password
  Deplo mints itself is `randomToken(24)`, which is base64url and would fail "at least 1 special
  character" about a third of the time, so the policy bounds only a password a person typed.
  Better Auth's own `/api/auth/*` endpoints are covered by the
  `haveIBeenPwned` plugin instead - Deplo's writes never reach them. External credentials
  (registry, SMTP, S3, git tokens) are deliberately NOT checked: Deplo cannot rotate them, so a hit
  would only break a working integration.
- **htpasswd credentials are bcrypt** (`htpasswdLine`, async like `hashPassword` and for the same
  reason). Traefik's `go-htpasswd` also reads the Apache MD5 (`$apr1$`) this used to emit; the hash
  lands in the proxy's compose file ON THE HOST, so 1000 rounds of MD5 was the wrong thing to leave
  there. Nothing on this side verifies these hashes, so there is no legacy format to keep reading.
- **Every user-supplied outbound address goes through `lib/outbound-url.ts` first**
  (`assertSafeOutboundUrl` / `assertSafeOutboundHost` for a bare SMTP host). S3 endpoints,
  notification webhooks, push endpoints and git base URLs are all on it; reaching inside the
  deployment is an `allowPrivateEndpoint` flag gated on `requireInstanceAdmin`, never on a team
  capability. A new `fetch` to an address a user typed is a hole until it is on this list.
  **Exactly one exemption**, named in that file: `probePanel` (`lib/data/instance-settings.ts`)
  dials the panel's OWN address, which is legitimately private on plenty of installs, so it asserts
  `requireInstanceAdmin` at the dialer instead. There is no second exemption.
- **The rate limiter (`lib/security.ts`) is Postgres-backed and `async`.** One UPSERT per attempt,
  so it survives a restart and works across instances; it **fails open** when the database is
  unreachable (a limiter that locks everyone out on a DB blip is worse than one that stops
  counting). `sweepRateLimits` runs in the maintenance sweep.
- **Better Auth is the live auth path** (ADR-0014, migration 0055): session cookie
  `deplo.session_token` (a real `session` row, `__Secure-` prefixed over https), configured in
  `lib/auth/better-auth.ts`. `deplo_team` still remembers the last team visited (ADR-0031) and
  stays Deplo's own.
  Three settings are load-bearing: `user: { modelName: "users" }` (its `user` model IS the
  control-plane table, never stand up a second one), `password: {hash, verify}` wired to Deplo's
  scrypt (change it and every credential dies), and `disableSignUp: true` (Better Auth must never
  INSERT into `users`, which has NOT NULL columns it knows nothing about). The credential lives on
  `account.password`; `users.password_hash` is GONE and `token_version` is dead - revoking sessions
  is `revokeAllSessions(userId)`. `lib/auth.ts` keeps its exported surface; only its internals moved.
- **The Better Auth route is mounted WHOLE, so its account surface is gated shut.** `/api/auth/*`
  has to exist for OAuth, and that also publishes a complete second account API. Three middlewares
  in `lib/auth/better-auth.ts` close what Deplo drives itself - `twoFactorGate`, `passkeyGate` and
  `deploOwnedGate` (`isDeploOwnedAuthPath`: sign-in/sign-up, change/set password, change email,
  update/delete user, the session list and the password-reset pair). All three discriminate on
  `ctx.request`, which exists only for a real HTTP call, so `auth.api.*({ body, headers })` from
  `lib/auth.ts` and `lib/data/*` is untouched. The reason is always the same: Deplo's own sign-in is
  the ONLY path that limits per ACCOUNT, raises `failed_logins` and refuses a suspended account -
  the plugin's endpoint has an in-memory limiter keyed on a caller-writable IP header and nothing
  else. **Adding a Better Auth endpoint means deciding which side of that list it is on.**
- **2FA is a POLICY, not a ninth capability.** `teams.require_two_factor` /
  `team_roles.require_two_factor`, both default false. Unmet ⇒ the member resolves NOTHING in that
  team, UI and bearer API alike. The gate is exactly two calls in `lib/membership.ts` -
  `membershipFor` (mutations + `authenticateToken`) and `requireActiveTeamId` (every read), and
  both are needed: reads never touch `membershipFor`. It raises `TwoFactorRequiredError`, which the
  dashboard layout catches to return a lock screen INSTEAD of its children.

## UI conventions

- **Default is RSC**; `"use client"` is leaf-ish (state/effects/forms). RSC pages `await`
  `lib/data`/`lib/auth`/`lib/membership` and pass plain props down.
- **Mutations go through GraphQL, not server actions.** Use `lib/graphql-client.ts` (`gql`,
  `gqlAction`) and the `useGraphqlMutation` hook (`useTransition` + auto `router.refresh()`).
  Inline the query string tagged `/* GraphQL */`. **No `revalidatePath`** - `router.refresh()`
  re-runs RSC reads; subscriptions via `gqlSubscribe` (SSE).
- **Toasts:** `import { toast } from "sonner"`; surface the server's message verbatim
  (`toast.error(res.error)`), don't invent generic copy.
- **Descriptive copy is SHORT and self-explanatory.** Every description, subtitle, empty state,
  tooltip and field help is one line a non-expert understands without stopping to parse it. Say
  what the thing does or what to do next; don't restate the control's own label, don't narrate
  implementation, don't explain Docker. If it needs a paragraph to make sense, the UI is wrong, not
  the copy. Errors and server messages are the exception: surface those verbatim.
- **The copy caps are a TEST, not a taste.** `copy-length.test.ts` fails the build over
  **120** characters in a modal description, **160** in an `info=` / `content=` tooltip and
  **200** in a muted paragraph - counted per BRANCH, so a ternary cannot hide a paragraph
  behind a condition. Over the cap means the sentence is carrying something the manual
  should: cut it and end the line with a `<DocsLink>`, never reword it to fit.
- **In a modal, the words that matter are WHITE.** `DialogDescription`, `SheetDescription`
  and a wizard's `lead` style their own `<strong>` as `text-foreground`, so the emphasis is
  a `<strong>` and nothing else - no `className="text-foreground"` at the call site, no
  second component. One phrase per description, the one the reader must not miss. This is
  a MODAL affordance: on a page the emphasis is the sentence being short.
- **A destructive confirm never puts the cost behind a link.** What the action destroys goes
  in the red box - `consequence=` on `ConfirmAction` / `DeleteWithArtifacts`, or
  `<ConsequenceNote>` in a hand-rolled dialog - in one concrete sentence. The description
  above it says what the action IS; the box says what it costs. Not both, and never the cost
  only in the manual.
- **The label names the thing; the tooltip carries the WHY.** Not "the tooltip carries everything":
  a tooltip does not exist on touch and screen readers lose it, and every major design system says
  so out loud - Vercel's own guidelines are "inline help first; tooltips last resort", Geist forbids
  wrapping a labelled input in one, Primer calls them "the last resort". So: the **label** is the
  noun. The **tooltip** (`FieldLabel info=` / `InfoTip`) carries the constraint, the limit or the
  reason - never a restatement of the label, never a description of an interaction. A **consequence
  of what you are about to do** stays VISIBLE (changing the server copies the data; this command
  will be detected, not skipped). Everything else is a docs page.
  What this kills is prose that explains a control the control could explain itself: "The archive is
  extracted and built with the Build & Output settings below. Use Save & Deploy to build and release
  it." Section hints, stage descriptions and "what this does" blurbs go in the title's tooltip.
  **The strongest version of this rule is not moving the words but removing the need for them** - an
  empty box behind an "(auto-detected)" placeholder needs a paragraph, and a row that shows who
  decides the value needs none (`components/shared/override-row.tsx`).
- **Never invent a name for a thing the world already names.** If a control, pattern or concept
  already has a label every user has seen a hundred times, use THAT label - exactly, not a
  synonym you find tidier. It is **"Select all" / "Unselect all"**, never "Select these" /
  "Clear these"; **Save**, **Cancel**, **Delete**, **Search**, **Copy**, **Rename**, **Duplicate**,
  **Import** / **Export**, **Sign in** / **Sign out**. A familiar word costs the reader nothing;
  a fresh one costs them a pause on every encounter, and a screenful of them makes a product feel
  like it was written by someone who had never used software.
  **Before writing any button, menu item or column header, check whether the repo already spells
  it** (`grep` the string across `components/`) and match the existing spelling - the same control
  must not be called two things in two places. Only invent a word when the thing itself is genuinely
  new, and then put it in `CONTEXT.md` so it stays the only spelling.
- **Field help lives in the tooltip:** `FieldLabel info={…}` / `InfoTip` (`components/ui/info-tip.tsx`) -
  don't duplicate it as helper text below the input.
- **A description under a title always gets a gap.** Any muted description stacked under its own
  title (setting rows, card subtitles, list rows, empty states) carries **`mt-1`**, or its wrapper
  carries `space-y-1`, never both. Two stacked lines with no spacing read as one cramped block; the
  4px is what separates them. The rule is global, not per-screen: a card that skips it misaligns
  with every sibling in the same grid.
- **Controls that sit on the same row are the same height.** A `Button` next to an `Input`,
  `SelectTrigger`, or any other form control must match its height, and the mismatch is real:
  `Button size="sm"` is **h-8** while `Input` / `SelectTrigger` / the facet triggers are **h-9**, so
  the house default (`size="sm"`) is the WRONG one on a toolbar and lands the button 4px short.
  Use the default size there and keep `sm` for rows that hold no input (a section heading, a card
  header, a table cell). **Fix any height discrepancy you find between an input and a button** -
  it is never "close enough", it reads as a broken row, and one short control makes the whole
  toolbar look misaligned. Same button in two homes: take the size as an argument
  (`const addButton = (size: "sm" | "default") => …`) instead of writing it twice.
- **An empty state does not repeat an action the screen already shows.** If the section heading or
  the toolbar above it already carries the button, the empty state gets a graphic, a title and a
  description - and nothing else. Give it an `action` only when it is the ONLY way to act: a target
  whose toolbar is hidden while the list is empty puts the button in the heading row instead, so
  there is exactly one at any moment. Reference: `components/env/env-manager.tsx`.
- **Every dialog with fields is a real `<form>` - Enter submits.** Wrap the body + `DialogFooter`
  in `<form className="grid gap-4" onSubmit={…}>` (matching `DialogContent`'s own grid, so the
  layout is unchanged), `preventDefault()`, and give the primary button `type="submit"` instead of
  an `onClick`. Keep its `disabled` guard - a disabled default button is exactly what makes Enter a
  no-op while the form is invalid. **Never fake it** with `onKeyDown={(e) => e.key === "Enter" && …}`.
  `Button` defaults to `type="button"`, so Cancel never submits by accident; a raw `<button>` you
  add inside a form must spell out `type="button"` itself. Pattern reference:
  `components/apps/create-folder-dialog.tsx`.
- **A page that is a header plus a tab bar has ONE vertical rhythm: `space-y-3`,
  everywhere.** The page wrapper (`PageHeader` → the tab bar) and the `Tabs` root (tab
  bar → its content) both carry it, so the same three pages cannot drift apart - MCP,
  Migrations and Storage had 6/8/6 and 6/10/none, and the same tab bar sat at a
  different height on each. 24px is too much between a title and the tabs that belong
  to it; they are one control, not two sections. This measure is for THIS shape only -
  a page of stacked cards keeps its own spacing, and `TabsContent`'s internal
  `space-y-*` is the content's business, not the rhythm's.
- **A dialog footer with exactly two controls SPLITS: the secondary far left, the primary far
  right.** Cancel is not a peer of the thing it cancels, and sitting next to it is how a stray
  click lands on the wrong one. Any other footer - a third button, a hint beside the buttons -
  keeps them together on the right, where a row of peers belongs. **`DialogFooter` does this
  itself**, by counting its children (`React.Children.toArray`, so a `{cond && <Button/>}` that
  renders nothing does not count): never hand it `sm:justify-between`, and pass `sm:justify-end`
  only to opt a two-control footer out. A primary that appears on a condition would move the
  secondary across the footer, so mount it always and disable it instead.
- **Status is shown LIVE** via `AppStatusBadge`/`AppStatusDot` (a `useLiveStatus`
  subscription), not the raw stored `status`. `idle`/`stopped` render **grey ("Stopped")**; red is
  reserved for `error`/`failed`.
- **Tailwind v4 is CSS-first, no `tailwind.config`.** Add tokens in `app/globals.css`
  (`:root`/`.dark` + `@theme inline`); **never hardcode colors** - use token utilities
  (`bg-background`, `text-muted-foreground`). App defaults to dark; theme is a **custom provider**
  (`useTheme` from `@/components/theme-provider`, not next-themes), zero-flash via the `theme`
  cookie read in `app/layout.tsx`. `cn()` from `@/lib/utils`; the only path alias is `@/* → ./*`.
- **An illustration NEVER draws a grey as white-with-alpha.** Every `*-graphic.tsx` and every
  animated or static illustration paints in **solid tokens at 100%**: if a grey is wanted, use the
  token that IS that grey. `foreground/40`, `primary/45`, `muted-foreground/25`, `bg-white/[0.04]`,
  `fillOpacity="0.65"` over a light fill - all forbidden, in both themes and in every state
  (`dim`, `off`, `done`, hover). It matters because `--foreground` and `--primary` are **near-white
  on the dark theme**: `stroke-primary/45` is not "a soft grey", it is white at 45%, and it renders
  as a washed-out smear that changes shade with whatever sits behind it. The three greys, recessive
  to prominent, are:
  **`--border`** furniture (floors, shelves, panes, tracks, vents) · **`--ring`** the drawn object
  that is not the subject (a machine, a socket, a crate, a clock face) · **`--muted-foreground`**
  the subject when it carries no colour. Colour beats stay what they were (`--success`, `--violet`,
  `--chart-*`, a brand gradient), and an alpha on a genuinely coloured token is fine - the ban is
  white and near-white only.
  **The one carve-out is MOTION:** an opacity that animates (a fade-in, a blink, a pulse, a packet
  arriving) is movement, not a colour choice, and stays. An opacity that is the element's resting
  shade is a colour choice, and gets replaced by the token for that shade.

## UX philosophy to preserve

- **Everything is scoped to the active team, and the URL is what names it** (ADR-0031):
  `/<team slug>/apps/web`. Paths are written FLAT in the code and take the prefix only at the
  navigation boundary - `withTeam()` inside `components/ui/link.tsx` and `lib/nav.ts`, which
  eslint makes the only way in. The `deplo_team` cookie is now just "the last team visited".
  **Servers are the one shared cross-team resource**, never team-scope server records.
- **A Project is an "advanced folder" with an environment dropdown - it has no page of its own.**
  It is browsed only on the Overview drill-in (`app/(dashboard)/[team]/projects/*` are redirect stubs);
  each Environment owns its own Apps and shared vars.
- **Every mutating action is capability-gated and enforced server-side.** UI `hasCapability` checks
  are cosmetic (hide/disable); the authoritative gate is `requireCapability` in the data layer.
- Secrets are write-only, status is live, Preview/app URLs are computed - favor derived-and-live
  over stored-and-stale.

## Vocabulary discipline

**The product is written `Deplo`, with a capital D - always, everywhere prose is read.** Docs,
comments, commit messages, UI copy, error strings, issue templates, log-facing sentences: capital D,
no exceptions. Lowercase `deplo` survives only where it is a MACHINE token that something matches on

- the npm package name, the `deplo` Docker network and compose key, the `deplo-agent` binary, the
  `deplo_` id prefix and `deplo.*` labels, the `deplo` Postgres role, `deplo.build`, `DeploCloud/deplo`,
  the `[deplo]` log prefix, the WebAuthn `rpName` / TOTP issuer, and paths like `/opt/deplo`. If
  changing the case would change what a program does, it stays lowercase; if a person reads it as a
  sentence, it is `Deplo`.

Use **CONTEXT.md's exact terms**; avoid its banned synonyms. **App** (the deployable unit, never
"service"/"project"; a bare compose "service" is a different thing) · **Project** (the
container-folder, never container/group/folder) · **Capability** (never permission/scope/grant) ·
**server agent** / "the owning server" (never bare agent/node/worker/daemon) · **Plugin** (an
installed catalog feature, never an App - deferred, see ADR-0013) · **active team** (never current/selected) ·
**Environment** (never "env target"). If a concept isn't in the glossary, you're probably inventing
language - reconsider, or note the gap.

## Working rules

- **Issues & PRDs = GitHub Issues in `DeploCloud/deplo` via the `gh` CLI** (`docs/agents/issue-tracker.md`);
  triage with the five canonical labels (`docs/agents/triage-labels.md`).
- Check `docs/adr/` before working an area; flag contradictions explicitly rather than overriding.
- **New behaviour ships with its tests, in the same commit.** A feature or a fix that changes
  behaviour and adds no test is unfinished; if it genuinely cannot be tested, say so in the
  commit body.
- **Docs live in another repo, and they ship with the feature.** The user manual is
  `DeploCloud/docs` (Fumadocs, `content/docs/**/*.mdx`), served at <https://deplo.build/docs>.
  Never add a user-facing page here. Every feature, changed behaviour or renamed control ends
  with **one question to the operator: "does this need a docs page?"** - inside the plan when
  the task has one, otherwise before the task is called done. Never write docs without that
  answer, and never skip the question because the change "looks internal". Clone at
  `/root/projects/deplo-docs`, `git pull` before touching it (that repo moves under you), and
  follow its own `AGENTS.md` for how a page is written.
- **Commits = Conventional Commits with a scope**: `type(scope): imperative lowercase summary`
  (`feat(apps): redeploy a stack from the app page`). **Title 50 characters or fewer, no trailing
  period.** Body only when the why does not fit the title, 2-3 lines at most. Commit straight to
  `main`; never create a branch.
- **Comments are few and short - hard cap about 3 lines per block.** No file-header essays, no
  design narratives, no numbered rationale lists, no art direction above an illustration. Where a
  feature has a docs page, one link replaces the explanation
  (`// https://deplo.build/docs/guides/data/backups-and-restore`). Cite an ADR in one line when it is
  the reason; pragmas, `@ts-expect-error`, `eslint-disable` and its paired `eslint-enable`,
  `/* GraphQL */` and `ponytail:` markers are code and stay untouched.
- **Never name a competitor in source.** Not in a comment, not in a string, not in UI copy: Deplo
  does not say who it learned from. The only names that stay are functional - a build tool
  (`nixpacks`, `railpack`), an image ref, and the source system of the migration importer, which
  the user has to recognise to use it.
- **Never bump the version on your own initiative.** A finished task is a commit, not a release:
  no `chore(release):` commit and no tag unless the owner explicitly asks for one. Deplo is in
  beta, so a release is `0.x.y` - **minor** when the user notices (feature, changed behaviour, DB
  migration, needs a newer agent), **patch** for everything else, and `1.0.0` is the launch, which
  is the owner's call. One command does the whole thing and makes tag/file drift impossible:
  `bun pm version minor --message "chore(release): Deplo %s"` then `git push --follow-tags`. Full
  procedure in `docs/agents/releasing.md`. `deplo-agent` versions on its own clock (also `0.x`
  since 24 Aug 2026) and the fleet only ever moves forward (`docs/agents/fleet-rollout.md`).
- **Stop what you start, including :3000.** Any build or server you launch to work a task (dev
  server, test server, watcher, Playwright harness) MUST be stopped once the task is 100% done,
  never leave it running in the background. **This includes the control plane on :3000: if YOU
  (re)started it, e.g. rebuilt + relaunched it to verify a change, you MUST stop that process
  when done (`kill <the PID you spawned>`), never leave a detached `setsid`/`nohup` control plane
  behind.** The owner runs :3000 themselves, attached to their own terminal, and a background
  copy you spawned takes it out of their hands. Only a :3000 that was already running before you
  touched it (and that you never restarted) is meant to stay up - don't kill that one. Kill the
  specific PID you spawned; **never `pkill -f next-server`** (it kills deployed apps).
