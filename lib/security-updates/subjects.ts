import type { DatabaseType } from "../types/database";
import { plural } from "../utils";

export interface SecurityCount {
  count: number;
  exploited: number;
}

type LogoTone = "dark" | "light" | null;

// An app or database with security updates to apply, as the Overview and the topbar list it.
export interface SecuritySubject extends SecurityCount {
  kind: "app" | "database";
  id: string;
  name: string;
  // The app's slug for its link; null for a database.
  slug: string | null;
  logo: string | null;
  logoTone: LogoTone;
  databaseType: DatabaseType | null;
}

export function securitySubjects(
  apps: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    logoTone: LogoTone;
    securityUpdates?: SecurityCount;
  }[],
  databases: {
    id: string;
    name: string;
    type: DatabaseType;
    logo: string | null;
  }[],
  databaseCounts: ReadonlyMap<string, SecurityCount>,
): SecuritySubject[] {
  const out: SecuritySubject[] = [];
  for (const a of apps)
    if (a.securityUpdates?.count)
      out.push({
        kind: "app",
        id: a.id,
        name: a.name,
        slug: a.slug,
        logo: a.logo,
        logoTone: a.logoTone,
        databaseType: null,
        ...a.securityUpdates,
      });
  for (const d of databases) {
    const c = databaseCounts.get(d.id);
    if (c?.count)
      out.push({
        kind: "database",
        id: d.id,
        name: d.name,
        slug: null,
        logo: d.logo,
        logoTone: null,
        databaseType: d.type,
        ...c,
      });
  }
  return out.sort(
    (a, b) =>
      b.exploited - a.exploited ||
      b.count - a.count ||
      a.name.localeCompare(b.name),
  );
}

export function subjectHref(
  s: Pick<SecuritySubject, "kind" | "id" | "slug">,
): string {
  return s.kind === "app" ? `/apps/${s.slug}` : `/storage/databases/${s.id}`;
}

// What the topbar notice was dismissed for: any new subject or count brings it back.
export function alertFingerprint(subjects: SecuritySubject[]): string {
  return subjects
    .map((s) => `${s.kind}:${s.id}:${s.count}:${s.exploited}`)
    .sort()
    .join("|");
}

export function subjectsTitle(subjects: SecuritySubject[]): string {
  const apps = subjects.filter((s) => s.kind === "app").length;
  const dbs = subjects.length - apps;
  const what =
    apps && dbs
      ? `${plural(apps, "app", "apps")} and ${plural(dbs, "database", "databases")}`
      : apps
        ? plural(apps, "app", "apps")
        : plural(dbs, "database", "databases");
  return `${what} ${subjects.length === 1 ? "needs" : "need"} security updates`;
}

export function exploitedLine(subjects: SecuritySubject[]): string | null {
  const n = subjects.filter((s) => s.exploited > 0).length;
  if (n === 0) return null;
  return n === 1
    ? "1 of them runs something already being used in attacks."
    : `${n} of them run something already being used in attacks.`;
}
