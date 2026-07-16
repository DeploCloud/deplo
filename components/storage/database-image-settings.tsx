"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
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
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { DbVersionInput } from "@/components/storage/db-version-input";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * Expert overrides (Advanced): custom image, custom command, and engine
 * version. All applied on the next Redeploy ("the row is truth"). The escape
 * hatch for experts — the warnings live here, but nothing is blocked.
 */
export function DatabaseImageSettings({ db }: { db: DatabaseDTO }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [version, setVersion] = React.useState(db.version);
  const [customImage, setCustomImage] = React.useState(db.customImage ?? "");
  const [customCommand, setCustomCommand] = React.useState(db.customCommand ?? "");

  const saved = React.useMemo(
    () => JSON.stringify([db.version, db.customImage ?? "", db.customCommand ?? ""]),
    [db.version, db.customImage, db.customCommand],
  );
  const current = JSON.stringify([version.trim(), customImage.trim(), customCommand.trim()]);
  const dirty = current !== saved;

  const redisCommandRisk =
    db.type === "redis" &&
    customCommand.trim() !== "" &&
    !customCommand.includes("--requirepass");

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateDatabaseImageInput!) {
          updateDatabaseImage(id: $id, input: $input) { id }
        }`,
        {
          id: db.id,
          input: {
            version: version.trim() || db.version,
            customImage: customImage.trim() || null,
            customCommand: customCommand.trim() || null,
          },
        },
      );
      if (res.ok) {
        toast.success("Image settings saved — Redeploy to apply");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Image & command</CardTitle>
        <CardDescription>
          Override the engine image or its start command. Changes apply on the
          next <strong className="font-medium text-foreground">Redeploy</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <FieldLabel info="The engine version (image tag) — the real Docker Hub tag list loads as you type. Downgrading across major versions can leave a data volume the new engine can't read.">
            Version
          </FieldLabel>
          {customImage.trim() !== "" ? (
            <>
              <Input value={version} disabled />
              <p className="text-xs text-muted-foreground">
                A custom image is set, so the version tag is ignored.
              </p>
            </>
          ) : (
            <DbVersionInput engine={db.type} value={version} onChange={setVersion} />
          )}
        </div>

        <div className="space-y-1.5">
          <FieldLabel info="A full image reference to run instead of the derived engine image (e.g. timescale/timescaledb:2.15-pg16). Leave empty to use the standard image for this engine + version.">
            Custom image
          </FieldLabel>
          <Input
            value={customImage}
            onChange={(e) => setCustomImage(e.target.value)}
            placeholder={`default: ${db.type} ${db.version}`}
            className="font-mono text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <FieldLabel info="Replaces the container's start command verbatim. Leave empty to use the image default.">
            Custom command
          </FieldLabel>
          <Input
            value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
            placeholder="image default"
            className="font-mono text-xs"
          />
          {redisCommandRisk && (
            <p className="flex items-start gap-1.5 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2 text-xs text-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
              <span>
                This command replaces Redis&apos;s default, which sets{" "}
                <code className="font-mono">--requirepass</code>. Without it the
                database has no password and the stored connection string and
                backups will stop authenticating. Add{" "}
                <code className="font-mono">--requirepass &lt;password&gt;</code>{" "}
                unless you configure auth another way.
              </span>
            </p>
          )}
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <DirtyHint dirty={dirty} />
        <Button onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  );
}
