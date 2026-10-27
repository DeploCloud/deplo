import "server-only";

import { DEPLO_REPO } from "../../version";

/** What a release declares in the `deplo` block of its package.json, beside its agent pin. */
export interface ReleaseDeclaration {
  agentMin: string | null;
  updateStop: boolean;
  requiresStop: string | null;
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
      `https://raw.githubusercontent.com/${DEPLO_REPO}/v${version}/package.json`,
      { signal: AbortSignal.timeout(5000), ...init },
    );
    if (!res.ok) return null;
    const block =
      ((await res.json()) as { deplo?: Record<string, unknown> } | null)
        ?.deplo ?? {};
    const stop =
      typeof block.requiresStop === "string"
        ? block.requiresStop.trim().replace(/^v/i, "")
        : "";
    return {
      agentMin: typeof block.agentMin === "string" ? block.agentMin : null,
      updateStop: block.updateStop === true,
      requiresStop: stop || null,
    };
  } catch {
    return null;
  }
}
