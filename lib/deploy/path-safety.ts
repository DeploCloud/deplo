import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

export async function safeBuildDir(
  base: string,
  candidate: string,
): Promise<string> {
  const realBase = await realpath(base).catch(() => base);
  try {
    const realCandidate = await realpath(candidate);
    const contained =
      realCandidate === realBase || realCandidate.startsWith(realBase + sep);
    if (!contained) return realBase;
    const st = await stat(realCandidate);
    return st.isDirectory() ? realCandidate : realBase;
  } catch {
    return realBase;
  }
}
