"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "@/lib/nav";
import { Save } from "lucide-react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { VolumeFields } from "@/components/apps/volume-fields/volume-editor";
import { StorageFileEditor } from "@/components/apps/storage-file-editor";
import {
  failedFileDraft,
  fileDraftIsDirty,
  loadingFileDraft,
  pendingFileWrite,
  storageFileDraft,
  unpathedFileDraft,
  type StorageFileDraft,
} from "@/lib/apps/storage-file-model";
import {
  effectiveMountPath,
  kindOf,
  normalizeFilesPath,
  volumeProblem,
  volumeSetProblem,
} from "@/lib/apps/volume-model";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import type { VolumeMount } from "@/lib/types/container";
import type { ComposeMount } from "@/lib/apps/compose-storage";
import { gql, gqlAction } from "@/lib/graphql-client";

function volumesKey(vs: VolumeMount[], workdir?: string | null): string {
  return JSON.stringify(
    vs.map((v) => {
      const kind = kindOf(v);
      return {
        type: kind,
        name: kind === "named" ? v.name.trim().toLowerCase() : "",
        projectPath: kind === "app" ? normalizeFilesPath(v.projectPath) : "",
        hostPath: kind === "host" ? (v.hostPath ?? "").trim() : "",
        service: (v.service ?? "").trim(),
        mountPath: effectiveMountPath(v, workdir),
        readOnly: v.readOnly,
        propagation: kind === "host" ? (v.propagation ?? "") : "",
      };
    }),
  );
}

const READ_FILE = /* GraphQL */ `
  query AppStorageFile($appId: String!, $path: String!) {
    appStorageFile(appId: $appId, path: $path) {
      path
      state
      text
    }
  }
`;

const WRITE_FILE = /* GraphQL */ `
  mutation WriteAppFile($appId: String!, $path: String!, $content: String!) {
    writeAppFile(appId: $appId, path: $path, content: $content)
  }
`;

const SET_VOLUMES = /* GraphQL */ `
  mutation SetAppVolumes($id: String!, $volumes: [VolumeInput!]!) {
    setAppVolumes(id: $id, volumes: $volumes) {
      id
    }
  }
`;

const READ_DEBOUNCE_MS = 300;

