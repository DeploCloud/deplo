import { builder } from "../builder";
import {
  writeAppFile,
  readAppStorageFile,
  type StorageFile,
} from "@/lib/data/app-files";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const StorageFileRef = builder
  .objectRef<StorageFile>("AppStorageFile")
  .implement({
    description:
      "The file behind a File storage entry, where a path that does not exist " +
      "yet is a normal answer rather than an error.",
    fields: (t) => ({
      path: t.exposeString("path"),
      // "text" | "new" | "folder" | "binary" | "too-large".
      state: t.exposeString("state"),
      // The body; always "" for anything but "text".
      text: t.exposeString("text"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  appStorageFile: t.field({
    type: StorageFileRef,
    authScopes: { capability: "configure_apps" },
    description:
      "Read the file a File storage entry points at (Settings → Storage). " +
      'A path that is not there yet answers state "new" with an empty body ' +
      "instead of failing, so the editor can offer it as a file to write.",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, path }) => readAppStorageFile(appId, path),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  writeAppFile: t.field({
    type: "String",
    authScopes: { capability: "configure_apps" },
    description:
      "Write the file a File storage entry points at. Answers its path.",
    args: {
      appId: t.arg.string({ required: true }),
      path: t.arg.string({ required: true }),
      content: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, path, content }) =>
      writeAppFile(appId, path, content),
  }),
}));
