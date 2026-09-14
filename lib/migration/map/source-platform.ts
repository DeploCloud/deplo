// https://deplo.build/docs/migrations/move-from-dokploy

/** What a mapper produces: the Deplo input plus what could not come across. */
export interface Mapped<T> {
  value: T;
  notes: string[];
}

/** Cut a value quoted back at the user. No trailing marker: an ellipsis is
 *  banned from Deplo's copy, and the string is quoted so the cut is visible. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

export const DOKPLOY_NETWORK = "dokploy-network";

/** SourcePlatformShape names the source platform and the networks that belong to
 *  the platform rather than to the stack. */
export interface SourcePlatformShape {
  name: string;
  networks: readonly string[];
}

/**
 * A note written by a mapper says `{panel}` where the source product's name goes:
 * a report telling a Coolify user what happened "on Dokploy" would be wrong.
 */
export function withPanel(text: string, panel: string): string {
  return text.split("{panel}").join(panel);
}

export const DOKPLOY_PLATFORM: SourcePlatformShape = {
  name: "Dokploy",
  networks: [DOKPLOY_NETWORK],
};

/**
 * Where the other platform keeps a stack's own files. Dokploy writes them beside
 * the compose (`../files/x`); Coolify writes them under its data directory.
 */
const PLATFORM_FILES_RE = [
  /^\.\.\/files(?:\/(.*))?$/,
  /^\/data\/coolify\/(?:applications|services)\/[^/]+(?:\/(.*))?$/,
  /^\/etc\/dokploy\/(?:applications|compose)\/[^/]+\/files(?:\/(.*))?$/,
  // Anything else under the panel's own directory leaves with the panel.
  /^\/etc\/dokploy(?:\/(.*))?$/,
  /^\/data\/coolify(?:\/(.*))?$/,
];

/** deploFilesPath is the source platform's own files directory as Deplo spells
 *  it, or null when the source is not one (a named volume, a real host path). */
export function deploFilesPath(source: string): string | null {
  const s = source.trim();
  for (const re of PLATFORM_FILES_RE) {
    const m = re.exec(s);
    if (!m) continue;
    const rest = (m[1] ?? "").replace(/^\/+/, "");
    return rest ? `./${rest}` : ".";
  }
  return null;
}
