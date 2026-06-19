import { requireUser } from "@/lib/auth";
import { read } from "@/lib/store";
import { getTeam, listMyTeams } from "@/lib/data/teams";
import { currentCapabilities } from "@/lib/membership";
import { AppShell } from "@/components/layout/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const team = await getTeam();
  const teams = await listMyTeams();
  const capabilities = await currentCapabilities();
  const server = read().servers[0] ?? null;

  return (
    <AppShell
      user={user}
      team={team}
      teams={teams}
      server={server}
      capabilities={capabilities}
    >
      {children}
    </AppShell>
  );
}
