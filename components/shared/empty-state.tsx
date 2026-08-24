import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  iconClassName,
  graphic,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  /** Extra classes on the icon itself (e.g. `animate-spin` for a loading state). */
  iconClassName?: string;
  /**
   * An illustration shown INSTEAD of the icon medallion, centred above the
   * title. For the few empty states worth explaining with a picture rather than
   * a glyph; everything else keeps the icon, so the set stays consistent.
   */
  graphic?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-16 text-center",
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
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
