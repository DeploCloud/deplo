import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { listDomains } from "@/lib/data/domains/crud";
import { domainDnsHints } from "@/lib/data/domains/dns-check";
import { serverIpForApp } from "@/lib/data/servers/roster";
import { domainNeedsAttention } from "@/lib/domain-issues";
import { composeServiceNames } from "@/lib/deploy/compose-stack/compose-read";
import { redactComposeForDisplay } from "@/lib/deploy/compose-redact";
import { productionDomain } from "@/lib/deploy/domains";
import { usesComposeStack } from "@/lib/utils";
import type { App } from "@/lib/types/app";
import { DomainNotices } from "./domain-notices";
import { DomainTable } from "./domain-table";

export async function AppDomainNotices({ app }: { app: App }) {
  const domains = await listDomains(app.id);
  const isCompose = usesComposeStack(app);
  const services = isCompose ? composeServiceNames(app.compose) : [];
  const issues = domains.filter((domain) =>
    domainNeedsAttention(domain, isCompose, services),
  );
  if (!issues.length && !domains.some((domain) => domain.importedFrom?.trim()))
    return null;
  const [serverIp, hints] = await Promise.all([
    serverIpForApp(app.id),
    domainDnsHints(app.id, domains),
  ]);
  const showContainer = isCompose;
  return (
    <section
      className="min-w-0 space-y-3"
      aria-labelledby="domain-notices-title"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="domain-notices-title" className="text-sm font-medium">
          Domain notices
        </h2>
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/apps/${app.slug}/domains`}>View domains</Link>
        </Button>
      </div>
      <DomainNotices
        appId={app.id}
        domains={domains}
        serverIp={serverIp}
        serverIpv6={hints.serverIpv6}
      />
      {issues.length > 0 && (
        <DomainTable
          domains={issues}
          siblings={domains}
          compose={
            app.compose == null ? null : redactComposeForDisplay(app.compose)
          }
          isCompose={isCompose}
          showContainer={showContainer}
          serverIp={serverIp}
          serverIpv6={hints.serverIpv6}
          strays={hints.strays}
          suggestedDomain={
            serverIp ? productionDomain(app.slug, serverIp) : undefined
          }
        />
      )}
    </section>
  );
}
