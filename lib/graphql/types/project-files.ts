import { builder } from "../builder";
import {
  projectFilesExist,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
  uploadProjectFile,
  createProjectDir,
  deleteProjectFile,
  renameProjectFile,
  type FileEntry,
  type FileContent,
} from "@/lib/data/project-files";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const FileEntryRef = builder.objectRef<FileEntry>("FileEntry").implement({
  description:
    "One entry in a project's files directory (the on-disk /data/stacks/files/<slug> tree).",
  fields: (t) => ({
    // Path relative to the project files root (POSIX, no leading slash). It is
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
  projectFilesExist: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_files" },
    description:
      "Whether the project has an on-disk files directory (drives the Files tab).",
    args: { projectId: t.arg.string({ required: true }) },
    resolve: (_r, { projectId }) => projectFilesExist(projectId),
  }),
  projectFiles: t.field({
    type: [FileEntryRef],
    authScopes: { capability: "manage_files" },
    description:
      "List the immediate children of a directory in the project files tree " +
      "(the root when path is omitted), directories first.",
    args: {
      projectId: t.arg.string({ required: true }),
      path: t.arg.string({ required: false }),
    },
    resolve: (_r, { projectId, path }) =>
      listProjectFiles(projectId, path ?? ""),
  }),
  projectFile: t.field({
    type: FileContentRef,
    authScopes: { capability: "manage_files" },
    description: "Read a single project file's text body.",
    args: {
      projectId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { projectId, path }) => readProjectFile(projectId, path),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  writeProjectFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Create or overwrite a text file in the project files tree.",
    args: {
      projectId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      content: t.arg.string({ required: true }),
    },
    resolve: (_r, { projectId, path, content }) =>
      writeProjectFile(projectId, path, content),
  }),
  uploadProjectFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Upload a file from a base64 body (used for binary files).",
    args: {
      projectId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      base64: t.arg.string({ required: true }),
    },
    resolve: (_r, { projectId, path, base64 }) =>
      uploadProjectFile(projectId, path, base64),
  }),
  createProjectDir: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Create a new (empty) folder in the project files tree.",
    args: {
      projectId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { projectId, path }) => createProjectDir(projectId, path),
  }),
  renameProjectFile: t.field({
    type: FileEntryRef,
    authScopes: { capability: "manage_files" },
    description: "Rename or move a file/folder within the project files tree.",
    args: {
      projectId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      newPath: t.arg.string({ required: true }),
    },
    resolve: (_r, { projectId, path, newPath }) =>
      renameProjectFile(projectId, path, newPath),
  }),
  deleteProjectFile: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_files" },
    description: "Delete a file or folder (recursively). Returns true.",
    args: {
      projectId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { projectId, path }) => deleteProjectFile(projectId, path),
  }),
}));
