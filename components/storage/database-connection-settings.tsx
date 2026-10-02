"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { KeyRound, Eye } from "lucide-react";
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
import { CopyButton } from "@/components/shared/copy-button";
import {
  useDatabaseExposure,
  ExposureSwitch,
  ExposurePortRow,
} from "@/components/storage/database-exposure";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases/rows";

export function DatabaseConnectionSettings({
  db,
  canExposePorts,
  canConfigure,
}: {
  db: DatabaseDTO;
  canExposePorts: boolean;
  canConfigure: boolean;
}) {
  return (
    <div className="space-y-6">
      <ExposureCard
        db={db}
        canExposePorts={canExposePorts}
        canConfigure={canConfigure}
      />
      <RotatePasswordCard db={db} />
    </div>
  );
}

function ExposureCard({
  db,
  canExposePorts,
  canConfigure,
}: {
  db: DatabaseDTO;
  canExposePorts: boolean;
  canConfigure: boolean;
}) {
  const exposure = useDatabaseExposure(db);
  const saveReady = exposure.ready && exposure.dirty;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Network</CardTitle>
        <CardDescription>
          Publish the database on a host port. Any save re-applies the
          database&apos;s current settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
              serverId={db.serverId}
            />
          )}
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <DirtyHint dirty={exposure.dirty} />
        <Button
          onClick={() => exposure.save()}
          disabled={exposure.pending || !saveReady || !canConfigure}
        >
          {exposure.pending ? "Saving" : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  );
}

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
            <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
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
