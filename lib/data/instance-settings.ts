import "server-only";

import { cache } from "react";
import { and, count, countDistinct, eq, gt, gte, isNotNull, isNull } from "drizzle-orm";
import { headers } from "next/headers";

import { getDb } from "../db/client";
import {
  apiTokens,
  apps,
  gitConnections,
  githubApps,
  instanceSettings,
  pushSubscriptions,
  registrationLinks,
  servers as serversTable,
  users,
} from "../db/schema/control-plane";
import { passkey, session } from "../db/schema/auth";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import {
  passkeyRelyingParty,
  resolvePublicBaseUrl,
  setStoredPublicBaseUrl,
} from "../public-url";
import {
  acmeEmail,
  DEFAULT_PANEL_TARGET,
  panelRoute,
  stackCertResolver,
  withAcmeEmail,
  withPanelRoute,
  type PanelRoute,
} from "../deploy/traefik-stack";
import {
  deploHostSelfAddresses,
  instanceHost,
  isDeploHostServer,
  isIpv4,
} from "../deploy/domains";
import { DEPLO_VERSION } from "../version";
import { serverLabel } from "../utils";
import { recordActivity } from "./activity";
import { instanceOwnerUserId } from "./instance-owner";

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
 *    instead of an SSH session. It also MOVES the panel's own route
 *    ({@link movePanelRoute}) on a Deplo that publishes itself through its
 *    proxy - proving the new address answers and putting the old one back when
 *    it does not - so the address and the routing cannot drift apart.
 *  - Moving it is DESTRUCTIVE, and invisibly so: a browser welds passkeys,
 *    cookies and notification subscriptions to one origin.
 *    {@link getPanelAddressImpact} counts what a given move would cost so the
 *    dialog in front of it can name the casualties instead of warning in the
 *    abstract, and the Activity entry records how many it took.
 *  - Every instance also answers on {@link InstanceSettings.panelIpUrl},
 *    its own machine's address, which is not a setting and cannot be turned
 *    off: the panel's DNS, certificate and proxy are the three things it cannot
 *    repair from inside itself, and that address needs none of them.
 *  - **Whether the panel is served over https at all** is a setting for the same
 *    reason, and read live off that route rather than stored. A Deplo installed
 *    on a domain that cannot get a certificate - not resolving publicly yet,
 *    :80 closed, an internal network - greets its first visitor with a browser
 *    warning on a page nobody has logged into, and the only fix used to be
 *    editing the compose file the installer wrote. {@link setPanelHttps} moves
 *    the route, the stored address and the session cookie together, because all
 *    three have to agree for the panel to still work afterwards, and ADOPTS the
 *    route on an instance that predates Deplo owning one ({@link adoptPanelRoute})
 *    rather than sending the operator back to the installer.
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
  /**
   * The address this panel also answers on, straight on the machine it runs on:
   * `http://<server ip>:3000`. Null only when Deplo cannot work out an address
   * of its own that anyone else could reach.
   *
   * Not a setting and not stored: it is a FACT about where the panel is, and it
   * is the way back in when the domain stops working - the panel's own DNS,
   * certificate or proxy are the three things it cannot fix from inside itself.
   * The installer publishes the port in every mode for exactly this reason.
   */
  panelIpUrl: string | null;
  /** The IPv4 an A record for the panel's domain should point at. */
  deploHostIp: string | null;
  /** This control plane's version. */
  version: string;
  /** The server running the panel, when it is one Deplo knows about. */
  deploHostId: string | null;
  deploHostName: string | null;
  /** Who owns this instance, or null on one that is unowned. */
  ownerName: string | null;
};

/**
 * Whether the panel is served over https, as the host's proxy is actually
 * configured.
 *
 * Read live, never stored, for the same reason the ACME email is: the router
 * that publishes this panel is a file on that host, and a stored copy would
 * disagree with it the first time anyone edited either one.
 */
