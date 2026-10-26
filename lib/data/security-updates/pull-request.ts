import "server-only";

import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { githubInstallation } from "../../db/schema/control-plane/integrations";
import { securityPullRequests } from "../../db/schema/control-plane/security-updates";
import {
  GithubAccessError,
  branchHead,
  openPullRequestWithFiles,
  readAppAccess,
} from "../../github/app";
import { githubFullName } from "../../github/repo-id";
import { resolveCloneUrl } from "../../git/clone-url";
import { connectAgent } from "../../infra/agent-client/connect";
import { PACKAGE_UPDATE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { assertUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { compareVersions } from "../../security-updates/versions";
import { recordActivity } from "../activity";
import { getAppById } from "../apps/listing";
import { requireAppCapability } from "../node-access";
import { appSecurityUpdates, type SecurityUpdate } from "./read";

export interface OpenedPullRequest {
  number: number | null;
  url: string | null;
  // Set instead when GitHub must first grant Deplo write access: where to grant it.
  accessUrl: string | null;
}

// Fixed names, so a second click finds the first pull request instead of opening another.
export function pullRequestNames(packageName: string, version: string) {
  return {
    branch: `deplo/security/${packageName.replace(/^@/, "").replace(/\//g, "-")}-${version}`,
    message: `fix(deps): ${packageName} ${version}`,
    title: `Security update: ${packageName} ${version}`,
  };
}

function pullRequestBody(
  packageName: string,
  version: string,
  items: SecurityUpdate[],
): string {
  const installed = [...new Set(items.map((u) => u.installedVersion))];
  const via = items.find((u) => u.via.length)?.via;
  const advisories = new Map(items.map((u) => [u.vulnId, u]));
  return [
    `Moves **${packageName}** from ${installed.join(", ")} to ${version}, which fixes:`,
    "",
    ...[...advisories.values()].map(
      (u) =>
        `- [${u.vulnId}](${u.osvUrl})${u.cve && u.cve !== u.vulnId ? ` (${u.cve})` : ""}${u.summary ? `: ${u.summary}` : ""}`,
    ),
    "",
    ...(via
      ? [
          `${via[0]} pulls it in, so the new version is pinned with an override.`,
        ]
      : []),
    "Opened from Deplo's Security updates. Merge it and the next deploy runs the fix.",
  ].join("\n");
}

async function missingWriteAccess(
  installationId: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ appId: githubInstallation.appId })
    .from(githubInstallation)
    .where(eq(githubInstallation.id, installationId))
    .limit(1);
  const access = rows[0] ? await readAppAccess(rows[0].appId) : null;
  return access?.missingSecurityPrs.length ? access.settingsUrl : null;
}

// Moves one npm dependency of a GitHub app to the version that fixes its advisories, as a pull request.
export async function openSecurityPullRequest(
  appId: string,
  packageName: string,
): Promise<OpenedPullRequest> {
  const { teamId, userId } = await requireAppCapability(
    appId,
    "open_security_prs",
  );
  const user = await assertUser();
  const app = await getAppById(appId);
  const repo = app?.repo;
  const fullName = githubFullName(repo);
  if (!app || !repo?.installationId || repo.provider !== "github" || !fullName)
    throw new Error("Deplo opens pull requests for apps deployed from GitHub");

  const items = (await appSecurityUpdates(appId))?.updates.filter(
    (u) =>
      u.ecosystem === "npm" &&
      u.packageName === packageName &&
      (u.fix === "code" || u.fix === "build_only") &&
      u.fixedVersion,
  );
  if (!items?.length)
    throw new Error(`${packageName} has no fix Deplo can move in your code`);
  const version = items
    .map((u) => u.fixedVersion as string)
    .sort(compareVersions)
    .at(-1) as string;

  const accessUrl = await missingWriteAccess(repo.installationId);
  if (accessUrl) return { number: null, url: null, accessUrl };

  const head = await branchHead(fullName, repo.branch, repo.installationId);
  if (!head) throw new Error(`Could not read ${repo.branch} on GitHub`);
  const conn = await connectAgent(app.serverId);
  let prepared;
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(PACKAGE_UPDATE_CAPABILITY))
      throw new Error(
        "Update this server's Deplo agent to open security pull requests",
      );
    prepared = await conn.preparePackageUpdate({
      git: {
        url: await resolveCloneUrl(repo),
        branch: repo.branch,
        commit: head.sha,
        subdir: app.build.rootDirectory ?? "",
        token: "",
        submodules: false,
      },
      package: packageName,
      version,
      override: items.some((u) => u.via.length > 0),
    });
  } finally {
    conn.close();
  }
  if (prepared.error) throw new Error(prepared.error);

  const names = pullRequestNames(packageName, version);
  let pr: { number: number; url: string };
  try {
    pr = await openPullRequestWithFiles({
      installationId: repo.installationId,
      fullName,
      base: repo.branch,
      baseCommit: prepared.baseCommit || head.sha,
      ...names,
      body: pullRequestBody(packageName, version, items),
      files: prepared.files.map((f) => ({
        path: f.path,
        content: gunzipSync(f.gzip).toString("utf8"),
      })),
    });
  } catch (e) {
    if (e instanceof GithubAccessError)
      return { number: null, url: null, accessUrl: e.settingsUrl };
    throw e;
  }

  const row = {
    appId,
    teamId,
    packageName,
    version,
    number: pr.number,
    url: pr.url,
    createdBy: user.name,
    createdByUserId: userId,
    createdAt: nowIso(),
  };
  await getDb()
    .insert(securityPullRequests)
    .values(row)
    .onConflictDoUpdate({
      target: [
        securityPullRequests.appId,
        securityPullRequests.packageName,
        securityPullRequests.version,
      ],
      set: { number: row.number, url: row.url },
    });
  await recordActivity(
    "security_update",
    `Opened pull request #${pr.number} to move ${packageName} to ${version} in ${app.name}`,
    user.name,
    appId,
    teamId,
  );
  return { number: pr.number, url: pr.url, accessUrl: null };
}
