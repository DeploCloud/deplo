"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { VolumeFields } from "@/components/services/volume-fields";
import { UnsavedChangesGuard } from "@/components/services/unsaved-changes-guard";
import { DirtyHint } from "@/components/services/settings/settings-shared";
import type { VolumeMount } from "@/lib/types";
import { gqlAction } from "@/lib/graphql-client";

/**
 * A canonical string for the volume list, ignoring row ids and normalising
 * whitespace/case exactly as a save would — so a saved list matches its snapshot
 * even though the server may re-key the rows.
 */
function volumesKey(vs: VolumeMount[]): string {
  return JSON.stringify(
    vs.map((v) => ({
      type: v.type,
      name: v.name.trim().toLowerCase(),
      projectPath: (v.projectPath ?? "").trim(),
      hostPath: (v.hostPath ?? "").trim(),
      mountPath: v.mountPath.trim(),
      readOnly: v.readOnly,
    })),
  );
}

/**
 * Storage settings: persistent named volumes mounted into the container. A
 * single-container feature — a compose stack declares its own volumes in its
 * YAML, so for those we show a note instead of the editor. `isComposeStack` is
 * derived from the service's SAVED source (the deploy source is edited on its own
 * page now), so it reflects what will actually deploy.
 */
export function StorageSettingsForm({
  serviceId,
  slug,
  volumes: initialVolumes,
  isComposeStack,
}: {
  serviceId: string;
  slug: string;
  volumes: VolumeMount[];
  isComposeStack: boolean;
}) {
  const router = useRouter();
  const [volumes, setVolumes] = React.useState<VolumeMount[]>(initialVolumes);
  const [pending, startTransition] = React.useTransition();

  const currentVolumesKey = React.useMemo(() => volumesKey(volumes), [volumes]);
  const [savedVolumesKey, setSavedVolumesKey] = React.useState(currentVolumesKey);
  const volumesDirty = currentVolumesKey !== savedVolumesKey;

  function saveVolumes() {
    // Client-side mirror of the server validation (the server is authoritative).
    // Catch the obvious mistakes before the round-trip for a snappier UX.
    const seenPath = new Set<string>();
    const seenName = new Set<string>();
    for (const v of volumes) {
      const path = v.mountPath.trim();
      if (!path.startsWith("/") || path.length < 2 || /[\s:]/.test(path)) {
        toast.error(`Mount path must be an absolute path with no spaces or ":"`);
        return;
      }
      if (seenPath.has(path)) {
        toast.error(`Duplicate mount path: ${path}`);
        return;
      }
      seenPath.add(path);
      if (v.type === "host") {
        const hostPath = (v.hostPath ?? "").trim();
        if (
          !hostPath.startsWith("/") ||
          hostPath.length < 2 ||
          /[\s:]/.test(hostPath)
        ) {
          toast.error(`Host path must be an absolute path with no spaces or ":"`);
          return;
        }
        continue; // host mounts have no docker name to validate
      }
      if (v.type === "service") {
        const projectPath = (v.projectPath ?? "").trim().replace(/^\.\/+/, "");
        if (projectPath === "" || projectPath.startsWith("/") || /[\s:]/.test(projectPath)) {
          toast.error(
            `Service path must be relative to the files dir, e.g. "config.toml"`,
          );
          return;
        }
        if (projectPath.split("/").includes("..")) {
          toast.error(`Service path must not contain ".."`);
          return;
        }
        continue; // project mounts have no docker name to validate
      }
      const name = v.name.trim().toLowerCase();
      if (name && !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        toast.error(`Volume name "${name}" must be lowercase letters, digits, "-"/"_"`);
        return;
      }
      if (name) {
        if (seenName.has(name)) {
          toast.error(`Duplicate volume name: ${name}`);
          return;
        }
        seenName.add(name);
      }
    }
    const committedVolumesKey = volumesKey(volumes);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $volumes: [VolumeInput!]!) { setServiceVolumes(id: $id, volumes: $volumes) { id } }`,
        {
          id: serviceId,
          volumes: volumes.map((v) => ({
            id: v.id,
            type:
              v.type === "host"
                ? "host"
                : v.type === "service"
                  ? "service"
                  : "named",
            name: v.name.trim(),
            projectPath:
              v.type === "service"
                ? (v.projectPath ?? "").trim().replace(/^\.\/+/, "")
                : undefined,
            hostPath: v.type === "host" ? (v.hostPath ?? "").trim() : undefined,
            mountPath: v.mountPath.trim(),
            readOnly: v.readOnly,
          })),
        },
      );
      if (res.ok) {
        setSavedVolumesKey(committedVolumesKey);
        router.refresh();
        toast.success("Volumes saved — applied on the next production deploy");
      } else toast.error(res.error);
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Volumes</CardTitle>
          <CardDescription>
            Persistent named volumes mounted into your container. Data survives
            redeploys.
          </CardDescription>
        </CardHeader>
        {isComposeStack ? (
          <CardContent>
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              This project deploys a compose stack — declare volumes directly in
              your <code className="font-mono">docker-compose.yml</code>.
            </p>
          </CardContent>
        ) : (
          <>
            <CardContent>
              <VolumeFields slug={slug} volumes={volumes} onChange={setVolumes} />
              <p className="mt-3 text-xs text-muted-foreground">
                Applied on the next production deploy. Removing a row stops
                mounting that volume — its data is never deleted automatically.
              </p>
            </CardContent>
            <CardFooter className="justify-between border-t border-border pt-4">
              <DirtyHint dirty={volumesDirty} />
              <Button size="sm" onClick={saveVolumes} disabled={pending || !volumesDirty}>
                <Save className="size-4" />
                Save volumes
              </Button>
            </CardFooter>
          </>
        )}
      </Card>

      {/* A compose stack has no editable volumes here, so only the single-
          container editor can strand unsaved edits. */}
      <UnsavedChangesGuard when={!isComposeStack && volumesDirty} />
    </>
  );
}
