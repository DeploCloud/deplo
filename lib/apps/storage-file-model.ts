export type StorageFileState =
  "text" | "new" | "folder" | "binary" | "too-large";

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
