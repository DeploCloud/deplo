import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
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
  await assertUser();
  return read().apiTokens.map(toDTO);
}

/** Returns the raw token ONCE; only the hash is persisted. */
export async function createToken(name: string): Promise<{ raw: string; token: ApiTokenDTO }> {
  await assertUser();
  if (!name.trim()) throw new Error("Name is required");
  const raw = `deplo_${randomToken(24)}`;
  const t: ApiToken = {
    id: newId("tok"),
    name: name.trim(),
    tokenHash: sha256Hex(raw),
    prefix: raw.slice(0, 12),
    lastUsedAt: null,
    createdAt: nowIso(),
  };
  mutate((d) => d.apiTokens.push(t));
  return { raw, token: toDTO(t) };
}

export async function revokeToken(id: string): Promise<void> {
  await assertUser();
  mutate((d) => {
    d.apiTokens = d.apiTokens.filter((x) => x.id !== id);
  });
}