interface StorageFileResult {
  path: string;
  state: string;
  text: string;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

export function StorageSettingsForm({
  appId,
  slug,
  volumes: initialVolumes,
  composeMounts,
  composeServices,
  defaultComposeService,
  canMountHostVolumes,
  canManageFiles,
  containerWorkdir,
}: {
  appId: string;
  slug: string;
  volumes: VolumeMount[];
  composeMounts: ComposeMount[];
  composeServices: string[];
  defaultComposeService?: string | null;
  canMountHostVolumes: boolean;
  canManageFiles: boolean;
  containerWorkdir?: string | null;
}) {
  const router = useRouter();
  const [volumes, setVolumes] = React.useState<VolumeMount[]>(initialVolumes);
  const [pending, startTransition] = React.useTransition();
  const [revealProblems, setRevealProblems] = React.useState(false);
  const [files, setFiles] = React.useState<Record<string, StorageFileDraft>>(
    {},
  );

  const currentVolumesKey = React.useMemo(
    () => volumesKey(volumes, containerWorkdir),
    [volumes, containerWorkdir],
  );
  const [savedVolumesKey, setSavedVolumesKey] =
    React.useState(currentVolumesKey);

  const fileTargets = React.useMemo(
    () =>
      volumes
        .filter((v) => kindOf(v) === "app")
        .map((v) => ({ id: v.id, path: normalizeFilesPath(v.projectPath) })),
    [volumes],
  );
  const targetsKey = JSON.stringify(fileTargets);

  const targetsRef = React.useRef(fileTargets);
  const filesRef = React.useRef(files);
  React.useEffect(() => {
    targetsRef.current = fileTargets;
    filesRef.current = files;
  });

  const inFlight = React.useRef(
    new Map<
      string,
      { path: string; token: object; promise: Promise<StorageFileDraft> }
    >(),
  );

  const loadFile = React.useCallback(
    (rowId: string, path: string): Promise<StorageFileDraft> => {
      const running = inFlight.current.get(rowId);
      if (running && running.path === path) return running.promise;
      const token = {};
      const superseded = () => inFlight.current.get(rowId)?.token !== token;
      const promise = gql<{ appStorageFile: StorageFileResult }>(READ_FILE, {
        appId,
        path,
      })
        .then(({ appStorageFile }) => {
          const previous = filesRef.current[rowId];
          const keep =
            previous?.status === "editable" && previous.draft !== previous.saved
              ? previous.draft
              : undefined;
          const next = storageFileDraft({ ...appStorageFile, path }, keep);
          if (!superseded()) setFiles((prev) => ({ ...prev, [rowId]: next }));
          return next;
        })
        .catch((e) => {
          const next = failedFileDraft(path, errMessage(e));
          if (!superseded()) setFiles((prev) => ({ ...prev, [rowId]: next }));
          return next;
        })
        .finally(() => {
          if (!superseded()) inFlight.current.delete(rowId);
        });
      inFlight.current.set(rowId, { path, token, promise });
      return promise;
    },
    [appId],
  );

  React.useEffect(() => {
    if (!canManageFiles) return;
    const timer = setTimeout(() => {
      for (const t of targetsRef.current) {
        if (!t.path) continue;
        const current = filesRef.current[t.id];
        if (current && current.path === t.path) continue;
        void loadFile(t.id, t.path);
      }
    }, READ_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [targetsKey, canManageFiles, loadFile]);

  function setDraft(rowId: string, text: string) {
    setFiles((prev) => {
      const current = prev[rowId];
      if (!current) return { ...prev, [rowId]: unpathedFileDraft(text) };
      if (current.status !== "editable") return prev;
      return { ...prev, [rowId]: { ...current, draft: text } };
    });
  }

  const contentDirty = fileTargets.some((t) =>
    fileDraftIsDirty(files[t.id], t.path),
  );
  const dirty = currentVolumesKey !== savedVolumesKey || contentDirty;

  function saveVolumes() {
    for (const v of volumes) {
      const problem = volumeProblem(v, containerWorkdir);
      if (problem) {
        setRevealProblems(true);
        toast.error(problem.message);
        return;
      }
    }
    const clash = volumeSetProblem(volumes, containerWorkdir);
    if (clash) {
      setRevealProblems(true);
      toast.error(clash);
      return;
    }
    setRevealProblems(false);
    const committedVolumesKey = volumesKey(volumes, containerWorkdir);
    const targets = fileTargets;
    startTransition(async () => {
      const written: { id: string; path: string; text: string }[] = [];
      if (canManageFiles) {
        for (const t of targets) {
          if (!t.path) continue;
          const known = filesRef.current[t.id];
          const file =
            known && known.path === t.path && known.status !== "loading"
              ? known
              : await loadFile(t.id, t.path);
          const content = pendingFileWrite(file, t.path);
          if (content === null) continue;
          const res = await gqlAction(WRITE_FILE, {
            appId,
            path: t.path,
            content,
          });
          if (!res.ok) {
            toast.error(`${t.path}: ${res.error}`);
            return;
          }
          written.push({ id: t.id, path: t.path, text: content });
        }
      }

      const res = await gqlAction(SET_VOLUMES, {
        id: appId,
        volumes: volumes.map((v) => ({
          id: v.id,
          type:
            kindOf(v) === "host"
              ? "host"
              : kindOf(v) === "app"
                ? "service"
                : "named",
          name: kindOf(v) === "named" ? v.name.trim() : "",
          projectPath:
            kindOf(v) === "app" ? normalizeFilesPath(v.projectPath) : undefined,
          hostPath:
            kindOf(v) === "host" ? (v.hostPath ?? "").trim() : undefined,
          service: (v.service ?? "").trim() || undefined,
          mountPath: effectiveMountPath(v, containerWorkdir),
          readOnly: v.readOnly,
          propagation:
            kindOf(v) === "host" ? (v.propagation ?? undefined) : undefined,
        })),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSavedVolumesKey(committedVolumesKey);
      if (written.length > 0) {
        setFiles((prev) => {
          const next = { ...prev };
          for (const w of written) {
            const current = next[w.id];
            if (current?.path !== w.path) continue;
            next[w.id] = { ...current, saved: w.text, exists: true };
          }
          return next;
        });
      }
      router.refresh();
      toast.success(
        written.length === 0
          ? "Storage saved - applied on the next production deploy"
          : `Storage saved, ${written.length === 1 ? "1 file" : `${written.length} files`} written - mounted on the next production deploy`,
      );
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            Mounted storage
            <InfoTip
              content="A Volume is disk space Deplo creates, a File is a config file you write here, a Bind shares a folder already on the server."
              docs="storage.overview"
            />
          </CardTitle>
        </CardHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            saveVolumes();
          }}
        >
          <CardContent>
            <VolumeFields
              slug={slug}
              volumes={volumes}
              composeMounts={composeMounts}
              composeServices={composeServices}
              defaultComposeService={defaultComposeService}
              canMountHostVolumes={canMountHostVolumes}
              containerWorkdir={containerWorkdir}
              revealProblems={revealProblems}
              fileContent={(mount) => {
                const path = normalizeFilesPath(mount.projectPath);
                return (
                  <StorageFileEditor
                    path={path}
                    state={files[mount.id]}
                    canManageFiles={canManageFiles}
                    onChange={(text) => setDraft(mount.id, text)}
                    onRetry={() => {
                      inFlight.current.delete(mount.id);
                      setFiles((prev) => ({
                        ...prev,
                        [mount.id]: loadingFileDraft(path),
                      }));
                      void loadFile(mount.id, path);
                    }}
                  />
                );
              }}
              onChange={setVolumes}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Applied on the next production deploy. Removing an entry stops
              mounting it - the data itself is never deleted automatically, and
              a Volume is included in this app&apos;s backups.
            </p>
          </CardContent>
          <CardFooter className="justify-between border-t border-border pt-4">
            <DirtyHint dirty={dirty} />
            <Button size="sm" type="submit" disabled={pending || !dirty}>
              <Save className="size-4" />
              Save storage
            </Button>
          </CardFooter>
        </form>
      </Card>

      <UnsavedChangesGuard when={dirty} />
    </>
  );
}