export type PanelHttps = {
  /** The host the panel's route answers on. Null when there is no route of ours. */
  domain: string | null;
  /** Whether the panel is served over https at all. */
  enabled: boolean;
  /** The resolver its certificate is ordered from, named as this host names it.
   *  Null when https is off, or when the host orders from nobody. */
  provider: string | null;
  /** Why this is not Deplo's to change, verbatim for the operator. Null when it is. */
  unavailable: string | null;
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
  /** How many certificates the operator installed on this host themselves. */
  customCertificates: number;
  /**
   * Whole days until the FIRST of those expires, negative once one has, null when
   * there are none.
   *
   * Read here because nothing renews a certificate someone pasted in by hand, and
   * the tab that shows one expiring is a tab nobody opens on a normal day. This
   * page is where an operator comes to think about certificates, so the warning
   * belongs on it - and it costs nothing, since every host's stack file is
   * already in hand for the account email.
   */
  expiresInDays: number | null;
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

/**
 * The server this panel runs on, when it is one Deplo knows about.
 *
 * Null is ordinary: the panel's own box is a server like any other and an
 * operator may simply not have added it yet. Everything that reaches for this
 * host's proxy has to answer for that case rather than assume a fleet of one.
 */
async function deploHostServer() {
  const { listAllServers } = await import("./servers");
  const servers = await listAllServers();
  const selfAddresses = deploHostSelfAddresses();
  return servers.find((s) => isDeploHostServer(s, selfAddresses)) ?? null;
}

/**
 * The instance owner's display name, or null when nobody holds it.
 *
 * Read here rather than exposed as a capability check because this is the
 * READ-ONLY answer to "whose Deplo is this" - the transfer itself stays on
 * Settings, Users, where the password confirmation and the candidate list live.
 * An unowned instance is an ordinary state (see `instanceOwnerUserId`), so this
 * returns null instead of pretending one exists.
 */
async function instanceOwnerName(): Promise<string | null> {
  const ownerId = await instanceOwnerUserId();
  if (!ownerId) return null;
  const rows = await getDb()
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/**
 * The IPv4 an outsider can reach this panel's machine on, or null.
 *
 * The server row wins over detection: it is the address an operator DECLARED
 * for this host, which is what their DNS should point at, while a NIC scan can
 * only see what the box knows about itself. Loopback is treated as "no answer" -
 * an address nobody else can dial is worse than none, because it reads as
 * a promise.
 */
function reachableHostIp(host: { ip?: string } | null): string | null {
  const candidate = host?.ip?.trim() || instanceHost();
  if (!isIpv4(candidate)) return null;
  return candidate.startsWith("127.") ? null : candidate;
}

/** Where the panel listens on its own machine. The installer publishes this port. */
function panelPort(): string {
  return process.env.PORT?.trim() || "3000";
}

export async function getInstanceSettings(): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const { panelUrl } = await loadSettings();
  const [host, ownerName] = await Promise.all([
    deploHostServer(),
    instanceOwnerName(),
  ]);
  const hostIp = reachableHostIp(host);

  return {
    panelUrl: panelUrl ?? (await instancePublicBaseUrl()),
    panelIpUrl: hostIp ? `http://${hostIp}:${panelPort()}` : null,
    deploHostIp: hostIp,
    panelUrlSource: panelUrl
      ? "stored"
      : process.env.DEPLO_PUBLIC_URL?.trim()
        ? "environment"
        : "request",
    storedPanelUrl: panelUrl,
    version: DEPLO_VERSION,
    deploHostId: host?.id ?? null,
    deploHostName: host ? serverLabel(host) : null,
    ownerName,
  };
}

/**
 * Store the address this instance answers on, or clear it (`null`) to fall back
 * to `DEPLO_PUBLIC_URL`, and move the panel's own route onto it.
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
  // Read BEFORE the write, and not only for the log line: `rpId` is derived from
  // the address, so once it has moved there is no way to say how many
  // credentials it just invalidated. A trail that records the change without its
  // casualties is what makes "my passkey stopped working" unanswerable later.
  const current = await instancePublicBaseUrl();
  const lostPasskeys =
    url !== null &&
    (hostOf(url) !== hostOf(current) || schemeOf(url) !== schemeOf(current))
      ? await passkeysBoundToThisAddress()
      : 0;
  // The routing moves FIRST, and this throws if it could not: storing an address
  // nothing routes to would break every install command copied from this page.
  // Clearing the address deliberately moves nothing - the route is real, and
  // tearing it down to fall back to an env var would unpublish the panel.
  if (url) await movePanelRoute(url);
  await rememberPanelUrl(url);

  await recordActivity(
    "member",
    (url
      ? `Set the Deplo panel address to ${url}`
      : "Cleared the Deplo panel address") + passkeyLossSuffix(lostPasskeys),
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

/* ------------------------------------------------------------------ */
/* What changing the address would break                               */
/* ------------------------------------------------------------------ */

/**
 * What moving the panel to `url` would break, counted live and instance-wide.
 *
 * The panel's address is not a label: a browser welds credentials, cookies and
 * subscriptions to the exact origin they were created on, and everything Deplo
 * has ever handed out is a string built from it. Changing it is therefore
 * destructive in ways nothing on the screen shows, and the worst of them -
 * every passkey on the instance - is silent and permanent.
 *
 * So the dialog states FACTS, in the shape {@link getDeleteUserImpact} set for
 * deleting an account: real counts, only the lines that are true right now, and
 * the repairable ones told apart from the ones that are gone. Read-only, and
 * instance-wide rather than active-team - the setting is instance-admin gated
 * and a team-shaped count would under-report, which is the one thing a warning
 * must never do.
 */
export type PanelAddressImpact = {
  /** The address as it would be stored, normalised the same way the save does. */
  url: string;
  /** What it is right now. */
  currentUrl: string;
  /** Whether the hostname moves. Everything origin-bound dies on this. */
  hostChanges: boolean;
  /** Whether http/https changes. An origin change too, and https->https is not one. */
  schemeChanges: boolean;
  /** https -> http specifically: the browser remembers the old HSTS either way. */
  losesHttps: boolean;
  /** The address that keeps working through all of it, when there is one. */
  panelIpUrl: string | null;
  /** Passkeys welded to the address as it is now, and how many accounts hold them. */
  passkeys: number;
  passkeyPeople: number;
  /** Live sessions, and the people behind them, who will have to sign in again. */
  sessions: number;
  sessionPeople: number;
  /** Deploy hooks whose URL is already pasted into somebody else's CI. */
  deployHooks: number;
  /** AI clients connected over MCP, which have to be reconnected. */
  mcpConnections: number;
  /** Registration links already handed out. Repairable: the same link re-renders. */
  registrationLinks: number;
  /** Servers whose install command was issued but never run. Repairable. */
  pendingServers: number;
  /** Browser notification subscriptions, which are per-origin. */
  pushSubscriptions: number;
  /** Git connections and GitHub Apps, pinned to the INSTALLER's address, not this one. */
  gitConnections: number;
  githubApps: number;
};

export async function getPanelAddressImpact(
  input: string,
): Promise<PanelAddressImpact> {
  await requireInstanceAdmin();
  const url = normalizePanelUrl(input);
  const currentUrl = await instancePublicBaseUrl();
  const base: PanelAddressImpact = {
    url,
    currentUrl,
    hostChanges: hostOf(url) !== hostOf(currentUrl),
    schemeChanges: schemeOf(url) !== schemeOf(currentUrl),
    losesHttps: schemeOf(currentUrl) === "https:" && schemeOf(url) === "http:",
    panelIpUrl: null,
    passkeys: 0,
    passkeyPeople: 0,
    sessions: 0,
    sessionPeople: 0,
    deployHooks: 0,
    mcpConnections: 0,
    registrationLinks: 0,
    pendingServers: 0,
    pushSubscriptions: 0,
    gitConnections: 0,
    githubApps: 0,
  };
  const host = await deploHostServer();
  const hostIp = reachableHostIp(host);
  base.panelIpUrl = hostIp ? `http://${hostIp}:${panelPort()}` : null;
  // Same address, nothing to warn about. Counting anyway would put a wall of
  // red in front of a save that changes nothing.
  if (!base.hostChanges && !base.schemeChanges) return base;

  const db = getDb();
  // Null when this instance cannot have passkeys at all (no address, or plain
  // http): then there are none to lose, rather than "none matched".
  const rp = passkeyRelyingParty();
  const now = nowIso();
  const [
    passkeys,
    sessions,
    deployHooks,
    mcp,
    links,
    pending,
    push,
    gitConns,
    ghApps,
  ] = await Promise.all([
    rp
      ? db
          .select({ n: count(), people: countDistinct(passkey.userId) })
          .from(passkey)
          .where(eq(passkey.rpId, rp.rpId))
      : Promise.resolve([{ n: 0, people: 0 }]),
    db
      .select({ n: count(), people: countDistinct(session.userId) })
      .from(session)
      .where(gt(session.expiresAt, new Date())),
    db
      .select({ n: count() })
      .from(apps)
      .where(
        and(
          isNotNull(apps.deployHookTokenEnc),
          eq(apps.deployHookEnabled, true),
        ),
      ),
    db
      .select({ n: count() })
      .from(apiTokens)
      .where(isNotNull(apiTokens.oauthClientId)),
    db
      .select({ n: count() })
      .from(registrationLinks)
      .where(
        and(
          eq(registrationLinks.status, "pending"),
          gte(registrationLinks.expiresAt, now),
        ),
      ),
    db
      .select({ n: count() })
      .from(serversTable)
      .where(
        and(
          isNotNull(serversTable.bootstrapTokenHash),
          isNull(serversTable.bootstrapUsedAt),
        ),
      ),
    db.select({ n: count() }).from(pushSubscriptions),
    db.select({ n: count() }).from(gitConnections),
    db.select({ n: count() }).from(githubApps),
  ]);

  return {
    ...base,
    passkeys: Number(passkeys[0]?.n ?? 0),
    passkeyPeople: Number(passkeys[0]?.people ?? 0),
    sessions: Number(sessions[0]?.n ?? 0),
    sessionPeople: Number(sessions[0]?.people ?? 0),
    deployHooks: Number(deployHooks[0]?.n ?? 0),
    mcpConnections: Number(mcp[0]?.n ?? 0),
    registrationLinks: Number(links[0]?.n ?? 0),
    pendingServers: Number(pending[0]?.n ?? 0),
    pushSubscriptions: Number(push[0]?.n ?? 0),
    gitConnections: Number(gitConns[0]?.n ?? 0),
    githubApps: Number(ghApps[0]?.n ?? 0),
  };
}

/** The two halves of an address that decide whether an origin moved. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

/** What an address change cost, said in the trail rather than only in a dialog. */
function passkeyLossSuffix(lost: number): string {
  if (lost <= 0) return "";
  return ` (${lost} passkey${lost === 1 ? "" : "s"} stopped working)`;
}

/** How many passkeys this address currently holds, for the Activity entry. */
async function passkeysBoundToThisAddress(): Promise<number> {
  const rp = passkeyRelyingParty();
  if (!rp) return 0;
  const [row] = await getDb()
    .select({ n: count() })
    .from(passkey)
    .where(eq(passkey.rpId, rp.rpId));
  return Number(row?.n ?? 0);
}

/**
 * Ask an address whether this instance answers on it.
 *
 * THE ONE OUTBOUND DIALER NOT ON `lib/outbound-url.ts`, and deliberately so: the
 * panel's own address is legitimately private on plenty of installs (an internal
 * network, a box with no public name yet, `http://<ip>:3000` before a domain
 * exists), so the SSRF guard would refuse exactly the operator this feature is
 * for. That makes it the same call `allowPrivateEndpoint` already grants on a
 * backup destination and a git connection - and, like that flag, it is
 * INSTANCE-ADMIN ONLY.
 *
 * The gate is asserted here rather than inherited from the callers. Both of them
 * are inside `requireInstanceAdmin()` mutations today; asserting it at the
 * dialer is what keeps that true when the third caller arrives, because this
 * function is the one that reaches an address of someone's choosing and reports
 * back whether something answered.
 *
 * Its callers are the route move and the adoption check.
 *
 * There is deliberately NO "check this address" button in front of it any more.
 * A button that answers "not yet" while DNS propagates taught nobody anything
 * the save itself does not: {@link movePanelRoute} moves the route, proves the
 * new address answers, and puts the old one back when it does not, which is the
 * only outcome that matters. The card spends the space on the A record instead -
 * the question an operator actually has at that moment.
 */
async function probePanel(url: string): Promise<PanelReachability> {
  await requireInstanceAdmin();
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
/* The panel's own route                                               */
/* ------------------------------------------------------------------ */

/**
 * Read the panel's route off the host that serves it.
 *
 * Every "no" is a different sentence on purpose: not added as a server, a proxy
 * Deplo did not install, and a panel published by its own container are three
 * different situations with three different fixes, and folding them into one
 * "unavailable" would leave the operator guessing which one they are in.
 */
async function readPanelHttps(): Promise<PanelHttps> {
  const none = { domain: null, enabled: false, provider: null };
  const host = await deploHostServer();
  if (!host)
    return {
      ...none,
      unavailable:
        "The server running Deplo is not added here yet, so Deplo does not manage the panel's own address.",
    };
  try {
    const { fetchHostInfo } = await import("../infra/agent-client");
    const info = await fetchHostInfo(host.id);
    if (!info.traefikComposeYaml)
      return {
        ...none,
        unavailable:
          "Deplo did not install the proxy on this server, so it does not manage how the panel is served.",
      };
    const route = panelRoute(info.traefikComposeYaml);
    if (!route) {
      // No route of OURS. On a Deplo whose address is a routable domain that is
      // a panel published the old way, by labels on its own container: Deplo can
      // still take it over ({@link adoptPanelRoute}), so this is offered rather
      // than refused, and what it reports is what the address itself says.
      const url = await instancePublicBaseUrl();
      const reason = noRouteReason(url);
      if (reason !== null) return { ...none, unavailable: reason };
      return {
        domain: new URL(url).hostname,
        enabled: url.startsWith("https://"),
        provider: null,
        unavailable: null,
      };
    }
    return {
      domain: route.domain,
      enabled: route.https,
      provider: route.https ? route.certResolver : null,
      unavailable: null,
    };
  } catch (e) {
    // An unreachable host is an answer about that host, not a failure of the
    // page - same rule the certificate accounts follow.
    return { ...none, unavailable: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Why there is no route of ours, in words that name the actual fix.
 *
 * Two very different situations look identical from the Traefik file: a Deplo
 * still on `http://<ip>:3000`, which the installer publishes by mapping the port
 * and never routes at all, and a Deplo on a domain from before the route was
 * Deplo's to write. The first needs a domain, the second needs the installer
 * re-run - and telling one to do the other is worse than saying nothing.
 *
 * The panel's own address is what tells them apart: a bare IP or a host:port is
 * the port-mapped install; anything else is a domain that is routed by
 * something Deplo does not own.
 */
export function noRouteReason(url: string): string | null {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  const routable = host.includes(".") && !isIpv4(host);
  return routable
    ? null
    : "This panel is served straight on port 3000, without a proxy in front of it. Give it a domain address above first.";
}

export async function getPanelHttps(): Promise<PanelHttps> {
  await requireInstanceAdmin();
  return readPanelHttps();
}

/**
 * Serve the panel over https, or over plain http.
 *
 * Turning it OFF is the one that has to work: a Deplo installed on a domain is
 * published on :443 with a certificate it may not be able to get - the name does
 * not resolve publicly yet, :80 is closed, the box is on an internal network -
 * and the operator meets a browser warning on a panel they have never logged
 * into. There is no shell answer to that in a product whose whole premise is not
 * needing one, so http is a setting.
 *
 * Three things move together, and all three are needed for the panel to still
 * work afterwards:
 *
 *  1. The ROUTE moves to the `web` entrypoint, and the entrypoint's own
 *     http-to-https redirect is pinned below it - without that the panel would
 *     answer 301 to an https it has no certificate for.
 *  2. The stored ADDRESS takes the new scheme, because every string Deplo hands
 *     out is built from it: an install command pointing at https on a panel that
 *     no longer speaks it is an agent that can never call home.
 *  3. The SESSION COOKIE stops being `__Secure-` ({@link resetAuth}). A browser
 *     will not send one of those over http, so skipping this would leave a panel
 *     that loads and can never be logged into - the exact failure this setting
 *     exists to end.
 *
 * The host's proxy is recreated to pick the change up, so every site on that
 * host - this panel included - is unreachable for the few seconds it takes to
 * come back. Same cost as installing a certificate there, and callers say so
 * before asking.
 */
export async function setPanelHttps(enabled: boolean): Promise<PanelHttps> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const host = await deploHostServer();
  if (!host)
    throw new Error(
      "The server running Deplo is not added here yet, so Deplo does not manage the panel's own address.",
    );

  // Same reason as in setPanelUrl: after the scheme moves, the credentials it
  // invalidated cannot be counted any more. Turning https OFF kills every
  // passkey outright - WebAuthn has no relying party on plain http.
  const lostPasskeys = enabled ? 0 : await passkeysBoundToThisAddress();

  const { fetchHostInfo, applyTraefikConfig, withTraefikStackLock } = await import(
    "../infra/agent-client"
  );
  // Held across the read and the write: this rewrites the host's WHOLE stack
  // file, and so does installing a certificate on it. See withTraefikStackLock.
  const moved = await withTraefikStackLock(host.id, async () => {
    const info = await fetchHostInfo(host.id);
    const current =
      panelRoute(info.traefikComposeYaml) ?? (await adoptPanelRoute(info.traefikComposeYaml));
    if (current.https === enabled) return null;

    const next: PanelRoute = {
      ...current,
      https: enabled,
      // Read off the host rather than assumed, and null is fine: a proxy that
      // orders from nobody still terminates TLS with a certificate the operator
      // installed. Naming a resolver it does not define is what would break it.
      certResolver: enabled ? stackCertResolver(info.traefikComposeYaml) : null,
    };
    const res = await applyTraefikConfig(host.id, {
      composeYaml: withPanelRoute(info.traefikComposeYaml, next),
    });
    if (!res.ok) throw new Error(res.error || "The proxy on this server refused the change");
    return next;
  });

  if (moved) {
    await rememberPanelUrl(`${enabled ? "https" : "http"}://${moved.domain}`);
    await recordActivity(
      "member",
      (enabled
        ? `Moved the panel to https://${moved.domain}`
        : `Moved the panel to http://${moved.domain}`) +
        passkeyLossSuffix(lostPasskeys),
      user.name,
      null,
      teamId,
    );
  }
  return readPanelHttps();
}

/**
 * Build a panel route for a Deplo that does not have one yet.
 *
 * A Deplo installed before the route was Deplo's to write publishes itself with
 * Traefik LABELS on its own container, in a compose file no agent RPC can touch.
 * Rather than send the operator back to the installer, Deplo writes its own
 * route beside those labels and outranks them: {@link PANEL_PRIORITY} clears the
 * 1 the installer pinned the label router to, so from the first change onwards
 * the route Deplo controls is the one Traefik answers with.
 *
 * The one thing that cannot be read off the host is WHERE the panel listens, and
 * a wrong guess there is a panel that 502s. So the guess is PROVEN first, from
 * inside: the control plane asks {@link DEFAULT_PANEL_TARGET} for its own health
 * endpoint over the shared Docker network, and adopts only if this very instance
 * answers. A Deplo running from source on the host, reached through the docker
 * gateway instead, fails that check and is told to re-run the installer - which
 * is the honest answer, because nothing here can discover where it lives.
 */
async function adoptPanelRoute(currentYaml: string): Promise<PanelRoute> {
  const url = await instancePublicBaseUrl();
  const reason = noRouteReason(url);
  if (reason) throw new Error(reason);

  const reached = await probePanel(DEFAULT_PANEL_TARGET);
  if (!reached.ok)
    throw new Error(
      "This panel is published by its own container, from before Deplo could manage it, and Deplo cannot tell where it listens. Re-run the installer to hand it over.",
    );

  return {
    domain: new URL(url).hostname,
    // What it is being served as RIGHT NOW, so the caller's own
    // `current.https === enabled` check still means what it says.
    https: url.startsWith("https://"),
    certResolver: url.startsWith("https://") ? stackCertResolver(currentYaml) : null,
    target: DEFAULT_PANEL_TARGET,
  };
}

/**
 * Store the address AND publish it to the two consumers that cannot await a
 * database read: the URL builder and Better Auth.
 *
 * Better Auth bakes `baseURL` and `useSecureCookies` into the instance it is
 * built from, so the reset is not housekeeping - it is what makes a scheme
 * change take effect in this process instead of at the next restart.
 */
async function rememberPanelUrl(url: string | null): Promise<void> {
  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, panelUrl: url, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { panelUrl: url, updatedAt: now },
    });
  setStoredPublicBaseUrl(url);
  const { resetAuth } = await import("../auth/better-auth");
  resetAuth();
  // The OAuth audience is `<base>/api/mcp`, so moving the panel mints a NEW
  // resource identifier and leaves the old row behind (seeding is insertOnly).
  // Disable the strays now rather than at the next boot: until then both would
  // be requestable, which is exactly the two-audience shape deplo has always
  // refused to have.
  const { reconcileOAuthResources } = await import("../auth/oauth-resources");
  await reconcileOAuthResources();
}

/**
 * Load the stored address into the in-memory copy the synchronous consumers
 * read. Called once at boot, before this instance serves a request.
 */
export async function hydratePublicBaseUrl(): Promise<void> {
  const [row] = await getDb()
    .select({ panelUrl: instanceSettings.panelUrl })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  setStoredPublicBaseUrl(row?.panelUrl ?? null);
}

/**
 * Move the panel's route onto a new address, and put it back if the new one does
 * not answer.
 *
 * The rollback is the point. Moving a router is the one setting on this page
 * that can lock the operator out of the page itself: get the DNS wrong and both
 * the old address and the new one stop working, leaving a shell as the only way
 * back - the exact trip Deplo exists to remove. So the new address has to prove
 * it answers, from the outside, before the old one is given up.
 *
 * Does nothing when Deplo does not own the route, and nothing when the host is
 * unreachable: the address field is also the tool an operator reaches for when
 * their box has moved, and refusing to store it while the fleet is down would
 * take away the recovery path.
 */
async function movePanelRoute(url: string): Promise<void> {
  const host = await deploHostServer();
  if (!host) return;

  const { fetchHostInfo, applyTraefikConfig, withTraefikStackLock } = await import(
    "../infra/agent-client"
  );
  const parsed = new URL(url);
  const domain = parsed.hostname;
  // The scheme in the address is not decoration: typing an http:// address is
  // the same request as turning HTTPS off, and leaving the route on :443 would
  // store an address the panel does not answer on.
  const https = parsed.protocol === "https:";

  await withTraefikStackLock(host.id, async () => {
    let currentYaml: string;
    try {
      currentYaml = (await fetchHostInfo(host.id)).traefikComposeYaml;
    } catch {
      return;
    }
    const current = currentYaml ? panelRoute(currentYaml) : null;
    if (!current || (current.domain === domain && current.https === https)) return;

    await moveWithRollback({
      from: current,
      to: {
        ...current,
        domain,
        https,
        certResolver: https ? stackCertResolver(currentYaml) : null,
      },
      apply: async (route) => {
        const res = await applyTraefikConfig(host.id, {
          composeYaml: withPanelRoute(currentYaml, route),
        });
        if (!res.ok)
          throw new Error(res.error || "The proxy on this server refused the new panel address");
      },
      probe: () => probeUntilAnswers(url),
    });
  });
}

/**
 * Point the route at `to`, and put it back on `from` if the new address does not
 * answer.
 *
 * Its own function, with the two host operations passed in, because this order
 * is the whole safety property and it deserves a test that does not need a
 * server: apply, PROVE, and only then keep it. Get it wrong and the operator is
 * locked out of the page they were on.
 */
export async function moveWithRollback(opts: {
  from: PanelRoute;
  to: PanelRoute;
  apply: (route: PanelRoute) => Promise<void>;
  probe: () => Promise<PanelReachability>;
}): Promise<void> {
  await opts.apply(opts.to);
  const reached = await opts.probe();
  if (reached.ok) return;
  await opts.apply(opts.from);
  throw new Error(`${reached.error}. The panel is still on ${opts.from.domain}.`);
}

/**
 * Ask the new address whether it answers, allowing for the moment Traefik takes
 * to pick the file up. One attempt would report a working move as a failure and
 * roll it straight back.
 */
async function probeUntilAnswers(url: string): Promise<PanelReachability> {
  let last = await probePanel(url);
  for (let attempt = 0; attempt < 2 && !last.ok; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    last = await probePanel(url);
  }
  return last;
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
  // Every host that routes traffic - which a migration source never does. It has
  // no Traefik of ours to read an ACME account from, and writing one would put our
  // certificate settings on another platform's proxy.
  const servers = (await listAllServers()).filter((s) => !s.importOnly);

  return Promise.all(
    servers.map(async (server): Promise<CertificateAccount> => {
      const base = {
        serverId: server.id,
        serverName: serverLabel(server),
        customCertificates: 0,
        expiresInDays: null,
      };
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
        const { describeStackCertificates } = await import("./server-certificates");
        const own = describeStackCertificates(info.traefikComposeYaml);
        const installed = {
          customCertificates: own.length,
          expiresInDays: own.length
            ? Math.min(...own.map((c) => c.expiresInDays))
            : null,
        };
        const email = acmeEmail(info.traefikComposeYaml);
        return email === null
          ? {
              ...base,
              ...installed,
              email: null,
              unavailable: "This server's proxy issues no certificates",
            }
          : { ...base, ...installed, email, unavailable: null };
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

  const { fetchHostInfo, applyTraefikConfig, withTraefikStackLock } = await import(
    "../infra/agent-client"
  );
  const accounts = await readAccounts();
  let applied = 0;

  for (const account of accounts) {
    if (account.unavailable) continue;
    if (account.email === address) continue;
    try {
      // Held across the read and the write: this rewrites the host's WHOLE stack
      // file, and so does installing a certificate on it. See withTraefikStackLock.
      const res = await withTraefikStackLock(account.serverId, async () => {
        const info = await fetchHostInfo(account.serverId);
        const yamlText = withAcmeEmail(info.traefikComposeYaml, address);
        return applyTraefikConfig(account.serverId, { composeYaml: yamlText });
      });
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
