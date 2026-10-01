import { createHash } from "node:crypto";

import type { SourceCredential } from "../source";
import {
  REQUEST_TIMEOUT_MS,
  openStream,
  panelSaid,
  refuseRedirect,
  sendRequest,
  type PanelIdentity,
} from "../transport";
import { DEPLO_EXPORT_VERSION, type DeploExport } from "./export-shape";

export const DEPLO_PANEL: PanelIdentity = { name: "Deplo", portHint: ":3000" };

export const TOKEN_RECIPE =
  "Mint one in that Deplo under Settings, API tokens, limited to the team you are moving, with Reveal secret values, Control apps and Control databases.";

function headers(c: SourceCredential): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "deplo",
    Authorization: `Bearer ${c.apiKey}`,
  };
}

async function refusal(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let said = panelSaid(text);
  try {
    const body = JSON.parse(text) as {
      error?: unknown;
      errors?: { message?: unknown }[];
    };
    if (typeof body.error === "string") said = body.error;
    else if (typeof body.errors?.[0]?.message === "string")
      said = body.errors[0].message;
  } catch {}
  if (res.status === 401)
    return `That Deplo refused the token${said ? ` (${said})` : ""}. It may have expired or been revoked. ${TOKEN_RECIPE}`;
  return `That Deplo answered ${res.status}${said ? `: ${said}` : ""}`;
}

export async function graphql<T>(
  c: SourceCredential,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await sendRequest(
    c.baseUrl,
    `${c.baseUrl}/api/graphql`,
    {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ query, variables }),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    DEPLO_PANEL,
  );
  refuseRedirect(res, DEPLO_PANEL);
  if (!res.ok) throw new Error(await refusal(res));
  const body = (await res.json().catch(() => null)) as {
    data?: T;
    errors?: { message?: string }[];
  } | null;
  const said = body?.errors?.[0]?.message;
  if (said) throw new Error(`That Deplo said: ${said}`);
  if (!body?.data) throw new Error("That Deplo answered with nothing to read.");
  return body.data;
}

export async function viewerTeam(
  c: SourceCredential,
): Promise<{ id: string; name: string } | null> {
  const d = await graphql<{ viewerTeam: { id: string; name: string } | null }>(
    c,
    "query { viewerTeam { id name } }",
  );
  return d.viewerTeam;
}

const EXPORT_TTL_MS = 60_000;
const cached = new Map<string, { at: number; value: Promise<DeploExport> }>();

const keyOf = (c: SourceCredential) =>
  createHash("sha256").update(`${c.baseUrl}|${c.apiKey}`).digest("hex");

async function fetchExport(c: SourceCredential): Promise<DeploExport> {
  const d = await graphql<{ migrationExport: DeploExport | null }>(
    c,
    "query { migrationExport }",
  ).catch((e: Error) => {
    if (/Cannot query field "migrationExport"/.test(e.message))
      throw new Error(
        "That Deplo is too old to hand itself over. Update it, then connect again.",
      );
    throw e;
  });
  const x = d.migrationExport;
  if (!x || typeof x !== "object")
    throw new Error("That Deplo answered with nothing to read.");
  if (x.version !== DEPLO_EXPORT_VERSION)
    throw new Error(
      x.version > DEPLO_EXPORT_VERSION
        ? "That Deplo is newer than this one. Update this Deplo, then connect again."
        : "That Deplo is older than this one. Update it, then connect again.",
    );
  return x;
}

// Read many times per migration, so one answer serves a minute; a failed read is never kept.
export function exportOf(c: SourceCredential): Promise<DeploExport> {
  const key = keyOf(c);
  const hit = cached.get(key);
  if (hit && Date.now() - hit.at < EXPORT_TTL_MS) return hit.value;
  const value = fetchExport(c);
  cached.set(key, { at: Date.now(), value });
  value.catch(() => cached.delete(key));
  return value;
}

export function forgetExport(c: SourceCredential): void {
  cached.delete(keyOf(c));
}

export function __resetDeploExportsForTest(): void {
  cached.clear();
}

export type WorkloadKind = "app" | "database";

export async function workloadRunning(
  c: SourceCredential,
  kind: WorkloadKind,
  id: string,
): Promise<boolean | null> {
  const field =
    kind === "app"
      ? "appRuntime(appId: $id)"
      : "databaseRuntime(databaseId: $id)";
  const d = await graphql<{
    runtime: { running?: number | null; unreachable?: boolean | null } | null;
  }>(c, `query ($id: String!) { runtime: ${field} { running unreachable } }`, {
    id,
  });
  if (!d.runtime || d.runtime.unreachable) return null;
  return (d.runtime.running ?? 0) > 0;
}

export async function setRunning(
  c: SourceCredential,
  kind: WorkloadKind,
  id: string,
  running: boolean,
): Promise<void> {
  if (kind === "database")
    await graphql(
      c,
      "mutation ($id: String!, $running: Boolean!) { setDatabaseRunning(id: $id, running: $running) { id } }",
      { id, running },
    );
  else
    await graphql(
      c,
      running
        ? "mutation ($id: String!) { startApp(id: $id) { id } }"
        : "mutation ($id: String!) { stopApp(id: $id) { id } }",
      { id },
    );
}

export interface DataRequest {
  kind: WorkloadKind;
  id: string;
  volume?: string;
  hostPath?: string;
  allowFile?: boolean;
  check?: string[];
}

async function dataResponse(
  c: SourceCredential,
  body: DataRequest,
  signal: AbortSignal,
): Promise<Response> {
  return openStream(
    c.baseUrl,
    `${c.baseUrl}/api/migration/export`,
    {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    },
    DEPLO_PANEL,
  );
}

export async function checkData(
  c: SourceCredential,
  body: Omit<DataRequest, "volume" | "hostPath">,
): Promise<{ reachable: boolean; present: string[] | null }> {
  const res = await dataResponse(
    c,
    body,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (!res.ok) throw new Error(await refusal(res));
  return (await res.json()) as { reachable: boolean; present: string[] | null };
}

// Same contract as an agent's export stream: a 404 is the agent's NOT_FOUND, so the copy reads it as "nothing there".
export function streamData(
  c: SourceCredential,
  body: DataRequest,
): AsyncIterable<Buffer> {
  return (async function* () {
    const aborter = new AbortController();
    try {
      const res = await dataResponse(c, body, aborter.signal);
      if (res.status === 204) return;
      if (!res.ok) {
        const notFound = res.status === 404;
        const err = new Error(await refusal(res)) as Error & { code?: number };
        if (notFound) err.code = 5;
        throw err;
      }
      if (!res.body) return;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>)
        yield Buffer.from(chunk);
    } finally {
      aborter.abort();
    }
  })();
}
