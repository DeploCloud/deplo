import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

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

/**
 * Stand-in for dynamic content: renders it invisibly, so the box is the real one. `box` wraps an
 * element, not text. Passing `loading` (even undefined) makes it conditional: falsy shows the content.
 */
function Bone(props: {
  children: React.ReactNode;
  className?: string;
  box?: boolean;
  loading?: boolean;
}) {
  const { children, className, box } = props;
  if ("loading" in props && !props.loading) return children;
  return (
    <span
      data-slot="skeleton"
      aria-hidden
      className={cn(
        "animate-pulse rounded-md bg-muted text-transparent select-none [&_*]:invisible",
        box && "flex w-fit",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The real field, read-only, with its value still loading. */
function InputBone({
  value = "loading value",
  className,
}: {
  value?: string;
  className?: string;
}) {
  return (
    <div className="relative" aria-hidden>
      <Input readOnly tabIndex={-1} className={className} />
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm max-md:text-base">
        <Bone>{value}</Bone>
      </span>
    </div>
  );
}

export { Skeleton, TextLine, Bone, InputBone };
