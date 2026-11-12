"use client";

import { LoadingText } from "@/components/apps/settings/settings-loading";
import * as React from "react";
import { useRouter } from "@/lib/nav";
import {
  ArrowRightLeft,
  Boxes,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DocsLink } from "@/components/ui/docs-link";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { ServerRoleHint } from "@/components/shared/server-role-hint";
import { gqlAction } from "@/lib/graphql-client";
import { joinNames } from "@/lib/utils";
import type { DocsTopic } from "@/lib/docs";
import type { ActionResult } from "@/lib/result";
import type { DatabaseDTO } from "@/lib/data/databases/rows";
import type { FailoverPreview } from "@/lib/data/databases/failover";
import type { ClusterChoice } from "@/lib/data/clusters/member-choice";
import { FailoverNote } from "@/components/storage/database-failover";
import { ClusterAddressNote } from "@/components/shared/cluster-address-note";

/** A picked target: a server, a cluster whose leader picks, or one server of a cluster. */
type Target =
  | { kind: "server"; serverId: string }
  | { kind: "cluster"; clusterId: string; serverId: string | null };

// "s:<server>", "c:<cluster>" or "m:<cluster>:<server>": ids never hold a colon.
function parseTarget(v: string): Target {
  const [k, a = "", b] = v.split(":");
  return k === "s"
    ? { kind: "server", serverId: a }
    : {
        kind: "cluster",
        clusterId: a,
        serverId: k === "m" ? (b ?? null) : null,
      };
}

type MoveServer = {
  id: string;
  name: string;
  isDeploHost: boolean;
  /** A cluster: the move lets its leader pick the server. */
  kind?: "cluster";
};
type OnCluster = {
  id: string;
  name: string;
  serverName: string;
  /** "Waiting for room in eu" while no server of the cluster runs it. */
  waiting?: string | null;
  /** A cluster of ARM and x86 servers: which ones it can fail over to, or that it has none. */
  reach?: { line: string | null; warning: string | null } | null;
};

export function AppServerCard({
  appId,
  name,
  serverId,
  servers,
  neighbours,
  cluster,
  clusters = [],
  addressNote,
}: {
  appId: string;
  name: string;
  serverId: string;
  servers: MoveServer[];
  neighbours: string[];
  cluster?: OnCluster | null;
  clusters?: ClusterChoice[];
  /** Shown once a cluster is picked: no domain of the App is on Cloudflare. */
  addressNote?: string | null;
}) {
  return (
    <ServerMoveCard
      cluster={cluster ?? undefined}
      onClusterNote={
        addressNote ? <ClusterAddressNote note={addressNote} /> : undefined
      }
      name={name}
      serverId={serverId}
      servers={servers}
      neighbours={neighbours}
      verb="Redeploys"
      docs="storage.move"
      clusters={clusters}
      successMessage={`Moving ${name}`}
      move={(to) =>
        to.kind === "cluster"
          ? gqlAction(
              `mutation($id: String!, $clusterId: String!, $serverId: String) { moveAppToCluster(id: $id, clusterId: $clusterId, serverId: $serverId) { id } }`,
              { id: appId, clusterId: to.clusterId, serverId: to.serverId },
            )
          : gqlAction(
              `mutation($id: String!, $serverId: String!) { moveAppToServer(id: $id, serverId: $serverId) { id } }`,
              { id: appId, serverId: to.serverId },
            )
      }
    />
  );
}

export function DatabaseServerCard({
  db,
  servers,
  disabled,
  cluster,
  clusters = [],
  failover,
}: {
  db: DatabaseDTO;
  servers: MoveServer[];
  disabled: boolean;
  cluster?: OnCluster | null;
  clusters?: ClusterChoice[];
  /** What placing it on a cluster would promise, shown once a cluster is picked. */
  failover?: FailoverPreview | null;
}) {
  return (
    <ServerMoveCard
      disabled={disabled}
      cluster={cluster ?? undefined}
      name={db.name}
      serverId={db.serverId}
      servers={servers}
      verb="Restarts"
      docs="databases.move"
      clusters={clusters}
      successMessage="Database moved"
      onClusterNote={failover ? <FailoverNote {...failover} /> : undefined}
      move={(to) =>
        to.kind === "cluster"
          ? gqlAction(
              `mutation($id: String!, $clusterId: String!, $serverId: String) { moveDatabaseToCluster(id: $id, clusterId: $clusterId, serverId: $serverId) { id } }`,
              { id: db.id, clusterId: to.clusterId, serverId: to.serverId },
            )
          : gqlAction(
              `mutation($id: String!, $input: UpdateDatabaseInput!) { updateDatabase(id: $id, input: $input) { id } }`,
              {
                id: db.id,
                input: {
                  exposedPublicly: db.exposedPublicly,
                  exposedPort: db.exposedPublicly ? db.exposedPort : null,
                  serverId: to.serverId,
                },
              },
            )
      }
    />
  );
}

