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
  props: PageProps<"/apps/[slug]/domains">
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // The ADDRESS of the host this app runs on, asked about the app — not the
  // fleet. Listing every server to find one is a team-wide read that a member
  // limited to part of the team is refused, and the value a DNS record must
  // point at is part of their own app rather than the inventory.
  const [domains, serverIp] = await Promise.all([
    listDomains(project.id),
    serverIpForApp(project.id),
  ]);
  // A zero-config nip.io hostname (`<slug>-<adjective>-<animal>-<hexip>.nip.io`)
  // the user can drop into the Domain field with one click — resolved here so the
  // server-only IP detection never reaches the client bundle. This is a fresh
  // suggestion for ADDING a domain (the app's own auto domain already exists),
  // so freshly-generated words are fine.
  // The public IPv4 a custom domain's A record must point at — the IP of the
  // server THIS project runs on (server-specific, not a shared address). Resolved
  // server-side and threaded to both the nip.io suggestion and the misconfigured
  // hint on each domain row, so the server-only IP detection never reaches the
  // client bundle.
  const suggestedDomain = productionDomain(project.slug, serverIp);
  // Whether each row routes to a compose service or to the app's single
  // container — the authoritative source check, not "does the app carry compose
  // text" (an app can keep leftover YAML while deploying a repo or an image).
  const isComposeStack = usesComposeStack(project);
  // The Container column only says something when there is a choice to say it
  // about. A single-image app has exactly one container, and so does a one-service
  // stack: the column would then repeat the same string on every row — the very
  // thing that made the old "App" column useless. It is dropped in that case (the
  // Edit dialog still names the container), and shown when the stack really has
  // more than one service, where each domain differs by exactly this.
  //
  // The one exception is a row that names NO service on a stack: it routes
  // nowhere, and that warning lives in this cell, so the column stays even on a
  // one-service stack while such a row exists.
  const containerCount = isComposeStack
    ? composeServiceNames(project.compose).length
    : 1;
  const showContainer =
    containerCount > 1 ||
    (isComposeStack && domains.some((d) => !(d.service ?? "").trim()));

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

  // Rows that answer on a different name than they did on the platform this app
  // was imported from. Empty for every app that was not imported, and for an
  // imported one whose notice has been dismissed.
  const importedDomains = domains
    .filter((d) => (d.importedFrom ?? "").trim())
    .map((d) => ({ id: d.id, name: d.name, importedFrom: d.importedFrom! }));

  return (
    // Adding a domain closes its dialog at once and puts the hostname in the
    // table as a pulsing row while the DNS check and the reroute run — the
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

        {/* The addresses a migration could not keep. Above the DNS callout on
            purpose: it explains WHY the hostnames in the table are not the ones
            the app used to answer on, which is the first question the table
            raises for someone who just imported. */}
        <ImportedDomainsNotice appId={project.id} domains={importedDomains} />

        {/* Only a host that has NOT checked out is off the router (see
            `unsettledDomains`). While any exist, this client component both
            explains the wait AND re-checks their DNS automatically on an
            interval — the moment a record resolves, the same server path a
            manual Verify uses flips the domain routable and applies routing. */}
        {unsettledDomains.length > 0 && (
          <DomainDnsAutoCheck domains={unsettledDomains} serverIp={serverIp} />
        )}

        <PendingList
          empty={domains.length === 0}
          emptyState={
            <EmptyState
              graphic={<DomainGraphic />}
              title="No domains"
              description="Add a custom domain to this app."
            />
          }
        >
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  {/* What the hostname reaches, not who owns it: the owning App
                      is the page you are already on, so its name was the same
                      on every row. Only rendered when the app has more than one
                      container to route to (see `showContainer`) — otherwise
                      every row would name the same one. Sized so a real compose
                      service name fits on one line instead of wrapping. */}
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
