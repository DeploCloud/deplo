import { notFound } from "next/navigation";
import { Globe, RefreshCw } from "lucide-react";
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
  // DNS hasn't checked out — `pending` after an add, `misconfigured`/`error`
  // after a failed check. Those are filtered out of the router on purpose, so
  // they route only once they verify, and that is what this notice explains.
  const hasUnsettledDomain = domains.some(
    (d) => d.status !== "valid" && d.status !== "cloudflare",
  );

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
          `hasUnsettledDomain`). Adding, editing, removing or verifying a domain
          re-applies routing to the running container on the spot, so a verified
          list is live and gets no notice. */}
      {hasUnsettledDomain && (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/40 px-3.5 py-2.5 text-sm">
          <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-0.5">
            <p className="font-medium">Verify to start routing</p>
            <p className="text-muted-foreground">
              A custom domain only reaches the app once its DNS is verified.
              Point it at this server, then hit Verify — routing is applied to
              the running container for you, with no rebuild.
            </p>
          </div>
        </div>
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
