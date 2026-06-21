import { requireUser } from "@/lib/auth";
import { getTeam, listMyTeams } from "@/lib/data/teams";
import { currentCapabilities, isInstanceAdmin } from "@/lib/membership";
import { AppShell } from "@/components/layout/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const team = await getTeam();
  const teams = await listMyTeams();
  const [capabilities, isAdmin] = await Promise.all([
    currentCapabilities(),
    isInstanceAdmin(),
  ]);

  return (
    <AppShell
      user={user}
      team={team}
      teams={teams}
      capabilities={capabilities}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
