import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { UpdateBanner } from "./update-banner";
import type { PublicUser, Server, Team } from "@/lib/types";

export function AppShell({
  user,
  team,
  server,
  children,
}: {
  user: PublicUser;
  team: Team;
  server: Server | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full">
      <Sidebar server={server} />

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} team={team} />
        <UpdateBanner />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-345">{children}</div>
        </main>
      </div>
    </div>
  );
}
