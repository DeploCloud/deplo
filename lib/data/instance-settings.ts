import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { getDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { resolvePublicBaseUrl } from "../public-url";
import { acmeEmail, withAcmeEmail } from "../deploy/traefik-stack";
import { deploHostSelfAddresses, isDeploHostServer } from "../deploy/domains";
import { DEPLO_VERSION } from "../version";
import { serverLabel } from "../utils";
import { recordActivity } from "./activity";

/**
 * Instance-wide settings: the two facts about a Deplo that are neither a team's
 * nor a single host's: the address this panel answers on, and the account its
 * certificates are issued under.
 *
 * Both used to be install-time environment variables, changeable only by editing
 * a file on the box and recreating a container. That is precisely the shell trip
 * Deplo exists to remove, so both are settings now:
 *
 *  - The **panel address** is stored here and preferred over `DEPLO_PUBLIC_URL`
 *    by {@link instancePublicBaseUrl}, which is what every copy-and-run string
 *    Deplo hands out is built from (a server's install command, a deploy hook
 *    URL, an invite link). Moving to a real domain therefore takes one field
 *    instead of an SSH session, and the check below proves the new address
 *    actually reaches this instance before anyone trusts a link built from it.
 *  - The **certificate account** is NOT stored: it lives in each host's Traefik
 *    stack file, which is the only thing that decides where Let's Encrypt sends
 *    expiry warnings. It is read live and written live, per host, for the same
 *    read-live-not-stored reason status and URLs follow.
 *
 * Every entry point here is instance-admin gated. `loadSettings` is the one
 * ungated read, for the same reason `loadCleanupPolicyForScheduler` is: resolving
 * this instance's own URL happens on paths a plain member legitimately walks
 * (creating a deploy hook), takes no caller input, and returns nothing about
 * anyone else.
 */

/** The singleton row's PK. See the `instance_settings` table comment. */
const SETTINGS_ID = "default";

export type PanelAddressSource = "stored" | "environment" | "request";

export type InstanceSettings = {
  /** The address Deplo uses for itself right now. */
  panelUrl: string;
  /** Where that came from. The UI says so, because only one of the three is
   *  editable here and the other two explain themselves. */
  panelUrlSource: PanelAddressSource;
  /** The stored override, or null when nothing has been set here. */
  storedPanelUrl: string | null;
  /** This control plane's version. */
  version: string;
  /** The server running the panel, when it is one Deplo knows about. */
  deploHostId: string | null;
  deploHostName: string | null;
};

/** Whether an address actually reaches this instance, asked of the address itself. */
export type PanelReachability = {
  url: string;
  ok: boolean;
  /** What went wrong, verbatim: a DNS failure and a 502 need different fixes. */
  error: string | null;
};

/** One host's certificate account, as its own Traefik reports it. */
export type CertificateAccount = {
  serverId: string;
  serverName: string;
  /** The address certificates are issued under. Empty string = the resolver has
   *  none; null = there is nothing here Deplo can manage (see `unavailable`). */
  email: string | null;
  /** Why this host is not manageable, verbatim for the operator. Null when it is. */
  unavailable: string | null;
};

/* ------------------------------------------------------------------ */
/* The panel address                                                   */
/* ------------------------------------------------------------------ */

/** The stored row, ungated and per-request cached. See the module comment. */
const loadSettings = cache(async (): Promise<{ panelUrl: string | null }> => {
  const [row] = await getDb()
    .select({ panelUrl: instanceSettings.panelUrl })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  return { panelUrl: row?.panelUrl ?? null };
});

/**
 * This instance's public base URL, as everything Deplo hands out should spell it.
 *
 * The stored address wins over `DEPLO_PUBLIC_URL`: the operator set it in the UI,
 * on purpose, after this instance moved; the env var is what it was installed
 * with. Without a stored address this is exactly the old behaviour.
 */
export async function instancePublicBaseUrl(): Promise<string> {
  const { panelUrl } = await loadSettings();
  if (panelUrl) return panelUrl;
  try {
    return resolvePublicBaseUrl(await headers());
  } catch {
    // Outside a request scope (a scheduler tick, a background sweep) there are no
    // headers to read; the configured env var, or the placeholder, still answers.
    return resolvePublicBaseUrl(new Headers());
  }
}

export async function getInstanceSettings(): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const { panelUrl } = await loadSettings();
  const { listAllServers } = await import("./servers");
  const servers = await listAllServers();
  const selfAddresses = deploHostSelfAddresses();
  const host = servers.find((s) => isDeploHostServer(s, selfAddresses)) ?? null;

  return {
    panelUrl: panelUrl ?? (await instancePublicBaseUrl()),
    panelUrlSource: panelUrl
      ? "stored"
      : process.env.DEPLO_PUBLIC_URL?.trim()
        ? "environment"
        : "request",
    storedPanelUrl: panelUrl,
    version: DEPLO_VERSION,
    deploHostId: host?.id ?? null,
    deploHostName: host ? serverLabel(host) : null,
  };
}

/**
 * Store the address this instance answers on, or clear it (`null`) to fall back
 * to `DEPLO_PUBLIC_URL`.
 *
 * The value is normalised and validated HARD, because it is interpolated into
 * copy-and-run strings: a server's install command is a `curl | bash`, and a
 * host with shell metacharacters in it would be an injection into the operator's
 * own root shell. Same rule, same reason, as `lib/public-url.ts`.
 */
