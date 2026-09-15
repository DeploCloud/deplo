import "server-only";
import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export const nowIso = () => new Date().toISOString();
