import type { FixKind, Level } from "@/lib/security-updates/fix-kind";

export interface Update {
  vulnId: string;
  cve: string | null;
  level: Level;
  cvss: number | null;
  epss: number | null;
  summary: string;
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
  imageRef: string;
  via: string[];
  osvUrl: string;
}

export interface Answer {
  checkedAt: string | null;
  checking: boolean;
  unreadable: string[];
  newerTag: string | null;
  updates: Update[];
  canOpenPullRequests: boolean;
  groups: {
    key: string;
    pullRequest: { number: number; url: string } | null;
  }[];
}

export type Subject = { appId?: string; databaseId?: string };
