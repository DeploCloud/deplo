import type { FixKind, Level } from "@/lib/security-updates/fix-kind";

export interface Update {
  vulnId: string;
  cve: string | null;
  level: Level;
  cvss: number | null;
  ecosystem: string;
  packageName: string;
  installedVersion: string;
  fixedVersion: string | null;
  fix: FixKind;
  actionable: boolean;
  ignored: boolean;
  ignoredUntil: string | null;
  ignoreReason: string | null;
  ignoredBy: string | null;
  service: string;
  osvUrl: string;
}

export interface Answer {
  checkedAt: string | null;
  unreadable: string[];
  newerTag: string | null;
  updates: Update[];
}

export type Subject = { appId?: string; databaseId?: string };
