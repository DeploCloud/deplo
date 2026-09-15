import type { Invite } from "./types";

export type PersonLanding = {
  team: string;
  teamAvatarUrl: string | null;
  link: string | null;
  outcome: string;
  message: string | null;
};

export type MergedPerson = {
  email: string;
  name: string;
  avatarUrl: string | null;
  sourceRole: string;
  hasAccount: boolean;
  landings: PersonLanding[];
};

type SourceGroup = {
  team: { name: string; avatarUrl: string | null };
  people: Invite[];
};

export function hasLink(p: MergedPerson): boolean {
  return p.landings.some((l) => l.link);
}

export function mergePeople(groups: SourceGroup[]): MergedPerson[] {
  const by = new Map<string, MergedPerson>();
  for (const g of groups)
    for (const m of g.people) {
      const key = m.email.toLowerCase();
      const person = by.get(key) ?? {
        email: m.email,
        name: m.name,
        avatarUrl: m.avatarUrl,
        sourceRole: m.sourceRole,
        hasAccount: m.hasAccount,
        landings: [],
      };
      person.name ||= m.name;
      person.avatarUrl ??= m.avatarUrl;
      person.sourceRole ||= m.sourceRole;
      person.hasAccount ||= m.hasAccount;
      person.landings.push({
        team: g.team.name,
        teamAvatarUrl: g.team.avatarUrl,
        link: m.link,
        outcome: m.outcome,
        message: m.message,
      });
      by.set(key, person);
    }
  return [...by.values()].sort(
    (a, b) =>
      Number(hasLink(b)) - Number(hasLink(a)) || a.email.localeCompare(b.email),
  );
}

export function teamsOf(people: MergedPerson[]): string[] {
  return [...new Set(people.flatMap((p) => p.landings.map((l) => l.team)))];
}

export const ALL_TEAMS = "all";

export function filterPeople(
  people: MergedPerson[],
  query: string,
  team: string,
): MergedPerson[] {
  const q = query.trim().toLowerCase();
  return people.filter(
    (p) =>
      (team === ALL_TEAMS || p.landings.some((l) => l.team === team)) &&
      (!q ||
        p.email.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q)),
  );
}

export function linkGroups(
  p: MergedPerson,
): { link: string; teams: string[] }[] {
  const by = new Map<string, string[]>();
  for (const l of p.landings)
    if (l.link) by.set(l.link, [...(by.get(l.link) ?? []), l.team]);
  return [...by].map(([link, teams]) => ({ link: prefilled(link, p), teams }));
}

function prefilled(link: string, p: MergedPerson): string {
  const q = new URLSearchParams();
  if (p.name.trim()) q.set("name", p.name.trim());
  if (p.email.trim()) q.set("email", p.email.trim());
  const query = q.toString();
  return query ? `${link}?${query}` : link;
}

export function notesFor(
  p: MergedPerson,
): { teams: string[]; message: string }[] {
  const by = new Map<string, string[]>();
  for (const l of p.landings)
    if (!l.link) {
      const msg = l.message ?? l.outcome;
      by.set(msg, [...(by.get(msg) ?? []), l.team]);
    }
  const bare = by.size === 1 && !hasLink(p);
  return [...by].map(([message, teams]) => ({
    teams: bare ? [] : teams,
    message,
  }));
}

export function linksTsv(people: MergedPerson[]): string {
  return people
    .flatMap((p) => linkGroups(p).map((g) => `${p.email}\t${g.link}`))
    .join("\n");
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export function linksCsv(people: MergedPerson[]): string {
  const rows = people.flatMap((p) => {
    const groups = linkGroups(p);
    if (groups.length === 0)
      return [[p.email, p.name, p.landings.map((l) => l.team), ""] as const];
    return groups.map((g) => [p.email, p.name, g.teams, g.link] as const);
  });
  return [
    "email,name,teams,link",
    ...rows.map(([email, name, teams, link]) =>
      [email, name, teams.join(";"), link].map(csvCell).join(","),
    ),
  ].join("\n");
}
