import "server-only";

import { isNotNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane";
import { sweepDomainDns } from "../data/domains";
import { describeStackCertificates } from "../data/server-certificates";
import { getUpdateInfo } from "../data/updates";
import { connectAgent } from "../infra/agent-client";
import { resolveExpectedAgentVersion } from "../version";
import { isAgentOutdated } from "../version";
import { dispatchServerAlert, dispatchToTeams } from "./dispatch";
import { allTeamIds } from "./server-teams";

/**
 * The things nobody polls.
 *
 * Four conditions that are real, checkable and — until now — only ever noticed
 * by somebody who happened to open the right page:
 *  - a new Deplo release (`getUpdateInfo` is a `revalidate: 3600` fetch, so on an
 *    instance nobody visits the check never runs at all),
 *  - a server agent left behind by the fleet,
 *  - a custom certificate about to lapse with nothing set to renew it,
 *  - a domain whose DNS was repointed after it was added.
 *
 * Rides the existing twice-daily certificate-renewal interval rather than adding
 * a scheduler: none of these is urgent to the minute, a new tick would cost a
 * lease name, a module and a teardown handler to run four queries a day, and the
 * cooldown state is per-process either way, so a lease would buy nothing.
 */

/** Warn this far ahead of a certificate expiring. */
const CERT_WARN_DAYS = 21;

export async function runMaintenanceSweep(): Promise<void> {
  await settle("deplo update", checkDeploUpdate);
  await settle("agent versions", checkAgentVersions);
  await settle("certificates", checkCustomCertificates);
  await settle("domain dns", sweepDomainDns);
}

/** One failing check must never stop the other three. */
async function settle(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`[deplo] maintenance sweep (${what}) failed:`, e);
  }
}

/** A newer Deplo. Instance-wide, so every team hears it. */
async function checkDeploUpdate(): Promise<void> {
  const info = await getUpdateInfo();
  if (!info.updateAvailable || !info.latest) return;
  const teams = await allTeamIds();
  if (teams.length === 0) return;
  dispatchToTeams(teams, {
    key: "deplo_update_available",
    // The VERSION is the dedupe state, so a fresh release re-fires at once
    // instead of waiting out the weekly nag.
    dedupe: { id: "deplo-update", state: info.latest },
    title: `Deplo ${info.latest} is available`,
    body: `This instance is on ${info.current}.`,
    path: "/settings/deplo",
  });
}

/**
 * Agents behind the fleet. Read from the stored `agent_version` column rather
 * than the telemetry frame's `agentOutdated`: same answer, no dial, and a
 * twice-daily cadence instead of every five seconds.
 */
async function checkAgentVersions(): Promise<void> {
  const expected = await resolveExpectedAgentVersion();
  const rows = await getDb()
    .select({
      id: serversTable.id,
      name: serversTable.name,
      agentVersion: serversTable.agentVersion,
    })
    .from(serversTable)
    .where(isNotNull(serversTable.agentVersion));
  for (const s of rows) {
    if (!isAgentOutdated(s.agentVersion, expected)) continue;
    dispatchServerAlert(s.id, {
      key: "agent_update_available",
      dedupe: { id: `agentver:${s.id}`, state: expected },
      title: `${s.name} can update its agent`,
      body: `It runs ${s.agentVersion}; ${expected} is out. Update it from the server's actions menu.`,
      path: "/settings/servers",
    });
  }
}

/**
 * Custom certificates a human uploaded. Let's Encrypt renews itself at 30 days,
 * so anything still inside three weeks is a manual certificate that nothing is
 * going to renew.
 */
async function checkCustomCertificates(): Promise<void> {
  const rows = await getDb()
    .select({ id: serversTable.id, name: serversTable.name })
    .from(serversTable)
    .where(isNotNull(serversTable.agentCertPem));
  for (const s of rows) {
    let yaml: string;
    try {
      const conn = await connectAgent(s.id);
      try {
        yaml = (await conn.readStack("traefik")).yaml;
      } finally {
        conn.close();
      }
    } catch {
      // An unreachable host is already the subject of its own alert.
      continue;
    }
    for (const cert of describeStackCertificates(yaml)) {
      if (!cert.expired && cert.expiresInDays > CERT_WARN_DAYS) continue;
      dispatchServerAlert(s.id, {
        key: "certificate_expiring",
        dedupe: {
          id: `cert:${s.id}:${cert.id}`,
          state: cert.expired ? "expired" : "expiring",
        },
        title: cert.expired
          ? `The certificate for ${cert.subject} has expired`
          : `The certificate for ${cert.subject} expires in ${cert.expiresInDays} days`,
        body: `Uploaded to ${s.name}. Nothing renews a custom certificate automatically.`,
        path: "/settings/servers",
      });
    }
  }
}

/** Exported so a future Advanced panel reads this instead of forking it. */
export { CERT_WARN_DAYS };
