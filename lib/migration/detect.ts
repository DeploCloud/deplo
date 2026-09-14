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

// Laravel Sanctum mints `<id>|<random>` and Dokploy's keys have no pipe; only ever decides which of the two to TRY first.
const SANCTUM_TOKEN = /^\d+\|[A-Za-z0-9]{20,}$/;

// The one call an import cannot proceed without, per platform.
const PROBE: Record<
  MigrationPlatform,
  (c: SourceCredential) => Promise<unknown>
> = {
  dokploy: (c) => dokployProjects(c),
  coolify: (c) => coolifyProjects(c),
};

const DEPLO_PANEL: PanelIdentity = { name: "Deplo", portHint: ":3000" };

// Deplo's `/api/health` says `{"ok":true}` word for word as Dokploy's, so the GraphQL endpoint neither panel has is what tells them apart.
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

// A TRANSPORT failure stops it dead (two timeouts are thirty seconds of spinner); only a refusal moves on to the other candidate.
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

  // Asked BEFORE the healthcheck: Deplo answers that one exactly as a Dokploy does, so read there it names somebody's own panel a Dokploy.
  if (await answersAsDeplo(baseUrl))
    throw new PanelNotIdentifiedError(SELF_PANEL_REFUSAL);

  // The unauthenticated healthcheck only chooses the WORDS: a reverse proxy can answer 200 there.
  const answered = await panelFromHealth(baseUrl);
  const name = answered === "coolify" ? "Coolify" : "Dokploy";
  const said = refused.find((r) => r.name === name);
  if (answered && said)
    throw new PanelNotIdentifiedError(
      `That is a ${name} panel, and it refused the token. ${said.said}`,
    );

  // The first line is the whole message; the wizard puts the rest behind View logs.
  const log = refused.map((r) => `${r.name} check: ${r.said}`).join("\n");
  throw new PanelNotIdentifiedError(
    `Deplo could not read ${baseUrl} as a Dokploy or a Coolify panel.\n${log}`,
  );
}
