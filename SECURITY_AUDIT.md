# deplo — Security Assessment Report

**Assessment type:** Authorized, non-destructive security review (code, architecture, authorization, deployment surfaces)
**Target:** deplo control plane (Next.js 16 / React 19 / TypeScript / Pothos GraphQL / Drizzle / Postgres), plus its deployment/compose rendering and integration surfaces
**Date:** 2026-08-16
**Method:** 3 independent passes (Architecture & Code Review → Access-Control Review → Adversarial Validation), fanned out across 6 domain auditors and consolidated + re-verified by hand
**Constraint honored:** no code, configuration, or data was modified; all validation was read-only or a controlled, reversible check (DNS resolution, code tracing). No exploitation against live tenant data.

> Note: the working tree was being edited by a parallel session during the audit (uncommitted changes to `apps.ts`, `compose-lint.ts`, `compose-stack.ts`, `domains.ts`, `install.sh`, `docker-compose.yml`). Findings are anchored on stable function names + quoted snippets; re-pin line numbers before acting.

---

## 1. Executive Summary

deplo's authorization core is **mature and, in most areas, exemplary.** The control plane enforces a genuine server-side boundary (`lib/data/*`): fine-grained capabilities, a live token scope-clamp, per-folder grants, a 2FA policy gate on both reads and writes, instance-admin-per-token, constant-time webhook HMAC, single-use bootstrap with cert-fingerprint pinning, and consistent "load-then-gate, return not-found for cross-team ids" discipline. Three prior audits are visible in the git history and the defenses they added hold up.

The residual risk is concentrated in **one surface: the compose rendering path.** deplo lets a team member submit near-arbitrary Docker Compose YAML, gates it with **write-time string-matching detectors** (`lib/deploy/compose-lint.ts`), and ships it **verbatim** to the host agent with no deploy-time re-validation. Every escape route the detector fails to enumerate is a live bypass — and the audit found three, one of them a full cross-tenant container escape reachable from a plain team capability. This is the same denylist-completeness class as the `privileged:` hole a previous audit closed; the structural fix is to stop trusting an enumerated denylist for a sandbox boundary.

| Severity | Count | Headline |
|---|---|---|
| **Critical** | 1 | Cross-tenant container escape via `pid:`/`ipc: "container:<name>"` (ungated) |
| **High** | 3 | SSRF via numeric-IP SMTP host · cross-team hostname takeover via raw `traefik.*` labels · `network_mode: host` port/loopback bypass |
| **Medium** | 2 | API-token scope containment bypass on app transfer · registry-client redirect SSRF |
| **Low** | 5 | First-run setup TOCTOU (2nd admin) · fleet-wide metrics wipe from a team cap · empty DB password under rotated secret · `github/setup` no state param · misleading capability description |
| **Informational** | 13 | Hardening notes, accepted ceilings, latent footguns, test-coverage gaps |

**Top remediation priorities:** (1) the compose sandbox — gate the `container:` namespace form, `network_mode: host`, and strip/allowlist user `traefik.*` labels, and add a deploy-time re-lint so a write-time miss is not the only line of defense; (2) the SMTP-host SSRF (a one-line strict-dotted-quad / `isIP()` fix); (3) the registry redirect SSRF (`redirect: "manual"`).

### Remediation status (this change)

