import { cn } from "@/lib/utils";

function Skeleton({
  className,
  shimmer = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  shimmer?: boolean;
}) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md bg-muted",
        shimmer ? "animate-shimmer" : "animate-pulse",
        className,
      )}
      {...props}
    />
  );
}

/** One line box of the text it stands for: same type classes, same height. */
function TextLine({
  type,
  className,
  shimmer,
}: {
  type?: string;
  className?: string;
  shimmer?: boolean;
}) {
  return (
    <div className={cn("flex h-lh items-center", type)}>
      <Skeleton className={cn("h-[1em]", className)} shimmer={shimmer} />
    </div>
  );
}

export { Skeleton, TextLine };
