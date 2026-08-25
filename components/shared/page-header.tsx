import { cn } from "@/lib/utils";
import { DocsLink } from "@/components/ui/docs-link";
import type { DocsTopic } from "@/lib/docs";

export function PageHeader({
  title,
  description,
  docs,
  docsLabel,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The manual page for whatever this screen is. */
  docs?: DocsTopic;
  docsLabel?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
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
