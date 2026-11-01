import { requireActiveTeamId } from "@/lib/membership";
import {
  dnsProviderTeamChoices,
  listMyDnsProviders,
} from "@/lib/data/dns-providers/store";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { DnsSettings } from "@/components/settings/dns/dns-settings";

export const metadata = { title: "Settings · Automatic DNS" };

export default async function DnsSettingsPage() {
  const [providers, teams, activeTeamId] = await Promise.all([
    listMyDnsProviders(),
    dnsProviderTeamChoices(),
    requireActiveTeamId(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Automatic DNS
            <BetaChip />
          </span>
        }
        description="Connect your domain's DNS provider, and Deplo creates the record when you add the domain to an app."
      />
      <DnsSettings
        providers={providers}
        teams={teams}
        activeTeamId={activeTeamId}
      />
    </div>
  );
}
