import { PageHeader } from "@/components/shared/page-header";
import { TeamCard } from "@/components/settings/team-form";
import { TeamSecurityCard } from "@/components/settings/team-security-card";
import { TeamAgentsCard } from "@/components/settings/team-agents-card";
import { TeamDnsCard } from "@/components/settings/dns/team-dns-card";
import { TeamDangerZoneSkeleton } from "@/components/settings/team-danger-zone";

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <PageHeader
        docs="team.overview"
        title="General"
        description="Your workspace details."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <TeamCard name="" avatarUrl={null} loading />
        <TeamSecurityCard
          requireTwoFactor={false}
          canManage={false}
          without={0}
          total={0}
          loading
        />
        <TeamAgentsCard enabled={false} canManage={false} agents={0} loading />
        <TeamDnsCard providers={[]} teams={[]} activeTeamId="" loading />
        <div className="md:col-span-2 xl:col-span-3">
          <TeamDangerZoneSkeleton />
        </div>
      </div>
    </div>
  );
}
