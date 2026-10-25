import { checkImageExists, listTags } from "../registry/client";
import { parseImageRef } from "../registry/image-ref";

export type RegistryState =
  | { status: "ok"; digest: string; newerTag: string | null }
  | { status: "private" }
  // Offline, rate-limited or gone: the caller keeps what it knew.
  | { status: "unknown" };

export async function registryState(imageRef: string): Promise<RegistryState> {
  const parsed = parseImageRef(imageRef);
  if (!parsed || parsed.digest) return { status: "unknown" };
  const head = await checkImageExists(imageRef);
  if (head.status === "private") return { status: "private" };
  if (head.status !== "exists" || !head.digest) return { status: "unknown" };
  const tags = await listTags(imageRef, 100).catch(() => []);
  return {
    status: "ok",
    digest: head.digest,
    newerTag: newerTagOf(
      parsed.tag,
      tags.map((t) => t.name),
    ),
  };
}

// The digest an image is known by in the repository its ref names, "" when none matches.
export function repoDigestFor(imageRef: string, repoDigests: string[]): string {
  const want = parseImageRef(imageRef);
  if (!want) return "";
  for (const rd of repoDigests) {
    const got = parseImageRef(rd);
    if (
      got?.digest &&
      got.registry === want.registry &&
      got.repository === want.repository
    )
      return got.digest;
  }
  return "";
}

const VERSION_TAG = /^v?(\d+(?:\.\d+)*)(.*)$/;

// The highest tag on the same line (same major, as many parts, same suffix) above the current one.
export function newerTagOf(current: string, tags: string[]): string | null {
  const cur = VERSION_TAG.exec(current);
  if (!cur) return null;
  const curParts = cur[1].split(".").map(Number);
  let best: { tag: string; parts: number[] } | null = null;
  for (const tag of tags) {
    const m = VERSION_TAG.exec(tag);
    if (!m || m[2] !== cur[2]) continue;
    const parts = m[1].split(".").map(Number);
    if (parts.length !== curParts.length || parts[0] !== curParts[0]) continue;
    if (compareParts(parts, curParts) <= 0) continue;
    if (!best || compareParts(parts, best.parts) > 0) best = { tag, parts };
  }
  return best?.tag ?? null;
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
