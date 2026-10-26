# Fleet rollout: shipping a server-agent release

How a `deplo-agent` change gets from a commit to every server in the fleet, and the order it must
happen in. Written for the 2am case: every command is copy-pasteable, every ordering rule states
what breaks if you ignore it.

The agent lives in its own repo (`DeploCloud/deplo-agent`); the control plane never builds it. The
whole update path is the control plane resolving a **GitHub Release** and telling each **server
agent** to replace its own binary over the existing pinned-mTLS channel - certificates are never
reissued, so a server keeps its identity and stays online across the upgrade.

## 1. The ship path

1. **Commit + push a `v*` tag** in `DeploCloud/deplo-agent`. The tag is the single source of truth
   for the version: `Makefile` stamps `internal/server.AgentVersion` from `git describe`, and
   `.github/workflows/release.yml` stamps it from `${GITHUB_REF_NAME#v}` - the leading `v` is
   stripped so it matches how `lib/agent/release.ts` normalizes tags.
2. **`release.yml` gates on `go test ./...`** before it builds anything. A red test = no release,
   so there is nothing for the fleet to pick up. It then builds static
   (`CGO_ENABLED=0 -trimpath`) `linux/amd64` + `linux/arm64`, runs `sha256sum` over both into
   `checksums.txt`, and publishes all three as release assets.
3. **Pin it in the control plane** (ADR-0037): `"deplo": { "agent": "<tag without v>" }` in
   `package.json`, and raise `agentMin` only if the panel now needs the newer agent - every server
   below it becomes unusable until it updates. That is the whole switch: the expected version is
   the pin, resolved from `releases/download/v<pin>/checksums.txt` (no API call) and memoised for
   the process. `docker-image.yml` refuses to publish a panel whose pin has no `checksums.txt`.
4. **Ship the panel.** Once it runs, it updates every server behind the pin by itself (§3). By hand
   is only for an agent-only re-cut, through §6.

## 2. The asset-name contract

Three basenames, exactly:

```
deplo-agent-linux-amd64
deplo-agent-linux-arm64
checksums.txt          # sha256sum format: "<64-hex>  <filename>" per line
```

`assetName()` in `lib/agent/release.ts` builds the first two by string interpolation and
`fetchPinnedRelease()` fetches `checksums.txt` by literal name. `install-agent.sh` picks its pair
by `uname -m`; the agent picks its own by `runtime.GOARCH`. Renaming an asset breaks both sides.

**A release missing `checksums.txt` is refused entirely.** `fetchPinnedRelease()` returns `null`
if it is absent, if the fetch fails, or if it names neither binary. `resolveAgentRelease()`
returning `null` means:

- `/install-agent.sh` 503s instead of serving an unverifiable installer (`lib/agent/install-script.ts`),
- `selfUpdateServerAgent` throws `AgentReleaseUnavailableError` _before_ dialing any agent,
- the automatic rollout claims nothing that pass, so a GitHub outage never spends any server's
  24 hours of retries.

No unverifiable binary is ever served or installed. The checksum is read from the published
artifact, deliberately **not** from the GitHub API's per-asset digest, so the integrity claim comes
from what CI actually signed off on. Per-arch resolution needs _both_ the asset and a matching
`checksums.txt` line; an arch missing either is dropped, and the release is only usable if at least
one arch survives.

## 3. The panel carries the fleet

**Deplo updates every provisioned server behind the pin on its own**
(`lib/data/servers/agent-rollout.ts`, ADR-0037). A pass runs every minute, one host at a time, in
§4's order. Activity entries are signed by `instance_settings.agent_rollout_by` (whoever clicked
the panel update, written by `applyDeploUpdate`), or "Deplo".

Each server has at most one row in `server_agent_updates` (`agent-update-state.ts`): none means
idle, the success of an attempt deletes it. An attempt is CLAIMED with one atomic upsert, so two
never run on one host, across processes too; a `running` row older than 10 minutes is a dead
process and can be taken back.

- **A deploy in flight** (`queued`/`building`, through `coalesce(deployments.server_id,
apps.server_id)` - see §5) is a `busy` failure; **no Hello** is `unreachable`; a failed
  SelfUpdate, including `AgentUpdateUnsupportedError`, is `error`. Each is that server's own
  failure: the pass moves on.
- **A host that took the binary and never came back** is `no_return`: the pass stops, and every
  later pass tries only that server until it recovers. A release that breaks one agent must not
  break four.
- **Retries** back off 1, 2, 4 … 60 minutes for 24 hours from the first failure, then stop. A
  server that was `unreachable` when Deplo gave up gets one more attempt the next time a Hello
  sees it (`agentSeen`, called from `markServerSeen`). A Hello on the pin closes the row whatever
  updated it. A new pin at boot drops every row (`dropStaleAgentUpdates`).

