import "server-only";

import { eq } from "drizzle-orm";
import { hostname } from "node:os";

import type { AppStatus } from "../types";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { getCurrentUser } from "../auth";
import { encryptSecret, decryptSecret, htpasswdLine } from "../crypto";
import { isDeploHostServer } from "../deploy/domains";
import { withTraefikDashboard, traefikDashboardDomain } from "../deploy/traefik-stack";
import { recordActivity } from "./activity";
import { getServerById } from "./servers";
import { stopStackOn, startStackOn } from "./volume-migration";

/**
 * Host-level maintenance for ONE server — the actions on Settings → Servers →
 * <server> that operate on the box rather than on anything deployed to it.
 *
 * Every entry point is instance-admin gated, matching the page itself: this view
 * spans servers restricted to other teams, and a host restart is an instance
 * concern, not a team one. There is no per-team variant on purpose.
 *
 * Everything that touches the host goes through the agent (ADR-0006). Nothing
 * here shells out, and the Traefik YAML is rendered by lib/deploy/traefik-stack —
 * this module decides WHEN, never WHAT the compose says.
 */

/** What a host reports about itself, plus what the control plane knows about it. */
export type ServerHostInfo = {
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  memTotalBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  osPretty: string;
  kernel: string;
  arch: string;
  dockerVersion: string;
  dockerRootDir: string;
  uptimeSec: number;
  timezone: string;
  timeUnixMs: number;
  /**
   * Deplo's own clock when this reading landed, so a caller can say how far the
   * host has drifted WITHOUT involving the viewer's machine. Skew measured
   * against a browser is a measurement of the browser: a laptop an hour out
   * would paint every healthy server in the fleet red.
   */
  controlPlaneTimeUnixMs: number;
  utcOffsetMinutes: number;
  /**
   * Whether Deplo installed the Traefik on this host — i.e. whether there is a
   * stack of ours to reconfigure. False for a host behind the operator's own
   * proxy, which is exactly when the dashboard toggle must not be offered.
   */
  traefikManaged: boolean;
  /** The domain the host is CURRENTLY publishing the dashboard on, read from the
   *  live stack file rather than from our stored column — the same read-live-not
   *  -stored rule status and URLs follow. */
  traefikDashboardDomain: string | null;
  /** Whether the panel runs in a container the agent could restart. */
  canRestartControlPlane: boolean;
};

/** Per-workload outcome of a whole-server restart. */
export type RestartedWorkload = {
  kind: "app" | "database";
  name: string;
  /** Why it did not come back, verbatim for the operator. When the stop landed
   *  but the start did not, it also says the workload is now DOWN rather than
   *  merely un-restarted. Nullable only because the DTO is shared. */
  error: string | null;
};

export type ServerRestartReport = {
  restarted: number;
  /** Workloads left alone: the ones already stopped (restarting them would have
   *  STARTED them, a different verb than the operator pressed) and the ones with
   *  a deploy in flight, which come back on their own. */
  skipped: number;
  failures: RestartedWorkload[];
};

/* ------------------------------------------------------------------ */
/* Host identity + clock                                               */
/* ------------------------------------------------------------------ */

/**
 * Read what this host IS. Dials the agent; persists nothing.
 *
 * Deliberately not cached: the whole point of the panel is to answer "what is
 * actually on this box right now", and a stored answer is how a server ends up
 * showing the RAM it had before the operator resized it.
 */
export async function serverHostInfo(id: string): Promise<ServerHostInfo> {
  await requireInstanceAdmin();
  // Not redundant with the gate above: the 2FA POLICY lives in
  // requireActiveTeamId, and every mutation in this module already goes through
  // it. Without this line a member the policy has locked out of everything else
  // could still read every host's hardware, disk and clock.
  await requireActiveTeamId();
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const { fetchHostInfo } = await import("../infra/agent-client");
  const info = await fetchHostInfo(id, { controlPlaneHint: controlPlaneHint() });
  return toHostInfo(info);
}

