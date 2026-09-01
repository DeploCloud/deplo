import "server-only";

import { and, eq, isNotNull, lt, notExists, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  gitConnections as gitConnectionsTable,
  githubApps as githubAppsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { oauthClient, oauthConsent, verification } from "../db/schema/auth";
import { decryptSecret } from "../crypto";
import { sweepRateLimits } from "../security";
import { probeCredential } from "../data/git-connections";
import { readAppAccess } from "../github/app";
import {
  grantedFromScopes,
  missingAccess,
  type AccessRequirement,
} from "../git/provider-access";
import { sweepDomainDns } from "../data/domains";
import { describeStackCertificates } from "../data/server-certificates";
import { getUpdateInfo } from "../data/updates";
import { sweepFinishedMigrationMarks } from "../data/migration-import";
import { connectAgent } from "../infra/agent-client";
import {
  dispatchAlert,
  dispatchServerAlert,
  dispatchToTeams,
} from "./dispatch";
import { allTeamIds } from "./server-teams";
import type { GitProviderId } from "../types";

/**
 * The things nobody polls.
 */

/** Warn this far ahead of a certificate expiring. */
const CERT_WARN_DAYS = 21;

export async function runMaintenanceSweep(): Promise<void> {
  await settle("Deplo update", checkDeploUpdate);
  await settle("certificates", checkCustomCertificates);
  await settle("domain dns", sweepDomainDns);
  await settle("git tokens", checkGitConnections);
  await settle("github app access", checkGithubAppAccess);
  // Housekeeping rather than a check: closed rate-limit windows are already
  // treated as absent, this just stops a year of guessed addresses accumulating
  // as dead rows.
  await settle("rate limits", sweepRateLimits);
  await settle("migration marks", sweepFinishedMigrationMarks);
  await settle("oauth clients", sweepAbandonedOauthClients);
  await settle("expired challenges", sweepExpiredVerifications);
}

/**
 * Drop `verification` rows whose deadline has passed. Better Auth consumes a
 * challenge on first use and never comes back for the ones nobody finishes, and it
 * ships no pruning of its own.
 */
async function sweepExpiredVerifications(): Promise<void> {
  await getDb()
    .delete(verification)
    .where(lt(verification.expiresAt, new Date()));
}

/**
 * Drop OAuth clients that registered and then never got approved. RFC 7591
 * registration has to be open, claude.ai and ChatGPT cannot pre-register, so
 * anyone who can reach the instance can create rows here.
 */
async function sweepAbandonedOauthClients(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await getDb()
    .delete(oauthClient)
    .where(
      and(
        lt(oauthClient.createdAt, cutoff),
        notExists(
          getDb()
            .select({ one: sql`1` })
            .from(oauthConsent)
            .where(eq(oauthConsent.clientId, oauthClient.clientId)),
        ),
      ),
    );
}

/** One failing step must never stop the others. */
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
  await dispatchToTeams(teams, {
    key: "deplo_update_available",
    // The VERSION is the dedupe state, so a fresh release re-fires at once
    // instead of waiting out the weekly nag.
    dedupe: { id: "deplo-update", state: info.latest },
    title: `Deplo ${info.latest} is available`,
    body: `This instance is on ${info.current}.`,
    path: "/settings/deplo?tab=updates",
  });
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
    // A migration source has no Traefik stack of ours to read: dialing it would
    // only ever produce a miss, on a machine we are borrowing.
    .where(
      and(
        isNotNull(serversTable.agentCertPem),
        eq(serversTable.importOnly, false),
      ),
    );
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

/**
 * Git connection tokens. A revoked or expired token is the one failure mode a user
 * cannot see coming: nothing changes in Deplo, and the first symptom is a deploy
 * failing on `git clone` at the worst possible moment.
 */
async function checkGitConnections(): Promise<void> {
  const rows = await getDb().select().from(gitConnectionsTable);
  for (const row of rows) {
    const cred = {
      provider: row.provider as GitProviderId,
      baseUrl: row.baseUrl,
      username: row.username,
      token: decryptSecret(row.tokenEnc),
    };
    const patch = await probeCredential(cred);
    await getDb()
      .update(gitConnectionsTable)
      .set(patch)
      .where(eq(gitConnectionsTable.id, row.id));

    // Independent of health: a token can be perfectly valid and still be missing
    // a scope, which is the failure nobody sees coming.
    raiseMissingAccess(
      row.teamId,
      `gitconn:${row.id}`,
      `The ${row.label} git connection is missing access`,
      missingAccess(
        row.provider as GitProviderId,
        grantedFromScopes(
          row.provider as GitProviderId,
          patch.tokenScopes ?? row.tokenScopes,
        ),
      ),
    );

    const expiringSoon =
      patch.health === "ok" &&
      patch.tokenExpiresAt != null &&
      Date.parse(patch.tokenExpiresAt) - Date.now() <
        TOKEN_WARN_DAYS * 24 * 60 * 60 * 1000;
    if (patch.health !== "failing" && !expiringSoon) continue;

    dispatchAlert({
      teamId: row.teamId,
      key: "git_connection_failing",
      // The state is what changed, so a token that goes from expiring to
      // revoked re-fires instead of being swallowed as a repeat.
      dedupe: {
        id: `gitconn:${row.id}`,
        state: patch.health === "failing" ? "failing" : "expiring",
      },
      title:
        patch.health === "failing"
          ? `The ${row.label} git connection stopped working`
          : `The ${row.label} git connection expires soon`,
      body:
        patch.health === "failing"
          ? `${patch.healthError || "The provider rejected the stored token."} Deploys from it will fail until the token is replaced.`
          : `Its token expires on ${(patch.tokenExpiresAt ?? "").slice(0, 10)}. Replace it in Settings → Git.`,
      path: "/settings/git",
    });
  }
}

/**
 * What each connected GitHub App is allowed to do, asked of GitHub. The pull
 * request half is only raised for a team that uses previews somewhere - nobody
 * needs telling about a feature they never turned on.
 */
async function checkGithubAppAccess(): Promise<void> {
  const db = getDb();
  const apps = await db
    .select({
      id: githubAppsTable.id,
      teamId: githubAppsTable.teamId,
      name: githubAppsTable.name,
    })
    .from(githubAppsTable);
  if (apps.length === 0) return;
  const previewTeams = new Set(
    (
      await db
        .selectDistinct({ teamId: appsTable.teamId })
        .from(appsTable)
        .where(eq(appsTable.previewEnabled, true))
    ).map((r) => r.teamId),
  );
  for (const app of apps) {
    // Null is an unreachable GitHub, not a stripped App: say nothing.
    const access = await readAppAccess(app.id);
    if (!access) continue;
    raiseMissingAccess(
      app.teamId,
      `ghapp:${app.id}`,
      `The ${app.name} GitHub App is missing access`,
      [
        ...access.missingCore,
        ...(previewTeams.has(app.teamId) ? access.missingPreviews : []),
      ],
    );
  }
}

/** One alert for both halves, so the two can never word the same gap differently. */
function raiseMissingAccess(
  teamId: string,
  dedupeId: string,
  title: string,
  missing: AccessRequirement[],
): void {
  if (missing.length === 0) return;
  dispatchAlert({
    teamId,
    key: "git_access_missing",
    // The state is WHAT is missing, so a second permission disappearing re-fires
    // instead of hiding behind the first.
    dedupe: {
      id: dedupeId,
      state: missing
        .map((r) => r.key)
        .sort()
        .join(","),
    },
    title,
    body: `Deplo cannot ${missing.map((r) => r.unlocks).join(", ")}. Allow ${missing
      .map((r) => r.label)
      .join(", ")} and it will work again.`,
    path: "/settings/git",
  });
}

/** Warn this far ahead of a git token expiring. */
const TOKEN_WARN_DAYS = 7;

/** Exported so a future Advanced panel reads this instead of forking it. */
export { CERT_WARN_DAYS };
