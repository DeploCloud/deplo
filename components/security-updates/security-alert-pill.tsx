"use client";

import * as React from "react";
import { ShieldAlert, X } from "lucide-react";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { gqlAction } from "@/lib/graphql-client";
import {
  alertFingerprint,
  exploitedLine,
  subjectHref,
  subjectsTitle,
  type SecuritySubject,
} from "@/lib/security-updates/subjects";
import { cn, plural } from "@/lib/utils";
import { SubjectLogo } from "./subject-logo";

const QUERY = /* GraphQL */ `
  query SecurityAlertPill {
    securityUpdatesOverview {
      kind
      id
      name
      slug
      logo
      logoTone
      databaseType
      count
      exploited
    }
  }
`;
const REFRESH_MS = 5 * 60_000;
const storageKey = (teamId: string) =>
  `deplo:security-alert-dismissed:${teamId}`;

// Next to the user menu on every page: dismissed until something new needs updating.
export function SecurityAlertPill({ teamId }: { teamId: string }) {
  const [subjects, setSubjects] = React.useState<SecuritySubject[]>([]);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(window.localStorage.getItem(storageKey(teamId)));
    } catch {
      setDismissed(null);
    }
    let active = true;
    const load = () =>
      void gqlAction<
        { securityUpdatesOverview: SecuritySubject[] },
        SecuritySubject[]
      >(QUERY, undefined, (d) => d.securityUpdatesOverview).then((res) => {
        if (active && res.ok) setSubjects(res.data ?? []);
      });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [teamId]);

  if (subjects.length === 0) return null;
  const fingerprint = alertFingerprint(subjects);
  if (dismissed === fingerprint) return null;
  const attacked = subjects.some((s) => s.exploited > 0);
  const title = subjectsTitle(subjects);

  function dismiss() {
    try {
      window.localStorage.setItem(storageKey(teamId), fingerprint);
    } catch {}
    setDismissed(fingerprint);
  }

  return (
    <div
      className={cn(
        "flex h-7 items-center rounded-md text-xs font-medium",
        attacked
          ? "bg-destructive-wash-strong text-destructive"
          : "bg-warning-wash-strong text-warning",
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={title}
            className="flex h-full items-center gap-1.5 rounded-l-md pr-1 pl-2"
          >
            <ShieldAlert className="size-3.5" />
            <span className="hidden lg:inline">{title}</span>
            <span className="lg:hidden">{subjects.length}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <div className="border-b border-border px-4 py-3">
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {exploitedLine(subjects) ??
                "Apply the fixes to close known security flaws."}
            </p>
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {subjects.map((s) => (
              <li key={`${s.kind}:${s.id}`}>
                <Link
                  href={subjectHref(s)}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-surface"
                >
                  <SubjectLogo subject={s} size={22} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {plural(s.count, "update", "updates")}
                  </span>
                  {s.exploited > 0 ? (
                    <ShieldAlert className="size-3.5 shrink-0 text-destructive" />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-border px-4 py-2">
            <Button asChild size="sm" variant="ghost">
              <Link href="/?needs=security" onClick={() => setOpen(false)}>
                Show these apps
              </Link>
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="flex h-full items-center rounded-r-md pr-2 pl-1"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