/**
 * Move a host's clock to an IANA timezone.
 *
 * Validated against the platform's own IANA database, so there is no list to
 * maintain and no dependency to add. The agent re-validates against
 * /usr/share/zoneinfo, because that is where the write happens and a host may
 * simply not carry every zone.
 *
 * This changes the host's WALL CLOCK LABEL, not the instant: nothing restarts,
 * no certificate and no TOTP is affected. Deplo's own schedules stay on UTC.
 * See the copy on the Advanced tab, which must keep saying so.
 */
export async function setServerTimezone(
  id: string,
  timezone: string,
): Promise<ServerHostInfo> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const tz = canonicalTimezone(timezone);
  if (!tz)
    throw new Error(
      `${timezone.trim() || "That"} is not a timezone. Pick one from the list, like "Europe/Rome".`,
    );

  const { setHostTimezone } = await import("../infra/agent-client");
  const info = await setHostTimezone(id, tz, { controlPlaneHint: controlPlaneHint() });
  await recordActivity(
    "member",
    `Set the timezone on ${server.name} to ${tz}`,
    user.name,
    null,
    teamId,
  );
  return toHostInfo(info);
}

/**
 * The CANONICAL IANA name for what the caller sent, or null if it is not a zone.
 *
 * Asked of the platform's own IANA database rather than a pattern or a list.
 * `Intl` is used instead of `Intl.supportedValuesOf("timeZone")` because it also
 * knows the ALIASES: that list holds only canonical names, so it rejects
 * `Asia/Calcutta` and `US/Eastern`, real zones a host carries and an API client
 * may reasonably send.
 *
 * Canonicalising rather than merely accepting is what keeps the host's two write
 * paths in agreement. `timedatectl` records the name it is handed; the
 * /etc/localtime relink records the file that name RESOLVES to. Send
 * "US/Eastern" and the host reports back "America/New_York" or "US/Eastern"
 * depending on which path ran. Send the canonical name and both agree.
 *
 * Two things `Intl` accepts that a host cannot:
 *  - a bare UTC offset ("+05:30"), which is not a zone and has no zone file;
 *  - any casing, so "europe/rome" survives here and then meets a case-sensitive
 *    filesystem, coming back as "not a known timezone on this host".
 * Both are refused here, where the message can still say something useful.
 *
 * The agent re-validates against /usr/share/zoneinfo, which is the check that
 * actually matters: this one only keeps garbage from reaching the host.
 *
 * Exported for its unit test: with the agent unreachable there is no other way to
 * observe WHICH name would have been sent.
 */
export function canonicalTimezone(input: string): string | null {
  const tz = input.trim();
  if (!tz) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return /^[+-]/.test(resolved) ? null : resolved;
}

/* ------------------------------------------------------------------ */
/* Restarts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Restart every App and database Deplo runs on this server.
 *
 * Scoped to Deplo's OWN workloads, not `docker restart $(docker ps -q)`: a
 * server can carry containers Deplo never deployed — the agent itself, an
 * operator's own tooling — and bouncing those is not what this button offers.
 *
 * Already-stopped workloads are SKIPPED rather than started. "Restart" and
 * "start everything that was off" are different verbs, and only one of them was
 * pressed. So are the ones with a deploy in flight: stopping a stack out from
 * under its own `compose up` is how a "restart everything" leaves a half-built
 * app behind, and that deploy brings it up by itself anyway.
 *
 * Failures are collected per workload instead of aborting: on a host where one
 * stack is wedged, the other twenty should still come back.
 */
