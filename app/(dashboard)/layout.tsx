import { requireUser } from "@/lib/auth";
import { read } from "@/lib/store";
import { AppShell } from "@/components/layout/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const data = read();
  const team = data.teams[0];
  const server = data.servers[0] ?? null;

  return (
    <AppShell user={user} team={team} server={server}>
      {children}
    </AppShell>
  );
}
