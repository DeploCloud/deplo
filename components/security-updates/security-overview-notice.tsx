import { ShieldAlert } from "lucide-react";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { SubjectLogo } from "./subject-logo";
import {
  exploitedLine,
  subjectHref,
  subjectsTitle,
  type SecuritySubject,
} from "@/lib/security-updates/subjects";
import { cn, plural } from "@/lib/utils";

const SHOWN = 6;

// The Overview's call to act: red while something runs a flaw already used in attacks.
export function SecurityOverviewNotice({
  subjects,
  filterActive,
  view,
}: {
  subjects: SecuritySubject[];
  filterActive: boolean;
  view: "grid" | "list";
}) {
  if (subjects.length === 0) return null;
  const attacked = subjects.some((s) => s.exploited > 0);
  const list = view === "list" ? "view=list" : "";
  const toggleHref = filterActive
    ? list
      ? `/?${list}`
      : "/"
    : `/?needs=security${list ? `&${list}` : ""}`;
  const apps = subjects.filter((s) => s.kind === "app").length;

  return (
    <section
      className={cn(
        "rounded-xl border px-5 py-4",
        attacked
          ? "border-destructive/50 bg-destructive-wash-strong"
          : "border-warning/50 bg-warning-wash-strong",
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            attacked ? "bg-destructive-wash" : "bg-warning-wash",
          )}
        >
          <ShieldAlert
            className={cn(
              "size-5",
              attacked ? "text-destructive" : "text-warning",
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{subjectsTitle(subjects)}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {exploitedLine(subjects) ??
              "Apply the fixes to close known security flaws."}{" "}
            <DocsLink topic="security.updates" />
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {subjects.slice(0, SHOWN).map((s) => (
              <li key={`${s.kind}:${s.id}`}>
                <Link
                  href={subjectHref(s)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background py-1 pr-2.5 pl-1.5 text-xs hover:bg-surface"
                >
                  <SubjectLogo subject={s} size={18} />
                  <span className="font-medium">{s.name}</span>
                  <span className="text-muted-foreground">
                    {plural(s.count, "update", "updates")}
                  </span>
                  {s.exploited > 0 ? (
                    <span className="text-destructive">used in attacks</span>
                  ) : null}
                </Link>
              </li>
            ))}
            {subjects.length > SHOWN ? (
              <li className="self-center text-xs text-muted-foreground">
                and {subjects.length - SHOWN} more
              </li>
            ) : null}
          </ul>
        </div>
        {apps > 0 ? (
          <Button
            asChild
            size="sm"
            variant={filterActive ? "outline" : "default"}
          >
            <Link href={toggleHref}>
              {filterActive ? "Show all apps" : "Show these apps"}
            </Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
