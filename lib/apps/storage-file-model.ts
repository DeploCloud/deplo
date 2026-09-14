// StorageFileState mirrors `AppStorageFile.state`: what the agent found at the path.
export type StorageFileState =
  "text" | "new" | "folder" | "binary" | "too-large";

// StorageFileDraft is one File entry's content, as the Storage form holds it.
export interface StorageFileDraft {
  path: string;
  status: "loading" | "editable" | "blocked" | "error";
  saved: string;
  draft: string;
  exists: boolean;
  message: string;
}

const BLOCKED_MESSAGE: Record<"folder" | "binary" | "too-large", string> = {
  folder: "This path is a folder, not a file. It stays mounted as it is.",
  binary:
    "This file isn't text, so it can't be edited here. It stays mounted as it is.",
  "too-large":
    "This file is too big to edit here (1 MiB max). It stays mounted as it is.",
};

// storageFileDraft turns the server's answer into what the editor shows.
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
      : "This path can't be written from here. It stays mounted as it is.",
  };
}

// loadingFileDraft is the placeholder while a read is in flight.
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

// unpathedFileDraft is what the box holds before the entry names a file.
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

// failedFileDraft is a read that failed for a real reason.
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

// fileDraftIsDirty reports whether this entry has content the user hasn't saved yet.
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

// pendingFileWrite is what the save must write to `path`, or null to leave it alone.
export function pendingFileWrite(
  draft: StorageFileDraft | undefined,
  path: string,
): string | null {
  if (!path) return null;
  if (!draft || draft.path !== path) return null;
  if (draft.status !== "editable") return null;
  if (draft.exists && draft.draft === draft.saved) return null;
  return draft.draft;
}
