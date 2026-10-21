// The body scripts/release-notes.mts writes, read back into typed rows. It arrives from
// GitHub, so a body in any other shape parses to null and is shown as plain markdown.

export type ReleaseNoteType = "feat" | "ui" | "fix" | "perf" | "other";

export type ReleaseNoteItem = {
  scope: string | null;
  text: string;
  user: string | null;
  pr: number | null;
  sha: string | null;
};

export type ReleaseNoteGroup = {
  type: ReleaseNoteType;
  label: string;
  items: ReleaseNoteItem[];
};

export type ParsedReleaseNotes = {
  note: string;
  groups: ReleaseNoteGroup[];
  contributors: string[];
};

const SECTIONS: [string, ReleaseNoteType | "contributors"][] = [
  ["feature", "feat"],
  ["interface", "ui"],
  ["fix", "fix"],
  ["perf", "perf"],
  ["contributor", "contributors"],
];

const HEADING = /^## \[[^\]]+\]\([^)\s]+\) \(\d{4}-\d{2}-\d{2}\)$/;
// "* **scope:** subject, by @login in [#75](<pr url>) ([f73245fe](<commit url>))"
const ITEM =
  /^\* (?:\*\*([^*]+):\*\* )?(.+?)(?:, by @([A-Za-z0-9-]{1,39}) in \[#(\d+)\]\([^)]+\))? \(\[([0-9a-f]{7,40})\]\([^)]+\)\)$/;

const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);

export function parseReleaseNotes(body: string): ParsedReleaseNotes | null {
  const lines = body.replace(/\r/g, "").trim().split("\n");
  if (!HEADING.test(lines[0] ?? "")) return null;

  const note: string[] = [];
  const groups: ReleaseNoteGroup[] = [];
  const contributors: string[] = [];
  let group: ReleaseNoteGroup | null = null;
  let inContributors = false;

  for (const line of lines.slice(1)) {
    const title = /^###\s+(.+)$/.exec(line)?.[1];
    if (title) {
      const type =
        SECTIONS.find(([key]) => title.toLowerCase().includes(key))?.[1] ??
        "other";
      inContributors = type === "contributors";
      group = null;
      if (type !== "contributors") {
        group = {
          type,
          label: title.replace(/^[^\p{L}\p{N}]+/u, ""),
          items: [],
        };
        groups.push(group);
      }
    } else if (inContributors) {
      const login = /^- @([A-Za-z0-9-]{1,39})$/.exec(line)?.[1];
      if (login) contributors.push(login);
    } else if (!group) {
      note.push(line.replace(/^>\s?/, ""));
    } else if (line.startsWith("* ")) {
      const m = ITEM.exec(line);
      // A line off the template keeps its text: raw beats gone.
      group.items.push(
        m
          ? {
              scope: m[1] ?? null,
              text: capital(m[2]!),
              user: m[3] ?? null,
              pr: m[4] ? Number(m[4]) : null,
              sha: m[5]!,
            }
          : {
              scope: null,
              text: line.slice(2),
              user: null,
              pr: null,
              sha: null,
            },
      );
    }
  }

  return {
    note: note
      .join("\n")
      .trim()
      .replace(/^[\p{Extended_Pictographic}\uFE0F]+\s*/u, ""),
    groups: groups.filter((g) => g.items.length > 0),
    contributors,
  };
}