export async function restartServerWorkloads(id: string): Promise<ServerRestartReport> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const db = getDb();
  const [appRows, dbRows] = await Promise.all([
    // status is the App's own INTENT: the last thing the control plane was asked
    // to do, not what the host has (lib/apps/display-status.ts). It is the right
    // input all the same: what this button must never do is turn something the
    // operator deliberately stopped back on, and intent is exactly the record of
    // that. What the host is actually running is the agent's business, and it
    // says so by failing the stop.
    db
      .select({ slug: appsTable.slug, name: appsTable.name, status: appsTable.status })
      .from(appsTable)
      .where(eq(appsTable.serverId, id)),
    db
      .select({ host: databasesTable.host, name: databasesTable.name, status: databasesTable.status })
      .from(databasesTable)
      .where(eq(databasesTable.serverId, id)),
  ]);

  const targets: Array<{
    kind: "app" | "database";
    slug: string;
    name: string;
    restart: boolean;
  }> = [
    ...appRows.map((a) => ({
      kind: "app" as const,
      slug: a.slug,
      name: a.name,
      restart: !LEAVE_ALONE_APP_STATUSES.has(a.status),
    })),
    ...dbRows.map((d) => ({
      kind: "database" as const,
      // `host` IS the stack slug (`db-<name>`, frozen at create). The connection
      // string's host is a different value that never lands in this column.
      slug: d.host,
      name: d.name,
      restart: !LEAVE_ALONE_DB_STATUSES.has(d.status),
    })),
  ];

  const failures: RestartedWorkload[] = [];
  let restarted = 0;
  let skipped = 0;
  // Sequential on purpose: this runs on ONE host, and firing twenty concurrent
  // compose invocations at a box the operator is already worried about is how a
  // "restart everything" turns into an outage.
  for (const target of targets) {
    if (!target.restart) {
      skipped++;
      continue;
    }
    try {
      await stopStackOn(id, target.slug);
    } catch (e) {
      failures.push({ kind: target.kind, name: target.name, error: reason(e) });
      continue;
    }
    try {
      await startStackOn(id, target.slug);
      restarted++;
    } catch (e) {
      // The one outcome the operator must not have to infer: it went down and did
      // not come back. Reported as a failure like any other would read as "nothing
      // happened", and something did.
      failures.push({
        kind: target.kind,
        name: target.name,
        error: `stopped, but did not start again: ${reason(e)}`,
      });
    }
  }

  await recordActivity(
    "member",
    `Restarted ${restarted} workload${restarted === 1 ? "" : "s"} on ${server.name}`,
    user.name,
    null,
    teamId,
  );
  return { restarted, skipped, failures };
}

/**
 * App statuses a whole-server restart passes over. See restartServerWorkloads.
 *
 * `idle`/`stopping` are down (restarting would START them); `building`/`queued`
 * have a deploy in flight and come back on their own. `error` is deliberately
 * NOT here: it means the last DEPLOY failed, which routinely leaves the previous
 * stack up and serving. Treating it as stopped skipped the very apps an operator
 * reaches for this button to fix, and then told them those apps were "already
 * stopped".
 *
 * Typed `Set<AppStatus>` inside and read as strings outside: that is what makes a
 * status that does not exist a COMPILE error. The untyped version carried
 * "stopped" and "failed" for months. Neither is an AppStatus, so neither ever
 * matched anything.
 */
const LEAVE_ALONE_APP_STATUSES: ReadonlySet<string> = new Set<AppStatus>([
  "idle",
  "stopping",
  "building",
  "queued",
]);

/** The same call for databases: `stopped` is down, `provisioning` is mid-create
 *  (there is no stack yet). `error` is restartable for the same reason as above. */
const LEAVE_ALONE_DB_STATUSES: ReadonlySet<string> = new Set(["stopped", "provisioning"]);

/** An error's own words, for a report the operator reads. */
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Restart the host's Traefik. Not a config change: the stack file is untouched,
 * so this is the "it is wedged, bounce it" button and nothing more.
 */
export async function restartServerTraefik(id: string): Promise<void> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const { applyTraefikConfig } = await import("../infra/agent-client");
  const res = await applyTraefikConfig(id, { restartOnly: true });
  // The agent reports a refusal (a Traefik it did not install) as ok:false with
  // a reason — surface that verbatim rather than inventing copy for it.
  if (!res.ok) throw new Error(res.error || `Could not restart Traefik on ${server.name}`);
  await recordActivity("member", `Restarted Traefik on ${server.name}`, user.name, null, teamId);
}

/**
 * Restart the Deplo panel — only ever on the host that runs it.
 *
 * The refusal for a remote is not cosmetic: `restartControlPlane` identifies its
 * target by the hint we send, which is OUR hostname. On a remote that hint names
 * nothing, so without this check the operator would get "Deplo is not running as
 * a container on this host" from a button that should not have been offered.
 */
