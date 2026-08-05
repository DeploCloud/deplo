import { builder } from "../builder";
import {
  checkPanelUrl,
  getInstanceSettings,
  listCertificateAccounts,
  setCertificateEmail,
  setPanelUrl,
  type CertificateAccount,
  type InstanceSettings,
  type PanelReachability,
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
      panelUrlSource: t.exposeString("panelUrlSource", {
        description:
          "`stored` (set here), `environment` (DEPLO_PUBLIC_URL, set at install time) or `request` (derived from the browser's own host, which is a guess).",
      }),
      storedPanelUrl: t.exposeString("storedPanelUrl", { nullable: true }),
      version: t.exposeString("version"),
      deploHostId: t.exposeString("deploHostId", { nullable: true }),
      deploHostName: t.exposeString("deploHostName", { nullable: true }),
    }),
  });

const PanelReachabilityRef = builder
  .objectRef<PanelReachability>("PanelReachability")
  .implement({
    description:
      "Whether an address actually reaches this Deplo, asked of the address itself. DNS and the proxy in front of the panel belong to the operator, so this reports what the address answered rather than claiming it works.",
    fields: (t) => ({
      url: t.exposeString("url"),
      ok: t.exposeBoolean("ok"),
      error: t.exposeString("error", { nullable: true }),
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
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  setPanelUrl: t.field({
    type: InstanceSettingsRef,
    authScopes: { instanceAdmin: true },
    description:
      "Set the address this Deplo answers on, or pass no url to fall back to DEPLO_PUBLIC_URL. A bare domain becomes https://. The value is validated as a hostname with no path, no credentials and no shell metacharacters, because it is interpolated into copy-and-run strings such as a server's install command. This does not move the panel's routing: that follows your DNS and proxy; use checkPanelUrl to prove the address reaches this instance.",
    args: { url: t.arg.string({ required: false }) },
    resolve: (_r, { url }) => setPanelUrl(url ?? null),
  }),
  // A MUTATION despite writing nothing, for the same reason checkServerHostInfo
  // is one: it dials out over the network, and the GraphQL route serves GET, so a
  // side-effecting query would be reachable by a plain link.
  checkPanelUrl: t.field({
    type: PanelReachabilityRef,
    authScopes: { instanceAdmin: true },
    description:
      "Ask an address whether it reaches this Deplo, by calling the panel's own liveness endpoint from the server side. Persists nothing. Reports what answered instead when it does not: a DNS failure, a 502 and 'something else lives here' all need different fixes.",
    args: { url: t.arg.string({ required: true }) },
    resolve: (_r, { url }) => checkPanelUrl(url),
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
