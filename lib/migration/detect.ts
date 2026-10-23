import {
  listProjects as coolifyProjects,
  panelFromHealth,
} from "./coolify/client";
import { TOKEN_RECIPE, viewerTeam } from "./deplo/client";
import { listProjects as dokployProjects } from "./dokploy/client";
import type { MigrationPlatform, SourceCredential } from "./source";
import {
  PanelUnreachableError,
  REQUEST_TIMEOUT_MS,
  sendRequest,
  type PanelIdentity,
} from "./transport";

const SANCTUM_TOKEN = /^\d+\|[A-Za-z0-9]{20,}$/;
const DEPLO_TOKEN = /^deplo_\S+$/;

const PANEL_NAME: Record<MigrationPlatform, string> = {
  dokploy: "Dokploy",
  coolify: "Coolify",
  deplo: "Deplo",
};

async function deploTeam(c: SourceCredential): Promise<unknown> {
  const team = await viewerTeam(c).catch((e: Error) => {
    if (/not authori[sz]ed|unauthori[sz]ed/i.test(e.message)) return null;
    throw e;
  });
  if (!team)
    throw new Error(
      `That Deplo refused the token: it may have expired, been revoked, or come from another Deplo. ${TOKEN_RECIPE}`,
    );
  return team;
}

const PROBE: Record<
  MigrationPlatform,
  (c: SourceCredential) => Promise<unknown>
> = {
  dokploy: (c) => dokployProjects(c),
  coolify: (c) => coolifyProjects(c),
  deplo: (c) => deploTeam(c),
};

const DEPLO_PANEL: PanelIdentity = { name: "Deplo", portHint: ":3000" };

// Deplo's /api/health answers {"ok":true} word for word as Dokploy's, so only the GraphQL endpoint tells them apart.
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

export async function detectMigrationSource(
  baseUrl: string,
  apiKey: string,
): Promise<MigrationPlatform> {
  const key = apiKey.trim();
  // A Deplo token says what it is, and nothing else would accept one - or should be sent a foreign key.
  const order: MigrationPlatform[] = DEPLO_TOKEN.test(key)
    ? ["deplo"]
    : SANCTUM_TOKEN.test(key)
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
        name: PANEL_NAME[kind],
        said: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (await answersAsDeplo(baseUrl)) {
    const said = refused.find((r) => r.name === "Deplo");
    throw new PanelNotIdentifiedError(
      said?.said ??
        `That is a Deplo. Paste one of its API tokens - they start with deplo_. ${TOKEN_RECIPE}`,
    );
  }

  const answered = await panelFromHealth(baseUrl);
  const name = answered === "coolify" ? "Coolify" : "Dokploy";
  const said = refused.find((r) => r.name === name);
  if (answered && order.includes("deplo"))
    throw new PanelNotIdentifiedError(
      `That is a ${name} panel, and the token is a Deplo one. Paste ${name}'s own API key.`,
    );
  if (answered && said)
    throw new PanelNotIdentifiedError(
      `That is a ${name} panel, and it refused the token. ${said.said}`,
    );

  const log = refused.map((r) => `${r.name} check: ${r.said}`).join("\n");
  throw new PanelNotIdentifiedError(
    `Deplo could not read ${baseUrl} as ${order.includes("deplo") ? "a Deplo" : "a Dokploy or a Coolify panel"}.\n${log}`,
  );
}
