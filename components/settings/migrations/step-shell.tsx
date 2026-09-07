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
  hero = false,
  children,
}: {
  title: string;
  lead: React.ReactNode;
  docs?: DocsTopic;
  /** The screen someone LANDS on: the greeting, centred and large. */
  hero?: boolean;
  /** Arrive out of a blur, one beat after another - the same class the setup
   *  wizard's first step uses. For a step somebody lands on, not one they walk into. */
  stagger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-stretch gap-5",
        // A greeting needs air under it: at the step gap the cards read as part
        // of the sentence rather than the answer to it.
        hero && "gap-10",
        stagger && "deplo-stagger",
      )}
    >
      <div className={cn(hero && "text-center")}>
        <h2
          className={cn(
            "font-semibold",
            hero
              ? "text-3xl tracking-tight sm:text-4xl"
              : "text-base lg:text-lg",
          )}
        >
          {title}
        </h2>
        <p
          className={cn(
            "mt-1 text-sm text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground",
            hero ? "mx-auto mt-2" : "max-w-prose",
          )}
        >
          {lead}
          {docs && <DocsLink topic={docs} className="ml-1.5" />}
        </p>
      </div>
      {children}
    </div>
  );
}
