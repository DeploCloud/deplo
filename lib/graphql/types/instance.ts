import { builder } from "../builder";
import {
  getInstanceSettings,
  getPanelAddressImpact,
  getPanelHttps,
  listCertificateAccounts,
  setCertificateEmail,
  setPanelHttps,
  setGravatarEnabled,
  setLogMaxDays,
  checkPanelDns,
  setPanelUrl,
  type CertificateAccount,
  type InstanceSettings,
  type PanelAddressImpact,
  type PanelDns,
  type PanelHttps,
} from "@/lib/data/instance-settings";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const InstanceSettingsRef = builder
  .objectRef<InstanceSettings>("InstanceSettings")
  .implement({
    description:
      "Settings that belong to this Deplo instance rather than to a team or a host: the address the panel answers on, and what version it runs.",
    fields: (t) => ({
      panelUrl: t.exposeString("panelUrl", {
        description:
          "The address Deplo uses for itself right now. Every install command, deploy hook URL and invite link is built from it.",
      }),
      logMaxDays: t.exposeInt("logMaxDays", {
        description:
          "How far back the log viewer's time range may reach, in days. Instance-wide because the logs live on the host, which several teams share. It bounds what may be ASKED for and nothing else: docker rotates its json-file logs by size, so no setting here makes the host actually hold that much.",
      }),
      gravatarEnabled: t.exposeBoolean("gravatarEnabled", {
        description:
          "Whether a person with no uploaded picture falls back to their Gravatar. The panel never dials gravatar.com itself - it only computes the address, and each viewer's browser fetches it.",
      }),
      panelUrlSource: t.exposeString("panelUrlSource", {
        description:
          "`stored` (set here), `environment` (DEPLO_PUBLIC_URL, set at install time) or `request` (derived from the browser's own host, which is a guess).",
      }),
      storedPanelUrl: t.exposeString("storedPanelUrl", { nullable: true }),
      panelIpUrl: t.exposeString("panelIpUrl", {
        nullable: true,
        description:
          "The address the panel also answers on, straight on the machine it runs on (http://<server ip>:3000). Always on and not a setting: it is the way back in when the panel's domain, certificate or proxy stops working. Null only when Deplo cannot work out an address of its own that anyone else could reach.",
      }),
      deploHostIp: t.exposeString("deploHostIp", {
        nullable: true,
        description:
          "The IPv4 an A record for the panel's domain should point at.",
      }),
      version: t.exposeString("version"),
      deploHostId: t.exposeString("deploHostId", { nullable: true }),
      deploHostName: t.exposeString("deploHostName", { nullable: true }),
    }),
  });

const PanelAddressImpactRef = builder
  .objectRef<PanelAddressImpact>("PanelAddressImpact")
  .implement({
    description:
      "What moving the panel to a given address would break, counted live and instance-wide. Every number is a fact about right now, so a dialog can name what is lost instead of warning in the abstract. Read-only: nothing here changes anything.",
    fields: (t) => ({
      url: t.exposeString("url"),
      currentUrl: t.exposeString("currentUrl"),
      hostChanges: t.exposeBoolean("hostChanges", {
        description:
          "Whether the hostname moves. Everything a browser welds to an origin - passkeys, cookies, push subscriptions - dies on this.",
      }),
      schemeChanges: t.exposeBoolean("schemeChanges"),
      losesHttps: t.exposeBoolean("losesHttps", {
        description:
          "https to http. Browsers that already loaded the panel over https keep refusing plain http on that hostname until the HSTS they remember expires.",
      }),
      panelIpUrl: t.exposeString("panelIpUrl", { nullable: true }),
      passkeys: t.exposeInt("passkeys"),
      passkeyPeople: t.exposeInt("passkeyPeople"),
      sessions: t.exposeInt("sessions"),
      sessionPeople: t.exposeInt("sessionPeople"),
      deployHooks: t.exposeInt("deployHooks"),
      mcpConnections: t.exposeInt("mcpConnections"),
      registrationLinks: t.exposeInt("registrationLinks"),
      pendingServers: t.exposeInt("pendingServers"),
      pushSubscriptions: t.exposeInt("pushSubscriptions"),
      gitConnections: t.exposeInt("gitConnections", {
        description:
          "Git connections whose webhook is registered against the address the INSTALLER was given, not this setting - so this change does not move them.",
      }),
      githubApps: t.exposeInt("githubApps"),
    }),
  });

