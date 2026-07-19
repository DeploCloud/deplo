# Fleet rollout: shipping a server-agent release

How a `deplo-agent` change gets from a commit to every server in the fleet, and the order it must
happen in. Written for the 2am case: every command is copy-pasteable, every ordering rule states
what breaks if you ignore it.

The agent lives in its own repo (`DeploCloud/deplo-agent`); the control plane never builds it. The
whole update path is the control plane resolving a **GitHub Release** and telling each **server
agent** to replace its own binary over the existing pinned-mTLS channel — certificates are never
reissued, so a server keeps its identity and stays online across the upgrade.

## 1. The ship path

1. **Commit + push a `v*` tag** in `DeploCloud/deplo-agent`. The tag is the single source of truth
   for the version: `Makefile` stamps `internal/server.AgentVersion` from `git describe`, and
   `.github/workflows/release.yml` stamps it from `${GITHUB_REF_NAME#v}` — the leading `v` is
   stripped so it matches how `lib/agent/release.ts` normalizes tags.
2. **`release.yml` gates on `go test ./...`** before it builds anything. A red test = no release,
   so there is nothing for the fleet to pick up. It then builds static
   (`CGO_ENABLED=0 -trimpath`) `linux/amd64` + `linux/arm64`, runs `sha256sum` over both into
   `checksums.txt`, and publishes all three as release assets.
3. **Bump the control plane's offline fallback** — `FALLBACK_AGENT_VERSION` in
   `lib/agent/release.ts` (re-exported as `EXPECTED_AGENT_VERSION` from `lib/version.ts`). This is
   *only* the value used when GitHub is unreachable; the live "expected" comes from
   `resolveExpectedAgentVersion()`. Keep it conservative: `isAgentOutdated` treats an older or
   unparseable expected version as "nothing is outdated", so a stale fallback under-reports rather
   than false-flagging healthy agents.
4. **Bust the memo.** `resolveLatestAgentRelease()` caches for `CACHE_TTL_MS = 300_000` (5 minutes,
   in-process, on a global `Symbol` so the RSC and route-handler module graphs share one cell). The
   Servers page header's **Check for updates** runs the `checkAgentUpdates` mutation →
   `refreshAgentRelease()`, which clears the cell and re-resolves immediately. The underlying
   fetches are `cache: "no-store"`, so there is no on-disk Data Cache to also defeat.
5. **Update each server, one at a time**, in the order in §4.

## 2. The asset-name contract

Three basenames, exactly:

```
deplo-agent-linux-amd64
deplo-agent-linux-arm64
checksums.txt          # sha256sum format: "<64-hex>  <filename>" per line
```

`assetName()` in `lib/agent/release.ts` builds the first two by string interpolation and
`fetchLatestRelease()` looks up `checksums.txt` by literal name. `install-agent.sh` picks its pair
by `uname -m`; the agent picks its own by `runtime.GOARCH`. Renaming an asset breaks both sides.

**A release missing `checksums.txt` is refused entirely.** `fetchLatestRelease()` does
`assets.find((a) => a.name === "checksums.txt")` and returns `null` if it is absent, if the fetch
fails, or if it does not parse — before it ever looks at the binaries. `resolveLatestAgentRelease()`
returning `null` means:

- `/install-agent.sh` 503s instead of serving an unverifiable installer (`lib/agent/install-script.ts`),
- `selfUpdateServerAgent` throws *before* dialing any agent ("Could not resolve the latest agent
  release from GitHub"),
- the expected-version resolver falls back to `FALLBACK_AGENT_VERSION`, so every agent reads as
  up-to-date.

No unverifiable binary is ever served or installed. The checksum is read from the published
artifact, deliberately **not** from the GitHub API's per-asset digest, so the integrity claim comes
from what CI actually signed off on. Per-arch resolution needs *both* the asset and a matching
`checksums.txt` line; an arch missing either is dropped, and the release is only usable if at least
one arch survives.

## 3. There is no "update all servers"

Only **`updateServerAgent(id: String!): String`** exists (`schema.graphql:1594`,
`lib/graphql/types/server.ts`, `lib/data/servers.ts`). One server per call. There is no batch
mutation, no queue, no "update fleet" button — a rollout is N deliberate calls.

Contrast health, which *does* have a fleet-wide action: `checkAllServerHealth(force: Boolean)` probes
every provisioned server and is what the Servers page runs on load. Do not reason by analogy from
one to the other; the absence of a batch update is what makes the ordering below enforceable by hand.

Both are `authScopes: { instanceAdmin: true }` at the field, and `updateServerAgent` calls
`requireInstanceAdmin()` inside the data layer (the real gate).

## 4. Order: canary → the rest → the Deplo host LAST

**Identify the Deplo host (agent 0) first.** It is stored as `type = "remote"` like every other
server — there is no discriminating column. The only signal is address matching:
`isDeploHostServer()` / `deploHostSelfAddresses()` in `lib/deploy/domains.ts` compare a row's `ip`
/ `host` against `DEPLO_SERVER_IP`, the hostname of `DEPLO_PUBLIC_URL`, and every non-internal NIC
IPv4. In practice: **`servers.ip` equals `DEPLO_SERVER_IP` in `.env`.**

```sh
grep '^DEPLO_SERVER_IP=' /root/projects/deplo/.env
# and, ordering by blast radius (fewest Apps first). DEPLO_DATABASE_URL lives only
# in .env — it is NOT in your shell — so pull it in first, or psql silently drops to
# its socket default and fails as `role "root" does not exist`:
export $(grep -E '^DEPLO_DATABASE_URL=' /root/projects/deplo/.env | xargs)
docker exec postgres psql "$DEPLO_DATABASE_URL" -c \
  "select s.id, s.name, s.ip, s.agent_version, count(a.id) as apps
     from servers s left join apps a on a.server_id = s.id
    group by s.id order by apps;"
```

At time of writing this fleet is:

| order | server | id | apps | note |
| --- | --- | --- | --- | --- |
| 1 (canary) | `neon-s1` | `srv_f47d8cba7db4c813` | 2 | fewest Apps |
| 2 | `neon-s2` | `srv_07b0be4ab9ef9533` | 3 | |
| 3 (last) | `eu-main-1` | `srv_3667cf1973005952` | 66 | **agent 0** — `ip` = `DEPLO_SERVER_IP` |

**Why agent 0 goes last.** It runs the control plane itself. A bad agent there takes out the
*observer* as well as the observed: the process that would tell you the rollout went wrong, that
serves the Servers page, that dials the other agents, and that hosts the app you would use to roll
forward. Break a leaf server and you have a healthy control plane and two good agents to compare
against; break agent 0 first and you are debugging blind, on the box, over SSH — the exact failure
mode the platform exists to avoid. It is also the biggest blast radius here (66 Apps).

**Why a canary at all.** `go test ./...` gates the release but proves nothing about *this* fleet's
kernels, Docker versions and install layouts. The canary is the smallest real host that can
disprove the release. Let it sit long enough to Hello, serve a deploy and stream logs before moving on.

## 5. Skip servers with in-flight deploys

Self-update `syscall.Exec`s the process **750ms after replying** (`selfUpdateGrace` in
`internal/server/selfupdate.go`). Every open stream on that agent dies with it: an in-flight deploy
(server-streaming `Deploy`), log tails, console attach, dev containers, tunnels. Check before each
server and wait it out:

```sh
export $(grep -E '^DEPLO_DATABASE_URL=' /root/projects/deplo/.env | xargs)
docker exec postgres psql "$DEPLO_DATABASE_URL" -c \
  "select d.id, d.app_id, d.status
     from deployments d join apps a on a.id = d.app_id
    where coalesce(d.server_id, a.server_id) = 'srv_f47d8cba7db4c813'
      and d.status in ('queued','building');"
```

`('queued','building')` is the in-progress set the control plane itself uses (`IN_PROGRESS` in
`lib/data/deployments.ts`). Non-empty → do not update that server yet.

**Do not simplify that to a bare `where d.server_id = …`.** `deployments.server_id` is nullable by
design (schema comment in `lib/db/schema/control-plane.ts`: it is a denormalized mirror of
`apps.server_id`, "backfilled for rows that predate the queue"). The control plane never reads it
bare either — `onServer` in `lib/data/deployments.ts` is exactly
`coalesce(deployments.server_id, apps.server_id)`, and the queue-position query uses the same. A
bare read makes a null-`server_id` deploy *invisible*, so the check returns zero rows, you read it
as all-clear, and the self-update `syscall.Exec`s 750ms later straight through the live `Deploy`
stream this section exists to protect. A safety check that fails open is worse than no check.

## 6. Scripted updates run under real Node, never Bun

Bun's TLS peer-certificate verification rejects the agent certificate's SAN set and hands
`checkServerIdentity` an **empty** cert object, so the fingerprint pin can never match and every
mTLS dial fails. Reproduced against a live agent:

```
node v24.18.0 → certKeys:19, subjectaltname:"IP Address:…, DNS:localhost, IP Address:127.0.0.1"
bun  v1.3.14  → ERR_TLS_CERT_ALTNAME_INVALID, certKeys:0, subjectaltname:null
```

`bun run test` and `bun run dev` are fine; anything that *dials an agent* is not. Run rollout
scripts from the repo root with:

```sh
/root/.nvm/versions/node/v24.18.0/bin/node \
  --env-file=.env \
  --require ./lib/test/server-only-shim.cjs \
  --import tsx <script>.ts
```

- `--env-file=.env` supplies `DEPLO_DATABASE_URL` / `DEPLO_SECRET` (the app fail-fasts without them).
- `--require ./lib/test/server-only-shim.cjs` no-ops the `server-only` guard that `lib/data/*` and
  `lib/agent/release.ts` import.
- `--import tsx` gives TypeScript **and** the `@/*` path alias — which resolves off the repo's
  `tsconfig.json`, so run from `/root/projects/deplo`, not from a scratch directory.
- The repo is CJS: **no top-level `await`** in the script (esbuild errors out). Wrap the body in
  `async function main() { … }` and call it.

## 7. The footgun: the infra seam does not write `agent_version`

`selfUpdateServerAgent(serverId)` in `lib/infra/agent-client.ts` returns `{ version, restarting }`
and writes **nothing** to the database. The version badge is updated one layer up, by
`updateServerAgent(id)` in `lib/data/servers.ts`, which sets `servers.agent_version` optimistically
after the seam returns (and records the activity entry).

So the UI path is fine. A **script that calls the infra seam directly** — the usual shape, because
the data-layer function needs `requireInstanceAdmin()` and an identity context — must do the write
itself:

```ts
const { version } = await selfUpdateServerAgent(id);
await markServerSeen(id, version); // lib/data/servers.ts — ungated, best-effort
```

Skip it and the badge lags. Note *what* corrects it, because it is not the health prober:
`recordServerHealth` (`lib/data/server-health.ts`) writes `status` / `statusMessage` /
`statusCheckedAt`, plus `lastSeenAt` only on an `online`/`warning` probe — and never
`agent_version`. The paths that do refresh it from a live Hello all go through `markServerSeen`:
the **metrics poll** (`lib/data/monitoring.ts`), the **deploy preflight** (`agentPreflight`), and —
on `feat/monitoring-telemetry-stream` — the telemetry **stream supervisor**
(`lib/monitoring/supervisor.ts`), which does one `markServerSeen` per connection off the opening
Hello and supersedes the poll for agents advertising `metrics-stream`. On a quiet server with
nobody on Monitoring, a stale badge can persist for a long time.

`markServerSeen` only pins the *version* when `agent_port is not null` (the `case` wraps just
`agentVersion`), so it is a no-op for the badge on an unprovisioned row — but the rest of the write
still lands: `lastSeenAt` unconditionally, and `traefikEnabled` / `dockerVersion` / specs whenever
the caller passes them.

## 8. What self-update actually does on the host

`Service.SelfUpdate` in `internal/server/selfupdate.go`, in order:

1. `os.Executable()` + `filepath.EvalSymlinks` — resolve the **real** file, so a symlinked install
   swaps the target, not the link.
2. Select `req.Binaries[runtime.GOARCH]`. The control plane sends *every* published arch; the agent
   is the authority on its own. A missing arch → `FAILED_PRECONDITION`, nothing touched.
3. Download (bounded at 256 MiB) and **verify sha256 — mandatory, no flag, no skip**. Mismatch →
   `FAILED_PRECONDITION` ("refusing to install an unverified binary") and the *running binary is
   untouched*. Same guarantee `install-agent.sh` enforces.
4. Stage to a temp file **beside** the executable (same filesystem, so the rename is atomic), chmod
   `0755`, then `os.Rename` over the running executable. On Linux this is legal: the open text
   segment holds the old inode, the path now points at the new bytes.
5. Reply `{version, restarting: true}`, then — after `selfUpdateGrace` (750ms, so the response
   flushes) — `syscall.Exec(exePath, argv, env)`.

`syscall.Exec` means **same PID, same argv, same env**. The process is *replaced*, not exited, so
systemd's `Restart=on-failure` is irrelevant — there is no exit for it to react to. The new binary
finds the same `--agent-dir`, reuses the existing `agent.crt` / `agent.key` / `ca.crt`, skips
bootstrap and serves. **mTLS material is never touched**: no new CSR, no token, no re-bootstrap, so
the pinned fingerprint still matches and the server stays "online" with the same identity. That is
the entire reason to do this over the agent channel instead of re-running the installer.

If `syscall.Exec` *does* return (it only returns on failure), the agent logs loudly and keeps
running the **old** code with the **new** binary already on disk — restart the service to apply.

Control-plane side: `selfUpdateServerAgent` sends `Hello` first and requires the `"self-update"`
capability (`SELF_UPDATE_CAPABILITY`); an agent too old gets `AgentUpdateUnsupportedError` ("re-run
the install command") rather than a raw `UNIMPLEMENTED`. The RPC deadline is
`SELF_UPDATE_TIMEOUT_MS = 2 * 60_000`.

## 9. Post-update verification, per server

Do this before moving to the next server — that is the whole point of going one at a time.

1. **Hello answers with the new version.** `connectAgent(id).hello()` → `agentVersion` matches the
   tag, `contractVersion` is `V1`, and `capabilities[]` still contains everything you rely on
   (`self-update`, `backup`, `docker-cleanup`, `container-stats`, `deploy.*`). A capability that
   *disappeared* is a release regression — stop the rollout.
2. **Status is `online`** on the Servers page (force a check), and `statusMessage` is empty.
3. **`agent_version` in the DB matches** — see §7 if it does not.
4. **Metrics flow**: the server card shows CPU/mem/disk, not `—`. This exercises the mTLS dial, the
   `Metrics` RPC and `markServerSeen` in one shot.
5. **A real deploy** on that server: redeploy one small App and watch the log stream to completion.
   Streaming is the thing a re-exec breaks, so a deploy that both builds *and* streams is the
   strongest single check.
6. **Logs / console** on an existing App still attach.
7. **If the release added a NEW path alongside an old one, diff the two on a real host** — same
   machine, same second, both paths, compare the numbers field by field.

Only then move on. Agent 0 gets the same list, plus: the control plane is still serving `:3000` and
the dashboard renders.

### Why step 7 exists

It is the check that caught the only real defect in the v1.11.0 rollout, and no test caught it —
because both paths were individually correct.

`StreamMetrics` shipped reporting `HostMetrics.running_containers` as the count of
**`deplo.managed`** containers, while the unary `Metrics` RPC has always reported the **unfiltered**
`docker ps -q` count. Each was self-consistent and each had passing tests. Run against a live host
they disagreed in the same second — the unary said 3, the stream said 2 — because that host also runs
Traefik. Left alone, the dashboard's container gauge would have silently dropped on every server as
its agent was updated, with nothing in the logs and no failing test to point at.

The general shape: **a new path that duplicates an old one is not verified by its own tests, only by
comparison against the thing it replaces.** Unit tests pin each path to its own author's assumption;
only a side-by-side run on real data catches the two assumptions differing. Do this before rolling
past the canary, not after — the fix required a v1.11.1, because a published tag cannot be withdrawn
(§10).

## 10. Rollback is forward-only — know this before you start

**`updateServerAgent` structurally cannot downgrade an agent.** It calls
`resolveLatestAgentRelease()`, which is hard-wired to `releases/latest` (the ALWAYS-LATEST policy in
`lib/agent/release.ts`). There is no version argument anywhere in the path — not in the GraphQL
mutation, not in the data layer, not in the RPC. "Update to the previous version" is not an
operation that exists.

Re-running the installer does not save you either: `renderInstallScript()` substitutes the URL and
sha256 from that *same* always-latest resolver, so the script the control plane serves always
installs the newest release.

The two real options:

- **Publish a patch release that reverts the change**, then roll it out through §1–§9. Preferred:
  it keeps every host on a verified, checksummed artifact and leaves the fleet self-consistent.
- **Pin by hand on the affected host**: take the rendered `install-agent.sh`, replace
  `AGENT_VERSION` / `AGENT_URL_*` / `AGENT_SHA256_*` with the values from the older release's
  `checksums.txt` and asset URLs, and run it there. This re-bootstraps (fresh token, new mTLS
  materials) — it is not the in-place path, and it needs shell access to the host.

**This is a known fleet-operations gap**, and it is a mission-level one: the second option requires
SSH, which is exactly what deplo promises the operator never needs (`AGENTS.md` → Core mission). The
honest mitigation today is that a bad agent is *caught on the canary*, not on 66 Apps — which is why
§4's ordering is not optional. A real fix (a pinnable target version through the whole path) belongs
in the issue tracker, not in a runbook workaround.
