"use client";

import { LoadingText } from "@/components/apps/settings/settings-loading";
import * as React from "react";
import { useRouter } from "@/lib/nav";
import { ArrowRightLeft, Boxes, Server as ServerIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
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
import { FailoverNote } from "@/components/storage/database-failover";

type MoveServer = {
  id: string;
  name: string;
  isDeploHost: boolean;
  /** A cluster: the move lets its leader pick the server. */
  kind?: "cluster";
};
type OnCluster = { id: string; name: string; serverName: string };

export function AppServerCard({
  appId,
  name,
  serverId,
  servers,
  neighbours,
  cluster,
}: {
  appId: string;
  name: string;
  serverId: string;
  servers: MoveServer[];
  neighbours: string[];
  cluster?: OnCluster | null;
}) {
  return (
    <ServerMoveCard
      cluster={cluster ?? undefined}
      name={name}
      serverId={serverId}
      servers={servers}
      neighbours={neighbours}
      verb="Redeploys"
      docs="storage.move"
      successMessage={`Moving ${name}`}
      move={(to) =>
        servers.find((s) => s.id === to)?.kind === "cluster"
          ? gqlAction(
              `mutation($id: String!, $clusterId: String!) { moveAppToCluster(id: $id, clusterId: $clusterId) { id } }`,
              { id: appId, clusterId: to },
            )
          : gqlAction(
              `mutation($id: String!, $serverId: String!) { moveAppToServer(id: $id, serverId: $serverId) { id } }`,
              { id: appId, serverId: to },
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
  failover,
}: {
  db: DatabaseDTO;
  servers: MoveServer[];
  disabled: boolean;
  cluster?: OnCluster | null;
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
      successMessage="Database moved"
      onClusterNote={failover ? <FailoverNote {...failover} /> : undefined}
      move={(to) =>
        servers.find((s) => s.id === to)?.kind === "cluster"
          ? gqlAction(
              `mutation($id: String!, $clusterId: String!) { moveDatabaseToCluster(id: $id, clusterId: $clusterId) { id } }`,
              { id: db.id, clusterId: to },
            )
          : gqlAction(
              `mutation($id: String!, $input: UpdateDatabaseInput!) { updateDatabase(id: $id, input: $input) { id } }`,
              {
                id: db.id,
                input: {
                  exposedPublicly: db.exposedPublicly,
                  exposedPort: db.exposedPublicly ? db.exposedPort : null,
                  serverId: to,
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
  onClusterNote,
}: {
  disabled?: boolean;
  cluster?: OnCluster;
  /** Shown in the dialog while the picked target is a cluster. */
  onClusterNote?: React.ReactNode;
  name: string;
  serverId: string;
  servers: MoveServer[];
  neighbours?: string[];
  verb: "Redeploys" | "Restarts";
  docs: DocsTopic;
  successMessage: string;
  move: (serverId: string) => Promise<ActionResult<unknown>>;
}) {
  const router = useRouter();
  const selectId = React.useId();
  const targets = servers.filter(
    (s) => s.id !== serverId && s.id !== cluster?.id,
  );
  const [target, setTarget] = React.useState("");
  const current = servers.find((s) => s.id === serverId);
  const currentName =
    cluster?.serverName ?? current?.name ?? "its current server";

  if (targets.length === 0) return null;

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
              {cluster ? (
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
        </div>
        <ConfirmAction
          trigger={
            <Button variant="outline" size="sm" disabled={disabled}>
              <ArrowRightLeft className="size-4" />
              Move
            </Button>
          }
          onOpenChange={(open) =>
            setTarget(open && targets.length === 1 ? targets[0].id : "")
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
                  {targets.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2">
                        {s.kind === "cluster" ? (
                          <Boxes className="size-4 text-muted-foreground" />
                        ) : (
                          <ServerIcon className="size-4 text-muted-foreground" />
                        )}
                        {s.name}
                        {s.kind === "cluster" ? (
                          <Badge variant="outline">Cluster</Badge>
                        ) : (
                          <ServerRoleHint isDeploHost={s.isDeploHost} />
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {targets.find((s) => s.id === target)?.kind === "cluster" &&
                onClusterNote}
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
            const res = await move(target);
            if (res.ok) router.refresh();
            return res;
          }}
        />
      </CardContent>
    </Card>
  );
}
