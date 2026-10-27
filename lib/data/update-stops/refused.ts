import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { dataDir } from "../../data-dir";
import { requireInstanceAdmin } from "../../membership";
import { DEPLO_VERSION, isNewer } from "../../version";

/** An update the installer rolled back, and why (ADR-0041). */
export interface RefusedUpdate {
  version: string | null;
  reason: string;
  at: string | null;
}

// install.sh writes it after a rollback and removes it on its next success. KEEP IN SYNC with REFUSED_NOTE there.
const NOTE = "refused-update";

/** Until an update succeeds: the installer removes the note, and a version installed since hides it. */
export async function lastRefusedUpdate(): Promise<RefusedUpdate | null> {
  await requireInstanceAdmin();
  const text = await readFile(join(dataDir(), NOTE), "utf8").catch(() => "");
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const reason = fields.get("reason")?.slice(0, 300);
  if (!reason) return null;
  const version = fields.get("version")?.replace(/^v/i, "") || null;
  if (version && !isNewer(version, DEPLO_VERSION)) return null;
  return {
    version: version && `v${version}`,
    reason,
    at: fields.get("at") || null,
  };
}