export async function restartDeploPanel(id: string): Promise<void> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  if (!isDeploHostServer(server))
    throw new Error(
      `${server.name} does not run the Deplo panel — only the host running Deplo can restart it.`,
    );

  const { restartControlPlaneOn } = await import("../infra/agent-client");
  const res = await restartControlPlaneOn(id, controlPlaneHint());
  if (!res.ok)
    throw new Error(res.error || "Deplo could not be restarted on this host");
  // Recorded BEFORE the restart lands (it is scheduled a moment out), so the
  // trail survives the process going away mid-request.
  await recordActivity("member", `Restarted the Deplo panel`, user.name, null, teamId);
}

/**
 * How the control plane names itself to the agent: its own hostname, which
 * inside a container IS the short container id. Sending an identity rather than
 * letting the agent hunt for "a container running the deplo image" is what stops
 * a second, unrelated deplo container on the same host from being the one bounced.
 */
function controlPlaneHint(): string {
  return hostname();
}

/* ------------------------------------------------------------------ */
/* The Traefik web panel                                               */
/* ------------------------------------------------------------------ */

export type TraefikDashboardInput = {
  domain: string;
  username: string;
  /** Empty ⇒ keep the stored one (an edit that only moves the domain). Required
   *  the first time the dashboard is enabled. */
  password: string;
};

/**
 * Publish (or unpublish) the host's Traefik dashboard.
 *
 * CREDENTIALS ARE MANDATORY, enforced here rather than only in the form: the
 * dashboard lists every router, service and certificate on the host, so a domain
 * without a username and password would put the fleet's routing table on the
 * open internet. The mutation is reachable from the bearer API too, where there
 * is no form to disable.
 *
 * The compose file is read from the LIVE host and transformed, never re-rendered
 * from a template — see lib/deploy/traefik-stack.ts for why. The row is written
 * only after the agent confirms the stack came up, so a stored domain always
 * means a dashboard that is actually being served.
 *
 * A request that would not change the host's file is answered by reading the host
 * and stopping there: applying recreates the proxy, and nothing on this box should
 * lose its routing for a few seconds to have the same bytes written back.
 */
