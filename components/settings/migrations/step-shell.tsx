import type * as React from "react";

/**
 * Every step is the same shape: a question, one line under it, the controls.
 *
 * Holding that shape is what makes five steps feel like one flow rather than
 * five screens someone bolted together, and it is why none of them is wrapped
 * in a `Card` - the illustration beside them already frames the column, and a
 * card drawn around the whole of a step is a box inside a box.
 *
 * Left-aligned, because the picture is on the right: a centred column of text
 * beside an illustration has no edge for the eye to come back to.
 */
export function StepShell({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-stretch gap-5">
      <div>
        <h2 className="text-base font-semibold lg:text-lg">{title}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{lead}</p>
      </div>
      {children}
    </div>
  );
}
