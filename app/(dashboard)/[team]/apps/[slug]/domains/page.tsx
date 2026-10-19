import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { serverIpForApp } from "@/lib/data/servers/roster";
import { listDomains } from "@/lib/data/domains/crud";
import { domainDnsHints } from "@/lib/data/domains/dns-check";
import { productionDomain } from "@/lib/deploy/domains";
import { composeServiceNames } from "@/lib/deploy/compose-stack/compose-read";
import { redactComposeForDisplay } from "@/lib/deploy/compose-redact";
import { usesComposeStack } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";

import { AddDomain } from "@/components/domains/add-domain";
import { DomainNotices } from "@/components/domains/domain-notices";
import { DomainGraphic } from "@/components/domains/domain-graphic";
import { DomainTable } from "@/components/domains/domain-table";
import {
  PendingCreateProvider,
  PendingList,
  PendingRows,
} from "@/components/shared/pending-create";

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
  const hints = await domainDnsHints(project.id, domains);
  const suggestedDomain = serverIp
    ? productionDomain(project.slug, serverIp)
    : undefined;
  const isComposeStack = usesComposeStack(project);
  const containerCount = isComposeStack
    ? composeServiceNames(project.compose).length
    : 1;
  const showContainer =
    containerCount > 1 ||
    (isComposeStack && domains.some((d) => !(d.service ?? "").trim()));

  const composeForBrowser =
    project.compose == null ? null : redactComposeForDisplay(project.compose);
  return (
    <PendingCreateProvider count={domains.length}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Domains</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Custom domains routed to this app with automatic TLS.
            </p>
            {!serverIp && (
              <p className="mt-1 text-sm text-muted-foreground">
                No generated address here: Deplo doesn’t know this server’s IPv4
                address.
              </p>
            )}
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

        <DomainNotices
          appId={project.id}
          domains={domains}
          serverIp={serverIp}
          serverIpv6={hints.serverIpv6}
        />

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
          <DomainTable
            domains={domains}
            compose={composeForBrowser}
            isCompose={isComposeStack}
            showContainer={showContainer}
            suggestedDomain={suggestedDomain}
            serverIp={serverIp}
            serverIpv6={hints.serverIpv6}
            strays={hints.strays}
          >
            <PendingRows columns={showContainer ? 4 : 3} />
          </DomainTable>
        </PendingList>
      </div>
    </PendingCreateProvider>
  );
}
