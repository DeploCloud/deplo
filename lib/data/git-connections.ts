import "server-only";

import { and, count, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  gitConnections as gitConnectionsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { decryptSecret, encryptSecret } from "../crypto";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { PUBLIC_URL_PLACEHOLDER, resolveManifestBaseUrl } from "../public-url";
import {
  ensureWebhook,
  hasWebhook,
  providerFor,
  removeWebhook,
  KNOWN_PROVIDERS,
  type GitCredential,
  type RepoSummary,
} from "../git/providers";
import { recordActivity } from "./activity";
import type { GitConnection, GitProviderId, GitRepo } from "../types";
import { randomBytes } from "node:crypto";

/**
 * Git connections - a team's stored credentials for every git host that is not
 * GitHub. The security boundary for the feature: every read filters by the
 * active team, every mutation is `manage_git`-gated (the same Capability that
 * connects a GitHub App), and the token never leaves this module in clear except
 * towards the provider itself or the clone edge.
 *
 * There is deliberately NO reveal path. A connection's token is write-only like
 * every other secret in Deplo: you can replace it, never read it back.
 */

/** A connection as the UI sees it: no token, plus what depends on it. */
export interface GitConnectionDTO extends GitConnection {
  /** Apps whose clone this connection authenticates. Drives the delete warning. */
  appCount: number;
  /** Whether this provider can list repositories and register webhooks. */
  hasApi: boolean;
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
  };
}

/**
 * The active team's connections, newest first.
 *
 * Not `requireTeamWide`-gated, matching `listGithubInstallations`: a member who
 * only reaches one project still has to pick a credential when configuring that
 * project's app, and the list carries no secret and no cross-team row.
 */
export async function listGitConnections(): Promise<GitConnectionDTO[]> {
  const teamId = await requireActiveTeamId();
  const db = getDb();
  const rows = await db
    .select()
    .from(gitConnectionsTable)
    .where(eq(gitConnectionsTable.teamId, teamId));
  // One grouped count instead of a query per connection.
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

/**
 * A connection's decrypted credentials. INTERNAL and deliberately NOT
 * team-scoped: its two callers are the clone edge and the inbound webhook, both
 * of which run outside a user session, and both reach it only through an id that
 * was written under a team-scoped, capability-gated mutation. Never expose it
 * through GraphQL, and never return it to a client.
 */
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
    token: decryptSecret(row.tokenEnc),
    webhookSecret: decryptSecret(row.webhookSecretEnc),
    teamId: row.teamId,
  };
}

/** Whether a connection id belongs to this team. The guard that keeps a crafted
 *  request from borrowing another team's token to clone their private repo. */
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

/** The same, but refusing a connection outside the caller's active team. */
async function requireOwnCredential(
  connectionId: string,
): Promise<GitCredential & { webhookSecret: string; teamId: string }> {
  const teamId = await requireActiveTeamId();
  const cred = await readGitCredential(connectionId);
  if (!cred || cred.teamId !== teamId) throw new Error("Git connection not found");
  return cred;
}

/* ------------------------------------------------------------------ */
/* The webhook address                                                 */
/* ------------------------------------------------------------------ */

/**
 * Where a provider posts its push deliveries for this connection. Built from
 * DEPLO_PUBLIC_URL and never from a request header: the URL is stored on the
 * provider's side, so a host guessed from one browser request would keep firing
 * at the wrong address forever.
 */
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

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export interface ConnectGitProviderInput {
  provider: string;
  label: string;
  baseUrl: string;
  username: string;
  token: string;
}

/** Normalise a user-typed host into an origin: https by default, no trailing
 *  slash, no path, no embedded credentials. */
function cleanBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter the address of your git server");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not a valid address`);
  }
  if (u.username || u.password) {
    throw new Error("Put the token in the token field, not in the address");
  }
  return u.origin;
}

/**
 * Connect a git provider: prove the token works, then store it encrypted.
 *
 * Proving it first is the whole point of the round trip - a typo'd token that is
 * only discovered at the next deploy is a broken deploy plus a mystery, while a
 * failure here is one error message next to the field that caused it.
 */
