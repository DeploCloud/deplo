import { AlertTriangle, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * What a git host has not allowed, in that host's own words. One block for every
 * surface that raises it, so the same gap never reads two different ways.
 * https://deplo.build/docs/guides/git-providers
 */
export function GitAccessNotice({
  heading,
  items,
  note,
  fix,
  className,
}: {
  heading: string;
  /** The provider's own labels, and what each one unlocks. */
  items?: { key?: string; label: string; unlocks: string }[];
  /** A sentence the check produced verbatim, under the list. */
  note?: string | null;
  /** Where it is fixed - on the provider (`href`) or right here (`onClick`).
   *  Null for a reader who cannot fix it. */
  fix?: {
    label: string;
    href?: string;
    onClick?: () => void;
  } | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <AlertTriangle className="size-3.5 text-[var(--warning)]" />
        {heading}
      </p>
      {items && items.length > 0 && (
        <ul className="mt-2 space-y-1">
          {items.map((r) => (
            <li key={r.key ?? r.label} className="text-xs">
              <span className="font-medium">{r.label}</span>
              <span className="text-muted-foreground"> - {r.unlocks}</span>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      {fix &&
        (fix.href ? (
          <Button asChild size="sm" className="mt-2">
            <a href={fix.href} target="_blank" rel="noopener noreferrer">
              {fix.label}
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        ) : (
          <Button size="sm" className="mt-2" onClick={fix.onClick}>
            {fix.label}
          </Button>
        ))}
    </div>
  );
}
