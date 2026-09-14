"use client";

import * as React from "react";
import { useFlatPathname, useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { ChevronDown, GripVertical, Plus, Settings } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { gqlAction } from "@/lib/graphql-client";
import { teamSwitchDestination } from "@/lib/team-switch";
import { withTeam } from "@/lib/team-path";
import { cn } from "@/lib/utils";
import type { TeamIdentity, TeamSummary } from "@/lib/types/team";

export function TeamSwitcher({
  team,
  teams,
}: {
  team: TeamIdentity;
  teams: TeamSummary[];
}) {
  const router = useRouter();
  const pathname = useFlatPathname();
  const [open, setOpen] = React.useState(false);
  const [, startReorder] = React.useTransition();
  const [draggedIds, setDraggedIds] = React.useState<string[] | null>(null);
  const order = React.useMemo(() => {
    if (!draggedIds) return teams;
    const byId = new Map(teams.map((t) => [t.id, t]));
    const picked = draggedIds
      .map((id) => byId.get(id))
      .filter((t): t is TeamSummary => Boolean(t));
    const seen = new Set(picked.map((t) => t.id));
    return [...picked, ...teams.filter((t) => !seen.has(t.id))];
  }, [teams, draggedIds]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const sortable = order.length > 1;

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = order.findIndex((t) => t.id === active.id);
    const to = order.findIndex((t) => t.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(order, from, to).map((t) => t.id);
    const previous = draggedIds;
    setDraggedIds(next);
    startReorder(async () => {
      const res = await gqlAction(
        `mutation($teamIds: [String!]!) { reorderMyTeams(teamIds: $teamIds) }`,
        { teamIds: next },
      );
      if (res.ok) router.refresh();
      else {
        setDraggedIds(previous);
        toast.error(res.error);
      }
    });
  }
  const [createOpen, setCreateOpen] = React.useState(false);

  function switchTo(target: TeamSummary, to?: string) {
    const dest = withTeam(to ?? teamSwitchDestination(pathname), target.slug);
    if (dest === window.location.pathname + window.location.search) return;
    router.replace(dest);
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
          >
            <TeamAvatar name={team.name} avatarUrl={team.avatarUrl} size="md" />
            <span className="max-w-40 truncate font-medium">{team.name}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Teams</DropdownMenuLabel>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={order.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              {order.map((t) => (
                <TeamRow
                  key={t.id}
                  team={t}
                  active={t.id === team.id}
                  sortable={sortable}
                  onSelect={() => switchTo(t)}
                  onEdit={() => {
                    setOpen(false);
                    switchTo(t, "/settings");
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
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

function TeamRow({
  team,
  active,
  sortable,
  onSelect,
  onEdit,
}: {
  team: TeamSummary;
  active: boolean;
  sortable: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: team.id, disabled: !sortable });

  return (
    <DropdownMenuItem
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group relative cursor-pointer overflow-hidden",
        active && "bg-secondary",
        isDragging && "z-10 opacity-80",
      )}
      onSelect={onSelect}
    >
      {/* Both controls fade rather than mount, so nothing moves under the pointer. */}
      <span className="flex w-full items-center gap-2">
        <TeamAvatar name={team.name} avatarUrl={team.avatarUrl} size="sm" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{team.name}</span>
          <span className="text-xs text-muted-foreground capitalize">
            {team.role} · {team.memberCount} member
            {team.memberCount === 1 ? "" : "s"}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          {sortable && (
            <span
              {...attributes}
              {...listeners}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Reorder ${team.name}`}
              className="cursor-grab text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
            >
              <GripVertical className="size-3.5" />
            </span>
          )}
          {team.canManage && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              aria-label={`Settings for ${team.name}`}
              className={cn(
                "cursor-pointer rounded-sm p-0.5 text-muted-foreground transition-opacity hover:text-foreground",
                !active &&
                  "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
              )}
            >
              <Settings className="size-3" />
            </button>
          )}
        </span>
      </span>
    </DropdownMenuItem>
  );
}
