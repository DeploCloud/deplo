"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, GripVertical, Pencil, Plus } from "lucide-react";
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
import { cn } from "@/lib/utils";
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
  // Controlled only so the pencil can shut it: Radix closes on select, and the
  // pencil deliberately does not select the row.
  const [open, setOpen] = React.useState(false);
  // The reorder gets its OWN transition: sharing `pending` with switchTo dimmed every
  // row to 50% (data-[disabled]:opacity-50) while the mutation and the refresh ran,
  // which is the one thing an optimistic reorder must not do - the list has already
  const [, startReorder] = React.useTransition();
  // What the drag has said so far, as ids - null until somebody drags. Ids the drag
  // never saw (a team joined in another tab) fall in at the end instead of vanishing.
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
  // Distance, so a click that switches team is never swallowed by a drag that
  // was not one. Pointer only: the menu is keyboard-navigable and dragging is
  // not the only way to reach a team.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  // Nothing to arrange with one team, and a handle beside a single row reads as
  // a broken control.
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

  /** `to` overrides where we land - the pencil always wants that team's settings. */
  function switchTo(teamId: string, to?: string) {
    if (teamId === team.id) {
      if (to) router.push(to);
      return;
    }
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
      const dest = to ?? teamSwitchDestination(pathname);
      // REPLACE, never push: the entry we'd leave behind points at the team we
      // just left, so "back" would land on a page that no longer resolves.
      if (dest !== window.location.pathname + window.location.search) {
        router.replace(dest);
      }
      // Staying put still needs the refresh - it is what re-runs the RSC reads
      // (and the layout) with the new deplo_team cookie.
      router.refresh();
    });
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
                  disabled={pending}
                  onSelect={() => switchTo(t.id)}
                  onEdit={() => {
                    setOpen(false);
                    switchTo(t.id, "/settings");
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

/**
 * One team in the switcher, draggable by its handle.
 */
function TeamRow({
  team,
  active,
  sortable,
  disabled,
  onSelect,
  onEdit,
}: {
  team: TeamSummary;
  active: boolean;
  sortable: boolean;
  disabled: boolean;
  onSelect: () => void;
  /** Switch to this team and open its settings. */
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
        // The active team is the row that is already lit, so it needs no mark of
        // its own. Same token the sidebar tints its rows with.
        active && "bg-foreground/10",
        isDragging && "z-10 opacity-80",
      )}
      disabled={disabled}
      onSelect={onSelect}
    >
      {/* The gutter the handle fades into. Reserved rather than uncovered by a
          slide, so the picture and the name never move under the pointer. */}
      <span
        className={cn("flex w-full items-center gap-2", sortable && "pr-5")}
      >
        <TeamAvatar name={team.name} avatarUrl={team.avatarUrl} size="sm" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{team.name}</span>
          <span className="text-xs text-muted-foreground capitalize">
            {team.role} · {team.memberCount} member
            {team.memberCount === 1 ? "" : "s"}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          {team.canManage && (
            <button
              type="button"
              // Same reason as the handle below: this is its own action, not a
              // way of picking the row.
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              aria-label={`Settings for ${team.name}`}
              className="cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
          )}
        </span>
      </span>
      {sortable && (
        <span
          {...attributes}
          {...listeners}
          // The handle drags; it must never also switch team - and stopping the CLICK is the
          // whole of what that takes.
          onClick={(e) => e.stopPropagation()}
          aria-label={`Reorder ${team.name}`}
          className="absolute right-1 cursor-grab text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </span>
      )}
    </DropdownMenuItem>
  );
}
