import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { acmeEmail, withAcmeEmail } from "../../deploy/traefik-stack";
import { serverLabel } from "../../utils";
import { recordActivity } from "../activity";

// One host's certificate account, as its own Traefik reports it.
export type CertificateAccount = {
  serverId: string;
  serverName: string;
  // Empty string = the resolver has none; null = there is nothing here Deplo can
  // manage (see `unavailable`).
  email: string | null;
  // Why this host is not manageable, verbatim for the operator. Null when it is.
  unavailable: string | null;
  // How many certificates the operator installed on this host themselves.
  customCertificates: number;
  // Whole days until the FIRST of those expires, negative once one has, null when
  // there are none.
  expiresInDays: number | null;
};

// What every server's Traefik has as its Let's Encrypt account, read live.
export async function listCertificateAccounts(): Promise<CertificateAccount[]> {
  await requireInstanceAdmin();
  return readAccounts();
}

async function readAccounts(): Promise<CertificateAccount[]> {
  const { listAllServers } = await import("../servers/roster");
  const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
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
        return {
          ...base,
          email: null,
          unavailable: "This server has not finished setting up yet",
        };
      try {
        const info = await fetchHostInfo(server.id);
        if (!info.traefikComposeYaml)
          return {
            ...base,
            email: null,
            unavailable:
              "Deplo did not install the proxy on this server, so it does not manage its certificates",
          };
        const { describeStackCertificates } =
          await import("../server-certificates");
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
        return {
          ...base,
          email: null,
          unavailable: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
}

// Point every manageable host's certificates at a new account email. Hosts Deplo
// cannot manage are skipped and REPORTED as skipped, never silently counted as
// done. Sequentially, so a fleet never goes dark all at once.
export async function setCertificateEmail(
  email: string,
): Promise<CertificateAccount[]> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const address = email.trim().toLowerCase();
  if (!address.includes("@") || /\s/.test(address))
    throw new Error("Enter a valid email address");

  const { fetchHostInfo, applyTraefikConfig, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
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
        account.unavailable =
          res.error || `Could not apply the change on ${account.serverName}`;
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
      "server",
      `Set the certificate account email to ${address} on ${applied} server${applied === 1 ? "" : "s"}`,
      user.name,
      null,
      teamId,
    );
  }
  return accounts;
}
