import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { sha256Hex, randomToken } from "../crypto";
import type { ApiToken } from "../types";

export interface ApiTokenDTO {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

function toDTO(t: ApiToken): ApiTokenDTO {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    lastUsedAt: t.lastUsedAt,
    createdAt: t.createdAt,
  };
}

export async function listTokens(): Promise<ApiTokenDTO[]> {
  const teamId = await requireActiveTeamId();
  return read()
    .apiTokens.filter((t) => t.teamId === teamId)
    .map(toDTO);
}

/** Returns the raw token ONCE; only the hash is persisted. */
export async function createToken(name: string): Promise<{ raw: string; token: ApiTokenDTO }> {
  const { teamId, userId } = await requireCapability("manage_infra");
  if (!name.trim()) throw new Error("Name is required");
  const raw = `deplo_${randomToken(24)}`;
  const t: ApiToken = {
    id: newId("tok"),
    teamId,
    // The token acts as its creator for user-scoped fields on bearer requests.
    userId,
    name: name.trim(),
    tokenHash: sha256Hex(raw),
    prefix: raw.slice(0, 12),
    lastUsedAt: null,
    createdAt: nowIso(),
  };
  mutate((d) => d.apiTokens.push(t));
  return { raw, token: toDTO(t) };
}

/**
 * Resolve an incoming `deplo_…` bearer token to its principal, or null if it
 * does not match a live token. Bumps `lastUsedAt`. The GraphQL request context
 * uses this to authenticate external API clients. Never throws.
 */
export function authenticateToken(
  raw: string,
): { userId: string; teamId: string } | null {
  if (!raw.startsWith("deplo_")) return null;
  const hash = sha256Hex(raw);
  const match = read().apiTokens.find((t) => t.tokenHash === hash);
  if (!match) return null;
  // Fire-and-forget usage stamp; a failed write must not block the request.
  try {
    mutate((d) => {
      const t = d.apiTokens.find((x) => x.id === match.id);
      if (t) t.lastUsedAt = nowIso();
    });
  } catch {
    /* usage tracking is best-effort */
  }
  return { userId: match.userId, teamId: match.teamId };
}

export async function revokeToken(id: string): Promise<void> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  mutate((d) => {
    d.apiTokens = d.apiTokens.filter((x) => !(x.id === id && x.teamId === teamId));
  });
}
