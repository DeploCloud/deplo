export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export const KNOWN_EXTS = [".tar.gz", ".tgz", ".tar", ".zip"] as const;

export const ACCEPT_ATTR = KNOWN_EXTS.join(",");

export const ACCEPT_RE = /\.(tar\.gz|tgz|tar|zip)$/i;

export function archiveExt(filename: string): string | null {
  const lower = filename.toLowerCase();
  return KNOWN_EXTS.find((ext) => lower.endsWith(ext)) ?? null;
}
