import "server-only";

import { errorMessage } from "../../utils";
import { isInstanceAdmin } from "../../membership";
import type { MappedDomain } from "../../migration/map/domains";
import type { SourceDomain } from "../../migration/model";
import { blocker, type Note } from "../../migration/note";
import { wwwCounterpart } from "../../www-redirect";
import { loadDomainsForApp } from "../app-graph-load";
import { updateDomain } from "../domains/crud";
import {
  addServerCertificate,
  certificateCovers,
  listServerCertificates,
  type ServerCertificate,
} from "../server-certificates";
import { getServerById } from "../servers/roster";

// A middleware lives on the proxy, not on the domain: one missing here leaves the domain answering nothing.
export async function noteDomainMiddlewares(
  appId: string,
  notes: Note[],
): Promise<void> {
  for (const d of await loadDomainsForApp(appId))
    if (d.middlewares?.length)
      notes.push(
        blocker(
          `${d.name} uses the Middlewares ${d.middlewares.join(", ")}, which were set up on {panel}'s server. Unless they are set up on this server too, ${d.name} does not answer - set them up, or remove them under Domains.`,
        ),
      );
}

// A domain moved onto a temporary address keeps its route only; what it set beyond that is named.
export function noteLeftRules(
  from: MappedDomain,
  to: string,
  notes: Note[],
): void {
  const r = from.rules;
  if (!r) return;
  const left = [
    r.corsOrigins?.length
      ? `Allowed origins (${r.corsOrigins.join(", ")})`
      : "",
    r.securityHeaders === false ? "Security headers off" : "",
    r.proxied ? "Behind a proxy" : "",
    r.middlewares?.length ? `Middlewares (${r.middlewares.join(", ")})` : "",
  ].filter(Boolean);
  if (left.length > 0)
    notes.push(
      `${from.host}'s settings did not move to ${to}: ${left.join(", ")}. Set them on ${to} under Domains if the app needs them there.`,
    );
}

const WITHHELD: Record<string, string> = {
  admin:
    "only an instance admin's token on {panel} hands a certificate's key over",
  missing: "{panel}'s server no longer holds a certificate for it",
  unreadable: "{panel} could not read its server's certificates",
  old: "{panel} is too old to hand certificates over",
};

// Before the domains land: one whose certificate is here stays "custom", any other lands without one.
export async function landDomainCertificates(
  serverId: string,
  domains: MappedDomain[],
  notes: Note[],
): Promise<void> {
  const wanted = domains.filter((d) => !d.generated && d.rules?.certificate);
  if (wanted.length === 0) return;
  const serverName = (await getServerById(serverId))?.name ?? "this server";
  let installed: ServerCertificate[] | null = null;
  try {
    installed = (await isInstanceAdmin())
      ? await listServerCertificates(serverId)
      : null;
  } catch {}
  const upload = `Upload it under Servers → ${serverName} → Certificates, then set the domain to use it`;
  for (const d of wanted) {
    const cert = d.rules!.certificate!;
    if (
      installed?.some((c) => !c.expired && certificateCovers(c.domains, d.host))
    ) {
      d.certProvider = "custom";
      d.entrypoint = "websecure";
      if ("withheld" in cert)
        notes.push(
          `${d.host} keeps the certificate already installed on ${serverName}; the one on {panel} did not come across (${WITHHELD[cert.withheld]}).`,
        );
      continue;
    }
    let why: string;
    if ("withheld" in cert) why = WITHHELD[cert.withheld] ?? "refused";
    else
      try {
        installed = await addServerCertificate(serverId, cert);
        d.certProvider = "custom";
        d.entrypoint = "websecure";
        notes.push(
          `${d.host}'s own certificate is installed on ${serverName} too. Nothing renews it automatically, so upload the next one there when it expires.`,
        );
        continue;
      } catch (e) {
        why = errorMessage(e, "refused");
      }
    notes.push(
      blocker(
        `${d.host} served its own certificate on {panel}, and it did not come across (${why}). Until it is here, ${d.host} has no valid certificate. ${upload}.`,
      ),
    );
  }
}

// Another Deplo only ever redirects a host to its www twin, so that is the redirect made here.
export async function landDomainRedirects(
  appId: string,
  source: SourceDomain[] | null | undefined,
  notes: Note[],
): Promise<void> {
  for (const d of source ?? []) {
    const host = d.host.trim().toLowerCase();
    const to = d.nativeRules?.redirectTo?.trim().toLowerCase();
    if (!to) continue;
    const target = (await loadDomainsForApp(appId)).find(
      (r) => r.name === to && !r.redirectTo,
    );
    const why = !target
      ? `${to} did not come across under that name`
      : wwwCounterpart(to) !== host
        ? "Deplo redirects a host only to its www twin"
        : null;
    try {
      if (why) throw new Error(why);
      await updateDomain(target!.id, { www: "toThis" });
    } catch (e) {
      notes.push(
        `${host} redirected to ${to} on {panel}, and that redirect did not come across (${errorMessage(
          e,
          "refused",
        )}). Add ${host} under Domains if you still need it.`,
      );
    }
  }
}
