export const AVATAR_COLORS = [
  "#50e3c2",
  "#f5a623",
  "#7928ca",
  "#ff0080",
  "#0070f3",
] as const;

export function monogramColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}
