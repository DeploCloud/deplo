import { builder } from "../builder";
import {
  serviceFilesExist,
  listServiceFiles,
  readServiceFile,
  writeServiceFile,
  uploadServiceFile,
  createServiceDir,
  deleteServiceFile,
  renameServiceFile,
  type FileEntry,
  type FileContent,
} from "@/lib/data/service-files";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const FileEntryRef = builder.objectRef<FileEntry>("FileEntry").implement({
  description:
    "One entry in a service's files directory (the on-disk /data/stacks/files/<slug> tree).",
  fields: (t) => ({
    // Path relative to the service files root (POSIX, no leading slash). It is
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
  serviceFilesExist: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_files" },
    description:
      "Whether the service has an on-disk files directory (drives the Files tab).",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => serviceFilesExist(serviceId),
  }),
  serviceFiles: t.field({
    type: [FileEntryRef],
    authScopes: { capability: "manage_files" },
    description:
      "List the immediate children of a directory in the service files tree " +
      "(the root when path is omitted), directories first.",
    args: {
      serviceId: t.arg.string({ required: true }),
      path: t.arg.string({ required: false }),
    },
    resolve: (_r, { serviceId, path }) =>
      listServiceFiles(serviceId, path ?? ""),
  }),
  serviceFile: t.field({
    type: FileContentRef,
    authScopes: { capability: "manage_files" },
    description: "Read a single project file's text body.",
    args: {
      serviceId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { serviceId, path }) => readServiceFile(serviceId, path),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  writeServiceFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Create or overwrite a text file in the service files tree.",
    args: {
      serviceId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      content: t.arg.string({ required: true }),
    },
    resolve: (_r, { serviceId, path, content }) =>
      writeServiceFile(serviceId, path, content),
  }),
  uploadServiceFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Upload a file from a base64 body (used for binary files).",
    args: {
      serviceId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      base64: t.arg.string({ required: true }),
    },
    resolve: (_r, { serviceId, path, base64 }) =>
      uploadServiceFile(serviceId, path, base64),
  }),
  createServiceDir: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Create a new (empty) folder in the service files tree.",
    args: {
      serviceId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { serviceId, path }) => createServiceDir(serviceId, path),
  }),
  renameServiceFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Rename or move a file/folder within the service files tree.",
    args: {
      serviceId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      newPath: t.arg.string({ required: true }),
    },
    resolve: (_r, { serviceId, path, newPath }) =>
      renameServiceFile(serviceId, path, newPath),
  }),
  deleteServiceFile: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_files" },
    description: "Delete a file or folder (recursively). Returns true.",
    args: {
      serviceId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { serviceId, path }) => deleteServiceFile(serviceId, path),
  }),
}));
