"use client";

import * as React from "react";
import {
  RenameInput,
  useInlineRename,
  type InlineRename,
} from "@/components/shared/inline-rename";

export const RENAME_APP = `mutation($id: String!, $name: String!) { renameApp(id: $id, name: $name) { id } }`;

const AppRenameContext = React.createContext<InlineRename | null>(null);

// The header's title and its menu are separate slots, so they share the rename here.
export function AppRenameProvider({
  appId,
  name,
  children,
}: {
  appId: string;
  name: string;
  children: React.ReactNode;
}) {
  const rename = useInlineRename(appId, name, RENAME_APP, "App renamed");
  return <AppRenameContext value={rename}>{children}</AppRenameContext>;
}

export function useAppRename(): InlineRename {
  const rename = React.use(AppRenameContext);
  if (!rename) throw new Error("useAppRename needs an AppRenameProvider");
  return rename;
}

export function AppTitle() {
  const rename = useAppRename();
  return rename.editing ? (
    <RenameInput rename={rename} label="App name" />
  ) : (
    rename.name
  );
}
