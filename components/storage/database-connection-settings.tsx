"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { ArrowRightLeft, KeyRound, Eye } from "lucide-react";
import { ServerRoleHint } from "@/components/shared/server-role-hint";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyButton } from "@/components/shared/copy-button";
import {
  useDatabaseExposure,
  ExposureSwitch,
  ExposurePortRow,
} from "@/components/storage/database-exposure";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * A database's Connection settings - everything about how clients reach it and
 * authenticate: public exposure (+ host port), server location / move, and
 * password rotation.
 */
export function DatabaseConnectionSettings({
  db,
  servers,
  canExposePorts,
  canConfigure,
}: {
  db: DatabaseDTO;
  servers: { id: string; name: string; isDeploHost: boolean }[];
  canExposePorts: boolean;
  canConfigure: boolean;
}) {
  return (
    <div className="space-y-6">
      <ExposureCard
        db={db}
        servers={servers}
        canExposePorts={canExposePorts}
        canConfigure={canConfigure}
      />
      <RotatePasswordCard db={db} />
    </div>
  );
}

/* Exposure + server move - one reroute either way (the data layer's
   updateDatabase applies both). */
function ExposureCard({
  db,
  servers,
  canExposePorts,
  canConfigure,
}: {
  db: DatabaseDTO;
  servers: { id: string; name: string; isDeploHost: boolean }[];
  canExposePorts: boolean;
  canConfigure: boolean;
}) {
  const exposure = useDatabaseExposure(db);
  const [serverId, setServerId] = React.useState(db.serverId);

  const movingServer = serverId !== db.serverId;
  const canPickServer = servers.length > 1;
  const currentServerName =
    servers.find((s) => s.id === db.serverId)?.name ?? "its server";
  const targetServerName =
    servers.find((s) => s.id === serverId)?.name ?? "the selected server";

  const dirty = movingServer || exposure.dirty;
  const saveReady = exposure.ready && dirty;

  function save() {
    exposure.save({
      serverId: movingServer ? serverId : null,
      success: movingServer ? "Database moved" : "Database updated",
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Network & location</CardTitle>
        <CardDescription>
          Publish the database on a host port, or move it to another server. Any
          save re-applies the database&apos;s current settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canPickServer && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="space-y-2">
              <FieldLabel
                info="The host this database runs on."
                docs="databases.move"
              >
                Server
              </FieldLabel>
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2">
                        {s.name}
                        <ServerRoleHint isDeploHost={s.isDeploHost} />
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {movingServer && (
              <div className="rounded-md border border-border bg-secondary/40 p-3">
                <div className="flex items-start gap-2">
                  <ArrowRightLeft className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="space-y-1 text-xs">
                    <p className="font-medium">
                      Move {db.name} to {targetServerName}
                    </p>
                    <p className="text-muted-foreground">
                      The database and its data are copied from{" "}
                      {currentServerName} to {targetServerName}. It will be
                      briefly offline while the data volume copies. If the copy
                      fails the move is rolled back and the database stays on{" "}
                      {currentServerName}.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Expose publicly</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Publish the port to the internet. Keep off unless required.
              </p>
            </div>
            <ExposureSwitch
              checked={exposure.exposed}
              onCheckedChange={exposure.setExposed}
              canExposePorts={canExposePorts}
              canConfigure={canConfigure}
            />
          </div>
          {exposure.exposed && (
            <ExposurePortRow
              exposure={exposure}
              canExposePorts={canExposePorts}
              canConfigure={canConfigure}
              serverId={serverId}
              extraInfo={
                movingServer &&
                " On a move it must be free on the new server too."
              }
            />
          )}
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <DirtyHint dirty={dirty} />
        <Button
          onClick={save}
          disabled={exposure.pending || !saveReady || !canConfigure}
        >
          {exposure.pending
            ? movingServer
              ? "Moving"
              : "Saving"
            : movingServer
              ? "Move & save"
              : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/* Password rotation - reveals the NEW connection string once. */
function RotatePasswordCard({ db }: { db: DatabaseDTO }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [custom, setCustom] = React.useState("");
  const [newConn, setNewConn] = React.useState<string | null>(null);
  const running = db.status === "running";

  function rotate() {
    startTransition(async () => {
      const res = await gqlAction<{ rotateDatabasePassword: string }, string>(
        `mutation($id: String!, $password: String) { rotateDatabasePassword(id: $id, password: $password) }`,
        { id: db.id, password: custom.trim() || null },
        (d) => d.rotateDatabasePassword,
      );
      if (res.ok && res.data) {
        setNewConn(res.data);
        setCustom("");
        toast.success("Password rotated");
        router.refresh();
      } else if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-muted-foreground" />
          Rotate password
        </CardTitle>
        <CardDescription>
          Generate a new engine password (or set your own) and re-issue the
          connection string. The database must be running.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <FieldLabel
            info="Leave empty to auto-generate a strong password. No quotes, spaces, or URL characters."
            docs="databases.password"
          >
            New password (optional)
          </FieldLabel>
          <Input
            type="text"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Leave empty to auto-generate"
            disabled={!running || pending}
          />
        </div>
        {newConn && (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Eye className="size-3.5" />
              New connection string - shown once, copy it now.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
                {newConn}
              </code>
              <CopyButton value={newConn} />
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          onClick={rotate}
          disabled={!running || pending}
          variant="outline"
        >
          {pending ? "Rotating" : "Rotate password"}
        </Button>
      </CardFooter>
    </Card>
  );
}
