import { DocsLink } from "@/components/ui/docs-link";
import { cn } from "@/lib/utils";
import type { DocsTopic } from "@/lib/docs";
import type * as React from "react";

/**
 * Every step is the same shape: a question, one line under it, the controls.
 * Left-aligned, because the picture is on the right: a centred column of text
 * beside an illustration has no edge for the eye to come back to.
 */
export function StepShell({
  title,
  lead,
  docs,
  stagger = false,
  children,
}: {
  title: string;
  lead: string;
  docs?: DocsTopic;
  /** Arrive out of a blur, one beat after another - the same class the setup
   *  wizard's first step uses. For a step somebody lands on, not one they walk into. */
  stagger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-stretch gap-5",
        stagger && "deplo-stagger",
      )}
    >
      <div>
        <h2 className="text-base font-semibold lg:text-lg">{title}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          {lead}
          {docs && <DocsLink topic={docs} className="ml-1.5" />}
        </p>
      </div>
      {children}
    </div>
  );
}
