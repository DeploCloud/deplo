import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { serverIpForApp } from "@/lib/data/servers";
import { listDomains } from "@/lib/data/domains";
import { productionDomain } from "@/lib/deploy/domains";
import { composeServiceNames } from "@/lib/deploy/compose-stack";
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
  props: PageProps<"/apps/[slug]/domains">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // The ADDRESS of the host this app runs on, asked about the app, not the fleet.
  const [domains, serverIp] = await Promise.all([
    listDomains(project.id),
    serverIpForApp(project.id),
  ]);
  // A zero-config nip.io hostname (`<slug>-<adjective>-<animal>-<hexip>.nip.io`) the
  // user can drop into the Domain field with one click - resolved here so the
  // server-only IP detection never reaches the client bundle.
  const suggestedDomain = productionDomain(project.slug, serverIp);
  // Whether each row routes to a compose service or to the app's single
  // container - the authoritative source check, not "does the app carry compose
  // text" (an app can keep leftover YAML while deploying a repo or an image).
  const isComposeStack = usesComposeStack(project);
  // The Container column only says something when there is a choice to say it about.
  const containerCount = isComposeStack
    ? composeServiceNames(project.compose).length
    : 1;
  const showContainer =
    containerCount > 1 ||
    (isComposeStack && domains.some((d) => !(d.service ?? "").trim()));

  // Every domain mutation now re-applies routing to the running container itself (see
  // `applyRouting` in lib/graphql/types/domain.ts), so a settled domain is genuinely
  // live and needs no nagging.
  const unsettledDomains = domains
    .filter((d) => d.status !== "valid" && d.status !== "cloudflare")
    .map((d) => ({ id: d.id, name: d.name, status: d.status }));

  // Rows that answer on a different name than they did on the platform this app
  // was imported from. Empty for every app that was not imported, and for an
  // imported one whose notice has been dismissed.
  const importedDomains = domains
    .filter((d) => (d.importedFrom ?? "").trim())
    .map((d) => ({ id: d.id, name: d.name, importedFrom: d.importedFrom! }));

  return (
    // Adding a domain closes its dialog at once and puts the hostname in the
    // table as a pulsing row while the DNS check and the reroute run - the
    // provider holds that row, so it wraps both the dialog and the table.
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
              compose: project.compose,
              defaultPort: project.build.port,
            }}
            suggestedDomain={suggestedDomain}
          />
        </div>

        {/**
         * The addresses a migration could not keep. Above the DNS callout on purpose: it
         * explains WHY the hostnames in the table are not the ones the app used to answer
         * on, which is the first question the table raises for someone who just imported.
         */}
        <ImportedDomainsNotice appId={project.id} domains={importedDomains} />

        {/**
         * Only a host that has NOT checked out is off the router (see `unsettledDomains`).
         */}
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
                  {/**
                   * What the hostname reaches, not who owns it: the owning App is the page you are
                   * already on, so its name was the same on every row.
                   */}
                  {showContainer && (
                    <TableHead className="w-56">Container</TableHead>
                  )}
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* A removed domain leaves the table on the click; the row is
                    dropped server-side before the routing is re-applied. */}
                <OptimisticList>
                  {domains.map((d) => (
                    <DomainRow
                      key={d.id}
                      domain={d}
                      compose={project.compose}
                      isCompose={isComposeStack}
                      showContainer={showContainer}
                      serverIp={serverIp}
                      // Every row of THIS app, so each Edit dialog can derive the
                      // hostname's www pairing from the rows that exist.
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
