"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { ChevronLeft, Network, Server as ServerIcon } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";

import { UNGROUP_DROP_ID } from "@/components/apps/apps-grid/folder-trail";
import { SortableItem } from "@/components/apps/apps-grid/sortable-item";
import { DragStack, DRAG_DROP_ANIMATION } from "@/components/shared/drag-stack";
import { EmptyState } from "@/components/shared/empty-state";
import { countBy, teamFacetOptions } from "@/components/shared/facet-filtering";
import { useUrlFacets } from "@/components/shared/filter-facet";
import type { ListView } from "@/components/shared/view-toggle";
import {
  JoinClusterConfirm,
  MakeLeaderConfirm,
  joinCluster,
  type LeaderOption,
} from "@/components/servers/cluster-actions";
import {
  ClusterCard,
  type ClusterCardData,
} from "@/components/servers/cluster-card";
import { serversHref } from "@/components/servers/cluster-join";
import { RemoveMemberDialog } from "@/components/servers/cluster-member-actions";
import type { TeamOption } from "@/components/servers/server-team-access";
import {
  SERVER_FACETS,
  ServersToolbar,
  filterServers,
  gridClass,
} from "@/components/servers/servers-toolbar";
import { cn } from "@/lib/utils";
import { ServerCard, type ServerCardData } from "./server-card";

// Cards stay where they are while one is dragged: a server has no order to change, only a cluster to join.
const still = () => null;

/** The servers the grid lists: outside a search, the ones in a cluster are found inside it. */
export function listedServers(
  servers: ServerCardData[],
  inCluster: boolean,
  filtering: boolean,
): ServerCardData[] {
  return inCluster || filtering ? servers : servers.filter((s) => !s.cluster);
}

function ServersTrail({
  name,
  view,
  dragging,
  actions,
}: {
  name: string;
  view: ListView;
  dragging: boolean;
  actions?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUP_DROP_ID });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md px-1 py-1 transition-colors",
        dragging && "ring-dashed ring-1 ring-border",
        isOver && "bg-primary-wash-strong ring-1 ring-primary/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <Link
          href={serversHref({ view })}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Servers
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <span className="font-medium">{name}</span>
      </div>
      {dragging && (
        <span className="ml-1 text-xs text-muted-foreground">
          {isOver
            ? "Release to remove it from the cluster"
            : "drop here to remove it from the cluster"}
        </span>
      )}
      {actions && <div className="ml-auto">{actions}</div>}
    </div>
  );
}