**The only manual path is `retryServerAgentUpdate(id)`** (`lib/graphql/types/server/enrollment.ts`,
`lib/data/servers/agent-maintenance.ts`): instance admin, refused before Deplo's own attempt has
failed and while one runs. It skips the wait, keeps the 24 hours, and is the **Retry now** button on
the server page and on the Updates tab. `fleetAgents` is the read side: pin, minimum, who is behind
with their update state, and `pausedBy`.

Both gates apply: `authScopes: { instanceAdmin: true }` at the field and `requireInstanceAdmin()`
inside. The automatic pass runs with no identity, so it calls the infra seam directly.

**Driving a rollout by hand is still supported**: the scripted path in §6 walks the same order.

## 4. Order: canary → the rest → the Deplo host LAST

**Identify the Deplo host (agent 0) first.** It is stored as `type = "remote"` like every other
server - there is no discriminating column. The only signal is address matching:
`isDeploHostServer()` / `deploHostSelfAddresses()` in `lib/deploy/domains.ts` compare a row's `ip`
/ `host` against `DEPLO_SERVER_IP`, the hostname of `DEPLO_PUBLIC_URL`, and every non-internal NIC
IPv4. In practice: **`servers.ip` equals `DEPLO_SERVER_IP` in `.env`.**

```sh
grep '^DEPLO_SERVER_IP=' /root/projects/deplo/.env
# and, ordering by blast radius (fewest Apps first). DEPLO_DATABASE_URL lives only
# in .env, it is NOT in your shell, so pull it in first, or psql silently drops to
# its socket default and fails as `role "root" does not exist`:
export $(grep -E '^DEPLO_DATABASE_URL=' /root/projects/deplo/.env | xargs)
docker exec postgres psql "$DEPLO_DATABASE_URL" -c \
  "select s.id, s.name, s.ip, s.agent_version, count(a.id) as apps
     from servers s left join apps a on a.server_id = s.id
    group by s.id order by apps;"
```

A snapshot, not a source of truth - the query above is. At the time of writing the fleet was:

| order      | server          | id                     | apps | note                                   |
| ---------- | --------------- | ---------------------- | ---- | -------------------------------------- |
| 1 (canary) | `neon-s1`       | `srv_f47d8cba7db4c813` | 2    | fewest Apps                            |
| 2          | `151.243.213.9` | `srv_905da16a400243c3` | 2    |                                        |
| 3          | `neon-s2`       | `srv_07b0be4ab9ef9533` | 3    |                                        |
| 4 (last)   | `eu-main-1`     | `srv_3667cf1973005952` | 10   | **agent 0** - `ip` = `DEPLO_SERVER_IP` |

**Why agent 0 goes last.** It runs the control plane itself. A bad agent there takes out the
_observer_ as well as the observed: the process that would tell you the rollout went wrong, that
serves the Servers page, that dials the other agents, and that hosts the app you would use to roll
forward. Break a leaf server and you have a healthy control plane and two good agents to compare
against; break agent 0 first and you are debugging blind, on the box, over SSH - the exact failure
mode the platform exists to avoid. It is also the biggest blast radius here (10 Apps).

**Why a canary at all.** `go test ./...` gates the release but proves nothing about _this_ fleet's
kernels, Docker versions and install layouts. The canary is the smallest real host that can
disprove the release. Let it sit long enough to Hello, serve a deploy and stream logs before moving on.

## 5. Skip servers with in-flight deploys

Self-update `syscall.Exec`s the process **750ms after replying** (`selfUpdateGrace` in
`internal/server/selfupdate.go`). Every open stream on that agent dies with it: an in-flight deploy
(server-streaming `Deploy`), log tails, console attach. Check before each
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
`lib/data/deployments/cancel-and-delete.ts`). Non-empty → do not update that server yet.

**Do not simplify that to a bare `where d.server_id = …`.** `deployments.server_id` is nullable by
design (schema comment in `lib/db/schema/control-plane/deployments.ts`: it is a denormalized mirror of
`apps.server_id`, "backfilled for rows that predate the queue"). The control plane never reads it
bare either - `onServer` in `lib/data/deployments/cancel-and-delete.ts` is exactly
`coalesce(deployments.server_id, apps.server_id)`, and the queue-position query uses the same. A
bare read makes a null-`server_id` deploy _invisible_, so the check returns zero rows, you read it
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

`bun run test` and `bun run dev` are fine; anything that _dials an agent_ is not. Run rollout
scripts from the repo root with:

