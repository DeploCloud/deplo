import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { acmeEmail, withAcmeEmail } from "../../deploy/traefik-stack";
import { serverLabel } from "../../utils";
import { recordActivity } from "../activity";

export type CertificateAccount = {
  serverId: string;
  serverName: string;
  email: string | null;
  unavailable: string | null;
  customCertificates: number;
  expiresInDays: number | null;
};

export async function listCertificateAccounts(): Promise<CertificateAccount[]> {
  await requireInstanceAdmin();
  return readAccounts();
}

async function readAccounts(): Promise<CertificateAccount[]> {
  const { listAllServers } = await import("../servers/roster");
  const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
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
        return {
          ...base,
          email: null,
          unavailable: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
}

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
