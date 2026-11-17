"use client";

import * as React from "react";
import { toast } from "sonner";
import { Copy, Network, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DocsLink } from "@/components/ui/docs-link";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { SelectionBar } from "@/components/shared/card-selection";
import type { ActionResult } from "@/lib/result";
import { joinCluster } from "./cluster-actions";
import { comesAlong, type ClusterJoinOption } from "./cluster-join";

/** What a bulk action needs to know about a server. */
export interface BulkServer {
  id: string;
  name: string;
  ip: string;
  cluster: { id: string; name: string } | null;
}

export interface BulkJoinPlan {
  joining: ClusterJoinOption[];
  skipped: { name: string; reason: string }[];
}

/** Which of the picked servers can join `cluster`, and why each of the others cannot. */
export function planBulkJoin(
  picked: BulkServer[],
  cluster: { id: string; name: string; joinOptions: ClusterJoinOption[] },
): BulkJoinPlan {
  const plan: BulkJoinPlan = { joining: [], skipped: [] };
  for (const s of picked) {
    const option = cluster.joinOptions.find((o) => o.serverId === s.id);
    if (s.cluster?.id === cluster.id)
      plan.skipped.push({ name: s.name, reason: `already in ${cluster.name}` });
    else if (s.cluster)
      plan.skipped.push({ name: s.name, reason: `in ${s.cluster.name}` });
    else if (!option)
      plan.skipped.push({ name: s.name, reason: "it cannot join a cluster" });
    else if (option.blocked)
      plan.skipped.push({ name: s.name, reason: option.blocked });
    else plan.joining.push(option);
  }
  return plan;
}

/** Runs `step` for each item in turn and says how many went through, naming the first refusal. */
export async function oneByOne<T>(
  items: T[],
  name: (item: T) => string,
  step: (item: T) => Promise<ActionResult<unknown>>,
): Promise<ActionResult<number>> {
  let done = 0;
  let first: string | null = null;
  for (const item of items) {
    const res = await step(item);
    if (res.ok) done++;
    else first ??= `${name(item)}: ${res.error}`;
  }
  if (first)
    return { ok: false, error: `${done} of ${items.length} done. ${first}` };
  return { ok: true, data: done };
}

export function BulkJoinConfirm({
  open,
  onOpenChange,
  cluster,
  plan,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cluster: { id: string; name: string };
  plan: BulkJoinPlan;
  onDone: () => void;
}) {
  const names = plan.joining.map((o) => o.serverName).join(", ");
  const along = comesAlong(
    plan.joining.reduce((n, o) => n + o.apps, 0),
    plan.joining.reduce((n, o) => n + o.databases, 0),
  );
  const n = plan.joining.length;
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      variant="default"
      title={`Move ${n} server${n === 1 ? "" : "s"} into ${cluster.name}?`}
      description={
        <>
          <strong>{names}</strong> join {cluster.name}, one at a time.{" "}
          <DocsLink topic="clusters.overview" />
        </>
      }
      extra={
        <div className="space-y-2 text-sm text-muted-foreground">
          {along && (
            <p>
              {along} on them move into the cluster too, and keep running
              without a restart.
            </p>
          )}
          {plan.skipped.length > 0 && (
            <ul className="space-y-1">
              {plan.skipped.map((s) => (
                <li key={s.name}>
                  <span className="text-foreground">{s.name}</span> stays out:{" "}
                  {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      }
      confirmLabel="Move"
      successMessage={`Moved ${n} server${n === 1 ? "" : "s"} into ${cluster.name}`}
      onConfirm={async () => {
        const res = await oneByOne(
          plan.joining,
          (o) => o.serverName,
          (o) => joinCluster(cluster.id, o.serverId),
        );
        onDone();
        return res;
      }}
    />
  );
}

/** The floating bar over picked servers: what every selection offers, plus the actions of where it is. */
export function ServerSelectionBar({
  picked,
  onSelectAll,
  onClear,
  onCheck,
  children,
}: {
  picked: BulkServer[];
  onSelectAll: () => void;
  onClear: () => void;
  onCheck: (ids: string[]) => void;
  children?: React.ReactNode;
}) {
  function copy() {
    void navigator.clipboard
      .writeText(picked.map((s) => s.ip).join("\n"))
      .then(() =>
        toast.success(
          `Copied ${picked.length} address${picked.length === 1 ? "" : "es"}`,
        ),
      );
  }
  return (
    <SelectionBar
      count={picked.length}
      onSelectAll={onSelectAll}
      onClear={onClear}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onCheck(picked.map((s) => s.id))}
      >
        <RefreshCw className="size-4" />
        Check status
      </Button>
      <Button variant="ghost" size="sm" onClick={copy}>
        <Copy className="size-4" />
        Copy addresses
      </Button>
      {children}
    </SelectionBar>
  );
}

/** Move to cluster, in the bar: one cluster for every picked server. */
export function MoveToClusterButton({
  clusters,
  onPick,
}: {
  clusters: { id: string; name: string }[];
  onPick: (clusterId: string) => void;
}) {
  if (clusters.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <Network className="size-4" />
          Move to cluster
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="top">
        {clusters.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => onPick(c.id)}>
            {c.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