```sh
/usr/bin/node \
  --env-file=.env \
  --require ./lib/test/server-only-shim.cjs \
  --import tsx <script>.ts
```

- Spell the path out. nvm is **gone** from this host (`/root/.nvm` no longer exists - that path is
  what older revisions of this doc and `scripts/rollout-agent-1.12.mts` still print); real Node is
  `/usr/bin/node`. A bare `node` works today but resolves off `PATH`, which is exactly where a
  bun shim would sit.
- `--env-file=.env` supplies `DEPLO_DATABASE_URL` / `DEPLO_SECRET` (the app fail-fasts without them).
- `--require ./lib/test/server-only-shim.cjs` no-ops the `server-only` guard that `lib/data/*` and
  `lib/agent/release.ts` import.
- `--import tsx` gives TypeScript **and** the `@/*` path alias, which resolves off the repo's
  `tsconfig.json`, so run from `/root/projects/deplo`, not from a scratch directory.
- The repo is CJS: **no top-level `await`** in the script (esbuild errors out). Wrap the body in
  `async function main() { … }` and call it.

### `scripts/fleet-update.mts` flags

```sh
/usr/bin/node --env-file=.env --require ./lib/test/server-only-shim.cjs --import tsx \
  scripts/fleet-update.mts --dry-run
/usr/bin/node --env-file=.env --require ./lib/test/server-only-shim.cjs --import tsx \
  scripts/fleet-update.mts --only=srv_… --expect=<capability>
```

- `--dry-run` touches no agent. Run it first, every time: it also prints the order.
- **`--expect=<capability>` is mandatory whenever the new binary reports the same version as the
  old one** - a re-cut tag, or a build off a tag that already shipped. The version then proves
  nothing about the swap; the capability the new commit adds is the only evidence. **If the commit
  adds none, adding one is part of the rollout, not an extra** - without it the script's confirm
  loop compares a version to itself, decides nothing changed, and reports the host as already done.
- `--only=<server id>` restricts the run to one server, which is how you drive §4's order by
  hand. The script sorts remotes by App count on its own, so the plain run is already
  canary-first; `--only` is for pausing between hosts.

## 7. The footgun: the infra seam does not write `agent_version`

`selfUpdateServerAgent(serverId)` in `lib/infra/agent-client/agent-lifecycle.ts` returns `{ version, restarting }`
and writes **nothing** to the database. The rollout writes the badge from the confirming Hello
(`confirmUpdated` → `markServerSeen`).

A **script that calls the infra seam directly** must do the write itself:

```ts
const { version } = await selfUpdateServerAgent(id);
await markServerSeen(id, version); // lib/data/servers/agent-handshake.ts - ungated, best-effort
```

Skip it and the badge lags. Note _what_ corrects it, because it is not the health prober:
`recordServerHealth` (`lib/data/server-health.ts`) writes `status` / `statusMessage` /
`statusCheckedAt`, plus `lastSeenAt` only on an `online`/`warning` probe, and never
`agent_version`. The paths that do refresh it from a live Hello all go through `markServerSeen`:
the **metrics poll** (`lib/data/monitoring.ts`), the **deploy preflight** (`agentPreflight`,
`lib/infra/agent-client/preflight.ts`), and the telemetry **stream supervisor**
(`lib/monitoring/supervisor.ts`, on main since the telemetry stream landed), which does one
`markServerSeen` per connection off the opening Hello and supersedes the poll for agents
advertising `metrics-stream`. On a quiet server with
nobody on Monitoring, a stale badge can persist for a long time.

`markServerSeen` only pins the _version_ when `agent_cert_fingerprint is not null` (the `case` wraps just
`agentVersion`), so it is a no-op for the badge on an unprovisioned row, but the rest of the write
still lands: `lastSeenAt` unconditionally, and `traefikEnabled` / `dockerVersion` / specs whenever
the caller passes them.

## 8. What self-update actually does on the host

`Service.SelfUpdate` in `internal/server/selfupdate.go`, in order:

1. `os.Executable()` + `filepath.EvalSymlinks` - resolve the **real** file, so a symlinked install
   swaps the target, not the link.
2. Select `req.Binaries[runtime.GOARCH]`. The control plane sends _every_ published arch; the agent
   is the authority on its own. A missing arch → `FAILED_PRECONDITION`, nothing touched.
3. Download (bounded at 256 MiB) and **verify sha256 - mandatory, no flag, no skip**. Mismatch →
   `FAILED_PRECONDITION` ("refusing to install an unverified binary") and the _running binary is
   untouched_. Same guarantee `install-agent.sh` enforces.
