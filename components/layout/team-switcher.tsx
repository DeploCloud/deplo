"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { gqlAction } from "@/lib/graphql-client";
import { teamSwitchDestination } from "@/lib/team-switch";
import type { TeamIdentity, TeamSummary } from "@/lib/types";

export function TeamSwitcher({
  team,
  teams,
}: {
  team: TeamIdentity;
  teams: TeamSummary[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = React.useTransition();
  const [createOpen, setCreateOpen] = React.useState(false);

  function switchTo(teamId: string) {
    if (teamId === team.id) return;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($teamId: String!) { switchTeam(teamId: $teamId) }`,
        { teamId },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Sections (Variables, Storage, Templates, …) exist in every team, so
      // stay on the open page and let it re-read under the new team; only a
      // page naming one team's App/Database/Project has to be left behind.
      const dest = teamSwitchDestination(pathname);
      // REPLACE, never push: the entry we'd leave behind points at the team we
      // just left, so "back" would land on a page that no longer resolves.
      if (dest !== window.location.pathname + window.location.search) {
        router.replace(dest);
      }
      // Staying put still needs the refresh — it is what re-runs the RSC reads
      // (and the layout) with the new deplo_team cookie.
      router.refresh();
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
            <Avatar className="size-6">
              <AvatarFallback className="bg-foreground text-[10px] text-background">
                {team.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="max-w-40 truncate font-medium">{team.name}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Teams</DropdownMenuLabel>
          {teams.map((t) => (
            <DropdownMenuItem
              key={t.id}
              className="cursor-pointer"
              disabled={pending}
              onSelect={() => switchTo(t.id)}
            >
              <Avatar className="size-5">
                <AvatarFallback className="bg-foreground text-[9px] text-background">
                  {t.name.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="flex flex-col">
                <span className="truncate">{t.name}</span>
                <span className="text-xs capitalize text-muted-foreground">
                  {t.role} · {t.memberCount} member
                  {t.memberCount === 1 ? "" : "s"}
                </span>
              </span>
              {t.id === team.id && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            onSelect={() => setCreateOpen(true)}
          >
            <Plus className="size-4" />
            Create team
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
