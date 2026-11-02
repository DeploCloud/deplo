import { cn } from "@/lib/utils";
import { DocsLink } from "@/components/ui/docs-link";
import type { DocsTopic } from "@/lib/docs";

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
  docs?: DocsTopic;
  docsLabel?: string;
  actions?: React.ReactNode;
  level?: "page" | "section";
  className?: string;
}) {
  const Heading = level === "page" ? "h1" : "h2";
  return (
    // On a phone the action sits beside the title and the description runs full width below.
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:flex sm:flex-row sm:items-center sm:justify-between sm:gap-3",
        className,
      )}
    >
      <div className="space-y-1 max-sm:contents">
        <Heading
          className={cn(
            titleClass[level],
            "max-sm:col-start-1 max-sm:row-start-1",
          )}
        >
          {title}
        </Heading>
        {(description || docs) && (
          <p className="text-sm text-muted-foreground max-sm:col-span-2 max-sm:row-start-2">
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
      {actions && (
        <div className="flex flex-wrap items-center justify-end gap-2 max-sm:col-start-2 max-sm:row-start-1">
          {actions}
        </div>
      )}
    </div>
  );
}
