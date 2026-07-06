"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Folder,
  File as FileIcon,
  ChevronRight,
  Home,
  Trash2,
  Save,
  Upload,
  FolderPlus,
  FilePlus,
  RotateCw,
  ArrowLeft,
} from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { TextEditor } from "@/components/projects/text-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Browse and edit a project's on-disk files directory
 * (`/data/stacks/files/<slug>`). Everything routes through the GraphQL
 * `projectFile*` operations — all of them sandboxed and `manage_files`-gated on
 * the server — so the client never holds a host path, only a relative one.
 *
 * State is dir-listing + an optionally-open file. Navigating folders refetches
 * the listing; opening a file fetches its text into the editor. Mutations
 * (save / delete / mkdir / rename / upload) refetch the affected listing so the
 * tree stays truthful without a full page reload.
 */

interface FileEntry {
  path: string;
  name: string;
  kind: "dir" | "file";
  size: number;
  modifiedAt: string;
}

interface OpenFile {
  path: string;
  /** Editor text; null while it's a binary/oversized file we can't edit. */
  text: string | null;
  reason: "binary" | "too-large" | null;
  /** The body as last saved/loaded, to detect unsaved edits. */
  saved: string;
}

const LIST = `
  query ProjectFiles($projectId: String!, $path: String) {
    projectFiles(projectId: $projectId, path: $path) {
      path name kind size modifiedAt
    }
  }
`;
const READ = `
  query ProjectFile($projectId: String!, $path: String!) {
    projectFile(projectId: $projectId, path: $path) { path text size reason }
  }
`;
const WRITE = `
  mutation WriteProjectFile($projectId: String!, $path: String!, $content: String!) {
    writeProjectFile(projectId: $projectId, path: $path, content: $content) {
      path name kind size modifiedAt
    }
  }
`;
const UPLOAD = `
  mutation UploadProjectFile($projectId: String!, $path: String!, $base64: String!) {
    uploadProjectFile(projectId: $projectId, path: $path, base64: $base64) { path }
  }
`;
const MKDIR = `
  mutation CreateProjectDir($projectId: String!, $path: String!) {
    createProjectDir(projectId: $projectId, path: $path) { path }
  }
`;
const DELETE = `
  mutation DeleteProjectFile($projectId: String!, $path: String!) {
    deleteProjectFile(projectId: $projectId, path: $path)
  }
`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Join the current directory with a leaf, dropping empty segments. */
function joinPath(dir: string, leaf: string): string {
  return [dir, leaf].filter(Boolean).join("/");
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

export function FileExplorer({ projectId }: { projectId: string }) {
  const [dir, setDir] = React.useState("");
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState<OpenFile | null>(null);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  // null = no dialog; "file" / "folder" = the create-X dialog is open.
  const [creating, setCreating] = React.useState<null | "file" | "folder">(null);
  const [newName, setNewName] = React.useState("");
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Fetch a directory listing. `cancelled` lets the effect ignore a stale
  // response if the user navigates again before it resolves. setState only ever
  // runs in the async `.then`/`.catch` continuations — never synchronously in
  // the effect body — so this stays clear of cascading-render lint.
  const loadDir = React.useCallback(
    (path: string, cancelled?: () => boolean) =>
      gql<{ projectFiles: FileEntry[] }>(LIST, { projectId, path })
        .then((data) => {
          if (cancelled?.()) return;
          setEntries(data.projectFiles);
          setLoading(false);
        })
        .catch((e) => {
          if (cancelled?.()) return;
          toast.error(errMessage(e));
          setLoading(false);
        }),
    [projectId],
  );

  React.useEffect(() => {
    let cancelled = false;
    loadDir(dir, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [dir, loadDir]);

  async function openFile(entry: FileEntry) {
    try {
      const data = await gql<{ projectFile: OpenFile }>(READ, {
        projectId,
        path: entry.path,
      });
      const f = data.projectFile;
      setOpen({ ...f, saved: f.text ?? "" });
      setDraft(f.text ?? "");
    } catch (e) {
      toast.error(errMessage(e));
    }
  }

  async function save() {
    if (!open) return;
    setSaving(true);
    try {
      await gql(WRITE, { projectId, path: open.path, content: draft });
      setOpen({ ...open, text: draft, saved: draft });
      toast.success("Saved");
      loadDir(dir);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: FileEntry) {
    if (
      !window.confirm(
        `Delete ${entry.kind === "dir" ? "folder" : "file"} “${entry.name}”${
          entry.kind === "dir" ? " and everything in it" : ""
        }? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await gql(DELETE, { projectId, path: entry.path });
      if (open?.path === entry.path) setOpen(null);
      toast.success("Deleted");
      loadDir(dir);
    } catch (e) {
      toast.error(errMessage(e));
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const path = joinPath(dir, name);
    try {
      if (creating === "folder") {
        await gql(MKDIR, { projectId, path });
      } else {
        await gql(WRITE, { projectId, path, content: "" });
      }
      toast.success(creating === "folder" ? "Folder created" : "File created");
      setCreating(null);
      setNewName("");
      loadDir(dir);
    } catch (e) {
      toast.error(errMessage(e));
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      // btoa needs a binary string; build it in chunks to avoid a huge spread.
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const base64 = btoa(binary);
      await gql(UPLOAD, {
        projectId,
        path: joinPath(dir, file.name),
        base64,
      });
      toast.success(`Uploaded ${file.name}`);
      loadDir(dir);
    } catch (err) {
      toast.error(errMessage(err));
    }
  }

  const dirty = open !== null && open.text !== null && draft !== open.saved;
  const segments = dir ? dir.split("/") : [];

  // --- File editor view -------------------------------------------------
  if (open) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 text-muted-foreground"
              onClick={() => setOpen(null)}
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <SimpleTooltip content={open.path}>
              <span className="truncate font-mono text-sm">{open.path}</span>
            </SimpleTooltip>
          </div>
          {open.text !== null && (
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              <Save className="size-4" />
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </div>

        {open.text === null ? (
          <EmptyState
            icon={FileIcon}
            title={
              open.reason === "too-large"
                ? "File too large to edit"
                : "Binary file"
            }
            description={
              open.reason === "too-large"
                ? "This file exceeds the 512 KB edit limit. Re-upload it to replace it."
                : "This file isn't text and can't be edited here. Upload a new version to replace it."
            }
          />
        ) : (
          <TextEditor value={draft} onChange={setDraft} minHeight={420} />
        )}
      </div>
    );
  }

  // --- Directory browser view -------------------------------------------
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <button
            className="flex cursor-pointer items-center gap-1 hover:text-foreground"
            onClick={() => setDir("")}
          >
            <Home className="size-4" />
            files
          </button>
          {segments.map((seg, i) => {
            const target = segments.slice(0, i + 1).join("/");
            const isLast = i === segments.length - 1;
            return (
              <React.Fragment key={target}>
                <ChevronRight className="size-3.5" />
                <button
                  className={cn(
                    "cursor-pointer hover:text-foreground",
                    isLast && "text-foreground",
                  )}
                  onClick={() => setDir(target)}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <SimpleTooltip content="Refresh">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true);
                loadDir(dir);
              }}
            >
              <RotateCw className="size-4" />
            </Button>
          </SimpleTooltip>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-4" />
            Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={onUpload}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCreating("folder");
              setNewName("");
            }}
          >
            <FolderPlus className="size-4" />
            Folder
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setCreating("file");
              setNewName("");
            }}
          >
            <FilePlus className="size-4" />
            New file
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-border px-4 py-10 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Folder}
          title="Empty folder"
          description="No files here yet. Upload one or create a new file."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {entries.map((entry, i) => (
            <div
              key={entry.path}
              className={cn(
                "group flex items-center gap-3 px-4 py-2.5 text-sm",
                i !== 0 && "border-t border-border",
              )}
            >
              <button
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                onClick={() =>
                  entry.kind === "dir" ? setDir(entry.path) : openFile(entry)
                }
              >
                {entry.kind === "dir" ? (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {entry.kind === "file" ? formatSize(entry.size) : "—"}
              </span>
              <SimpleTooltip content="Delete">
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => remove(entry)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </SimpleTooltip>
            </div>
          ))}
        </div>
      )}

      {/* Create file / folder dialog */}
      <Dialog
        open={creating !== null}
        onOpenChange={(v) => !v && setCreating(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              New {creating === "folder" ? "folder" : "file"}
            </DialogTitle>
            <DialogDescription>
              Created in{" "}
              <span className="font-mono">{dir ? `files/${dir}` : "files"}</span>
              .
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-entry-name">Name</Label>
            <Input
              id="new-entry-name"
              autoFocus
              value={newName}
              placeholder={
                creating === "folder" ? "config" : "config.toml"
              }
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={!newName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
