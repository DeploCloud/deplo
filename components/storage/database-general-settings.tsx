"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRightLeft, KeyRound, Eye } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CopyButton } from "@/components/shared/copy-button";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * A database's General settings — the ported EditDatabaseDialog body, split
 * into SettingsSection cards: public exposure (+ host port), server location /
 * move, and password rotation. Engine, version, username and db name stay
 * create-only (shown read-only on the Overview).
 */
export function DatabaseGeneralSettings({
  db,
  servers,
  canExposePorts,
}: {
  db: DatabaseDTO;
  servers: { id: string; name: string }[];
  canExposePorts: boolean;
}) {
  return (
    <div className="space-y-6">
      <ExposureCard db={db} servers={servers} canExposePorts={canExposePorts} />
      <RotatePasswordCard db={db} />
    </div>
  );
}

/* Exposure + server move — one reroute either way (the data layer's
   updateDatabase applies both). */
function ExposureCard({
  db,
  servers,
  canExposePorts,
}: {
  db: DatabaseDTO;
  servers: { id: string; name: string }[];
  canExposePorts: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [exposed, setExposed] = React.useState(db.exposedPublicly);
  const [port, setPort] = React.useState(db.exposedPort ? String(db.exposedPort) : "");
  const [serverId, setServerId] = React.useState(db.serverId);
  const [generatingPort, setGeneratingPort] = React.useState(false);

  const parsedPort = Number.parseInt(port, 10);
  const portValid =
    Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535;
  const exposeReady = !exposed || portValid;
  const movingServer = serverId !== db.serverId;
  const canPickServer = servers.length > 1;
  const currentServerName =
    servers.find((s) => s.id === db.serverId)?.name ?? "its server";
  const targetServerName =
    servers.find((s) => s.id === serverId)?.name ?? "the selected server";

  const dirty =
    movingServer ||
    exposed !== db.exposedPublicly ||
    (exposed && parsedPort !== db.exposedPort);
  const saveReady = exposeReady && dirty;

  function generatePort() {
    setGeneratingPort(true);
    startTransition(async () => {
      const res = await gqlAction<{ generateAvailableDbPort: number }, number>(
        `mutation($serverId: ID) { generateAvailableDbPort(serverId: $serverId) }`,
        { serverId },
        (d) => d.generateAvailableDbPort,
      );
      setGeneratingPort(false);
      if (res.ok) setPort(String(res.data));
      else toast.error(res.error);
    });
  }

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateDatabaseInput!) {
          updateDatabase(id: $id, input: $input) { id }
        }`,
        {
          id: db.id,
          input: {
            exposedPublicly: exposed,
            exposedPort: exposed ? parsedPort : null,
            serverId: movingServer ? serverId : null,
          },
        },
      );
      if (res.ok) {
        toast.success(movingServer ? "Database moved" : "Database updated");
        router.refresh();
      } else toast.error(res.error);
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
              <FieldLabel info="The host this database runs on.">Server</FieldLabel>
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
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
                      The database and its data are copied from {currentServerName}{" "}
                      to {targetServerName}. It will be briefly offline while the
                      data volume copies. If the copy fails the move is rolled back
                      and the database stays on {currentServerName}.
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
              <p className="text-xs text-muted-foreground">
                Publish the port to the internet. Keep off unless required.
              </p>
            </div>
            {canExposePorts ? (
              <Switch checked={exposed} onCheckedChange={setExposed} />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Switch checked={exposed} disabled />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  You don&apos;t have permission to publish ports
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {exposed && (
            <div className="space-y-1.5">
              <FieldLabel
                htmlFor="db-port"
                info={
                  <>
                    Port clients connect to. Use a free unprivileged port
                    (1024–65535), or click Generate.
                    {movingServer && " On a move it must be free on the new server too."}
                  </>
                }
              >
                Host port
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="db-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="e.g. 25432"
                  aria-invalid={port !== "" && !portValid}
                  disabled={!canExposePorts}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={generatePort}
                  disabled={generatingPort || pending || !canExposePorts}
                >
                  {generatingPort ? "Finding…" : "Generate"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <DirtyHint dirty={dirty} />
        <Button onClick={save} disabled={pending || !saveReady}>
          {pending
            ? movingServer
              ? "Moving…"
              : "Saving…"
            : movingServer
              ? "Move & save"
              : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/* Password rotation — reveals the NEW connection string once. */
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
          <FieldLabel info="Leave empty to auto-generate a strong password. No quotes, spaces, or URL characters.">
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
              New connection string — shown once, copy it now.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
                {newConn}
              </code>
              <CopyButton value={newConn} />
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={rotate} disabled={!running || pending} variant="outline">
          {pending ? "Rotating…" : "Rotate password"}
        </Button>
      </CardFooter>
    </Card>
  );
}
