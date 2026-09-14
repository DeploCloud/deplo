import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { serverIpForApp } from "@/lib/data/servers/roster";
import { listDomains } from "@/lib/data/domains/crud";
import { productionDomain } from "@/lib/deploy/domains";
import { isRoutableDomain } from "@/lib/deploy/cloudflare";
import { composeServiceNames } from "@/lib/deploy/compose-stack/compose-read";
import { redactComposeForDisplay } from "@/lib/deploy/compose-redact";
import { usesComposeStack } from "@/lib/utils";
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
import { DomainGraphic } from "@/components/domains/domain-graphic";
import { DomainRow } from "@/components/domains/domain-row";
import { ImportedDomainsNotice } from "@/components/domains/imported-domains-notice";
import {
  PendingCreateProvider,
  PendingList,
  PendingRows,
} from "@/components/shared/pending-create";
import { OptimisticList } from "@/components/shared/optimistic-list";

export const metadata = { title: "App Domains" };

export default async function AppDomainsPage(
  props: PageProps<"/[team]/apps/[slug]/domains">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  const [domains, serverIp] = await Promise.all([
    listDomains(project.id),
    serverIpForApp(project.id),
  ]);
  // Resolved here so the server-only IP detection never reaches the client bundle.
  const suggestedDomain = productionDomain(project.slug, serverIp);
  // Not "does the app carry compose text": an app can keep leftover YAML while deploying a repo or an image.
  const isComposeStack = usesComposeStack(project);
  const containerCount = isComposeStack
    ? composeServiceNames(project.compose).length
    : 1;
  const showContainer =
    containerCount > 1 ||
    (isComposeStack && domains.some((d) => !(d.service ?? "").trim()));

  // `applyRouting` (lib/graphql/types/domain.ts) runs on every domain mutation, so a settled domain is already live.
  const unsettledDomains = domains
    .filter((d) => !isRoutableDomain(d))
    .map((d) => ({ id: d.id, name: d.name, status: d.status }));

  const importedDomains = domains
    .filter((d) => (d.importedFrom ?? "").trim())
    .map((d) => ({ id: d.id, name: d.name, importedFrom: d.importedFrom! }));

  // The values a compose inlines are not the `view` floor's to see; the client only reads service names.
  const composeForBrowser =
    project.compose == null ? null : redactComposeForDisplay(project.compose);
  return (
    // The provider holds the pending row, so it wraps both the dialog and the table.
    <PendingCreateProvider count={domains.length}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Domains</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Custom domains routed to this app with automatic TLS.
            </p>
          </div>
          <AddDomain
            project={{
              id: project.id,
              name: project.name,
              compose: composeForBrowser,
              defaultPort: project.build.port,
            }}
            suggestedDomain={suggestedDomain}
          />
        </div>

        {/* Above the DNS callout on purpose: it explains why the table's hostnames are not the imported ones. */}
        <ImportedDomainsNotice appId={project.id} domains={importedDomains} />

        {/* Only a host that has not checked out is off the router. */}
        {unsettledDomains.length > 0 && (
          <DomainDnsAutoCheck domains={unsettledDomains} serverIp={serverIp} />
        )}

        <PendingList
          empty={domains.length === 0}
          emptyState={
            <EmptyState
              graphic={<DomainGraphic />}
              title="No domains"
              docs="domains.overview"
              description="Add a custom domain to this app."
            />
          }
        >
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  {/* What the hostname reaches, not who owns it: every row here is this same app. */}
                  {showContainer && (
                    <TableHead className="w-56">Container</TableHead>
                  )}
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* The row is dropped server-side before the routing is re-applied. */}
                <OptimisticList>
                  {domains.map((d) => (
                    <DomainRow
                      key={d.id}
                      domain={d}
                      compose={composeForBrowser}
                      isCompose={isComposeStack}
                      showContainer={showContainer}
                      serverIp={serverIp}
                      // So each Edit dialog can derive the hostname's www pairing from the rows that exist.
                      siblings={domains}
                    />
                  ))}
                </OptimisticList>
                <PendingRows columns={showContainer ? 4 : 3} />
              </TableBody>
            </Table>
          </div>
        </PendingList>
      </div>
    </PendingCreateProvider>
  );
}
