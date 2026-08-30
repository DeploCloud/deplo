// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One short phrase for what a token reaches, from its three id lists.
 */
export function scopeLabel(
  token: {
    scoped: boolean;
    teamIds: string[];
    projectIds: string[];
    folderIds: string[];
    appIds: string[];
  },
  names: Record<string, string> = {},
): { text: string; empty: boolean } {
  if (!token.scoped) return { text: "Everything I can access", empty: false };

  const total =
    token.teamIds.length +
    token.projectIds.length +
    token.folderIds.length +
    token.appIds.length;
  // Every node it named has been deleted: it reaches nothing and no longer
  // authenticates at all, which is worth saying out loud rather than showing a
  // blank cell.
  if (total === 0) return { text: "Nothing left", empty: true };

  if (total === 1) {
    const only =
      token.teamIds[0] ??
      token.projectIds[0] ??
      token.folderIds[0] ??
      token.appIds[0] ??
      "";
    const named = names[only];
    if (named) return { text: named, empty: false };
    const noun = token.teamIds.length
      ? "1 team"
      : token.projectIds.length
        ? "1 project"
        : token.folderIds.length
          ? "1 folder"
          : "1 app";
    return { text: noun, empty: false };
  }

  const parts: string[] = [];
  if (token.teamIds.length)
    parts.push(
      `${token.teamIds.length} ${token.teamIds.length === 1 ? "team" : "teams"}`,
    );
  if (token.projectIds.length)
    parts.push(
      `${token.projectIds.length} ${token.projectIds.length === 1 ? "project" : "projects"}`,
    );
  if (token.folderIds.length)
    parts.push(
      `${token.folderIds.length} ${token.folderIds.length === 1 ? "folder" : "folders"}`,
    );
  if (token.appIds.length)
    parts.push(
      `${token.appIds.length} ${token.appIds.length === 1 ? "app" : "apps"}`,
    );
  return { text: parts.join(", "), empty: false };
}
