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
import { VolumeFields } from "@/components/apps/volume-fields";
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
import type { VolumeMount } from "@/lib/types";
import type { ComposeMount } from "@/lib/apps/compose-storage";
import { gql, gqlAction } from "@/lib/graphql-client";

/**
 * A canonical string for the volume list, ignoring row ids and normalising
 * whitespace/case exactly as a save would, so a saved list matches its snapshot
 * even though the server may re-key the rows.
 */
function volumesKey(vs: VolumeMount[], workdir?: string | null): string {
  return JSON.stringify(
    vs.map((v) => {
      // Hash exactly what the save SENDS, so nothing invisible can arm the
      // unsaved-changes guard: a stored row comes back with `type` absent (the
      // back-compat default), each kind's payload carries only its own source, and an
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

/** How long a path edit rests before Deplo reads that file. */
const READ_DEBOUNCE_MS = 300;

interface StorageFileResult {
  path: string;
  state: string;
  text: string;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

/**
 * Storage settings: persistent volumes mounted into the app's container(s).
 * Writing first (including an empty file the user never typed into) means an entry
 * always has a file.
 */
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
  /** Storage this app's own compose file mounts; read-only here. */
  composeMounts: ComposeMount[];
  /** Compose services this app declares; empty ⇒ single-container (no picker). */
  composeServices: string[];
  /** The service a row with no explicit pick lands on at deploy. */
  defaultComposeService?: string | null;
  /** Whether the viewer may save a Bind (the host-volume grant). */
  canMountHostVolumes: boolean;
  /** Whether the viewer may read and write this app's files (`configure_apps`). */
  canManageFiles: boolean;
  /** Where this app's code runs in its container; null for a prebuilt image. */
  containerWorkdir?: string | null;
}) {
  const router = useRouter();
  const [volumes, setVolumes] = React.useState<VolumeMount[]>(initialVolumes);
  const [pending, startTransition] = React.useTransition();
  const [revealProblems, setRevealProblems] = React.useState(false);
  /** File contents, by row id. A row appears here once its path has been read. */
  const [files, setFiles] = React.useState<Record<string, StorageFileDraft>>(
    {},
  );

  const currentVolumesKey = React.useMemo(
    () => volumesKey(volumes, containerWorkdir),
    [volumes, containerWorkdir],
  );
  const [savedVolumesKey, setSavedVolumesKey] =
    React.useState(currentVolumesKey);

  // Every File entry and the path it names right now - an entry that has not been
  // named yet is IN this list, with an empty path.
  const fileTargets = React.useMemo(
    () =>
      volumes
        .filter((v) => kindOf(v) === "app")
        .map((v) => ({ id: v.id, path: normalizeFilesPath(v.projectPath) })),
    [volumes],
  );
  const targetsKey = JSON.stringify(fileTargets);

  // Refs so the loader effect can read the latest targets/contents without
  // re-running on every keystroke in an unrelated field.
  const targetsRef = React.useRef(fileTargets);
  const filesRef = React.useRef(files);
  React.useEffect(() => {
    targetsRef.current = fileTargets;
    filesRef.current = files;
  });

  /**
   * In-flight reads, so a re-render can't fire the same read twice, and so a read
   * the user has already superseded (they kept typing the path) can tell that it
   * lost and leave the newer answer alone.
   */
  const inFlight = React.useRef(
    new Map<
      string,
      { path: string; token: object; promise: Promise<StorageFileDraft> }
    >(),
  );

  /**
   * Read one entry's file. Resolves to the draft it produced (the save awaits
   * these, so a Save pressed while a read is still in flight still knows whether
   * the file is there). State is only ever set in the async continuations.
   */
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
          // Keyed by the path we ASKED for, not the one the server echoed: every other check
          // (is this draft still for this entry, may the save write it) compares against the
          // entry's current path, so the two must be the same string even if the server
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

  // Read every File entry's path, and re-read it when the path changes. An entry
  // whose read FAILED is left alone - retrying it on every keystroke would hammer an
  // unreachable agent; the editor offers a "Try again" button instead.
  React.useEffect(() => {
    if (!canManageFiles) return;
    const timer = setTimeout(() => {
      for (const t of targetsRef.current) {
        if (!t.path) continue; // not named yet, nothing to read
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
      // Typed before the entry names a file: the text is held with no path, so
      // no read can be tied to it and no write can go anywhere. The read that
      // follows the first path carries it over as the unsaved draft.
      if (!current) return { ...prev, [rowId]: unpathedFileDraft(text) };
      if (current.status !== "editable") return prev;
      return { ...prev, [rowId]: { ...current, draft: text } };
    });
  }

  // Content counts as unsaved work just like a changed path does, otherwise
  // typing a config file and leaving the page would lose it with the Save button
  // still greyed out.
  const contentDirty = fileTargets.some((t) =>
    fileDraftIsDirty(files[t.id], t.path),
  );
  const dirty = currentVolumesKey !== savedVolumesKey || contentDirty;

  function saveVolumes() {
    // The SAME validator the editor rings fields with, so nothing can be typed here
    // that the save then rejects with different words. (The server remains
    // authoritative - this is the snappy first pass, not the boundary.)
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
      // 1. The files, first and one at a time, so a failure names the file it failed on
      // and no row is ever saved pointing at a file that isn't there.
      const written: { id: string; path: string; text: string }[] = [];
      if (canManageFiles) {
        for (const t of targets) {
          // Validation above guarantees every File entry is named by now; the
          // guard stays because writing to "" is the one thing this loop must
          // never do.
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

      // 2. The rows.
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
          // Type-gated, like the dirty key: a name typed for a Volume must not
          // ride along in a Bind row that never showed the field.
          name: kindOf(v) === "named" ? v.name.trim() : "",
          projectPath:
            kindOf(v) === "app" ? normalizeFilesPath(v.projectPath) : undefined,
          hostPath:
            kindOf(v) === "host" ? (v.hostPath ?? "").trim() : undefined,
          // Compose stacks only; the server ignores it elsewhere. Blank ⇒ the
          // stack's default service, resolved at render time.
          service: (v.service ?? "").trim() || undefined,
          // A path the user left empty is DERIVED and sent explicitly, never left to the
          // server to invent: the row is stored with the exact path the editor previewed, so
          // a later change to the app's root directory cannot silently move a mount that is
          mountPath: effectiveMountPath(v, containerWorkdir),
          readOnly: v.readOnly,
          // Host binds only, like hostPath: a propagation left behind by a row
          // that used to be a Bind must not ride along in another kind.
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
        {/**
         * A real form, so Enter in any field saves - `display: contents` keeps Card's own
         * layout untouched.
         */}
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
