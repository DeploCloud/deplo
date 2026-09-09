/**
 * Which product is answering at that address.
 *
 * Deplo migrates from two, and works this out rather than asking. The wizard only
 * asks when this comes back empty-handed.
 */

import {
  listProjects as coolifyProjects,
  panelFromHealth,
} from "./coolify/client";
import { listProjects as dokployProjects } from "./dokploy/client";
import { SELF_PANEL_REFUSAL } from "./self";
import type { MigrationPlatform, SourceCredential } from "./source";
import {
  PanelUnreachableError,
  REQUEST_TIMEOUT_MS,
  sendRequest,
  type PanelIdentity,
} from "./transport";

/**
 * Laravel Sanctum mints `<id>|<random>`, and Dokploy's keys have no pipe. Free,
 * and only ever used to decide which of the two to TRY first.
 */
const SANCTUM_TOKEN = /^\d+\|[A-Za-z0-9]{20,}$/;

/** The one call an import cannot proceed without, per platform. */
const PROBE: Record<
  MigrationPlatform,
  (c: SourceCredential) => Promise<unknown>
> = {
  dokploy: (c) => dokployProjects(c),
  coolify: (c) => coolifyProjects(c),
};

const DEPLO_PANEL: PanelIdentity = { name: "Deplo", portHint: ":3000" };

/**
 * Deplo's own API answering. Its `/api/health` says `{"ok":true}`, word for word
 * Dokploy's, so what tells them apart is the GraphQL endpoint neither panel has.
 */
async function answersAsDeplo(baseUrl: string): Promise<boolean> {
  try {
    const res = await sendRequest(
      baseUrl,
      `${baseUrl}/api/graphql`,
      {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "deplo" },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      DEPLO_PANEL,
    );
    const body = (await res.json().catch(() => null)) as {
      errors?: unknown;
    } | null;
    // A GET with no query: yoga answers 200 with an `errors` array and nothing else.
    return Array.isArray(body?.errors);
  } catch {
    return false;
  }
}

export class PanelNotIdentifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelNotIdentifiedError";
  }
}

/**
 * Ask each platform, cheapest guess first, and answer with the one that did.
 *
 * A TRANSPORT failure stops it dead: a machine that did not answer will not
 * answer the second guess either, and two timeouts are thirty seconds of spinner.
 * Only an application-level refusal moves on to the other candidate.
 */
export async function detectMigrationSource(
  baseUrl: string,
  apiKey: string,
): Promise<MigrationPlatform> {
  const order: MigrationPlatform[] = SANCTUM_TOKEN.test(apiKey.trim())
    ? ["coolify", "dokploy"]
    : ["dokploy", "coolify"];

  const refused: { name: string; said: string }[] = [];
  for (const kind of order) {
    try {
      await PROBE[kind]({ kind, baseUrl, apiKey });
      return kind;
    } catch (e) {
      if (e instanceof PanelUnreachableError) throw e;
      refused.push({
        name: kind === "coolify" ? "Coolify" : "Dokploy",
        said: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Both refused, so this is asked before the healthcheck rather than never:
  // Deplo answers that one exactly as a Dokploy does, and read as one it would
  // tell somebody their own panel is a Dokploy with a bad key.
  if (await answersAsDeplo(baseUrl))
    throw new PanelNotIdentifiedError(SELF_PANEL_REFUSAL);

  // The unauthenticated healthcheck only chooses the WORDS - a
  // reverse proxy can answer 200 there, so it never decides which product it is.
  const answered = await panelFromHealth(baseUrl);
  const name = answered === "coolify" ? "Coolify" : "Dokploy";
  const said = refused.find((r) => r.name === name);
  if (answered && said)
    throw new PanelNotIdentifiedError(
      `That is a ${name} panel, and it refused the token. ${said.said}`,
    );

  // The first line is the whole message; what each probe got is a LOG, and the
  // wizard puts it behind View logs rather than in the warning.
  const log = refused.map((r) => `${r.name} check: ${r.said}`).join("\n");
  throw new PanelNotIdentifiedError(
    `Deplo could not read ${baseUrl} as a Dokploy or a Coolify panel.\n${log}`,
  );
}
