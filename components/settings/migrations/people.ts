import type { Invite } from "./types";

/** What became of one person on ONE team of the panel. */
export type PersonLanding = {
  team: string;
  teamAvatarUrl: string | null;
  link: string | null;
  outcome: string;
  message: string | null;
};

/**
 * One person, however many teams of the panel they were on. The control plane
 * mints ONE link per address for the whole migration, so the teams are what
 * differ, not the link.
 */
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

/** Whether any team of theirs handed back a link to send. */
export function hasLink(p: MergedPerson): boolean {
  return p.landings.some((l) => l.link);
}

/**
 * One card per address. Grouped on the address and never on the link: whoever
 * was already a member has no link, and two of them would collapse into one.
 * Whoever has something to send comes first - the rest is a report, not a task.
 */
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
      // A run that knows their name or their picture wins over one that does not.
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

/** The teams that actually hold somebody, in the order their runs landed. */
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

/**
 * One block per distinct link. Normally one; a second appears when the first was
 * spent or revoked between two teams and the run had to mint a fresh one.
 */
export function linkGroups(
  p: MergedPerson,
): { link: string; teams: string[] }[] {
  const by = new Map<string, string[]>();
  for (const l of p.landings)
    if (l.link) by.set(l.link, [...(by.get(l.link) ?? []), l.team]);
  return [...by].map(([link, teams]) => ({ link: prefilled(link, p), teams }));
}

/** The registration form opens on what the panel already knew about them, so
 *  nobody retypes their own name. Query only - the link's authority is its
 *  token, and both fields stay editable. */
function prefilled(link: string, p: MergedPerson): string {
  const q = new URLSearchParams();
  if (p.name.trim()) q.set("name", p.name.trim());
  if (p.email.trim()) q.set("email", p.email.trim());
  const query = q.toString();
  return query ? `${link}?${query}` : link;
}

/**
 * The lines for the teams no link covers, teams saying the same thing on one
 * line. With nothing else on the card the line drops the team names: the step
 * is about that team and naming it twice reads as two facts.
 */
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

/** The links to send, one line per link, for a paste into a mail client. */
export function linksTsv(people: MergedPerson[]): string {
  return people
    .flatMap((p) => linkGroups(p).map((g) => `${p.email}\t${g.link}`))
    .join("\n");
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Everyone shown, link or not - a migration report, not just a mailing list. */
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
