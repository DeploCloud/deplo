import "server-only";
import { randomBytes } from "node:crypto";

/** Prefixed random id, e.g. newId("prj") -> "prj_3f9a..." */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export const nowIso = () => new Date().toISOString();
