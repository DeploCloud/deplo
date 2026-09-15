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
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