export async function setServerTraefikDashboard(
  id: string,
  input: TraefikDashboardInput | null,
): Promise<void> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  // Validate BEFORE dialing. A request missing a password must be refused on its
  // own merits, not after a round trip that may itself fail — otherwise the
  // operator gets "server unreachable" for a form they simply filled in wrong.
  let credentials: { domain: string; username: string; password: string } | null = null;
  if (input) {
    const domain = input.domain.trim().toLowerCase();
    const username = input.username.trim();
    if (!domain) throw new Error("Enter the domain the Traefik panel should answer on");
    if (!username) throw new Error("Enter a username for the Traefik panel");
    // A username with a colon would split the htpasswd line and silently create a
    // different account than the one the operator typed.
    if (username.includes(":")) throw new Error("A username cannot contain a colon");

    // An empty password means "keep the stored one" — an edit that only moves the
    // domain must not require retyping it. Empty with nothing stored is the
    // first-time case, and that is exactly what may never be published.
    const password = input.password || (await storedPassword(id));
    if (!password)
      throw new Error(
        "Enter a password for the Traefik panel — it cannot be published without one",
      );
    credentials = { domain, username, password };
  }

  const { fetchHostInfo, applyTraefikConfig, withTraefikStackLock } = await import(
    "../infra/agent-client"
  );

  const stored = credentials
    ? {
        domain: credentials.domain,
        username: credentials.username,
        passwordEnc: encryptSecret(credentials.password),
      }
    : null;

  // Read and write under one lock: the whole stack file is rewritten here, and
  // installing a certificate on this host rewrites the same file. Interleaved,
  // whichever read second puts the other's change back. See withTraefikStackLock.
  const changesTheHost = await withTraefikStackLock(id, async () => {
    const current = await fetchHostInfo(id);
    if (!current.traefikComposeYaml)
      throw new Error(
        `Deplo did not install Traefik on ${server.name}, so it cannot publish a dashboard there.`,
      );

    const composeYaml = credentials
      ? withTraefikDashboard(current.traefikComposeYaml, {
          domain: credentials.domain,
          // Re-hashed on every write: the apr1 salt is random, so the stack file
          // never carries a hash we could have reused from somewhere else.
          htpasswdUsers: htpasswdLine(credentials.username, credentials.password),
        })
      : withTraefikDashboard(current.traefikComposeYaml, null);

    // A rewrite that would change nothing is never applied. Applying recreates the
    // proxy, and that takes every site on the host down for a few seconds - doing it
    // to write the same bytes back is the worst kind of surprise. The case this
    // exists for is "turn off the panel" on a host that never published one: it now
    // costs one read of the host and nothing else. The transform is byte-stable, so
    // this comparison is exact (see lib/deploy/traefik-stack.ts).
    if (composeYaml === current.traefikComposeYaml) return false;
    const res = await applyTraefikConfig(id, { composeYaml });
    if (!res.ok)
      throw new Error(res.error || `Could not apply the Traefik configuration on ${server.name}`);
    return true;
  });

  // Only now — the row describes what the host is serving, not what we asked for.
  await getDb()
    .update(serversTable)
    .set({
      traefikDashboardDomain: stored?.domain ?? null,
      traefikDashboardUser: stored?.username ?? null,
      traefikDashboardPasswordEnc: stored?.passwordEnc ?? null,
    })
    .where(eq(serversTable.id, id));

  // Only a real change is an event. Bringing a stale row back in line with a host
  // that publishes nothing is bookkeeping, and an Activity line claiming someone
  // turned off a panel that was never on is a small lie in the audit trail.
  if (changesTheHost) {
    await recordActivity(
      "member",
      stored
        ? `Published the Traefik panel for ${server.name} on ${stored.domain}`
        : `Turned off the Traefik panel for ${server.name}`,
      user.name,
      null,
      teamId,
    );
  }
}

/** The stored dashboard password, so changing the domain does not mean retyping
 *  it. Never leaves this module — there is no reveal path for it. */
async function storedPassword(id: string): Promise<string> {
  const [row] = await getDb()
    .select({ enc: serversTable.traefikDashboardPasswordEnc })
    .from(serversTable)
    .where(eq(serversTable.id, id));
  return row?.enc ? decryptSecret(row.enc) : "";
}

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

function toHostInfo(info: {
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  memTotalBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  osPretty: string;
  kernel: string;
  arch: string;
  dockerVersion: string;
  dockerRootDir: string;
  uptimeSec: number;
  timezone: string;
  timeUnixMs: number;
  utcOffsetMinutes: number;
  traefikComposeYaml: string;
  controlPlaneContainer: string;
}): ServerHostInfo {
  const managed = Boolean(info.traefikComposeYaml);
  return {
    cpuModel: info.cpuModel,
    cpuCores: info.cpuCores,
    cpuThreads: info.cpuThreads,
    memTotalBytes: Number(info.memTotalBytes),
    diskTotalBytes: Number(info.diskTotalBytes),
    diskUsedBytes: Number(info.diskUsedBytes),
    osPretty: info.osPretty,
    kernel: info.kernel,
    arch: info.arch,
    dockerVersion: info.dockerVersion,
    dockerRootDir: info.dockerRootDir,
    uptimeSec: Number(info.uptimeSec),
    timezone: info.timezone,
    timeUnixMs: Number(info.timeUnixMs),
    // Stamped where the reading lands, so the pair is measured between two
    // machines Deplo controls. The agent round trip is inside the difference,
    // which is why a few seconds of it never counts as drift.
    controlPlaneTimeUnixMs: Date.now(),
    utcOffsetMinutes: info.utcOffsetMinutes,
    traefikManaged: managed,
    // Read from the LIVE stack file, not from our stored column: a host whose
    // Traefik was reconfigured out of band should report what it is serving.
    traefikDashboardDomain: managed
      ? traefikDashboardDomain(info.traefikComposeYaml)
      : null,
    canRestartControlPlane: Boolean(info.controlPlaneContainer),
  };
}
