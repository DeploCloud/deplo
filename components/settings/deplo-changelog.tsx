"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { EmptyState } from "@/components/shared/empty-state";
import { RemoteMarkdown } from "@/components/shared/remote-markdown";
import { UpdateGraphic } from "@/components/settings/update-graphic";

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
  if (releases === null)
    return <div className="h-40 animate-pulse rounded-xl bg-surface-strong" />;

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
            {r.body ? (
              <ReleaseNotes source={r.body} />
            ) : (
              <p className="text-sm text-muted-foreground">
                This release shipped without notes.
              </p>
            )}
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex text-sm text-foreground underline underline-offset-4"
            >
              Open on GitHub
            </a>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

const NOTES_CLAMP_PX = 320;

function ReleaseNotes({ source }: { source: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [long, setLong] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > NOTES_CLAMP_PX + 48);
  }, [source]);

  const clamped = long && !expanded;
  return (
    <div>
      <div
        ref={ref}
        className="relative overflow-hidden"
        style={clamped ? { maxHeight: NOTES_CLAMP_PX } : undefined}
      >
        <RemoteMarkdown source={source} />
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
