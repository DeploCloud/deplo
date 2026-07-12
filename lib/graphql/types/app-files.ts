import { builder } from "../builder";
import {
  appFilesExist,
  listAppFiles,
  readAppFile,
  writeAppFile,
  uploadAppFile,
  createAppDir,
  deleteAppFile,
  renameAppFile,
  type FileEntry,
  type FileContent,
} from "@/lib/data/app-files";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const FileEntryRef = builder.objectRef<FileEntry>("FileEntry").implement({
  description:
    "One entry in an app's files directory (the on-disk /data/stacks/files/<slug> tree).",
  fields: (t) => ({
    // Path relative to the app files root (POSIX, no leading slash). It is
    // the stable handle every other op takes, so expose it as the id too.
    path: t.exposeString("path"),
    name: t.exposeString("name"),
    kind: t.exposeString("kind"), // "dir" | "file"
    size: t.exposeInt("size"),
    modifiedAt: t.exposeString("modifiedAt"),
  }),
});

const FileContentRef = builder.objectRef<FileContent>("FileContent").implement({
  description: "A project file's text body (null when binary or too large).",
  fields: (t) => ({
    path: t.exposeString("path"),
    text: t.exposeString("text", { nullable: true }),
    size: t.exposeInt("size"),
    // "binary" | "too-large" when text is null; null when text is present.
    reason: t.exposeString("reason", { nullable: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  appFilesExist: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_files" },
    description:
      "Whether the app has an on-disk files directory (drives the Files tab).",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => appFilesExist(appId),
  }),
  appFiles: t.field({
    type: [FileEntryRef],
    authScopes: { capability: "manage_files" },
    description:
      "List the immediate children of a directory in the app files tree " +
      "(the root when path is omitted), directories first.",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: false }),
    },
    resolve: (_r, { appId, path }) =>
      listAppFiles(appId, path ?? ""),
  }),
  appFile: t.field({
    type: FileContentRef,
    authScopes: { capability: "manage_files" },
    description: "Read a single project file's text body.",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, path }) => readAppFile(appId, path),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  writeAppFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Create or overwrite a text file in the app files tree.",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      content: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, path, content }) =>
      writeAppFile(appId, path, content),
  }),
  uploadAppFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Upload a file from a base64 body (used for binary files).",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      base64: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, path, base64 }) =>
      uploadAppFile(appId, path, base64),
  }),
  createAppDir: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Create a new (empty) folder in the app files tree.",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, path }) => createAppDir(appId, path),
  }),
  renameAppFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Rename or move a file/folder within the app files tree.",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      newPath: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, path, newPath }) =>
      renameAppFile(appId, path, newPath),
  }),
  deleteAppFile: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_files" },
    description: "Delete a file or folder (recursively). Returns true.",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, path }) => deleteAppFile(appId, path),
  }),
}));