4. Stage to a temp file **beside** the executable (same filesystem, so the rename is atomic), chmod
   `0755`, then `os.Rename` over the running executable. On Linux this is legal: the open text
   segment holds the old inode, the path now points at the new bytes.
5. Reply `{version, restarting: true}`, then - after `selfUpdateGrace` (750ms, so the response
   flushes) - `syscall.Exec(exePath, argv, env)`.

`syscall.Exec` means **same PID, same argv, same env**. The process is _replaced_, not exited, so
systemd's `Restart=on-failure` is irrelevant - there is no exit for it to react to. The new binary
finds the same `--agent-dir`, reuses the existing `agent.crt` / `agent.key` / `ca.crt`, skips
bootstrap and serves. **mTLS material is never touched**: no new CSR, no token, no re-bootstrap, so
the pinned fingerprint still matches and the server stays "online" with the same identity. That is
the entire reason to do this over the agent channel instead of re-running the installer.

If `syscall.Exec` _does_ return (it only returns on failure), the agent logs loudly and keeps
running the **old** code with the **new** binary already on disk - restart the service to apply.

Control-plane side: `selfUpdateServerAgent` sends `Hello` first and requires the `"self-update"`
capability (`SELF_UPDATE_CAPABILITY`); an agent too old gets `AgentUpdateUnsupportedError` ("re-run
the install command") rather than a raw `UNIMPLEMENTED`. The RPC deadline is
`SELF_UPDATE_TIMEOUT_MS = 2 * 60_000`.

## 9. Post-update verification, per server

Do this before moving to the next server - that is the whole point of going one at a time.

1. **Hello answers with the new version.** `connectAgent(id).hello()` → `agentVersion` matches the
   tag, `contractVersion` is `V1`, and `capabilities[]` still contains everything you rely on
   (`self-update`, `backup`, `docker-cleanup`, `container-stats`, `deploy.*`). A capability that
   _disappeared_ is a release regression - stop the rollout.
2. **Status is `online`** on the Servers page (force a check), and `statusMessage` is empty.
3. **`agent_version` in the DB matches**: see §7 if it does not.
4. **Metrics flow**: the server card shows CPU/mem/disk, not `—`. This exercises the agent link, the
   `Metrics` RPC and `markServerSeen` in one shot.
5. **A real deploy** on that server: redeploy one small App and watch the log stream to completion.
   Streaming is the thing a re-exec breaks, so a deploy that both builds _and_ streams is the
   strongest single check.
6. **Logs / console** on an existing App still attach.
7. **If the release added a NEW path alongside an old one, diff the two on a real host**: same
   machine, same second, both paths, compare the numbers field by field.

Only then move on. Agent 0 gets the same list, plus: the control plane still answers on its own
address and the dashboard renders.

### Why step 7 exists

It is the check that caught the only real defect in the v1.11.0 rollout, and no test caught it,
because both paths were individually correct.

`StreamMetrics` shipped reporting `HostMetrics.running_containers` as the count of
**`deplo.managed`** containers, while the unary `Metrics` RPC has always reported the **unfiltered**
`docker ps -q` count. Each was self-consistent and each had passing tests. Run against a live host
they disagreed in the same second (the unary said 3, the stream said 2), because that host also runs
Traefik. Left alone, the dashboard's container gauge would have silently dropped on every server as
its agent was updated, with nothing in the logs and no failing test to point at.

The general shape: **a new path that duplicates an old one is not verified by its own tests, only by
comparison against the thing it replaces.** Unit tests pin each path to its own author's assumption;
only a side-by-side run on real data catches the two assumptions differing. Do this before rolling
past the canary, not after - the fix required a v1.11.1, because a published tag cannot be withdrawn
(§10).

## 10. Rollback is forward-only - know this before you start

**Nothing installs an agent older than the one a server runs.** `selfUpdateServerAgent` refuses
when the agent is ahead of the pin, and an agent newer than the pin is compatible and left alone
(ADR-0037). The pin is now explicit, so a bad agent release is undone by **pinning a fixed one**:

- **Publish a patch release that reverts the change**, pin it, ship the panel. Preferred: every host
  stays on a verified, checksummed artifact. Hosts that took the bad release move forward to it.
- **Pin by hand on the affected host**: take the rendered `install-agent.sh`, replace
  `AGENT_VERSION` / `AGENT_URL_*` / `AGENT_SHA256_*` with an older release's values, and run it
  there. This re-bootstraps (fresh token, new mTLS materials) and needs shell access, which the
  mission says nobody should need: it is the break-glass, not the procedure.

The canary in §4 is still the real protection, and the `no_return` pause in §3 is what stops a
release that kills its agent from reaching the second server.
