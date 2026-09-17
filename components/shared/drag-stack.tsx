import {
  defaultDropAnimationSideEffects,
  type DropAnimation,
} from "@dnd-kit/core";

/** Shared by every card grid: a decelerating drop, never dnd-kit's overshoot. */
export const DRAG_DROP_ANIMATION: DropAnimation = {
  duration: 260,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

import { cn } from "@/lib/utils";

export function DragStack({
  count,
  className,
  children,
}: {
  count: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none relative rotate-[1.5deg] cursor-grabbing",
        className,
      )}
    >
      {count > 2 && (
        <div
          aria-hidden
          className="absolute inset-0 translate-x-4 translate-y-4 rounded-xl border border-border bg-card shadow-lg"
        />
      )}
      {count > 1 && (
        <div
          aria-hidden
          className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl border border-border bg-card shadow-lg"
        />
      )}
      <div className="relative rounded-xl shadow-2xl ring-1 ring-border/60">
        {children}
      </div>
      {count > 1 && (
        <span className="absolute -top-2 -right-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground shadow-md ring-2 ring-background">
          {count}
        </span>
      )}
    </div>
  );
}
