import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getTeam, listMyTeams } from "@/lib/data/teams";
import { currentCapabilities, isInstanceAdmin } from "@/lib/membership";
import { getBreadcrumbGraph } from "@/lib/data/breadcrumb";
import { AppShell } from "@/components/layout/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const teams = await listMyTeams();
  // A user can end up with zero teams (their last team was deleted, or they
  // were removed from it). The dashboard needs an active team, so route them
  // to the standalone create-team screen instead of throwing "No active team".
  if (teams.length === 0) redirect("/welcome");
  const team = await getTeam();
  const [capabilities, isAdmin, breadcrumb] = await Promise.all([
    currentCapabilities(),
    isInstanceAdmin(),
    getBreadcrumbGraph(),
  ]);

  return (
    <AppShell
      user={user}
      team={team}
      teams={teams}
      breadcrumb={breadcrumb}
      capabilities={capabilities}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