const PanelHttpsRef = builder.objectRef<PanelHttps>("PanelHttps").implement({
  description:
    "How the Deplo panel itself is served, read live off the router that publishes it. `unavailable` says why it is not Deplo's to change here - the host is not added as a server, its proxy is not one Deplo installed, or the panel is still published by its own container.",
  fields: (t) => ({
    domain: t.exposeString("domain", {
      nullable: true,
      description:
        "The host the panel's route answers on, as the proxy has it.",
    }),
    enabled: t.exposeBoolean("enabled", {
      description:
        "Whether the panel is served over https. False means plain http on :80, for a panel whose address cannot get a certificate.",
    }),
    provider: t.exposeString("provider", {
      nullable: true,
      description:
        "The certificate resolver it is ordered from, named as this host names it. Null when https is off, or when this host orders from nobody and serves a certificate you installed.",
    }),
    unavailable: t.exposeString("unavailable", { nullable: true }),
  }),
});

const CertificateAccountRef = builder
  .objectRef<CertificateAccount>("CertificateAccount")
  .implement({
    description:
      "One server's Let's Encrypt account, read from that host's own proxy configuration. `email` is null when Deplo cannot manage certificates there; `unavailable` says why, in the host's own words.",
    fields: (t) => ({
      serverId: t.exposeString("serverId"),
      serverName: t.exposeString("serverName"),
      email: t.exposeString("email", { nullable: true }),
      unavailable: t.exposeString("unavailable", { nullable: true }),
      customCertificates: t.exposeInt("customCertificates", {
        description:
          "How many certificates the operator installed on this host themselves (see `serverCertificates`).",
      }),
      expiresInDays: t.exposeInt("expiresInDays", {
        nullable: true,
        description:
          "Whole days until the first of those expires, negative once one has, null when there are none. Nothing renews a certificate installed by hand, so this is the only warning there is.",
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  instanceSettings: t.field({
    type: InstanceSettingsRef,
    authScopes: { instanceAdmin: true },
    description:
      "This instance's own settings. A plain database read: it never dials a server, so it answers even when the fleet is down.",
    resolve: () => getInstanceSettings(),
  }),
  panelAddressImpact: t.field({
    type: PanelAddressImpactRef,
    authScopes: { instanceAdmin: true },
    description:
      "What moving the panel to this address would break: passkeys welded to the current hostname, sessions, deploy hooks already pasted into someone's CI, connected AI clients, invite links, servers still waiting for their install command, notification subscriptions. Counted live and instance-wide, and only meaningful when the address actually moves - an unchanged address answers all zeroes. A query, not a mutation: it reads the database and dials nothing.",
    args: { url: t.arg.string({ required: true }) },
    resolve: (_r, { url }) => getPanelAddressImpact(url),
  }),
}));

const PanelDnsRef = builder.objectRef<PanelDns>("PanelDns").implement({
  description: "What DNS says about the address the panel answers on.",
  fields: (t) => ({
    status: t.exposeString("status"),
    host: t.exposeString("host"),
    resolved: t.exposeStringList("resolved"),
  }),
});

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  setPanelUrl: t.field({
    type: InstanceSettingsRef,
    authScopes: { instanceAdmin: true },
    description:
      "Set the address this Deplo answers on, or pass no url to fall back to DEPLO_PUBLIC_URL. A bare domain becomes https://. The value is validated as a hostname with no path, no credentials and no shell metacharacters, because it is interpolated into copy-and-run strings such as a server's install command. On a Deplo that publishes itself through its own proxy this MOVES the panel's route too, and puts the old one back if the new address does not answer; DNS still has to point at the server first.",
    args: { url: t.arg.string({ required: false }) },
    resolve: (_r, { url }) => setPanelUrl(url ?? null),
  }),
  panelDns: t.field({
    type: PanelDnsRef,
    authScopes: { instanceAdmin: true },
    description:
      "Resolve the panel's own hostname and classify it the way a custom domain is classified: `valid` when its A records include this host's public IPv4, `cloudflare` when they are Cloudflare's anycast addresses and the origin cannot be read from DNS, `misconfigured` when it answers with something else, `pending` when it does not resolve, and `unknown` when there is nothing to check (a bare IP, or no host address on record). A mutation despite writing nothing, for the same reason panelHttps is one: it leaves the process.",
    resolve: () => checkPanelDns(),
  }),
  panelHttps: t.field({
    type: PanelHttpsRef,
    authScopes: { instanceAdmin: true },
    description:
      "Read how the panel is served off the proxy that publishes it, live. A mutation despite writing nothing, for the same reason serverCertificateAccounts is one: it dials a server.",
    resolve: () => getPanelHttps(),
  }),
  setPanelHttps: t.field({
    type: PanelHttpsRef,
    authScopes: { instanceAdmin: true },
    description:
      "Serve the panel over https, or over plain http. Turning it off is for a panel whose address cannot get a certificate - it does not resolve publicly yet, :80 is closed, the box is internal - where https means a browser warning on a page nobody has logged into yet. Three things move together: the route goes to the :80 entrypoint (with that entrypoint's redirect pinned below it), the stored panel address takes the new scheme, and the session cookie drops its `__Secure-` prefix, without which the panel would load over http and be impossible to log into. The host's proxy is recreated to pick it up, so sites on that server - this panel included - are unreachable for the few seconds it takes to come back. On a Deplo installed before it published its own route, the first change ADOPTS that route: Deplo writes one beside the container labels the installer left and outranks them, after proving from inside the network that it knows where the panel listens.",
    args: { enabled: t.arg.boolean({ required: true }) },
    resolve: (_r, { enabled }) => setPanelHttps(enabled),
  }),
  setLogMaxDays: t.field({
    type: InstanceSettingsRef,
    authScopes: { instanceAdmin: true },
    description:
      "Set how far back the log viewer's time range may reach, in days. It is a ceiling on the ranges the picker offers, not a retention policy: docker rotates a container's logs by SIZE, so nothing here makes a host hold more of them, and a window that comes back empty says the host rotated them rather than pretending the app was quiet. Clamped rather than rejected - the field is a number input with the same bounds, so a value outside them arrived from an API client, and the honest answer to \"keep 900 days\" is the ceiling.",
    args: { days: t.arg.int({ required: true }) },
    resolve: (_r, { days }) => setLogMaxDays(days),
  }),
  setGravatarEnabled: t.field({
    type: InstanceSettingsRef,
    authScopes: { instanceAdmin: true },
    description:
      "Turn Gravatar profile pictures on or off for the whole instance. On, a person with no uploaded picture falls back to the one registered against their address, and each VIEWER's browser fetches it - the panel itself never dials out, so an instance with no egress still works. Off, no Gravatar address is emitted anywhere and nothing about anybody leaves the instance. Instance-wide because it is a property of this deployment's egress and policy, not of one team's taste.",
    args: { enabled: t.arg.boolean({ required: true }) },
    resolve: (_r, { enabled }) => setGravatarEnabled(enabled),
  }),
  serverCertificateAccounts: t.field({
    type: [CertificateAccountRef],
    authScopes: { instanceAdmin: true },
    description:
      "Read the Let's Encrypt account email off every server's proxy, live. Per host, because the address is a flag in each host's own stack file and a fleet installed over time can genuinely disagree with itself. A host Deplo cannot manage reports why instead of an address.",
    resolve: () => listCertificateAccounts(),
  }),
  setCertificateEmail: t.field({
    type: [CertificateAccountRef],
    authScopes: { instanceAdmin: true },
    description:
      "Point every manageable server's certificates at this account email, where Let's Encrypt sends expiry and revocation notices. Each host's proxy is recreated to pick it up, one host at a time, so routing there is interrupted for a few seconds; certificates already issued keep working. Servers Deplo cannot manage are skipped and reported as skipped, never counted as done.",
    args: { email: t.arg.string({ required: true }) },
    resolve: (_r, { email }) => setCertificateEmail(email),
  }),
}));
