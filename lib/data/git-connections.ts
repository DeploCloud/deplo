import "server-only";

// https://deplo.build/docs/guides/git-providers

import { and, count, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { gitConnections as gitConnectionsTable } from "../db/schema/control-plane/integrations";
import { getCurrentUser } from "../auth/current-user";
import { decryptSecret, decryptSecretOrThrow, encryptSecret } from "../crypto";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireTeamWide,
} from "../membership";
import { assertSafeOutboundUrl } from "../outbound-url";
import { PUBLIC_URL_PLACEHOLDER, resolveManifestBaseUrl } from "../public-url";
import { providerFor, KNOWN_PROVIDERS } from "../git/providers/registry";
import type { GitCredential, RepoSummary } from "../git/providers/types";
import {
  ensureWebhook,
  hasWebhook,
  removeWebhook,
} from "../git/providers/webhooks";
import {
  grantedFromScopes,
  missingAccess,
  type AccessRequirement,
} from "../git/provider-access";
import { recordActivity } from "./activity";
import type { GitRepo } from "../types/build";
import type { GitConnection, GitProviderId } from "../types/git";
import { randomBytes } from "node:crypto";

// GitConnectionDTO - a connection as the UI sees it: no token, plus what depends on it.
export interface GitConnectionDTO extends GitConnection {
  appCount: number;
  hasApi: boolean;
  missingAccess: AccessRequirement[];
}

function toDTO(
  row: typeof gitConnectionsTable.$inferSelect,
  appCount: number,
): GitConnectionDTO {
  return {
    id: row.id,
    teamId: row.teamId,
    provider: row.provider as GitProviderId,
    label: row.label,
    baseUrl: row.baseUrl,
    allowPrivateEndpoint: row.allowPrivateEndpoint,
    username: row.username,
    accountLogin: row.accountLogin,
    avatarUrl: row.avatarUrl,
    health: row.health === "failing" ? "failing" : "ok",
    healthError: row.healthError,
    tokenExpiresAt: row.tokenExpiresAt,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    appCount,
    hasApi: providerFor(row.provider).api != null,
    missingAccess: missingAccess(
      row.provider as GitProviderId,
      grantedFromScopes(row.provider as GitProviderId, row.tokenScopes),
      // A connection is not an app: previews are a GitHub feature, so only the core half.
      { previews: false },
    ),
  };
}

// listGitConnections - the active team's connections, newest first.
export async function listGitConnections(): Promise<GitConnectionDTO[]> {
  const teamId = await requireActiveTeamId();
  const db = getDb();
  const rows = await db
    .select()
    .from(gitConnectionsTable)
    .where(eq(gitConnectionsTable.teamId, teamId));
  const usage = await db
    .select({ id: appsTable.repoConnectionId, n: count() })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId))
    .groupBy(appsTable.repoConnectionId);
  const byId = new Map(usage.map((u) => [u.id, Number(u.n)]));
  return rows
    .map((r) => toDTO(r, byId.get(r.id) ?? 0))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// readGitCredential - decrypted credentials; never expose them through GraphQL or to a client.
export async function readGitCredential(
  connectionId: string,
): Promise<(GitCredential & { webhookSecret: string; teamId: string }) | null> {
  const row = (
    await getDb()
      .select()
      .from(gitConnectionsTable)
      .where(eq(gitConnectionsTable.id, connectionId))
      .limit(1)
  )[0];
  if (!row) return null;
  return {
    provider: row.provider as GitProviderId,
    baseUrl: row.baseUrl,
    username: row.username,
    // Strict: decrypting to "" reads as the provider's own "bad credentials" instead.
    token: decryptSecretOrThrow(row.tokenEnc, "This git connection's token"),
    webhookSecret: decryptSecret(row.webhookSecretEnc),
    teamId: row.teamId,
  };
}

