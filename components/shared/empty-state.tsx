import { cn } from "@/lib/utils";
import { DocsLink } from "@/components/ui/docs-link";
import type { DocsTopic } from "@/lib/docs";

export function EmptyState({
  icon: Icon,
  iconClassName,
  graphic,
  title,
  description,
  docs,
  docsLabel,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  graphic?: React.ReactNode;
  title: string;
  description?: string;
  docs?: DocsTopic;
  docsLabel?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center",
        className,
      )}
    >
      {graphic ? (
        <div className="mb-5 flex items-center justify-center">{graphic}</div>
      ) : (
        Icon && (
          <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-border bg-secondary">
            <Icon
              className={cn("size-5 text-muted-foreground", iconClassName)}
            />
          </div>
        )
      )}
      <h3 className="text-sm font-medium">{title}</h3>
      {(description || docs) && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
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
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