export async function setPanelUrl(input: string | null): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const url = input === null || input.trim() === "" ? null : normalizePanelUrl(input);
  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, panelUrl: url, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { panelUrl: url, updatedAt: now },
    });

  await recordActivity(
    "member",
    url
      ? `Set the Deplo panel address to ${url}`
      : "Cleared the Deplo panel address",
    user.name,
    null,
    teamId,
  );
  return getInstanceSettings();
}

/** The host shape `lib/public-url.ts` accepts: no metacharacters, ever. */
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * "deplo.example.com" → "https://deplo.example.com". A bare host gets HTTPS,
 * because that is what a panel on a domain should be and what the certificate
 * will be issued for; an explicit `http://` is kept (a bare IP with no proxy in
 * front of it is a real, if temporary, way to run this).
 */
export function normalizePanelUrl(input: string): string {
  const raw = input.trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`"${raw}" is not an address. Use a domain like deplo.example.com`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("The panel address must start with https:// or http://");
  if (parsed.username || parsed.password)
    throw new Error("The panel address cannot carry a username or password");
  if (parsed.pathname !== "/" && parsed.pathname !== "")
    throw new Error("The panel address is a host, without a path after it");
  if (!HOST_RE.test(parsed.host))
    throw new Error(`"${parsed.host}" is not a valid hostname`);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Ask an address whether it reaches this instance, by calling the panel's own
 * liveness endpoint from the server side.
 *
 * This is the honest half of the setting: Deplo can store what it should call
 * itself, but DNS and the proxy in front of it belong to the operator, so the
 * only useful thing to report is whether the address answers, and, when it does
 * not, what it answered with instead.
 */
export async function checkPanelUrl(input: string): Promise<PanelReachability> {
  await requireInstanceAdmin();
  const url = normalizePanelUrl(input);
  try {
    const res = await fetch(`${url}/api/health`, {
      // Redirects are FOLLOWED: an http address in front of a proxy that sends
      // everything to https is the normal case, and refusing to follow would
      // report a working panel as unreachable. The probe carries no credentials,
      // so following one costs nothing.
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok)
      return { url, ok: false, error: `${url} answered ${res.status}, it does not reach Deplo yet` };
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!body?.ok)
      return { url, ok: false, error: `Something answered on ${url}, but it is not this Deplo` };
    return { url, ok: true, error: null };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { url, ok: false, error: `${url} did not answer (${reason})` };
  }
}

/* ------------------------------------------------------------------ */
/* The certificate account                                             */
/* ------------------------------------------------------------------ */

/**
 * What every server's Traefik has as its Let's Encrypt account, read live.
 *
 * Per host on purpose: the email is a flag in each host's own stack file, so a
 * fleet installed over two years can genuinely disagree with itself, and hiding
 * that behind one field would make the disagreement invisible.
 */
export async function listCertificateAccounts(): Promise<CertificateAccount[]> {
  await requireInstanceAdmin();
  return readAccounts();
}

async function readAccounts(): Promise<CertificateAccount[]> {
  const { listAllServers } = await import("./servers");
  const { fetchHostInfo } = await import("../infra/agent-client");
  const servers = await listAllServers();

  return Promise.all(
    servers.map(async (server): Promise<CertificateAccount> => {
      const base = { serverId: server.id, serverName: serverLabel(server) };
      if (server.status === "provisioning")
        return { ...base, email: null, unavailable: "This server has not finished setting up yet" };
      try {
        const info = await fetchHostInfo(server.id);
        if (!info.traefikComposeYaml)
          return {
            ...base,
            email: null,
            unavailable: "Deplo did not install the proxy on this server, so it does not manage its certificates",
          };
        const email = acmeEmail(info.traefikComposeYaml);
        return email === null
          ? { ...base, email: null, unavailable: "This server's proxy issues no certificates" }
          : { ...base, email, unavailable: null };
      } catch (e) {
        // An unreachable host is an answer about that host, not a failure of the
        // page: the other servers still report, and this one says why it did not.
        return { ...base, email: null, unavailable: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

/**
 * Point every manageable host's certificates at a new account email.
 *
 * Fleet-wide because the address is: Let's Encrypt sends expiry and revocation
 * notices there, and an operator who changes it means "for this instance", not
 * "for the one host I happen to be looking at". Hosts Deplo cannot manage are
 * skipped and REPORTED as skipped, never silently counted as done.
 *
 * Each host's Traefik is recreated to pick the flag up, so routing there is
 * interrupted for a few seconds. Sequentially, one host at a time, so a fleet
 * never goes dark all at once. Certificates already issued keep working; only
 * where the renewal notices go changes.
 */
export async function setCertificateEmail(email: string): Promise<CertificateAccount[]> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const address = email.trim().toLowerCase();
  if (!address.includes("@") || /\s/.test(address))
    throw new Error("Enter a valid email address");

  const { fetchHostInfo, applyTraefikConfig } = await import("../infra/agent-client");
  const accounts = await readAccounts();
  let applied = 0;

  for (const account of accounts) {
    if (account.unavailable) continue;
    if (account.email === address) continue;
    try {
      const info = await fetchHostInfo(account.serverId);
      const yamlText = withAcmeEmail(info.traefikComposeYaml, address);
      const res = await applyTraefikConfig(account.serverId, { composeYaml: yamlText });
      if (!res.ok) {
        account.unavailable = res.error || `Could not apply the change on ${account.serverName}`;
        continue;
      }
      account.email = address;
      applied++;
    } catch (e) {
      account.unavailable = e instanceof Error ? e.message : String(e);
    }
  }

  if (applied > 0) {
    await recordActivity(
      "member",
      `Set the certificate account email to ${address} on ${applied} server${applied === 1 ? "" : "s"}`,
      user.name,
      null,
      teamId,
    );
  }
  return accounts;
}