export function ServersGrid({
  servers,
  clusters,
  teams,
  openCluster,
  view,
  panel,
  bar,
  leaderChoices = [],
}: {
  /** Every server at the top level; inside a cluster, its servers. */
  servers: ServerCardData[];
  /** The cluster cards of the top level; none inside a cluster. */
  clusters: ClusterCardData[];
  teams: TeamOption[];
  openCluster: { id: string; name: string } | null;
  view: ListView;
  /** The open cluster's warnings, above its servers. */
  panel?: React.ReactNode;
  /** The open cluster's own controls, beside its trail. */
  bar?: React.ReactNode;
  /** Where the open cluster's leader may run. */
  leaderChoices?: LeaderOption[];
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = useUrlFacets(SERVER_FACETS);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);
  const [moving, startMove] = React.useTransition();
  const [movingId, setMovingId] = React.useState<string | null>(null);
  const [joinAsk, setJoinAsk] = React.useState<{
    serverId: string;
    clusterId: string;
  } | null>(null);
  const [joinOpen, setJoinOpen] = React.useState(false);
  const [removeId, setRemoveId] = React.useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [leaderAsk, setLeaderAsk] = React.useState<LeaderOption | null>(null);
  const [leaderOpen, setLeaderOpen] = React.useState(false);

  const q = query.trim().toLowerCase();
  const faceted = picked.team.length > 0 || picked.use.length > 0;
  const pool = listedServers(
    servers,
    openCluster !== null,
    q !== "" || faceted,
  );
  const shown = filterServers(pool, {
    query,
    teams: picked.team,
    uses: picked.use,
  });
  const shownClusters = faceted
    ? []
    : clusters.filter((c) => !q || c.name.toLowerCase().includes(q));
  const clusterIds = React.useMemo(
    () => new Set(clusters.map((c) => c.id)),
    [clusters],
  );
  const byId = new Map(servers.map((s) => [s.id, s]));

  const dragging = activeId !== null;
  const active = activeId ? (byId.get(activeId) ?? null) : null;
  const overCluster = overId !== null && clusterIds.has(overId);

  function optionFor(serverId: string, clusterId: string) {
    return clusters
      .find((c) => c.id === clusterId)
      ?.joinOptions.find((o) => o.serverId === serverId);
  }

  async function join(serverId: string, clusterId: string) {
    const cluster = clusters.find((c) => c.id === clusterId);
    const res = await joinCluster(clusterId, serverId);
    if (res.ok) {
      toast.success(
        res.data ??
          `${byId.get(serverId)?.name ?? "The server"} joined ${cluster?.name}`,
      );
      router.refresh();
    }
    return res;
  }

  // A server that runs something only moves once the person says so: its Apps move into the cluster with it.
  function requestJoin(serverId: string, clusterId: string) {
    const option = optionFor(serverId, clusterId);
    if (!option) return;
    if (option.blocked) return void toast.error(option.blocked);
    if (option.apps + option.databases > 0) {
      setJoinAsk({ serverId, clusterId });
      setJoinOpen(true);
      return;
    }
    setMovingId(serverId);
    startMove(async () => {
      const res = await join(serverId, clusterId);
      if (!res.ok) toast.error(res.error);
    });
  }

  function requestRemove(serverId: string) {
    setRemoveId(serverId);
    setRemoveOpen(true);
  }

  const canDrag = (s: ServerCardData) =>
    openCluster ? s.member?.emptying === "idle" : !s.cluster;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // A server lands on a cluster or on the trail, never on another server.
  const collisionDetection = React.useCallback<CollisionDetection>(
    (args) => {
      const targets = args.droppableContainers.filter(
        (c) => clusterIds.has(String(c.id)) || c.id === UNGROUP_DROP_ID,
      );
      const scoped = { ...args, droppableContainers: targets };
      // The keyboard has no pointer to be within anything.
      return args.pointerCoordinates
        ? pointerWithin(scoped)
        : closestCenter(scoped);
    },
    [clusterIds],
  );

  function onDragOver(event: DragOverEvent) {
    const next = event.over ? String(event.over.id) : null;
    setOverId((prev) => (prev === next ? prev : next));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setOverId(null);
    if (!event.over) return;
    const a = String(event.active.id);
    const o = String(event.over.id);
    if (o === UNGROUP_DROP_ID) requestRemove(a);
    else if (clusterIds.has(o)) requestJoin(a, o);
  }

  function onView(next: ListView) {
    const params = new URLSearchParams(window.location.search);
    if (next === "list") params.set("view", "list");
    else params.delete("view");
    const s = params.toString();
    router.replace(s ? `/settings/servers?${s}` : "/settings/servers", {
      scroll: false,
    });
  }

  const moveTargets = (s: ServerCardData) =>
    clusters.map((c) => ({
      id: c.id,
      name: c.name,
      blocked: optionFor(s.id, c.id)?.blocked ?? "",
    }));

  const joinOption = joinAsk
    ? optionFor(joinAsk.serverId, joinAsk.clusterId)
    : undefined;
  const joinTarget = joinAsk
    ? clusters.find((c) => c.id === joinAsk.clusterId)
    : undefined;
  const removing = removeId ? byId.get(removeId) : undefined;

  return (
    <div className="space-y-5">
      {servers.length + clusters.length > 1 && (
        <ServersToolbar
          query={query}
          onQuery={setQuery}
          view={view}
          onView={onView}
          teams={teamFacetOptions(pool.map((s) => s.teams))}
          useCounts={countBy(pool, (s) => s.use)}
          picked={picked}
          onPick={setPicked}
        />
      )}

      <DndContext
        id="dnd-servers-grid"
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          setOverId(null);
        }}
      >
        <div className="space-y-6">
          {openCluster && (
            <ServersTrail
              name={openCluster.name}
              view={view}
              dragging={dragging}
              actions={bar}
            />
          )}
          {panel}
          {shownClusters.length > 0 && (
            <SortableContext
              items={shownClusters.map((c) => c.id)}
              strategy={still}
            >
              <div className={gridClass(view)}>
                {shownClusters.map((c) => (
                  <SortableItem
                    key={c.id}
                    id={c.id}
                    dragging={dragging}
                    dropOnly
                    dataKind="cluster"
                  >
                    {({ dragActive, isOver }) => (
                      <ClusterCard
                        cluster={c}
                        teams={teams}
                        view={view}
                        dragActive={dragActive}
                        dropActive={isOver && dragging}
                      />
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableContext>
          )}
          {shown.length > 0 ? (
            <SortableContext items={shown.map((s) => s.id)} strategy={still}>
              <div className={gridClass(view)}>
                {shown.map((s) => (
                  <SortableItem
                    key={s.id}
                    id={s.id}
                    dragging={dragging}
                    scaleOut={overCluster}
                    locked={!canDrag(s)}
                    dataKind="server"
                  >
                    {({ handle, dragActive }) => (
                      <ServerCard
                        server={s}
                        view={view}
                        moveTargets={openCluster ? [] : moveTargets(s)}
                        showCluster={!openCluster}
                        dragHandle={canDrag(s) ? handle : undefined}
                        dragActive={dragActive}
                        busy={moving && movingId === s.id}
                        onJoin={(clusterId) => requestJoin(s.id, clusterId)}
                        onRemove={() => requestRemove(s.id)}
                        leaderChoices={leaderChoices}
                        deploMachineOutside={
                          !servers.some((x) => x.isDeploHost)
                        }
                        onMakeLeader={(choice) => {
                          setLeaderAsk(choice);
                          setLeaderOpen(true);
                        }}
                      />
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableContext>
          ) : openCluster && servers.length === 0 ? (
            <EmptyState
              icon={Network}
              title="This cluster has no servers"
              description="Drag a server onto this cluster from Servers, or use Move to cluster in its menu."
            />
          ) : (
            shownClusters.length === 0 && (
              <EmptyState
                icon={ServerIcon}
                title="No matching servers"
                description="No server matches the current search and filter."
              />
            )
          )}
        </div>

        <DragOverlay dropAnimation={DRAG_DROP_ANIMATION}>
          {active ? (
            <DragStack
              count={1}
              className={cn(
                "transition-transform duration-200 ease-out",
                overCluster && "scale-50 opacity-80",
              )}
            >
              <ServerCard server={active} view={view} dragActive />
            </DragStack>
          ) : null}
        </DragOverlay>
      </DndContext>

      {joinAsk && joinOption && joinTarget && (
        <JoinClusterConfirm
          key={`${joinAsk.serverId}:${joinAsk.clusterId}`}
          open={joinOpen}
          onOpenChange={setJoinOpen}
          option={joinOption}
          cluster={joinTarget}
          onJoin={() => join(joinAsk.serverId, joinAsk.clusterId)}
        />
      )}
      {openCluster && leaderAsk && (
        <MakeLeaderConfirm
          key={leaderAsk.serverId}
          clusterId={openCluster.id}
          choice={leaderAsk}
          servers={servers.length}
          open={leaderOpen}
          onOpenChange={setLeaderOpen}
        />
      )}
      {removing?.cluster && removing.member && (
        <RemoveMemberDialog
          key={removing.id}
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          clusterId={removing.cluster.id}
          clusterName={removing.cluster.name}
          serverId={removing.id}
          serverName={removing.name}
          held={removing.member.held}
          memberCount={removing.cluster.servers}
        />
      )}
    </div>
  );
}
