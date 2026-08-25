import { cn } from "@/lib/utils";
import { DocsLink } from "@/components/ui/docs-link";
import type { DocsTopic } from "@/lib/docs";

/**
 * The two title sizes, and the only two. `page` is the h1 a screen carries once;
 * `section` is every heading under it, sized like CardTitle so a bare section and
 * a card read the same.
 */
export const titleClass = {
  page: "text-xl font-semibold tracking-tight",
  section: "text-base font-semibold tracking-tight lg:text-lg",
} as const;

export function PageHeader({
  title,
  description,
  docs,
  docsLabel,
  actions,
  level = "page",
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The manual page for whatever this screen is. */
  docs?: DocsTopic;
  docsLabel?: string;
  actions?: React.ReactNode;
  /** `section` for a screen that already sits under an entity's own h1. */
  level?: "page" | "section";
  className?: string;
}) {
  const Heading = level === "page" ? "h1" : "h2";
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="space-y-1">
        <Heading className={titleClass[level]}>{title}</Heading>
        {(description || docs) && (
          <p className="text-sm text-muted-foreground">
            {description}
            {docs && (
              <DocsLink
                topic={docs}
                label={docsLabel}
                className={description ? "ml-1.5" : undefined}
              />
            )}
          </p>
        )}
      </div>
      {/* Wraps: a header can carry three buttons, which is already wider than a
          phone, and a toolbar that grows past the screen takes the whole page
          with it. */}
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
