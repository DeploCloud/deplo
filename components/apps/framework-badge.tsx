import * as React from "react";
import { FrameworkIcon } from "@/components/shared/framework-icons";
import { Skeleton } from "@/components/ui/skeleton";
import { frameworkById } from "@/lib/apps/framework-catalog";
import { cn } from "@/lib/utils";

/**
 * How a recognised framework is shown — the whole visible surface of framework
 * recognition, so the wizard, the build settings and the app overview say the
 * same thing in the same shape.
 *
 * Two forms, both driven by the stored id and the catalog:
 *  - {@link FrameworkBadge}, inline, for a line that already has context
 *    ("Source: nextjs-app · Next.js");
 *  - {@link FrameworkRow}, a bordered row, for the moment the platform is
 *    telling the user what it just worked out about their code.
 *
 * An id the running catalog doesn't know renders NOTHING rather than a broken
 * chip: the value is derived and self-corrects on the next deploy, so a blank is
 * accurate for the few seconds it can be wrong. No component here takes a
 * "framework" the user could set — there is no such thing.
 */

/** Inline icon + name, sized to sit in a sentence of body text. */
export function FrameworkBadge({
  id,
  className,
}: {
  id: string | null | undefined;
  className?: string;
}) {
  const framework = frameworkById(id);
  if (!framework) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <FrameworkIcon id={framework.id} className="size-3.5 shrink-0" />
      {framework.name}
    </span>
  );
}

/**
 * The bordered "we recognised your stack" row. `caption` says where the answer
 * came from — the wizard reads a repo the user just picked, settings reports what
 * the last deploy saw — because "Next.js" alone leaves the user wondering
 * whether they chose it or Deplo did.
 */
export function FrameworkRow({
  id,
  caption,
  className,
}: {
  id: string | null | undefined;
  caption?: React.ReactNode;
  className?: string;
}) {
  const framework = frameworkById(id);
  if (!framework) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border p-3",
        className,
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
        <FrameworkIcon id={framework.id} className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{framework.name}</span>
        {caption && (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            {caption}
          </span>
        )}
      </span>
    </div>
  );
}

/** The same row while the repository is still being read — a skeleton, so the
 * layout doesn't jump when the answer lands. */
export function FrameworkRowSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border p-3",
        className,
      )}
    >
      <Skeleton className="size-8 shrink-0 rounded-md" />
      <span className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-44" />
      </span>
    </div>
  );
}