All findings above were remediated in the same change set **except L-2, which was assessed and accepted as by-design** (see its entry). **Fixed:** C-1, H-1, H-2, H-3, M-1, M-2, L-1, L-3, L-4 (documented — the mitigation is real), L-5, I-1, I-4, I-6 — each with a focused regression test where it carries logic; the full suite, `tsc`, and lint are green. **Accepted (won't-fix):** L-2 — `setSaveMetrics` is a global infra toggle whose dedicated `manage_monitoring` capability is its only API gate; forcing it to instance-admin orphans that capability and would require retiring it (a migration + capability-model change), disproportionate for a transient, non-disclosing effect. The remaining Informational items (I-2, I-3, I-5, I-7 … I-13) are latent/accepted notes, left as documented.

---

## 2. Scope

**In scope (audited):**
- AuthN/AuthZ: capabilities (`lib/capabilities.ts`), roles (`lib/data/roles.ts`), membership + token clamp + 2FA gate (`lib/membership.ts`), folder/app/project node grants (`lib/data/node-access.ts`, `node-scope.ts`, `folder-access.ts`).
- Session/account: Better Auth integration + gates (`lib/auth/better-auth.ts`, `lib/auth.ts`), sessions, passkeys, 2FA, instance-owner/ownership transfer, registration links.
- API surfaces: the single GraphQL endpoint + hardening (`lib/graphql/yoga.ts`, `mask-error.ts`, `playground.ts`), all REST routes under `app/api/*`, the MCP server (`lib/mcp/*`), deploy hooks, git/GitHub webhooks + callback/setup.
- Tenant isolation: cross-team IDOR/BOLA across ~28 `lib/data/*` domains; token scope confusion; folder-scope enforcement.
- Deployment: compose rendering/gating (`lib/deploy/*`), preview deployments, rollback, cron/backup schedulers, server/agent management, custom server certificates, docker cleanup.
- Secrets: encryption entry points, DTO projection, redaction, env resolution + fork isolation, logs/files/console/build-output access control.
- SSRF / injection: outbound URL guard (`lib/outbound-url.ts`) and every user-supplied-address dialer; path traversal; command/YAML injection into the agent.
- Web platform: CSP/headers/CORS (`proxy.ts`, `next.config.ts`), CSRF posture, rate limiting.

**Out of scope (control-plane audit boundary):**
- The Go host agent (`DeploCloud/deplo-agent`) internals — a separate repository/binary. Where a defense is claimed to be enforced agent-side (e.g. the file-path sandbox, compose execution), that enforcement was **not** verified here.
- Live exploitation against production tenant data; infrastructure/OS hardening of the host; third-party dependency CVEs beyond what `bun audit` already gates in CI.

---

## 3. Methodology

Three independent passes, per the engagement brief:

1. **Architecture & Code Review** — mapped the two-plane architecture, the `lib/data` security boundary, the capability model, the enforcement primitives (`requireCapability`, `requireActiveTeamId`, `requireInstanceAdmin`, `clampToToken`, `requireTeamWide`, `requireFolderCapabilityForApp`), and the request/identity flow (cookie vs bearer, ALS `runWithIdentity`).
2. **Access-Control & Security Review** — systematically checked privilege escalation, IDOR/BOLA, authorization bypass, scope confusion, and tenant isolation across every mutating and team-wide-read data function, plus SSRF/injection/secret-exposure classes. Frontend was treated as untrusted throughout; only server-side enforcement was credited.
3. **Adversarial Validation** — re-derived each candidate from the source, confirmed reachability and precondition, and ran controlled non-destructive checks (guard-verdict-vs-resolver DNS comparisons for the SSRF findings; end-to-end reachability tracing for the compose findings). Findings that could not be confirmed are marked *Needs Validation* with the missing evidence named.

Execution: 6 parallel domain auditors (compose/deploy; capability & tenant isolation; tokens/MCP/webhooks; SSRF/servers/certs; auth/sessions/2FA; secrets/env/preview), each instructed to return concrete `file:line` evidence and to report negative results. Every Critical/High/Medium was then re-verified by hand against the source.

---

## 4. Limitations

- **Agent side unverified.** Several defenses (the file-path realpath sandbox, compose execution, container isolation) are enforced in the Go agent, which was not in scope. A control-plane guard that is *also* claimed agent-side was credited only for its control-plane half.
- **Moving target.** A parallel session edited security-relevant files mid-audit; line numbers may have drifted (function names/snippets are stable).
- **No live exploitation.** SSRF was validated by comparing the guard's verdict against what Node's resolver returns for the same host (DNS only, no internal dial). Compose findings were validated by code path, not by deploying a malicious stack against production.
- **Reference deployment assumed.** Impact ratings for the compose findings assume the documented **single-box** install (control-plane Postgres + tenant containers on one Docker daemon). On a fleet where tenants are isolated to dedicated hosts, the cross-tenant reach of Finding 1 is bounded to co-located tenants.

---

## 5. Results by Pass

**Pass 1 (Architecture & Code Review):** The boundary is real — resolvers are thin and delegate to `lib/data`, which is the only place authorization is decided (the sole DB-touching resolver is the documented public pre-auth `auth.ts` path). The capability model is fine-grained (46 caps, one action each) with an always-on `view` floor and orthogonal `canExposePorts`/`canMountHostVolumes` grants. Web hardening (strict nonce CSP, `cors:false`, `requireJsonPost`, masked errors, graphql-armor limits) is solid. The one architectural weak point identified: the compose write path uses a denylist detector and ships user YAML verbatim to the agent.

**Pass 2 (Access-Control & Security Review):** No Critical/High/Medium cross-team IDOR/BOLA or capability-escalation was found in the data layer across 28 domains — every app-shaped write routes through `requireAppCapability` (team + ownership + folder + token-scope), team-wide collections call `requireTeamWide`, and node grants re-apply the token clamp. The escalation guard `withinActor` *throws* on any capability beyond the actor. The exploitable findings surfaced instead at the **edges**: the compose→agent path (Pass 1's weak point, three findings), two SSRF sinks, and one token-scope containment gap on the cross-team app-transfer action.

**Pass 3 (Adversarial Validation):** All Critical/High/Medium findings were confirmed against the source; the two SSRF findings were additionally reproduced at the guard/resolver level. Adversarial checks that came back clean (and thus produced no finding): label-based scope spoofing (`deplo.project` is injected and overrides on every service), preview fork secret-drop (`isFork` is server-derived from an HMAC-signed payload; all four env loaders project the required `type`), path traversal (`normalizeRel` + realpath containment), the token clamp on node grants, and the app-transfer *source*-side gates.

---

## 6. Findings

### CRITICAL

---

#### C-1 — Cross-tenant container escape via ungated `pid:` / `ipc: "container:<name>"`

- **Severity:** Critical · **CVSS 3.1:** ~9.3 (`AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:L/A:H`) · **Confidence:** High — CONFIRMED by reading
- **Component:** `lib/deploy/compose-lint.ts` → `hostPrivilegeKeys()` (the `pid`/`ipc`/`uts` branch); gate call sites `lib/data/apps.ts` `createApp` / `updateAppSource`.
- **Description:** The host-privilege detector treats `pid`/`ipc`/`uts` as escapes **only when their value is the literal string `host`**:
  ```ts
  if (key === "pid" || key === "ipc" || key === "uts") {
    if (typeof v === "string" && v.trim().toLowerCase() === "host") out.push(key);
    continue;
  }
  ```
  Docker Compose also accepts `pid: "container:<name-or-id>"` and `ipc: "container:<name-or-id>"`, which place the new container **inside the namespace of an existing container** — and this form is **not restricted to the same compose stack**. The detector's own docstring acknowledges the `container:` form ("and, for pid/ipc, another `container:` in the same stack") but the code never checks for it and the value is unconstrained. Because the gate runs only at write time and `buildComposeStack` passes `pid`/`ipc` through to the agent verbatim (no deploy-time re-lint), the key reaches `docker compose up` unchanged.
- **Precondition:** any member holding `create_apps` (create) or `configure_apps` (edit source) — a normal team capability. **No `canMountHostVolumes`, no instance-admin.** The target container must be running and its name known; deplo container names are deterministic (`deplo-<slug>`, the platform `…deplo-postgres`) and enumerable via the shared network.
- **Impact:** Joining another container's PID namespace exposes `/proc/<pid>/cmdline` (secrets passed as arguments) and the full process list of the victim; where the target runs as the same uid (root, the default for many official images, with no user-namespace remapping on the reference install) it also exposes `/proc/<pid>/environ` — the victim's **environment variables**, i.e. database passwords, API keys, and the platform Postgres credential. `SIGKILL` of the victim's processes is unconditional (cross-tenant denial of service). `ipc: "container:<victim>"` shares SysV/POSIX shared memory.
- **Realistic abuse:** A tenant with `create_apps` creates an App whose compose declares a service with `pid: "container:<platform-postgres-or-another-tenant>"`. On deploy, the container shares the target's PID namespace; the tenant reads the target's environment and process arguments (secret disclosure across the tenancy line) and can kill the target's processes at will.
- **Evidence:** `hostPrivilegeKeys` matches only `"host"` (quoted above); `HOST_PRIVILEGE_KEYS` includes `pid/ipc/uts` but the branch under-checks them; `composeNeedsHostPrivileges` is referenced only in `compose-lint.ts` and the two `apps.ts` write paths — no deploy-time re-lint in `build.ts`/agent-deploy; `buildComposeStack` rewrites volumes/labels/env but never touches `pid`/`ipc`.
- **Why existing controls are insufficient:** `canMountHostVolumes` is meant to gate *every* way out of the sandbox, and `HOST_PRIVILEGE_KEYS` lists `pid`/`ipc` — but the *value* check only recognizes `host`, so the `container:` escape is invisible to both the server gate and the editor lint (the user gets no warning either).
- **Limiting conditions:** full `/proc/environ` read depends on the target container's uid and `ptrace_scope`; `cmdline` disclosure and DoS are unconditional. Requires the target container name (deterministic/guessable) and that it be running. On a fleet that isolates each tenant to its own host, reach is bounded to co-located tenants + platform containers on that host.
- **Remediation (do not apply here):** In the `pid`/`ipc` branch, flag any non-empty string that is not a bare namespace mode — treat `container:*` (and `service:*`) as an escape, not only `host` — so it falls under `canMountHostVolumes`. Add a deploy-time re-lint so a write-time detector miss is not the sole defense. `uts: container:` is low-impact (hostname only) but should be included for completeness.

---

### HIGH

---

#### H-1 — SSRF: non-canonical numeric IPs bypass `assertSafeOutboundHost` (SMTP host sink)

- **Severity:** High · **CVSS 3.1:** ~7.1 (`AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N`) · **Confidence:** High — CONFIRMED (code + reproduced at the resolver level)
- **Component:** `lib/outbound-url.ts:103` (early return) + `:116` (`isInternalHost` v4 regex); sink `lib/notify/email.ts:78`; save-path `lib/data/notifications.ts` (`saveNotificationChannel`, `sendTestNotification`).
- **Description:** The bare-host guard short-circuits before DNS for anything that looks like a literal:
  ```ts
  if (isInternalHost(host)) refuse();
  if (/^[\d.]+$/.test(host) || host.includes(":")) return;  // "already a literal, skip DNS"
  ```
  but `isInternalHost` only recognizes an internal address in **canonical dotted-quad** form (`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$`). Non-canonical IPv4 — 32-bit decimal (`2130706433`), octal (`0177.0.0.1`), or dotted-shorthand (`127.1`, `10.0.1`) — fails that regex, so `isInternalHost` returns false, and the `/^[\d.]+$/` line then returns early **without resolving**. Node's `getaddrinfo` (glibc `inet_aton`) later dials the real internal address. The URL sink (`assertSafeOutboundUrl`) is **not** affected because `new URL()` canonicalizes numeric hosts before the check; only the bare-host SMTP path skips canonicalization.
- **Precondition:** a team member with `manage_notifications` (team-level, **not** instance-admin).
- **Impact:** Blind/semi-blind SSRF from the control plane: internal TCP port scanning (connect success/refusal/timeout is surfaced verbatim in the error), reaching internal SMTP relays, banner disclosure, and TCP-connecting the cloud-metadata IP (`169.254.169.254`). The SMTP sink constrains exfiltration to connectivity/banner rather than arbitrary HTTP-body read.
- **Realistic abuse:** Create an email alert channel with SMTP host `2852039166` (= `169.254.169.254`) or `127.1` and an arbitrary port; press **Test**. The control plane's nodemailer dials the internal address:port.
- **Evidence (resolver-level reproduction):** `host="127.1"` → guard PASSES (no DNS) → `dns.lookup` → `127.0.0.1`; `host="2852039166"` → guard PASSES → `169.254.169.254`; `host="3232235777"` → `192.168.1.1`.
- **Why existing controls are insufficient:** every *other* private-endpoint dialer (S3, git) requires `allowPrivateEndpoint` → `requireInstanceAdmin`; the SMTP host reaches private space with only a team capability, defeating exactly the control the module documents. The guard is present but holed on the bare-host path.
- **Limiting conditions:** SMTP protocol constrains response exfiltration; over-blocks one benign public host (`010.0.0.1`) as a harmless side effect.
- **Remediation:** On the bare-host path, only skip DNS for a strict dotted-quad (4 octets, each 0–255), or use `isIP(host)` from `node:net` (returns 0 for these forms). Non-canonical numerics then fall through to `dnsLookup`, canonicalize, and are caught by `isInternalHost`.

---

#### H-2 — Cross-team hostname takeover via user-authored `traefik.*` compose labels

- **Severity:** High · **CVSS 3.1:** ~7.5 (`AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:H/A:L`) · **Confidence:** High on mechanism
- **Component:** `lib/deploy/compose-stack.ts` → `mergeLabels()` and the shared-network choke point; contrast `lib/data/domains.ts` `assertHostnameNotAnotherTeams`.
- **Description:** deplo treats the `domains` table as the *only* routing source and refuses a hostname owned by another team on `addDomain`/`updateDomain`. But a compose stack carries raw `labels:`, and `mergeLabels` preserves every user label whose **key** does not collide with deplo's injected set:
  ```ts
  if (typeof l === "string" && !incoming.has(keyOf(l))) existing.push(l); // user traefik router labels survive
  ```
  There is no `traefik.*` filtering in the compose path. A member can therefore ship a service with `traefik.enable=true`, `traefik.http.routers.evil.rule=Host(\`victim-app.com\`)`, and `traefik.http.routers.evil.priority=1000`, and attach it by hand to the shared `deplo` network. The shared-network choke point strips `aliases:` and refuses the four reserved service **names** (`deplo`/`postgres`/`traefik`/`deplo-traefik`), but does not touch traefik router labels. Traefik runs `--providers.docker.exposedbydefault=false`, so the opt-in requires `traefik.enable=true` — which the user simply adds and `mergeLabels` keeps. The result is a router for another team's hostname that never passed `assertHostnameNotAnotherTeams`; a higher `priority` wins the conflict.
- **Precondition:** member with `create_apps`/`configure_apps`, on the same threat model deplo already accepts for the domains table (an `all_teams` server — default true — the victim's DNS points at).
- **Impact:** Same-origin content served under the victim's hostname (phishing/credential capture against the victim's users, response tampering) — the exact cross-team takeover class `assertHostnameNotAnotherTeams` exists to prevent, through a door that guard does not cover.
- **Evidence:** `mergeLabels` (quoted); no strip/`isOurs` filter on `traefik.` in the app-compose path; `exposedbydefault=false` in `install.sh`/`install-agent.sh`; reserved-name block covers names only.
- **Why existing controls are insufficient:** the hostname-ownership guard lives on the `domains` writer; raw compose labels are a second, un-gated routing source.
- **Limiting conditions:** the single-image render path (`renderCompose`) is unaffected (labels built from scratch, no user labels); requires a custom-proxy operator not to diverge from deplo's defaults.
- **Remediation:** In `buildComposeStack`, drop user-authored `traefik.*` labels (or allowlist only deplo's own) so routing is exclusively the `domains` table, mirroring the single-image path.

---

#### H-3 — `network_mode: host` bypasses `canExposePorts` and reaches host-loopback services

- **Severity:** High (single-box) / Medium (isolated fleet) · **CVSS 3.1:** ~6.8 (`AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:L`) · **Confidence:** High that it deploys + bypasses the port grant
- **Component:** `lib/deploy/compose-lint.ts:742` (docstring) + omission from `HOST_PRIVILEGE_KEYS`; not covered by `composePublishesPorts`.
- **Description:** `network_mode: host` is deliberately excluded from the host-privilege set on the stated grounds that it "grants nothing on the host." That justification is incorrect. An unrouted service with `network_mode: host` is never wired to the `deplo` network and never stripped, so it deploys in the **host network namespace**, which (a) lets the container bind any host port with no `ports:` declaration — a direct `canExposePorts` bypass — and (b) reach `127.0.0.1` services on the host (on the reference install, the control plane on `:3000`), plus the metadata IP. It is a warning-only rule in the linter and blocks nothing at write time.
- **Precondition:** member with `create_apps`/`configure_apps`; **no `canExposePorts`, no `canMountHostVolumes`.**
- **Impact:** Publish arbitrary host ports without the grant that exists to control exactly that; reach host-loopback-bound services and the metadata endpoint from inside a tenant container.
- **Evidence:** `network_mode` absent from `HOST_PRIVILEGE_KEYS`; only a linter warning ("won't be reachable via your domain"); `composePublishesPorts` reads only `ports:`/`expose:`.
- **Why existing controls are insufficient:** the "breaks Traefik routing" rationale addresses discoverability, not host-port binding or loopback access.
- **Limiting conditions:** loopback-reachability impact depends on what the host binds on `127.0.0.1`; the port-binding bypass is unconditional.
- **Remediation:** Gate `network_mode: host` behind `canExposePorts` (at minimum).

---

### MEDIUM

---

#### M-1 — API-token scope containment bypass in `transferAppToTeam`

- **Severity:** Medium · **CVSS 3.1:** ~5.0 (`AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N`) · **Confidence:** High (check absent); the *severity* is design-ambiguous (see below)
- **Component:** `lib/data/app-transfer.ts` `transferAppToTeam`; enabled by `lib/membership.ts` `clampToToken` (returns unclamped for a team other than the token's). Reachable via GraphQL `transferAppToTeam` and MCP `transfer_app_to_team`.
- **Description:** The **source** gates (`requireAppCapability(appId,"move_apps")` + `"manage_env"`) are token-clamped. The **destination** gate is not:
  ```ts
  const dest = await membershipFor(userId, destTeamId);          // human's caps, NOT token-clamped
  if (!dest.capabilities.includes("move_apps")) throw ...
  // no check that destTeamId ∈ token.scope.teamIds
  ```
  `clampToToken` short-circuits (`return caps`) whenever the resolved team differs from the token's team, so for the destination it returns the *human's* raw capabilities. An API token scoped to whole team A (which retains `move_apps`, since it is not narrowed below team level) can transfer an app from A into team B — outside the token's scope — carrying its **encrypted environment variables**, and writes an activity row in B.
- **Precondition:** a token scoped to specific whole teams that names the source A but not the destination B; the token holds `move_apps`+`manage_env` on the source app; the token's creator is a member of B with `move_apps`.
- **Impact:** Defeats the blast-radius containment a scoped token is meant to provide: a compromise of a token deliberately scoped to A can relocate an app and its secrets into B and write into B. No *new human* gains secret access (the creator already had it in B).
- **Evidence:** `app-transfer.ts` destination block (quoted); `membership.ts:301` clamp short-circuit; `app-transfer.test.ts` drives only cookie sessions — no bearer-token destination test.
- **Why existing controls are insufficient:** the MCP/GraphQL acting-team validation (`forTeam`) checks the *acting* team (the source, in scope); the destination is a data argument that skips it.
- **Limiting conditions:** requires the token's creator to be a member of both teams with `move_apps`; the token loses reach to the app after the move.
- **Remediation:** When `currentIdentity()?.token?.scope` is present, refuse a `destTeamId` not in `scope.teamIds`.

---

#### M-2 — SSRF: registry client follows redirects into private addresses without re-validation

- **Severity:** Medium · **CVSS 3.1:** ~6.1 (`AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:N/A:N`) · **Confidence:** High — CONFIRMED (code + reproduced)
- **Component:** `lib/registry/client.ts` (`fetchJson`, `ociToken` realm follow, `checkImageExists` HEAD); reachable via `app/api/registry/images/route.ts` and `app/api/database-versions/route.ts`.
- **Description:** The SSRF guard `isPublicHttpsUrl` validates only the **initial** URL. None of the three fetches set `redirect: "manual"`, so Node follows 3xx by default and each redirect hop is unchecked. A public host the attacker controls can 302-redirect to a loopback/RFC1918/metadata address; the fetch follows it and returns the internal response.
- **Precondition:** **any logged-in user** (no capability — documented as intentional so the image-hint UI works). The `image=`/`q=` params control the registry host.
- **Impact:** `action=tags` surfaces the internal endpoint's JSON body (data exfil where the shape matches); `action=exists` leaks open/absent/private status (internal port scan). The `ociToken` realm-follow is a second instance.
- **Evidence:** the three fetches lack `redirect:"manual"`; reproduced with a public host redirecting to loopback returning an internal body. Note the inconsistency: `lib/notify/channels.ts` and `lib/git/providers.ts` **do** set `redirect:"manual"` with comments naming this exact attack — the registry client is the lone dialer that doesn't (and the route's docblock wrongly claims it guards every hop).
- **Why existing controls are insufficient:** the guard checks the first URL only; a 302 is the other way out of a checked URL, as the module's own siblings document.
- **Limiting conditions:** exfil requires the internal endpoint to return a JSON shape the action parses; otherwise it degrades to a connectivity/port oracle.
- **Remediation:** Add `redirect: "manual"` to `fetchJson`, the `ociToken` realm fetch, and the `checkImageExists` HEAD (treat any 3xx as failure), matching the other dialers.

---

### LOW

---

#### L-1 — First-run setup TOCTOU: concurrent `completeSetup` can mint a second instance admin
- **Severity:** Low · **Confidence:** CONFIRMED (logic); narrow real-world window
- **Component:** `lib/auth.ts` `completeSetup` (the user-count check is read *outside* the `createAccountWithTeam` transaction).
- **Description:** The "no users yet" guard is not in the same transaction as first-account creation. Two concurrent `completeSetup` calls both read `existing === 0` and both create an `is_instance_admin = true` account. The instance-*owner* crown is serialized (`onConflictDoNothing` on `instance_settings`), so only one becomes owner, but the loser still creates a fully-privileged admin. `setup:global` (10/min) does not serialize.
- **Precondition:** a fresh, uninitialized instance reachable by an attacker during the setup window.
- **Impact:** a co-instance-admin alongside the legitimate owner. Incremental risk is narrow — anyone who can reach a pre-setup instance can already seize it by completing setup first.
- **Remediation:** move the count check inside the creation transaction, or take a `pg_advisory_xact_lock` / partial-unique-index on a setup sentinel so exactly one first account commits.

#### L-2 — A team-level `manage_monitoring` clears fleet-wide (all teams') metrics history — ASSESSED, ACCEPTED (by-design)
- **Severity:** Low · **Confidence:** CONFIRMED · **Outcome:** accepted / won't-fix
- **Component:** `lib/data/monitoring-settings.ts` `setSaveMetrics` → `clearMetricsHistory()` / `clearContainerHistory()`.
- **Description:** The gate is the team capability `manage_monitoring`, but the cleared buffers are the in-RAM history for **every** team's servers/apps. A team-B member can wipe team-A chart history.
- **Impact:** transient cross-team integrity effect only — history regenerates from the live telemetry stream within seconds; no persistent data, no disclosure. Consistent with the documented fleet-scoped monitoring model.
- **Why accepted:** `save-metrics` is an *instance-wide singleton* (one master switch for the whole box), and `manage_monitoring` is a dedicated capability that exists **only** to gate it — it is used by no other API field or data function. The two candidate fixes both cost more than the transient, non-disclosing effect they remove: (a) instance-admin-gating it orphans `manage_monitoring`, which then must be retired (a stored-capability migration touching `membership_capabilities`, role presets, and `LEGACY_CAPABILITY_EXPANSION`); (b) dropping the destructive clear-on-disable contradicts the documented "off means nothing stays saved" behavior and still leaves a team member toggling the global switch. Toggling a shared global infra setting inherently has a global effect, and the dedicated capability *is* the intended control. Left as-is; documented here as a conscious accepted risk. (An attempted instance-admin fix was reverted when the `authz-matrix` capability-coverage test correctly flagged the orphaned capability.)

#### L-3 — `rebuildDatabase` renders an empty engine password under a rotated `DEPLO_SECRET`
- **Severity:** Low · **Confidence:** Medium — NEEDS VALIDATION
- **Component:** `lib/data/databases.ts` (`rebuildDatabase` and the DB-render family) — `parseConnectionPassword(decryptSecret(...))` uses best-effort decrypt where the value is consumed.
- **Description:** After a `DEPLO_SECRET` rotation, `connectionStringEnc` no longer decrypts and `decryptSecret` returns `""`. `rebuildDatabase` wipes the volume and re-inits the engine from env; with `password === ""`, a publicly-exposed redis boots with `--requirepass` empty (no auth). Postgres rejects an empty password; redis is the real exposure. `redeployDatabase` (volume preserved) is unaffected — the engine ignores env on an initialized volume.
- **Precondition:** `DEPLO_SECRET` already rotated (a state AGENTS.md documents as globally destructive), caller holds `delete_databases`, DB is exposed on a host port.
- **Remediation:** use `decryptSecretOrThrow` in the DB-render callers (as `revealBasicAuthPassword`/`basicAuthUsersValue` already do) — refuse to render a stack around an unreadable password rather than emit an empty one.

#### L-4 — `/api/github/setup` has no state/CSRF parameter
- **Severity:** Low (mitigated) · **Confidence:** CONFIRMED
- **Component:** `app/api/github/setup/route.ts`.
- **Description:** Unlike `github/callback` (which verifies `verifyState`), `github/setup?installation_id=X` accepts an attacker-suppliable `installation_id` with no state check. Mitigated because `upsertInstallation` re-gates (`manage_git` in the active team + verifies the resolved App belongs to the caller's team). Worst case for a forged link is refreshing metadata for an installation the victim's own team already owns — not a cross-tenant write.
- **Remediation:** add a `state` param for consistency with the callback.

#### L-5 — `control_databases` capability description advertises a data-wipe it doesn't grant
- **Severity:** Low (documentation/UX) · **Confidence:** CONFIRMED
- **Component:** `lib/capabilities.ts` (`control_databases` description) vs `lib/data/databases.ts` `rebuildDatabase` (requires `delete_databases`).
- **Description:** The catalog describes `control_databases` as "Start, stop, restart, redeploy and **rebuild**", but rebuild (the destructive `down -v` factory reset) requires `delete_databases`. Enforced in the safe direction (a `control_databases`-only member is refused rebuild), so it misleads role designers rather than escalating.
- **Remediation:** drop "and rebuild" from the description.

---

### INFORMATIONAL / HARDENING

- **I-1** — REST cookie routes (`apps/[id]/upload`, `.../logs`, `.../attach`) rely solely on `SameSite=Lax` for CSRF, without the explicit Origin/content-type assertion the GraphQL route makes (`requireJsonPost`). Live-safe today; a one-line Origin or content-type check would match the belt-and-braces the GraphQL endpoint documents wanting.
- **I-2** — `assembleServer` (`lib/data/infra-rows.ts`) projects the agent mTLS `certPem` (public) and `bootstrapTokenHash` (already a single-use, expiring SHA-256) into the data-layer `Server` object. The GraphQL `Server` type exposes only a `Boolean(certFingerprint)` "provisioned" bit, so nothing leaks today — latent footgun if a future resolver spreads `...server`.
- **I-3** — `projects.ts` `renameProject`/`setProjectColor`/`deleteProject` gate on `requireCapability` + a `teamId`-only write, relying on the clamp layer (rather than a call-site `inProjectScope`) to contain a narrowed principal. Not exploitable today (`organize_projects`/`delete_projects` are in neither `PROJECT_SCOPED_CAPABILITIES` nor `NODE_GRANTABLE_CAPABILITIES`, so narrowed tokens/scoped roles have them stripped); becomes a cross-scope IDOR if a project-CRUD verb is ever added to those sets.
- **I-4** — `deleteAllDeployments` filters per-app with `hasAppCapability(appId,"deploy_apps")` while its entry gate already requires team-wide `delete_apps`. Cosmetic; no privilege gain, no cross-team reach. Switch to `delete_apps` for coherence.
- **I-5** — `mintRegistrationLink` bakes `cleanCapabilities(a.capabilities, a.role)` into a link with no `withinActor` bound. Moot (the minter is `requireInstanceAdmin`, holds everything; the join is member/viewer only); would become an escalation if the gate were ever loosened to a team capability.
- **I-6** — Stale docstrings cite retired coarse capabilities (`database-console.ts` "manage_infra", `basic-auth.ts` "manage_domains", `app-transfer.ts` "deploy"). Code enforces the correct fine-grained caps; misleads an auditor grepping by docstring only.
- **I-7** — The rate limiter (`lib/security.ts`) and the HIBP pwned check both **fail open** on a DB/network outage. Deliberate and correct for self-hosting (a limiter that locks everyone out on a blip is worse), documented; noted so it is a conscious accepted risk.
- **I-8** — The 2FA-verify brute-force ceiling is ~240 codes/day/account (per-account bucket 10/hr) against a 10^6 TOTP space — disclosed in-code, acceptable, and the only bound that actually holds (the IP bucket is spoofable). Accepted risk.
- **I-9** — `keepAuthCookiesUsableOverHttp` intentionally declassifies auth cookies (drops `Secure`/`__Secure-`) when a request arrives on the panel's `http://<ip>:3000` rescue address. Deliberate; cookies stay `httpOnly` + `SameSite=Lax`. Not a downgrade vector absent an on-path attacker already on that IP.
- **I-10** — The agent bootstrap route has no rate limiting; a 256-bit single-use token + hash lookup makes brute force infeasible. Not actionable.
- **I-11** — DNS-rebinding TOCTOU is an acknowledged ceiling in `outbound-url.ts` (the name is resolved at check and again at dial, never pinned to the socket); the same class applies to the git base URL and the registry. M-2 is the concrete, directly-exploitable instance of this family.
- **I-12** — Build-arg → Dockerfile injection: control-plane-side, build/env var **names** are constrained by `ENV_KEY_RE` (`/^[A-Z_][A-Z0-9_]*$/i`) at every writer and values ride the process env (not string-concatenated into the Dockerfile), so no injection on this side. The agent-side build assembly is a separate repo and was not audited.
- **I-13** — The scoping label `deplo.app` is not collision-protected on production apps (it is injected only when `trackingId !== appId`, i.e. previews), so a user could set a stray `deplo.app` label that survives `mergeLabels`. Not security-relevant today: the **trusted** demux key is `deplo.project`, which is injected on every service and overrides any user value. Confirm no future scoping decision reads `deplo.app`.

**Test-coverage gaps (code correct, regression net thin):** cross-team refusal on `environments` rename/delete; the DB-console exec/attach capability (`open_database_console`); the `rebuildDatabase` required capability (how L-5's drift went unnoticed); `projects.ts` scoped-principal refusal (I-3); the app-transfer bearer-token destination path (M-1).

---

## 7. Risk Matrix

| ID | Finding | Severity | Confidence | Exploitability | Precondition |
|---|---|---|---|---|---|
| C-1 | `pid`/`ipc: container:` container escape | Critical | High | Confirmed | `create_apps`/`configure_apps` |
| H-1 | Numeric-IP SMTP-host SSRF | High | High | Confirmed/reproduced | `manage_notifications` |
| H-2 | `traefik.*` label hostname takeover | High | High | Confirmed (mechanism) | `create_apps`/`configure_apps` + shared server |
| H-3 | `network_mode: host` port/loopback bypass | High/Med | High | Confirmed | `create_apps`/`configure_apps` |
| M-1 | App-transfer token-scope bypass | Medium | High | Confirmed | scoped token + creator in dest team |
| M-2 | Registry redirect SSRF | Medium | High | Confirmed/reproduced | any logged-in user |
| L-1 | Setup TOCTOU → 2nd admin | Low | High | Confirmed | pre-setup window |
| L-2 | Fleet-wide metrics wipe (accepted, by-design) | Low | High | Confirmed | `manage_monitoring` |
| L-3 | Empty DB password on rotated secret | Low | Medium | Needs validation | rotated `DEPLO_SECRET` + exposed DB |
| L-4 | `github/setup` no state param | Low | High | Mitigated | forged link + victim click |
| L-5 | Misleading capability description | Low | High | N/A (doc) | — |

---

## 8. Areas Analyzed Without Finding (verified defenses)

- **GraphQL endpoint:** `cors:false`, `requireJsonPost` (CSRF class removed beyond `SameSite=Lax`), graphql-armor depth 12 / aliases 30 / cost 5000, error masking (`mask-error.ts` masks Drizzle/pg/gRPC, preserves intentional messages). The playground executes queries read-only wrapped in `runWithIdentity` (respects the token clamp) and simulates mutations (dry-run, never executed).
- **Web platform:** strict per-request-nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`; HSTS only over real TLS; optimistic auth redirect with the real gate downstream.
- **Token model:** expiry enforced in `identityForTokenRow` before any use; scope clamp intersects with the token's set and drops team-wide caps for narrowed tokens; node grants re-apply the clamp; team-wide collections call `requireTeamWide`; point lookups return "not found" (no existence oracle); mint/edit refuse capabilities beyond the actor (`withinActor` throws); instance-admin is per-token opt-in.
- **Deploy hook / webhooks:** per-app rotatable token + bearer, constant-time compare, 404 for wrong token/unknown app; GitHub webhook HMAC verified against the receiving App's secret with the installation bound to that App; other providers keyed by an unguessable per-connection token; empty secret refuses (never verifies).
- **MCP:** `teams.mcp_enabled` enforced at the route; every tool runs in-process under `runWithIdentity` against the same schema (same gates); no `reveal*` tool; token-mint tools deliberately absent.
- **Auth/session/account:** Better Auth `admin()`/`organization()` plugins **not** enabled (no `/admin/set-user-password`, `impersonate-user`, `create-user`); all sensitive account/session endpoints closed by `deploOwnedGate`/`twoFactorGate`/`passkeyGate`; no self-service password reset; 2FA policy enforced on reads, writes, and every bearer/MCP/deploy-hook path; no session fixation; server-side revocation; suspension enforced live; owner immutable to other admins; ownership transfer requires password (+ live 2FA / current-hash).
- **SSRF (URL path):** `assertSafeOutboundUrl` canonicalizes via `new URL()`, resolves DNS, checks every A record (loopback/RFC1918/CGNAT/link-local+metadata/IPv6 loopback-link-local-ULA-v4mapped); notification/git/S3/push dialers use it + `redirect:"manual"` + `allowPrivateEndpoint`→`requireInstanceAdmin`; `probePanel` is the one documented exemption (instance-admin at the dialer).
- **Servers/agent/PKI:** bootstrap token 256-bit, single-use (conditional UPDATE), 1h TTL, CSR proof-of-possession; SANs from the server row (never the CSR/self-report); HMAC-bound response; exact cert-fingerprint pinning on every dial including agent 0; all destructive server-management mutations `requireInstanceAdmin`; per-container metrics/logs keyed by the trusted `deplo.project` label (injected + overriding, un-spoofable). Custom certificates entirely `requireInstanceAdmin`, cert/key pairing + validity validated.
- **Secrets/preview:** no `*_enc`/`*_hash` in any DTO; every `reveal*` double-gated + team(+folder)-scoped; preview fork-drop intact with a server-derived, HMAC-signed `isFork` and required `type` on all four env loaders; `redactComposeForDisplay` masks env values + the htpasswd label; `decryptSecretOrThrow` at the deploy edge and git-clone; webhook empty-secret refusal.
- **Data isolation:** 28 `lib/data` domains verified — load-then-gate, teamId-scoped writes with `.returning()` confirmation, folder gates on folder-scoped resources, `requireAppCapability` on every app-shaped mutation, correct fine-grained capability at each call site; cross-team hostname takeover closed on both `addDomain` and `updateDomain`; path traversal defended (`normalizeRel` + realpath containment, plus the agent-side sandbox).

---

## 9. Correlated / Grouped Findings

- **Compose sandbox is a write-time denylist (C-1, H-2, H-3):** all three share one root cause — the sandbox boundary is a string-matching detector in `compose-lint.ts` that must enumerate every escape, run only at write time, over YAML shipped verbatim to the agent with no deploy-time re-check. C-1 (namespace `container:` form), H-2 (`traefik.*` labels), and H-3 (`network_mode: host`) are three gaps in that enumeration. This is the same class as the previously-fixed `privileged:` hole. **Structural fix:** treat the compose→agent path as the trust boundary — prefer an allowlist for privileged/routing keys, strip user routing labels, and add a deploy-time re-lint so a single write-time miss is not a full bypass.
- **SSRF guard completeness (H-1, M-2, I-11):** the outbound guard is strong on the URL path but has two edges — the bare-host path skips canonicalization (H-1) and the registry client skips redirect re-validation (M-2) — both instances of "a checked address is not the address finally dialed" (I-11).
- **`decryptSecret` where the value is consumed (L-3, I-12 context):** the DB-render family is the last place best-effort decrypt is used where the result is acted on; the pattern elsewhere (basic-auth, backups reveal, deploy edge) already uses `decryptSecretOrThrow`.

---

## 10. Security Assumptions

- The Go host agent correctly enforces its side of the file-path sandbox and executes only the compose it is handed (it does **not** re-lint for host privileges — that is the control plane's job, which is precisely why C-1/H-2/H-3 matter).
- `DEPLO_SECRET` is high-entropy and not rotated except as a deliberate, documented destructive operation (L-3 lives in the rotated state).
- The reference deployment is single-box (control-plane Postgres + tenants on one daemon); impact ratings for the compose findings assume this and are bounded on an isolated fleet.
- Servers are the one intentionally cross-team-shared resource; `all_teams=true` default is by design and per-container isolation rests on the trusted `deplo.project` label.
- The frontend is untrusted; only server-side (`lib/data`) enforcement was credited.

---

## 11. Remediation Priorities

1. **C-1 (Critical, now):** gate the `pid`/`ipc`/`uts` `container:`/`service:` form under `canMountHostVolumes`; add a deploy-time re-lint.
2. **H-1 (High, one line):** strict dotted-quad / `isIP()` on the bare-host SSRF path.
3. **H-2 (High):** strip/allowlist user `traefik.*` labels in `buildComposeStack`.
4. **H-3 (High):** gate `network_mode: host` behind `canExposePorts`.
5. **M-2 (Medium, one line):** `redirect:"manual"` on the three registry fetches.
6. **M-1 (Medium):** refuse an out-of-scope `destTeamId` for a scoped token in `transferAppToTeam`.
7. **Low batch:** setup-count-in-transaction (L-1); `decryptSecretOrThrow` in the DB-render family (L-3); `state` param on `github/setup` (L-4); fix the `control_databases` description (L-5). (L-2 assessed and accepted — see its entry.)
8. **Regression net:** add the five missing tests named in §6 so the implicit clamp-layer enforcement cannot silently regress.

---

## 12. Conclusions

deplo is a well-engineered, security-conscious platform whose authorization core — the part hardest to get right in a multi-tenant system — is genuinely strong and has visibly improved across successive audits. The data layer is a real boundary, the token/2FA/capability model is coherent and consistently enforced, and the account, secret, SSRF-URL, and PKI surfaces are in good shape.

The concentrated risk is the **compose rendering path**, where a permissive "bring your own YAML" model meets a write-time denylist and a verbatim hand-off to the agent. One finding there (C-1) is a genuine cross-tenant container escape reachable from an ordinary team capability, and two more (H-2, H-3) are gate bypasses of the same shape. Addressing that surface structurally — allowlist the dangerous keys, strip user routing labels, re-lint at deploy — closes the highest-impact findings and the class they belong to. The two SSRF edges and the token-scope gap are contained, well-understood fixes.

None of the findings required modifying the project, and none were exploited against live data. The recommended fixes are specific, mostly small, and do not conflict with deplo's mission of keeping the non-expert happy path free of Docker/SSH knowledge — they harden the *expert* escape hatch (raw compose) that a non-expert never touches.

*End of report.*

---
---

# Part II — Second Independent Re-Audit + Remediation

**Date:** 2026-08-16 · **Type:** authorized, second independent pass over the CURRENT tree (Part I's fixes already committed), followed by **implementation of every finding**.
**Method:** (1) hand review of the compose/deploy and SSRF surfaces; (2) six parallel domain auditors; (3) a **real-time re-hunt** (five parallel hunters) for what pass 1–2 missed; (4) every Critical/High/Medium re-verified from source and reproduced read-only (`docker compose config`, `js-yaml`, `net.isIP`); (5) **fixes written, tested, and pushed to `main`.**

## 1. Executive summary

This pass found that Part I's residual-risk surface — "the compose path is a write-time denylist shipped verbatim to the agent" — was **materially wider than Part I concluded**, and that the same *incomplete-severance* / *unbounded-reach* classes existed elsewhere. **13 new findings** (2 Critical, 4 High, 3 Medium, plus Lows), **all now fixed and pushed**. The write-time-denylist root is unchanged as an architecture, but every enumerated gap it left is closed.

**Every finding below is FIXED on `main`.** Fix ledger:

| # | Finding | Sev | Fix commit |
|---|---|---|---|
| N-C1 | Compose `env_file:` / `secrets.file:` / `configs.file:` read arbitrary HOST files into a tenant container | **Critical** | `6efd193` |
| N-C2 | Compose `volumes_from: "container:<name>"` mounts another tenant's / the control-plane DB volume | **Critical** | `6efd193` |
| N-H1 | `build:` (context/dockerfile/additional_contexts/ssh/privileged) reaches host paths at build time | **High** | `30fb2be` |
| N-H2 | `extends:{file:}` / top-level `include:` / `label_file:` smuggle privileged/host-bind/ports/traefik-labels past every gate | **High** | `30fb2be` |
| N-H3 | Git-connection **PAT exfiltrated** to an attacker-chosen host (clone URL host not bound to the connection) | **High** | `5a2a575` |
| N-H4 | `transferAppToTeam` leaves **cron jobs executing cross-tenant** in the destination team's container | **High** | `b87bf89` |
| N-H5 | Cross-tenant **GitHub installation repo/branch enumeration** (IDOR, `loggedIn`-only) | **High** | `cc18709` |
| N-M1 | H-1 fix was **IPv4-only**; non-canonical IPv6 loopback still bypassed the SMTP SSRF guard | **Medium** | `b038c1c` |
| N-M2 | `createToken`/`updateToken` didn't contain a scoped token's **reach** (M-1 class, un-fixed instance) | **Medium** | `94f1e0b` |
| N-M3 | MCP kill-switch (`teams.mcp_enabled`) not re-checked on **team switch** via a tool's `team` arg | **Medium** | `94f1e0b` |
| N-L1 | `cgroup: host` / `oom_kill_disable: true` ungated | Low | `6efd193`,`30fb2be` |
| N-L2 | `teardownDatabaseStack` rendered from a best-effort decrypt (missed 4th L-3 site) | Low | `c99fe05` |
| N-L3 | Suspended-account **login enumeration** (message + timing oracle) | Low | `c99fe05` |
| N-L4 | Account-settings password re-auth **un-throttled** (vs the rate-limited 2FA step-up) | Low | `8e78952` |
| N-L5 | CSRF Origin check missing on the DB-SSE + backup routes | Low | `4072d3e` |
| N-L6 | web-push endpoint **not re-validated** at send | Low | `8e78952` |
| N-L7 | `revokeToken` missing the `requireInstanceAdmin` guard create/update enforce | Low | `94f1e0b` |
| N-L8 | Scoped-role read oracles (`getQueuePosition`, `projectContents`) | Low | `02a8275` |
| N-L9 | Git-connection repo browse not `requireTeamWide` (narrowed-token enumeration) | Low | `28fe2ac` |
| N-L10 | Preview server override gated **existence, not accessibility** (per-team server grants) | Low/Med | `28fe2ac` |

## 2. The two Critical findings (compose host-file / cross-container escapes)

**N-C1 — `env_file:` / top-level `secrets:`/`configs:` with a `file:` source read arbitrary host files.** Docker resolves these on the agent host against the **shared** stack directory (`/data/stacks`), so `env_file: [/data/stacks/<victim-slug>.env]` — the deterministic path deplo writes each tenant's *decrypted* secrets to — hands another tenant's secrets to the attacker's container, whose image + command echo them to the Logs the attacker can read. An absolute path (`/root/projects/deplo/.env`) reaches the control plane's own `DEPLO_SECRET` on the reference install. Confirmed read-only: `docker compose config` reads a file outside the compose dir and injects it; the `js-yaml` load→dump round-trip shows the keys survive to the agent while every write-time detector reports nothing.
**Fix (`6efd193`):** folded `env_file` and top-level `secrets`/`configs` file sources into `composeNeedsHostPrivileges` / `composeMountsForeignStorage`, so both compose write paths gate them behind `canMountHostVolumes` like any bind mount. No over-gating (a same-stack service reference, `cgroup: private`, an ordinary volume stay free). Regression tests added.

**N-C2 — `volumes_from: "container:<name>"` mounts a foreign container's volumes.** The `container:` form references a container *outside* this stack; it ignores the network split (it names a container, not a service), so it reaches a co-located tenant's data volume and the control-plane `deplo-postgres` volume at rest (every `*_enc`, every session, write access to `users.is_instance_admin`). Ungated, unread by every detector. **Fix (`6efd193`):** flag the `container:` form in the host-privilege detector.

## 3. The four High findings

- **N-H1 / N-H2 (compose, `30fb2be`)** — the real-time re-hunt found two more gate bypasses, neither an enumerated key: `build.context`/`dockerfile`/`additional_contexts` pointing at an absolute or `..`-escaping host path, `build.ssh`, and a privileged BuildKit build reach the host at build time; and `extends:{file:}` / top-level `include:` / `label_file:` **merge config from a file docker resolves on the host**, so `privileged`, host binds, published ports, and even `traefik.*` labels (past the H-2 label strip) never appear in the authored YAML the gate — or a deploy-time re-lint — parses. Fixed by gating `build:` host-reach behind `canMountHostVolumes` and **refusing** the external-merge keys outright (deplo owns the render; they can be inlined). All confirmed with `docker compose config`.
- **N-H3 (git PAT, `5a2a575`)** — `resolveCloneUrl` embedded the connection's PAT into whatever host `repo.url` named, and `scopeRepoCredentials` checked only team membership (not `manage_git`, not host match). A member could exfiltrate the PAT to an attacker host (the agent lifts userinfo into `Authorization: Basic`; `redactCloneUrl` hides it from the deploy log). Fixed by binding the clone host to the connection's `baseUrl` host, mirroring the GitHub-App and fork paths.
- **N-H4 (cron transfer, `b87bf89`)** — `transferAppToTeam` severed every team-bound child except `cron_jobs`, which then ran the source team's command in the destination team's container every tick, unmanageable from either UI. Fixed by deleting the jobs in the transfer transaction (runs/env cascade) plus a `teamId`-matched scheduler join as defense in depth.
- **N-H5 (GitHub IDOR, `cc18709`)** — `githubRepos`/`githubBranches` were `loggedIn`-only and took the installation id from the args with no team check, so any member could enumerate another team's private repositories/branches through its installation token. Fixed with a data-layer team-scope check.

## 4. Medium / Low

The three Mediums (N-M1 IPv6 SSRF, N-M2 token-mint scope reach, N-M3 MCP kill-switch on team switch) and every Low in the ledger are fixed as summarized above, each with a targeted regression test where the harness allowed one. The two that were **assessed and left as-is by design**: N-L1's `listProjects` tile *counts* (count-only, matching the documented `listFolders` team-scoped-count choice), and Part I's L-2 (fleet-scoped monitoring) already documented as by-design.

## 5. Deferred (informational, not a live vulnerability)

- **Deploy-time compose re-lint (Part II NEW-INFO-1).** The write-time gate is now complete for the current writers (the only two paths that store compose), so the two Criticals are closed. A *deploy-time* re-lint of the whole host-privilege class remains a defense-in-depth improvement that needs a schema change (recording write-time authorization) to be enforced without an actor context — deferred, not required to close any specific finding, and note that N-H2 (`extends:{file:}`) is refused precisely because a deploy-time re-lint of the authored string could not see the merged file.
- **`deploOwnedGate` negative-allowlist test (NEW-INFO-2)** and **`resolvePublicBaseUrl` `x-forwarded-host` fallback / `github/setup` state param (NEW-INFO-3).** Both latent/mitigated (no social-login configured; `DEPLO_PUBLIC_URL` is required-to-boot so the header is normally never consulted, and `HOST_RE` forbids CR/LF). Left as documented hardening.

## 6. Verification

- **`tsc --noEmit`: clean** after every batch (`bunx next typegen` first).
- **`eslint`: clean** on every changed file.
- **Targeted `node --test` per touched area: green** — compose-host-bind, outbound/destinations, git-connections, app-transfer + cron scheduler, databases, auth, tokens + token-scope, all MCP suites, projects, deployments, previews, github webhook-binding — plus the new regression tests (host-file/volumes_from/build/external-merge/cgroup/oom detectors, IPv6 SSRF, git clone-host, cross-tenant cron drop, GitHub-IDOR refusal, suspended-login generic error, scoped-token mint refusal).
- **Full suite** (`bun run test`, `node --test` over `lib/**` + `components/**`, `DEPLO_DATABASE_URL` unset) run as the final gate.
- No new dependency, no schema/migration change, no DB column added (so the inventory tests are untouched).

## 7. Conclusions (Part II)

Part I's verdict holds and is sharpened on the compose path: the write-time enumerated denylist was missing **five** host-escape keys (`env_file`, `secrets.file`, `configs.file`, `volumes_from`, `cgroup`/`oom_kill_disable`) and **three** file-merge keys (`build:` host reach, `extends:{file:}`, `include:`, `label_file:`) — two of them cross-tenant-Critical from an ordinary team capability. Those are closed, along with a git-PAT exfiltration, a cross-tenant cron persistence hole in the just-hardened transfer path, a GitHub-installation IDOR, the IPv4-only half of the SSRF fix, and the token-mint / MCP-kill-switch reach gaps. The structural recommendation stands and is now the load-bearing follow-up: **prefer an allowlist for the privileged/file/merge/routing keys and re-lint at deploy**, so the next un-enumerated key is not the next bypass.

*End of Part II.*

---
---

# Part III — Fifth Pass: "the fix closed the instance, not the class"

**Date:** 2026-08-16 · **Type:** authorized fifth pass over the tree Part II's fixes had just landed on, followed by **implementation of every finding**.
**Method:** four parallel read-only auditors — (a) adversarial attempts to BYPASS each of Part II's 13 fixes and to find un-fixed siblings of their classes, (b) output-rendering / stored-XSS / agent-RPC-argument injection, (c) races / TOCTOU / business-logic / cross-tenant resource abuse, (d) the freshest code (the MCP page rebuild, the in-flight playground removal) plus the surfaces four passes had structurally skipped (boot, install scripts, PKI dial, the small REST routes) — then hand re-verification of every High/Medium from source, with read-only `docker compose config` / `js-yaml` / `net.isIP` reproductions.

## 1. Executive summary

**Part II's 13 fixes hold under attack** (see §5). What this pass found instead is a pattern, not a regression: **each fix closed its own instance while leaving a sibling of the same class open** — the storage gate got foreign volumes but not foreign *networks*, `oom_kill_disable` was gated but not `oom_score_adj`, the GitHub IDOR got the cross-team check but not the depth check its twin had, the re-auth limiter reached two of the three re-auth sites, the transfer severed `cron_jobs` but not `api_token_apps`. Nine new findings, **all fixed and pushed**:

| # | Finding | Sev | Fix |
|---|---|---|---|
| P3-H1 | Compose join to a **FOREIGN network** (external / pinned `name:` / `driver_opts` / macvlan) — reaches another team's unpublished services at L3 and, via the service-name DNS alias, collects their internal lookups (DB credentials) | **High** | `000935b` |
| P3-M1 | `oom_score_adj: -1000` ungated in compose **and** in the structured Resources form (apps + databases) — makes the kernel kill the NEIGHBOURS | **Medium** | `000935b` |
| P3-M2 | Build/deploy log output **unbounded** into the shared control-plane Postgres → disk fill → instance-wide DoS | **Medium** | `de59636` |
| P3-M3 | `transferInstanceOwner` password re-auth **un-throttled** (the highest-value re-auth there is) | **Medium** | `0592730` |
| P3-M4 | `githubRepos`/`githubBranches` missing `requireTeamWide` — a narrowed token enumerates the team's private repos | **Medium** | `0592730` |
| P3-M5 | `api_token_apps` not severed on app transfer — a source-team token follows the app into the destination team | **Med/Low** | `0592730` |
| P3-L1 | Preview `maxActive` cap counted under a per-**PR** lock → concurrent PRs overshoot the cap (containers + Docker networks on a ~31-network host) | Low | `d796793` |
| P3-L2 | `restoreBackup` took **no** `app-lifecycle` mutex → wipe/untar can race a concurrent deploy on the same volumes | Low | `d796793` |
| P3-L3 | `outbound-url`: an IPv6 **zone id** made canonicalization throw → *allowed*; **NAT64** (`64:ff9b::<v4>`) embedded IPv4 unread | Low | `d796793` |
| P3-L4 | cron `workdir`/`user` reached the agent on a bare `.trim()` | Low | `d796793` |
| P3-L5 | `group_add` / non-default `logging` driver+options ungated (host groups; dockerd dials an author-chosen address) | Low | `30fb2be`→`000935b` |
| P3-L6 | The agent installer is fetched over plain **http** in the bare-IP default, with its checksum on the same channel → on-path attacker gets root on the new host | Low (op) | `d9bff44` (warning; see §4) |

## 2. The High: foreign-network join

`composeMountsForeignStorage` gated a top-level `volumes:` entry pinned by `external` / `name:` / `driver_opts`; the parallel **`networks:` block was read by no detector at all**, and `buildComposeStack` only processes the shared `deplo` network — every other network passes through exactly as authored, alias-drop and reserved-name refusal included. Compose project names are deterministic (`deplo-<slug>`), so another team's default network is `deplo-<their-slug>_default`, guessable from any app name. Verified read-only: all six detectors answered "safe" for that compose and `docker compose config` accepted the join.

Two consequences, the second worse than the first: every unpublished service of the victim's stack becomes reachable at L3; and because a container registers its **service name** as a DNS alias on each network it joins, a service called `postgres` or `redis` round-robins the victim's own internal lookups onto the attacker's container — the credential arrives on the first packet. That is the same round-robin the shared-network choke point exists to stop, on a network that choke point never looks at.

**Fixed** with `composeJoinsForeignNetwork` (external, pinned `name:`, `driver_opts`, or a `macvlan`/`ipvlan`/`host` driver — and only when a service actually joins it), wired into both compose write paths' `canMountHostVolumes` gate, plus an editor warning. The shared `deplo` network stays free, by key *and* under an alias that points at it by name; a plain per-app network stays free; declaring-without-joining stays free.

## 3. Notes on the rest

- **P3-M1** also covers the structured Resources form for **databases** (same shared `cleanResourceLimits`), and gates only the NEGATIVE direction — a positive `oom_score_adj` volunteers this container first, which is safe and free. `cpu_shares` / `nofile` / `nproc` remain `configure_apps` (they bound this app; they do not tell the kernel to kill someone else's).
- **P3-M2**: the budget deliberately does **not** live on the per-deployment buffer, because `loadDeploymentLogs` → `finalizeDeploymentLogs` → `evictIfIdle` runs on any READ — a reader opening the Logs page mid-build would otherwise hand the build a fresh budget. (That bug existed in the first draft of the fix and is what the regression test pins.)
- **P3-L1**: the re-fit runs AFTER the insert with `maxActive + 1`, because `evictToFit(keep)` evicts `count - keep + 1` (it makes room *for* an incoming row). Passing `maxActive` post-insert evicts one too many — which is exactly what the existing eviction tests caught.

## 4. Accepted / deferred, with the reason

- **P3-L6 (installer over http) — mitigated by disclosure, not closable in-band.** On a plain-http panel the installer *and* the checksum it verifies travel the same unauthenticated channel; no value the control plane puts in the command can fix that (the attacker rewrites the verification code too). The `:3000` http address is a deliberate rescue path (see `install.sh`), so it is not removed. What shipped: the add-server screen now says the installer is being fetched over an unencrypted connection when the panel address is http. **Operational recommendation: give the panel a domain with HTTPS before enrolling servers across an untrusted network** — then the fingerprint is pinned and this class is gone.
- **Bootstrap token in `sudo` argv** — not improved: `sudo` records its whole command line either way (an env-var prefix is part of that line), so there is no spelling that hides it. Bounded by single-use + ~1h TTL + near-instant consumption, and the script already keeps the token off the *agent's* argv and writes `bootstrap.env` 0600.
- **Control-plane container runs as root** — left as the documented deferral: a `USER` line needs a `/data` ownership migration for existing installs, which is a release step, not a patch. No docker socket is mounted (verified), which is what bounds it.
- **Third-party `curl | bash`** (Docker's installer, nixpacks) — unchanged; pinning would mean vendoring two upstream installers.
- **Registry-client DNS rebinding** — the same accepted ceiling as `outbound-url` (I-11): closing it needs an IP-pinned dispatcher, a trade the first audit already declined. `redirect: "manual"` + all-addresses checking remain.
- **No aggregate upload quota** (512 MiB per app, unbounded by app count) — a product decision about per-team disk quota, not a security patch; flagged, not invented.
- **`listProjects` tile counts** (count-only across role scope) — matches the documented `listFolders` choice; assessed, left.

## 5. What held under attack (Part II's fixes)

- **Compose parse-differential is closed by construction**: `!override`/`!reset`/duplicate keys make js-yaml throw, and `buildComposeStack` re-parses with the *same* js-yaml and re-emits via `yaml.dump`, so nothing raw reaches compose-go — a throwing input only fails its own deploy.
- **Clone-URL host binding**: userinfo, backslash, fragment, trailing dot, port, punycode and scp forms all either match the connection's real host or clone anonymously.
- **Token-mint containment**: a project-narrowed token cannot reach `createToken` at all (the clamp strips `manage_tokens`); a whole-team token is bounded by `assertScopeWithinActingToken`; `mintMcpConnection` inherits it.
- **`isCrossSite`**: malformed Origin fails closed, `x-forwarded-host` is proxy-set, every cookie-auth mutating/streaming route in `app/api` now calls it.
- **Empty-decrypt**: every booting-stack site throws or falls back to a throwaway; every verifier refuses an empty secret.
- **No HTML-injection sink exists anywhere** (`dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`: zero hits), log lines only linkify `http(s)`, markdown runs without `rehype-raw`, xterm has no link addon, OAuth redirects go through the library's `SafeUrlSchema`.
- **Agent-RPC arguments** are structured fields and argv, never shell strings: `composeUpArgs` allowlist + agent-side mirror, backup object keys built from system ids, stack slug `[a-z0-9-]`, upload extraction via `spawn` with the user filename used only as a log label.
- **The freshest code is clean**: `stampMcpUse` keys on the caller's own token; the reworked `listMcpConnections` OR-predicate is AND-nested inside `inArray(tokenIdsReaching(teamId))`; the `mask-error` change is comment-only.
- **The running core**: server address + pinned fingerprint read atomically, deploy vs delete share `app-lifecycle`, deploy-queue `busyKeys`, server removal blocked on live workloads, folder/project deletion reparents children, backups/crons/uploads/SSE all bounded server-side.

## 6. Verification

`tsc --noEmit` clean and `eslint` clean after every batch; targeted `node --test` green on every touched area (compose detectors 34, outbound/destinations 34, previews 21, backups 30, crons 20, tokens 31, app-transfer 11, instance-owner 14, github binding 4, deployment-logs 7, pr-webhook 17), with new regression tests for: the foreign-network join (attack + no-over-gating), `oom_score_adj` sign sensitivity, `group_add`/`logging`, the log caps incl. the read-can't-reset-the-budget case, the zone-id/NAT64 refusals, and `api_token_apps` severance. Full suite run as the final gate. No schema change, no new dependency, no migration.

## 7. Conclusion (Part III)

The authorization core continues to hold; five passes have not found a cross-team read or write in the data layer. The recurring risk is **class incompleteness in the compose→agent path and in one-site fixes** — this pass's own header. The standing follow-up is unchanged and now twice-evidenced: **allowlist the privileged/file/merge/routing compose keys and re-lint at deploy**, and when fixing a class, grep every sibling of the pattern before closing the ticket.

*End of Part III.*
