export interface Mapped<T> {
  value: T;
  notes: string[];
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

export const DOKPLOY_NETWORK = "dokploy-network";

export interface SourcePlatformShape {
  name: string;
  networks: readonly string[];
}

export function withPanel(text: string, panel: string): string {
  return text.split("{panel}").join(panel);
}

export const DOKPLOY_PLATFORM: SourcePlatformShape = {
  name: "Dokploy",
  networks: [DOKPLOY_NETWORK],
};

const PLATFORM_FILES_RE = [
  /^\.\.\/files(?:\/(.*))?$/,
  /^\/data\/coolify\/(?:applications|services)\/[^/]+(?:\/(.*))?$/,
  /^\/etc\/dokploy\/(?:applications|compose)\/[^/]+\/files(?:\/(.*))?$/,
  /^\/etc\/dokploy(?:\/(.*))?$/,
  /^\/data\/coolify(?:\/(.*))?$/,
];

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