export async function connectGitProvider(
  input: ConnectGitProviderInput,
): Promise<GitConnectionDTO> {
  const { teamId } = await requireCapability("manage_git");
  const user = (await getCurrentUser())!;
  // An unrecognised provider degrades to plain git (credentials only) rather
  // than being stored verbatim: `provider` comes from a client request and it
  // decides which HTTP client we later point at the user's host.
  const provider: GitProviderId = KNOWN_PROVIDERS.has(input.provider as GitProviderId)
    ? (input.provider as GitProviderId)
    : "git";
  const adapter = providerFor(provider);

  const baseUrl = cleanBaseUrl(input.baseUrl || adapter.defaultBaseUrl || "");
  const token = input.token.trim();
  if (!token) throw new Error("Enter an access token");
  const username = (input.username.trim() || adapter.defaultUsername).trim();
  if (!username) throw new Error("Enter the username the token belongs to");

  const cred: GitCredential = { provider, baseUrl, username, token };
  // A plain git server has no API to ask, so there is nothing to prove until the
  // first clone. Every other provider is verified now.
  const account = adapter.api ? await adapter.api.whoami(cred) : null;

  const row = {
    id: newId("gitc"),
    teamId,
    provider,
    label: input.label.trim() || adapter.label,
    baseUrl,
    username,
    tokenEnc: encryptSecret(token),
    webhookSecretEnc: encryptSecret(randomBytes(32).toString("hex")),
    webhookToken: randomBytes(24).toString("hex"),
    accountLogin: account?.login ?? "",
    avatarUrl: account?.avatarUrl ?? "",
    health: "ok",
    healthError: "",
    tokenExpiresAt: account?.expiresAt ?? null,
    lastCheckedAt: nowIso(),
    createdAt: nowIso(),
    createdBy: user.id,
  };
  await getDb().insert(gitConnectionsTable).values(row);
  await recordActivity(
    "member",
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
  /** A replacement token. Absent/empty ⇒ keep the stored one. */
  token?: string | null;
}

/** Rename a connection or rotate its token. A new token is proven before it
 *  replaces the working one. */
export async function updateGitConnection(
  id: string,
  input: UpdateGitConnectionInput,
): Promise<GitConnectionDTO> {
  const { teamId } = await requireCapability("manage_git");
  const current = await requireOwnCredential(id);
  const adapter = providerFor(current.provider);

  const username = input.username?.trim() || current.username;
  const token = input.token?.trim() || current.token;
  if (adapter.api && (token !== current.token || username !== current.username)) {
    await adapter.api.whoami({ ...current, username, token });
  }
  const patch: Partial<typeof gitConnectionsTable.$inferInsert> = {
    username,
    health: "ok",
    healthError: "",
    lastCheckedAt: nowIso(),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(token !== current.token ? { tokenEnc: encryptSecret(token) } : {}),
  };
  const updated = await getDb()
    .update(gitConnectionsTable)
    .set(patch)
    .where(
      and(eq(gitConnectionsTable.id, id), eq(gitConnectionsTable.teamId, teamId)),
    )
    .returning();
  if (updated.length === 0) throw new Error("Git connection not found");
  const user = (await getCurrentUser())!;
  await recordActivity(
    "member",
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

/**
 * Disconnect a provider. Apps that cloned through it are unlinked in the same
 * transaction and their auto-deploy is turned off: without the token they can
 * neither clone a private repo nor receive a delivery, and an app that silently
 * stops deploying is worse than one that says so.
 */
export async function removeGitConnection(id: string): Promise<number> {
  const { teamId } = await requireCapability("manage_git");
  const db = getDb();
  const row = (
    await db
      .select()
      .from(gitConnectionsTable)
      .where(
        and(eq(gitConnectionsTable.id, id), eq(gitConnectionsTable.teamId, teamId)),
      )
      .limit(1)
  )[0];
  if (!row) throw new Error("Git connection not found");

  const unlinked = await db.transaction(async (tx) => {
    const affected = await tx
      .update(appsTable)
      .set({ repoConnectionId: null, autoDeploy: false, updatedAt: nowIso() })
      .where(
        and(
          eq(appsTable.repoConnectionId, id),
          eq(appsTable.teamId, teamId),
        ),
      )
      .returning({ id: appsTable.id });
    await tx
      .delete(gitConnectionsTable)
      .where(
        and(eq(gitConnectionsTable.id, id), eq(gitConnectionsTable.teamId, teamId)),
      );
    return affected.length;
  });

  const user = (await getCurrentUser())!;
  await recordActivity(
    "member",
    `Disconnected the ${row.label} git connection`,
    user.name,
    null,
    teamId,
  );
  return unlinked;
}

/**
 * Ask the provider who the token belongs to, and record the answer. The manual
 * half of the health story (the sweep in `lib/notify/maintenance.ts` is the
 * automatic half) - both write the same two columns.
 */
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
      and(eq(gitConnectionsTable.id, id), eq(gitConnectionsTable.teamId, teamId)),
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

/**
 * Probe a credential and return the health columns it implies. Shared by "Test
 * connection" and the maintenance sweep so the two can never disagree about what
 * "failing" means.
 */
export async function probeCredential(
  cred: GitCredential,
): Promise<Partial<typeof gitConnectionsTable.$inferInsert>> {
  const adapter = providerFor(cred.provider);
  // A plain git server has nothing to probe; it is healthy until a clone says
  // otherwise.
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

/* ------------------------------------------------------------------ */
/* Browsing (the repo picker)                                          */
/* ------------------------------------------------------------------ */

export async function listGitRepos(
  connectionId: string,
): Promise<RepoSummary[]> {
  const cred = await requireOwnCredential(connectionId);
  const api = providerFor(cred.provider).api;
  if (!api) return [];
  return api.listRepos(cred);
}

export async function listGitBranches(
  connectionId: string,
  fullName: string,
): Promise<string[]> {
  const cred = await requireOwnCredential(connectionId);
  const api = providerFor(cred.provider).api;
  if (!api) return [];
  return api.listBranches(cred, fullName);
}

/* ------------------------------------------------------------------ */
/* Push webhook, registered on the user's behalf                       */
/* ------------------------------------------------------------------ */

/** What the Deploy Source card shows about an app's push trigger. */
export interface GitWebhookStatus {
  /** False when this repo needs no webhook (GitHub App, plain URL, plain git). */
  applicable: boolean;
  installed: boolean;
  /** The address to paste when we could not register it ourselves. */
  url: string;
  /** The provider's refusal, verbatim, or "". */
  error: string;
}

const NOT_APPLICABLE: GitWebhookStatus = {
  applicable: false,
  installed: false,
  url: "",
  error: "",
};

/**
 * Register our push webhook on the repository, if it is not already there.
 *
 * Called after the source is saved, never inside its transaction: this makes an
 * HTTP call to a third party, and holding a row lock across someone else's
 * network is how a save ends up taking thirty seconds. Failure is reported, not
 * thrown - a token without the webhook scope should still save a working
 * repository, with the address to paste shown next to it.
 */
export async function syncAppWebhook(repo: GitRepo | null): Promise<GitWebhookStatus> {
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

/**
 * Whether the hook is registered right now, asked of the provider rather than
 * remembered in a column - somebody deleting it on the provider's side is
 * exactly the case a stored flag would get wrong.
 */
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

/** Best-effort removal when an app stops deploying from a connection's repo. */
export async function dropAppWebhook(repo: GitRepo | null): Promise<void> {
  if (!repo?.connectionId || !repo.repo) return;
  const cred = await readGitCredential(repo.connectionId);
  if (!cred) return;
  const url = gitWebhookUrl(await webhookTokenFor(repo.connectionId));
  if (!url) return;
  // Another app may still deploy from the same repository through the same
  // connection, in which case the hook must stay: it is keyed on (connection,
  // repo), not on the app.
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
