import "server-only";

import { bareVersion, DEPLO_REPO, versionTag } from "../../version";

/** What a release declares in the `deplo` block of its package.json, beside its agent pin. */
export interface ReleaseDeclaration {
  agentMin: string | null;
  updateStop: boolean;
  requiresStop: string | null;
  /** The oldest version without a known security flaw: below it, Deplo asks for the update. */
  securityFloor: string | null;
  /** Why this release never installs itself: a step the admin has to read first. */
  manualUpdate: string | null;
}

/** Read off the release's tag without the API budget. Null when it could not be read. */
export async function readReleaseDeclaration(
  version: string,
  init: RequestInit = {
    cache: "force-cache",
    next: { revalidate: 3600 },
  } as RequestInit,
): Promise<ReleaseDeclaration | null> {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${DEPLO_REPO}/${versionTag(version)}/package.json`,
      { signal: AbortSignal.timeout(5000), ...init },
    );
    if (!res.ok) return null;
    const block =
      ((await res.json()) as { deplo?: Record<string, unknown> } | null)
        ?.deplo ?? {};
    const stop =
      typeof block.requiresStop === "string"
        ? bareVersion(block.requiresStop)
        : "";
    const floor =
      typeof block.securityFloor === "string"
        ? bareVersion(block.securityFloor)
        : "";
    const manual =
      typeof block.manualUpdate === "string"
        ? block.manualUpdate.trim().slice(0, 300)
        : "";
    return {
      agentMin: typeof block.agentMin === "string" ? block.agentMin : null,
      updateStop: block.updateStop === true,
      requiresStop: stop || null,
      securityFloor: floor || null,
      manualUpdate: manual || null,
    };
  } catch {
    return null;
  }
}
