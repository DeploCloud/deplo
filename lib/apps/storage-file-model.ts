/**
 * The pure model behind a **File** storage entry's content box: what the server's
 * answer means for the editor, and the one rule that decides whether a save must
 * write the file. No React and no fetching, so it unit-tests directly (the same
 * split as `volume-model` / `resource-limits-model`).
 *
 * The rule is the interesting part. A File entry's content is not a database
 * column — it is the real file under this app's Files, on the app's own server —
 * so the save has to decide, per entry, whether to touch it at all. Three cases
 * matter and each one has bitten somebody:
 *
 *  - **A file that isn't there yet is still written**, even when the user typed
 *    nothing. Docker answers a missing bind source by inventing an empty
 *    DIRECTORY at the mount path, so an entry with no file behind it boots the
 *    app with a folder where its config should be — the one storage mistake that
 *    fails silently.
 *  - **A read is tied to the path it was read for.** Content read for
 *    `config.toml` must never be written to `nginx.conf` because the user edited
 *    the path a moment ago; that would truncate a file nobody looked at.
 *  - **What deplo cannot edit, it does not touch**: a folder, a binary, an
 *    oversized file, or a read that failed. Each one stays mounted exactly as it
 *    is, and the editor says which it is instead of showing an empty box that
 *    would overwrite it.
 */

/** What the agent found at the entry's path. Mirrors `AppStorageFile.state`. */
export type StorageFileState =
  "text" | "new" | "folder" | "binary" | "too-large";

/**
 * One File entry's content, as the Storage form holds it.
 *
 * `path` is the path in Files this content was read for — NOT necessarily the
 * entry's current path. Keeping it here is what lets the form notice a path edit
 * and re-read, and what stops a save from writing to a file it never read.
 */
export interface StorageFileDraft {
  path: string;
  status: "loading" | "editable" | "blocked" | "error";
  /** editable: the body as it is on the server ("" when the file is new). */
  saved: string;
  /** editable: what the user has typed (starts as `saved`). */
  draft: string;
  /** editable: false ⇒ nothing is there yet and the save creates it. */
  exists: boolean;
  /** blocked / error: what to tell the user, in their words. */
  message: string;
}

/** Why a file can't be written from here — stated, never silently ignored. */
const BLOCKED_MESSAGE: Record<"folder" | "binary" | "too-large", string> = {
  folder:
    "This path is a folder in this app's Files, not a file. It stays mounted as it is — open the Files tab to change what's inside it.",
  binary:
    "This file isn't text, so it can't be written here. It stays mounted as it is — replace it from the Files tab.",
  "too-large":
    "This file is too big to edit here (1 MiB max). It stays mounted as it is — edit it from the Files tab.",
};

/**
 * Turn the server's answer into what the editor shows. `keepDraft` carries text
 * the user had already typed: a path edit re-reads the NEW path, and that must
 * never be a way to silently lose what they wrote.
 */
export function storageFileDraft(
  file: { path: string; state: string; text: string },
  keepDraft?: string,
): StorageFileDraft {
  if (file.state === "text" || file.state === "new") {
    return {
      path: file.path,
      status: "editable",
      exists: file.state === "text",
      saved: file.text,
      draft: keepDraft ?? file.text,
      message: "",
    };
  }
  const known = file.state in BLOCKED_MESSAGE;
  return {
    path: file.path,
    status: "blocked",
    exists: true,
    saved: "",
    draft: "",
    message: known
      ? BLOCKED_MESSAGE[file.state as keyof typeof BLOCKED_MESSAGE]
      : "This path can't be written from here. It stays mounted as it is — open the Files tab to change it.",
  };
}

/** The placeholder while a read is in flight. */
export function loadingFileDraft(path: string): StorageFileDraft {
  return {
    path,
    status: "loading",
    saved: "",
    draft: "",
    exists: false,
    message: "",
  };
}

/**
 * What the box holds before the entry names a file. The editor is on screen from
 * the moment a File entry exists — you write the config first and say where it
 * goes after, which is the order people actually work in — so the text needs
 * somewhere to live while there is no path to read or write it at.
 *
 * `path: ""` is what keeps it inert: nothing is read (there is nothing to read),
 * {@link pendingFileWrite} refuses an empty path outright, and the moment the
 * entry IS given a path the form re-reads it and carries this text over as the
 * unsaved draft.
 */
export function unpathedFileDraft(text: string): StorageFileDraft {
  return {
    path: "",
    status: "editable",
    saved: "",
    draft: text,
    exists: false,
    message: "",
  };
}

/** A read that failed for a real reason (an unreachable server, above all). */
export function failedFileDraft(
  path: string,
  message: string,
): StorageFileDraft {
  return {
    path,
    status: "error",
    saved: "",
    draft: "",
    exists: false,
    message,
  };
}

/**
 * Whether this entry has content the user hasn't saved yet — so the Save button
 * lights up for a typed config file exactly as it does for a changed path, and
 * leaving the page warns instead of dropping it.
 */
export function fileDraftIsDirty(
  draft: StorageFileDraft | undefined,
  path: string,
): boolean {
  return (
    draft?.status === "editable" &&
    draft.path === path &&
    draft.draft !== draft.saved
  );
}

/**
 * What the save must write to `path`, or null to leave the file alone. See the
 * module note for why an empty NEW file is still a write.
 */
export function pendingFileWrite(
  draft: StorageFileDraft | undefined,
  path: string,
): string | null {
  if (!path) return null; // typed before the entry named a file — nowhere to put it
  if (!draft || draft.path !== path) return null; // read for another path, or not read
  if (draft.status !== "editable") return null; // a folder, a binary, too big, unreadable
  if (draft.exists && draft.draft === draft.saved) return null; // unchanged
  return draft.draft;
}