// gitConnectionInTeam - the guard that stops a crafted request borrowing another team's token.
export async function gitConnectionInTeam(
  connectionId: string,
  teamId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: gitConnectionsTable.id })
    .from(gitConnectionsTable)
    .where(
      and(
        eq(gitConnectionsTable.id, connectionId),
        eq(gitConnectionsTable.teamId, teamId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function requireOwnCredential(
  connectionId: string,
): Promise<GitCredential & { webhookSecret: string; teamId: string }> {
  const teamId = await requireActiveTeamId();
  const cred = await readGitCredential(connectionId);
  if (!cred || cred.teamId !== teamId)
    throw new Error("Git connection not found");
  return cred;
}

// gitWebhookUrl - where a provider posts its push deliveries for this connection.
export function gitWebhookUrl(webhookToken: string): string {
  const base = resolveManifestBaseUrl();
  if (base === PUBLIC_URL_PLACEHOLDER) return "";
  return `${base}/api/git/webhook/${webhookToken}`;
}

async function webhookTokenFor(connectionId: string): Promise<string> {
  const row = (
    await getDb()
      .select({ token: gitConnectionsTable.webhookToken })
      .from(gitConnectionsTable)
      .where(eq(gitConnectionsTable.id, connectionId))
      .limit(1)
  )[0];
  return row?.token ?? "";
}

export interface ConnectGitProviderInput {
  provider: string;
  label: string;
  baseUrl: string;
  username: string;
  token: string;
  // Instance-admin only, enforced below: a git server on the operator's own LAN.
  allowPrivateEndpoint?: boolean | null;
}

// https by default, no path, no embedded credentials, and not inside the deployment unless allowed.
async function cleanBaseUrl(
  raw: string,
  allowPrivate: boolean,
): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter the address of your git server");
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not a valid address`);
  }
  if (u.username || u.password) {
    throw new Error("Put the token in the token field, not in the address");
  }
  if (!allowPrivate)
    await assertSafeOutboundUrl(u.origin, "Address", { allowHttp: true });
  return u.origin;
}

// connectGitProvider - prove the token works, then store it encrypted.
export async function connectGitProvider(
  input: ConnectGitProviderInput,
): Promise<GitConnectionDTO> {
  const { teamId } = await requireCapability("manage_git");
  const user = (await getCurrentUser())!;
  // provider comes from a client request, so an unrecognised one degrades to plain git.
  const provider: GitProviderId = KNOWN_PROVIDERS.has(
    input.provider as GitProviderId,
  )
    ? (input.provider as GitProviderId)
    : "git";
  const adapter = providerFor(provider);

  // A team capability must never be enough to aim the control plane at its own network.
  const allowPrivateEndpoint = Boolean(input.allowPrivateEndpoint);
  if (allowPrivateEndpoint) await requireInstanceAdmin();

  const baseUrl = await cleanBaseUrl(
    input.baseUrl || adapter.defaultBaseUrl || "",
    allowPrivateEndpoint,
  );
  const token = input.token.trim();
  if (!token) throw new Error("Enter an access token");
  const username = (input.username.trim() || adapter.defaultUsername).trim();
  if (!username) throw new Error("Enter the username the token belongs to");

  const cred: GitCredential = { provider, baseUrl, username, token };
  // A plain git server has no API to ask: nothing is proven until the first clone.
  const account = adapter.api ? await adapter.api.whoami(cred) : null;

  const row = {
    id: newId("gitc"),
    teamId,
    provider,
    label: input.label.trim() || adapter.label,
    baseUrl,
    allowPrivateEndpoint,
    username,
    tokenEnc: encryptSecret(token),
    webhookSecretEnc: encryptSecret(randomBytes(32).toString("hex")),
    webhookToken: randomBytes(24).toString("hex"),
    accountLogin: account?.login ?? "",
    avatarUrl: account?.avatarUrl ?? "",
    health: "ok",
    healthError: "",
    tokenExpiresAt: account?.expiresAt ?? null,
    tokenScopes: (account?.scopes ?? []).join(" "),
    lastCheckedAt: nowIso(),
    createdAt: nowIso(),
    createdBy: user.id,
  };
  await getDb().insert(gitConnectionsTable).values(row);
  await recordActivity(
    "integration",
    `Connected ${adapter.label}${row.accountLogin ? ` as ${row.accountLogin}` : ""}`,
    user.name,
    null,
    teamId,
  );
  return toDTO(row, 0);
}

export interface UpdateGitConnectionInput {
  label?: string | null;
  username?: string | null;
  token?: string | null;
}

// updateGitConnection - rename a connection or rotate its token; a new token is proven first.
export async function updateGitConnection(
  id: string,
  input: UpdateGitConnectionInput,
): Promise<GitConnectionDTO> {
  const { teamId } = await requireCapability("manage_git");
  const current = await requireOwnCredential(id);
  const adapter = providerFor(current.provider);

  const username = input.username?.trim() || current.username;
  const token = input.token?.trim() || current.token;
  // A replacement token can carry different scopes: the old token's must not describe it.
  const account =
    adapter.api && (token !== current.token || username !== current.username)
      ? await adapter.api.whoami({ ...current, username, token })
      : null;
  const patch: Partial<typeof gitConnectionsTable.$inferInsert> = {
    username,
    health: "ok",
    healthError: "",
    lastCheckedAt: nowIso(),
    ...(account ? { tokenScopes: (account.scopes ?? []).join(" ") } : {}),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(token !== current.token ? { tokenEnc: encryptSecret(token) } : {}),
  };
  const updated = await getDb()
    .update(gitConnectionsTable)
    .set(patch)
    .where(
      and(
        eq(gitConnectionsTable.id, id),
        eq(gitConnectionsTable.teamId, teamId),
      ),
    )
    .returning();
  if (updated.length === 0) throw new Error("Git connection not found");
  const user = (await getCurrentUser())!;
  await recordActivity(
    "integration",
    `Updated the ${updated[0].label} git connection`,
    user.name,
    null,
    teamId,
  );
  return toDTO(updated[0], await appCountFor(id, teamId));
}

async function appCountFor(id: string, teamId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(appsTable)
    .where(
      and(eq(appsTable.repoConnectionId, id), eq(appsTable.teamId, teamId)),
    );
  return Number(row?.n ?? 0);
}

// removeGitConnection - disconnect a provider.
export async function removeGitConnection(id: string): Promise<number> {
  const { teamId } = await requireCapability("manage_git");
  const db = getDb();
  const row = (
    await db
      .select()
      .from(gitConnectionsTable)
      .where(
        and(
          eq(gitConnectionsTable.id, id),
          eq(gitConnectionsTable.teamId, teamId),
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new Error("Git connection not found");

  const unlinked = await db.transaction(async (tx) => {
    const affected = await tx
      .update(appsTable)
      .set({ repoConnectionId: null, autoDeploy: false, updatedAt: nowIso() })
      .where(
        and(eq(appsTable.repoConnectionId, id), eq(appsTable.teamId, teamId)),
      )
      .returning({ id: appsTable.id });
    await tx
      .delete(gitConnectionsTable)
      .where(
        and(
          eq(gitConnectionsTable.id, id),
          eq(gitConnectionsTable.teamId, teamId),
        ),
      );
    return affected.length;
  });

  const user = (await getCurrentUser())!;
  await recordActivity(
    "integration",
    `Disconnected the ${row.label} git connection`,
    user.name,
    null,
    teamId,
  );
  return unlinked;
}

// testGitConnection - ask the provider who the token belongs to, and record the answer.
export async function testGitConnection(id: string): Promise<GitConnectionDTO> {
  await requireCapability("manage_git");
  const teamId = await requireActiveTeamId();
  const cred = await requireOwnCredential(id);
  const adapter = providerFor(cred.provider);
  const patch = await probeCredential(cred);
  const updated = await getDb()
    .update(gitConnectionsTable)
    .set(patch)
    .where(
      and(
        eq(gitConnectionsTable.id, id),
        eq(gitConnectionsTable.teamId, teamId),
      ),
    )
    .returning();
  if (updated.length === 0) throw new Error("Git connection not found");
  if (patch.health === "failing") {
    throw new Error(
      `${adapter.label} rejected the stored token: ${patch.healthError}`,
    );
  }
  return toDTO(updated[0], await appCountFor(id, teamId));
}

// probeCredential - probe a credential and return the health columns it implies.
export async function probeCredential(
  cred: GitCredential,
): Promise<Partial<typeof gitConnectionsTable.$inferInsert>> {
  const adapter = providerFor(cred.provider);
  if (!adapter.api) {
    return { health: "ok", healthError: "", lastCheckedAt: nowIso() };
  }
  try {
    const account = await adapter.api.whoami(cred);
    return {
      health: "ok",
      healthError: "",
      accountLogin: account.login,
      avatarUrl: account.avatarUrl,
      tokenExpiresAt: account.expiresAt,
      tokenScopes: (account.scopes ?? []).join(" "),
      lastCheckedAt: nowIso(),
    };
  } catch (e) {
    return {
      health: "failing",
      healthError: (e as Error).message.slice(0, 300),
      lastCheckedAt: nowIso(),
    };
  }
}

export async function listGitRepos(
  connectionId: string,
): Promise<RepoSummary[]> {
  // A narrowed token must not enumerate the team's git host through the connection's PAT.
  await requireTeamWide("the team's git repositories");
  const cred = await requireOwnCredential(connectionId);
  const api = providerFor(cred.provider).api;
  if (!api) return [];
  return api.listRepos(cred);
}

export async function listGitBranches(
  connectionId: string,
  fullName: string,
): Promise<string[]> {
  await requireTeamWide("the team's git repositories");
  const cred = await requireOwnCredential(connectionId);
  const api = providerFor(cred.provider).api;
  if (!api) return [];
  return api.listBranches(cred, fullName);
}

// GitWebhookStatus - what the Deploy Source card shows about an app's push trigger.
export interface GitWebhookStatus {
  applicable: boolean;
  installed: boolean;
  url: string;
  error: string;
}

const NOT_APPLICABLE: GitWebhookStatus = {
  applicable: false,
  installed: false,
  url: "",
  error: "",
};

// syncAppWebhook - register the push webhook on the repository, if it is not already there.
export async function syncAppWebhook(
  repo: GitRepo | null,
): Promise<GitWebhookStatus> {
  if (!repo?.connectionId || !repo.repo) return NOT_APPLICABLE;
  const cred = await readGitCredential(repo.connectionId);
  if (!cred || !providerFor(cred.provider).api) return NOT_APPLICABLE;
  const url = gitWebhookUrl(await webhookTokenFor(repo.connectionId));
  if (!url) {
    return {
      applicable: true,
      installed: false,
      url: "",
      error:
        "Set DEPLO_PUBLIC_URL to a public address so your git provider can reach this instance.",
    };
  }
  try {
    await ensureWebhook(cred, repo.repo, url, cred.webhookSecret);
    return { applicable: true, installed: true, url, error: "" };
  } catch (e) {
    return {
      applicable: true,
      installed: false,
      url,
      error: (e as Error).message.slice(0, 300),
    };
  }
}

// appWebhookStatus - asked of the provider, never stored: a hook deleted there must read as gone.
export async function appWebhookStatus(
  repo: GitRepo | null,
): Promise<GitWebhookStatus> {
  if (!repo?.connectionId || !repo.repo) return NOT_APPLICABLE;
  const cred = await readGitCredential(repo.connectionId);
  if (!cred || !providerFor(cred.provider).api) return NOT_APPLICABLE;
  const url = gitWebhookUrl(await webhookTokenFor(repo.connectionId));
  if (!url) {
    return {
      applicable: true,
      installed: false,
      url: "",
      error:
        "Set DEPLO_PUBLIC_URL to a public address so your git provider can reach this instance.",
    };
  }
  try {
    return {
      applicable: true,
      installed: await hasWebhook(cred, repo.repo, url),
      url,
      error: "",
    };
  } catch (e) {
    return {
      applicable: true,
      installed: false,
      url,
      error: (e as Error).message.slice(0, 300),
    };
  }
}

// dropAppWebhook - best-effort removal when an app stops deploying from a connection's repo.
export async function dropAppWebhook(repo: GitRepo | null): Promise<void> {
  if (!repo?.connectionId || !repo.repo) return;
  const cred = await readGitCredential(repo.connectionId);
  if (!cred) return;
  const url = gitWebhookUrl(await webhookTokenFor(repo.connectionId));
  if (!url) return;
  // The hook is keyed on (connection, repo), so it stays while another app still uses it.
  const [still] = await getDb()
    .select({ n: count() })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.repoConnectionId, repo.connectionId),
        eq(appsTable.repoRepo, repo.repo),
      ),
    );
  if (Number(still?.n ?? 0) > 0) return;
  await removeWebhook(cred, repo.repo, url).catch(() => {});
}
