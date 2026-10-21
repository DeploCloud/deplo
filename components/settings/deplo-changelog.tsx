"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { EmptyState } from "@/components/shared/empty-state";
import { RemoteMarkdown } from "@/components/shared/remote-markdown";
import { UpdateGraphic } from "@/components/settings/update-graphic";
import {
  parseReleaseNotes,
  type ReleaseNoteGroup,
  type ReleaseNoteItem,
  type ReleaseNoteType,
  type ParsedReleaseNotes,
} from "@/lib/release-notes";
import { cn } from "@/lib/utils";

const REPO = "https://github.com/DeploCloud/deplo";

export type Release = {
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  body: string;
  prerelease: boolean;
  current: boolean;
  available: boolean;
};

function day(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function Changelog({
  releases,
  error,
}: {
  releases: Release[] | null;
  error: string | null;
}) {
  if (releases === null) return <ChangelogSkeleton />;

  if (releases.length === 0)
    return (
      <EmptyState
        graphic={<UpdateGraphic className="w-40" />}
        title={error ? "Couldn't read the release history" : "No releases yet"}
        description={
          error ??
          "Deplo publishes its release notes on GitHub. Nothing has been tagged so far."
        }
        docs="upgrade.releases"
      />
    );

  return (
    <Accordion
      type="multiple"
      defaultValue={releases
        .filter((r, i) => r.available || r.current || i === 0)
        .map((r) => r.tag)}
      className="rounded-xl border border-border px-4"
    >
      {releases.map((r) => (
        <AccordionItem key={r.tag} value={r.tag} className="last:border-b-0">
          <AccordionTrigger>
            <span className="flex flex-wrap items-center gap-2 text-left">
              <span className="font-mono text-sm font-medium">{r.tag}</span>
              {r.publishedAt && (
                <span className="text-xs text-muted-foreground">
                  {day(r.publishedAt)}
                </span>
              )}
              {r.current && <Badge variant="success">Installed</Badge>}
              {r.available && <Badge variant="info">Update available</Badge>}
              {r.prerelease && <Badge variant="muted">Canary</Badge>}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <ReleaseBody release={r} />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

// [tag, date, badge] per closed row; the first release sits open, as it does once loaded.
const SKELETON_ROWS: [string, string, string | null][] = [
  ["w-36", "w-20", "w-16"],
  ["w-36", "w-20", null],
  ["w-14", "w-20", null],
  ["w-14", "w-20", null],
];
const SKELETON_GROUPS = [
  ["w-72", "w-56", "w-64"],
  ["w-60", "w-44"],
];

export function ChangelogSkeleton() {
  return (
    <div className="rounded-xl border border-border px-4">
      {SKELETON_ROWS.map(([tag, date, badge], i) => (
        <div key={i} className="border-b border-border last:border-b-0">
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center gap-2">
              <TextLine type="font-mono text-sm" className={tag} />
              <TextLine type="text-xs" className={date} />
              {badge && <Skeleton className={cn("h-[22px]", badge)} />}
            </div>
            <Skeleton className="size-4" />
          </div>
          {i === 0 && (
            <div className="pb-4">
              <div className="space-y-5 text-sm">
                {SKELETON_GROUPS.map((rows, g) => (
                  <div key={g}>
                    <div className="flex items-center gap-2 pb-2">
                      <Skeleton className="size-2 rounded-none" />
                      <TextLine type="font-medium" className="w-20" />
                      <TextLine className="w-3" />
                    </div>
                    {rows.map((w, r) => (
                      <div
                        key={r}
                        className="flex items-center gap-3 border-l-2 border-border py-1.5 pl-3 leading-relaxed"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <Skeleton className="h-[18px] w-14 rounded-full" />
                          <TextLine type="leading-relaxed" className={w} />
                        </div>
                        <TextLine type="text-xs" className="w-8" />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <TextLine type="mt-4 text-sm" className="w-24" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ReleaseBody({ release }: { release: Release }) {
  const notes = React.useMemo(
    () => parseReleaseNotes(release.body),
    [release.body],
  );
  return (
    <>
      {notes ? (
        <Clamp>
          <ReleaseNotes notes={notes} />
        </Clamp>
      ) : release.body ? (
        <Clamp>
          <RemoteMarkdown source={release.body} />
        </Clamp>
      ) : (
        <p className="text-sm text-muted-foreground">
          This release shipped without notes.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
        <a
          href={release.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-4"
        >
          Open on GitHub
        </a>
        {notes && notes.contributors.length > 0 && (
          <p className="text-muted-foreground">
            Contributors{" "}
            {notes.contributors.map((login, i) => (
              <React.Fragment key={login}>
                {i > 0 && ", "}
                <GithubUser login={login} />
              </React.Fragment>
            ))}
          </p>
        )}
      </div>
    </>
  );
}

const TONE: Record<ReleaseNoteType, { dot: string; rail: string }> = {
  feat: { dot: "bg-success", rail: "border-success" },
  ui: { dot: "bg-info", rail: "border-info" },
  fix: { dot: "bg-warning", rail: "border-warning" },
  perf: { dot: "bg-violet", rail: "border-violet" },
  other: { dot: "bg-muted-foreground", rail: "border-border" },
};

function ReleaseNotes({ notes }: { notes: ParsedReleaseNotes }) {
  return (
    <div className="space-y-5 text-sm">
      {notes.note && (
        <div className="flex items-start gap-2.5 border-l-2 border-warning bg-warning-wash px-4 py-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <RemoteMarkdown source={notes.note} />
        </div>
      )}
      {notes.groups.map((group) => (
        <NoteGroup key={`${group.type}-${group.label}`} group={group} />
      ))}
    </div>
  );
}

function NoteGroup({ group }: { group: ReleaseNoteGroup }) {
  const tone = TONE[group.type];
  return (
    <section>
      <h4 className="flex items-center gap-2 pb-2 font-medium">
        <span aria-hidden className={cn("size-2 shrink-0", tone.dot)} />
        {group.label}
        <span className="text-muted-foreground">{group.items.length}</span>
      </h4>
      <ul>
        {group.items.map((item, i) => (
          <li
            key={item.sha ?? item.pr ?? i}
            className={cn(
              "flex items-baseline gap-3 border-l-2 py-1.5 pl-3 leading-relaxed",
              tone.rail,
            )}
          >
            <span className="min-w-0 flex-1">
              {item.scope && (
                <span className="mr-2 inline-flex rounded-full border border-border bg-background px-2 align-[1px] text-xs whitespace-nowrap text-muted-foreground">
                  {item.scope}
                </span>
              )}
              <RemoteMarkdown source={item.text} inline />
              {item.user && (
                <span className="ml-2 text-muted-foreground">
                  <GithubUser login={item.user} />
                </span>
              )}
            </span>
            <ItemRef item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// The pull request when there is one, the commit otherwise.
function ItemRef({ item }: { item: ReleaseNoteItem }) {
  const href = item.pr
    ? `${REPO}/pull/${item.pr}`
    : item.sha
      ? `${REPO}/commit/${item.sha}`
      : null;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground"
    >
      {item.pr ? `#${item.pr}` : item.sha}
    </a>
  );
}

function GithubUser({ login }: { login: string }) {
  return (
    <a
      href={`https://github.com/${login}`}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-foreground"
    >
      @{login}
    </a>
  );
}

const NOTES_CLAMP_PX = 320;

function Clamp({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [long, setLong] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > NOTES_CLAMP_PX + 48);
  }, [children]);

  const clamped = long && !expanded;
  return (
    <div>
      <div
        ref={ref}
        className="relative overflow-hidden"
        style={clamped ? { maxHeight: NOTES_CLAMP_PX } : undefined}
      >
        {children}
        {clamped && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-sm font-medium text-foreground underline underline-offset-4"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
