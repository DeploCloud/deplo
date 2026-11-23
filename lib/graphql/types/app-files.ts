import { builder } from "../builder";
import {
  writeAppFile,
  readAppStorageFile,
  type StorageFile,
} from "@/lib/data/app-files";
import {
  listAppSetAsideCopies,
  removeAppSetAsideCopy,
  type SetAsideCopyView,
} from "@/lib/data/apps/set-aside";

const StorageFileRef = builder
  .objectRef<StorageFile>("AppStorageFile")
  .implement({
    description:
      "The file behind a File storage entry, where a path that does not exist " +
      "yet is a normal answer rather than an error.",
    fields: (t) => ({
      path: t.exposeString("path"),
      state: t.exposeString("state"),
      text: t.exposeString("text"),
    }),
  });

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

const SetAsideCopyRef = builder
  .objectRef<SetAsideCopyView>("AppSetAsideCopy")
  .implement({
    description:
      "A dated copy of one of the App's volumes, kept on the cluster server that held it when the App moved away: any writes its copy had not sent yet are in it. It stays until removed.",
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      serverName: t.exposeString("serverName"),
      volumeName: t.exposeString("volumeName"),
      of: t.exposeString("of", {
        description: "The volume it is a copy of.",
      }),
      at: t.exposeString("at", {
        description: "When its server came back and set it aside.",
      }),
      bytes: t.exposeFloat("bytes"),
    }),
  });

builder.queryFields((t) => ({
  appSetAsideCopies: t.field({
    type: [SetAsideCopyRef],
    authScopes: { loggedIn: true },
    description:
      "The dated copies cluster servers set aside of the App's volumes when they came back after it moved, newest first.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => listAppSetAsideCopies(appId),
  }),
}));

builder.mutationFields((t) => ({
  removeAppSetAsideCopy: t.field({
    type: "Boolean",
    authScopes: { capability: "delete_backups" },
    description: "Remove one set-aside copy of the App's data, for good.",
    args: {
      appId: t.arg.string({ required: true }),
      serverId: t.arg.string({ required: true }),
      volumeName: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, serverId, volumeName }) =>
      removeAppSetAsideCopy(appId, serverId, volumeName),
  }),
}));
