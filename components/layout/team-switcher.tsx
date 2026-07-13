"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import type { Team, TeamSummary } from "@/lib/types";

export function TeamSwitcher({
  team,
  teams,
}: {
  team: Team;
  teams: TeamSummary[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [createOpen, setCreateOpen] = React.useState(false);

  function switchTo(teamId: string) {
    if (teamId === team.id) return;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($teamId: String!) { switchTeam(teamId: $teamId) }`,
        { teamId },
      );
      if (res.ok) {
        router.push("/");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
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
              onSelect={(e) => {
                e.preventDefault();
                switchTo(t.id);
              }}
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
