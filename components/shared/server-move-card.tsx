"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { ArrowRightLeft, Server as ServerIcon } from "lucide-react";
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

type MoveServer = { id: string; name: string; isDeploHost: boolean };

export function AppServerCard({
  appId,
  name,
  serverId,
  servers,
  neighbours,
}: {
  appId: string;
  name: string;
  serverId: string;
  servers: MoveServer[];
  neighbours: string[];
}) {
  return (
    <ServerMoveCard
      name={name}
      serverId={serverId}
      servers={servers}
      neighbours={neighbours}
      verb="Redeploys"
      docs="storage.move"
      successMessage={`Moving ${name}`}
      move={(to) =>
        gqlAction(
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
}: {
  db: DatabaseDTO;
  servers: MoveServer[];
  disabled: boolean;
}) {
  return (
    <ServerMoveCard
      disabled={disabled}
      name={db.name}
      serverId={db.serverId}
      servers={servers}
      verb="Restarts"
      docs="databases.move"
      successMessage="Database moved"
      move={(to) =>
        gqlAction(
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
}: {
  disabled?: boolean;
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
  const targets = servers.filter((s) => s.id !== serverId);
  const [target, setTarget] = React.useState("");
  const current = servers.find((s) => s.id === serverId);
  const currentName = current?.name ?? "its current server";

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
            {currentName}
            <ServerRoleHint isDeploHost={current?.isDeploHost} />
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
                        <ServerIcon className="size-4 text-muted-foreground" />
                        {s.name}
                        <ServerRoleHint isDeploHost={s.isDeploHost} />
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
