import { notFound } from "next/navigation";
import { Globe } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listServers } from "@/lib/data/servers";
import { listDomains } from "@/lib/data/domains";
import { resolveServerIp, productionDomain } from "@/lib/deploy/domains";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddDomain } from "@/components/domains/add-domain";
import { DomainDnsAutoCheck } from "@/components/domains/domain-dns-auto-check";
import { DomainRow } from "@/components/domains/domain-row";

export const metadata = { title: "App Domains" };

export default async function AppDomainsPage(
  props: PageProps<"/apps/[slug]/domains">
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  const [domains, servers] = await Promise.all([
    listDomains(project.id),
    listServers(),
  ]);
  // A zero-config nip.io hostname (`<slug>-<adjective>-<animal>-<hexip>.nip.io`)
  // the user can drop into the Domain field with one click — resolved here so the
  // server-only IP detection never reaches the client bundle. This is a fresh
  // suggestion for ADDING a domain (the app's own auto domain already exists),
  // so freshly-generated words are fine.
  const server = servers.find((s) => s.id === project.serverId);
  // The public IPv4 a custom domain's A record must point at — the IP of the
  // server THIS project runs on (server-specific, not a shared address). Resolved
  // server-side and threaded to both the nip.io suggestion and the misconfigured
  // hint on each domain row, so the server-only IP detection never reaches the
  // client bundle.
  const serverIp = resolveServerIp(server);
  const suggestedDomain = productionDomain(project.slug, serverIp);

  // Every domain mutation now re-applies routing to the running container itself
  // (see `applyRouting` in lib/graphql/types/domain.ts), so a settled domain is
  // genuinely live and needs no nagging. What is still NOT live is a host whose
  // DNS hasn't checked out — `pending`/`misconfigured` after the add-time check,
  // `error` after an unexpected failure. Those are filtered out of the router on
  // purpose; while any exist, the auto-check callout below re-verifies them on
  // an interval so they start routing on their own the moment DNS resolves.
  //
  // `cloudflare` is excluded despite rendering amber/unverified: it is settled
  // as far as DNS is concerned. Re-resolving a proxied host returns Cloudflare's
  // anycast IPs every time, so the poller could never learn anything new and the
  // "Waiting for DNS" callout would sit there forever on a domain that is very
  // likely working. Its caveat is carried per-row instead (DomainRow).
  const unsettledDomains = domains
    .filter((d) => d.status !== "valid" && d.status !== "cloudflare")
    .map((d) => ({ id: d.id, name: d.name, status: d.status }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Domains</h3>
          <p className="text-sm text-muted-foreground">
            Custom domains routed to this app with automatic TLS.
          </p>
        </div>
        <AddDomain
          project={{
            id: project.id,
            name: project.name,
            compose: project.compose,
            defaultPort: project.build.port,
          }}
          suggestedDomain={suggestedDomain}
        />
      </div>

      {/* Only a host that has NOT checked out is off the router (see
          `unsettledDomains`). While any exist, this client component both
          explains the wait AND re-checks their DNS automatically on an
          interval — the moment a record resolves, the same server path a
          manual Verify uses flips the domain routable and applies routing. */}
      {unsettledDomains.length > 0 && (
        <DomainDnsAutoCheck domains={unsettledDomains} serverIp={serverIp} />
      )}

      {domains.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains"
          description="Add a custom domain to this app."
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>App</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.map((d) => (
                <DomainRow
                  key={d.id}
                  domain={d}
                  compose={project.compose}
                  serverIp={serverIp}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