function ServerMoveCard({
  name,
  serverId,
  servers,
  neighbours = [],
  verb,
  docs,
  successMessage,
  move,
  disabled,
  cluster,
  clusters = [],
  onClusterNote,
}: {
  disabled?: boolean;
  cluster?: OnCluster;
  clusters?: ClusterChoice[];
  /** Shown in the dialog while the picked target is a cluster. */
  onClusterNote?: React.ReactNode;
  name: string;
  serverId: string;
  servers: MoveServer[];
  neighbours?: string[];
  verb: "Redeploys" | "Restarts";
  docs: DocsTopic;
  successMessage: string;
  move: (to: Target) => Promise<ActionResult<unknown>>;
}) {
  const router = useRouter();
  const selectId = React.useId();
  const plain = servers.filter(
    (s) => s.kind !== "cluster" && s.id !== serverId,
  );
  // On its cluster already, "any server" would change nothing; one of its other servers still moves it.
  const groups = clusters
    .map((c) => ({ ...c, any: c.id !== cluster?.id }))
    .filter((c) => c.any || c.servers.some((m) => !m.here));
  const pickable = [
    ...plain.map((s) => `s:${s.id}`),
    ...groups.flatMap((c) => [
      ...(c.any ? [`c:${c.id}`] : []),
      ...c.servers
        .filter((m) => !m.here && !m.refusal)
        .map((m) => `m:${c.id}:${m.id}`),
    ]),
  ];
  const [target, setTarget] = React.useState("");
  const current = servers.find((s) => s.id === serverId);
  const currentName =
    cluster?.serverName ?? current?.name ?? "its current server";
  const picked = target ? parseTarget(target) : null;
  const toCluster =
    picked?.kind === "cluster" && picked.clusterId !== cluster?.id;

  // Where a cluster App runs is always said; only the Move button needs somewhere to go.
  if (pickable.length === 0 && !cluster) return null;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
        <div className="min-w-56 flex-1 space-y-1">
          <FieldLabel
            info="Moving copies its data to the new server."
            docs={docs}
          >
            Server
          </FieldLabel>
          <p className="flex items-center gap-2 text-sm">
            <ServerIcon className="size-4 text-muted-foreground" />
            <LoadingText>
              {cluster?.waiting ? (
                cluster.waiting
              ) : cluster ? (
                <>
                  Runs on <strong>{cluster.name}</strong> · now on{" "}
                  {cluster.serverName}
                </>
              ) : (
                <>
                  {currentName}
                  <ServerRoleHint isDeploHost={current?.isDeploHost} />
                </>
              )}
            </LoadingText>
          </p>
          {cluster?.reach?.line && (
            <p className="text-xs text-muted-foreground">
              {cluster.reach.line} <DocsLink topic="clusters.architectures" />
            </p>
          )}
          {cluster?.reach?.warning && (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {cluster.reach.warning}{" "}
                <DocsLink topic="clusters.architectures" />
              </span>
            </p>
          )}
        </div>
        {(plain.length > 0 || groups.length > 0) && (
          <ConfirmAction
            trigger={
              <Button variant="outline" size="sm" disabled={disabled}>
                <ArrowRightLeft className="size-4" />
                Move
              </Button>
            }
            onOpenChange={(open) =>
              setTarget(open && pickable.length === 1 ? pickable[0]! : "")
            }
            title={`Move ${name} to another server?`}
            description={
              <>
                {verb} it on the server you pick and{" "}
                <strong>copies its data across</strong>.
              </>
            }
            consequence={`${name} is offline during the copy. If the copy fails, it stays on ${currentName}.`}
            variant="default"
            confirmLabel="Move"
            confirmDisabled={!target}
            successMessage={successMessage}
            extra={
              <div className="space-y-2">
                <FieldLabel htmlFor={selectId}>Move to</FieldLabel>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id={selectId} className="w-full">
                    <SelectValue placeholder="Pick a server" />
                  </SelectTrigger>
                  <SelectContent>
                    {plain.length > 0 && (
                      <SelectGroup>
                        {groups.length > 0 && (
                          <SelectLabel>Servers</SelectLabel>
                        )}
                        {plain.map((s) => (
                          <SelectItem key={s.id} value={`s:${s.id}`}>
                            <span className="flex items-center gap-2">
                              <ServerIcon className="size-4 text-muted-foreground" />
                              {s.name}
                              <ServerRoleHint isDeploHost={s.isDeploHost} />
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {groups.map((c) => (
                      <SelectGroup key={c.id}>
                        <SelectLabel>Cluster {c.name}</SelectLabel>
                        {c.any && (
                          <SelectItem value={`c:${c.id}`}>
                            <span className="flex items-center gap-2">
                              <Boxes className="size-4 text-muted-foreground" />
                              Any server
                              <Badge variant="outline">The cluster picks</Badge>
                            </span>
                          </SelectItem>
                        )}
                        {c.servers.map((m) => (
                          <SelectItem
                            key={m.id}
                            value={`m:${c.id}:${m.id}`}
                            disabled={m.here || m.refusal !== null}
                          >
                            <span className="flex flex-col items-start gap-0.5">
                              <span className="flex items-center gap-2">
                                <ServerIcon className="size-4 text-muted-foreground" />
                                {m.name}
                                {m.here ? (
                                  <Badge variant="muted">Runs here now</Badge>
                                ) : (
                                  <ServerRoleHint isDeploHost={m.isDeploHost} />
                                )}
                              </span>
                              {m.refusal && !m.here && (
                                <span className="pl-6 text-xs text-muted-foreground">
                                  {m.refusal}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                {toCluster && onClusterNote}
                {picked?.kind === "cluster" && picked.serverId && (
                  <p className="text-xs text-muted-foreground">
                    It stays on cluster{" "}
                    {groups.find((c) => c.id === picked.clusterId)?.name}, and a
                    failover can still move it.{" "}
                    <DocsLink topic="clusters.moveToServer" />
                  </p>
                )}
                {neighbours.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Stops reaching {joinNames(neighbours)} by name:{" "}
                    {neighbours.length === 1 ? "it stays" : "they stay"} on{" "}
                    {currentName}.
                  </p>
                )}
              </div>
            }
            onConfirm={async () => {
              const res = await move(parseTarget(target));
              if (res.ok) router.refresh();
              return res;
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
