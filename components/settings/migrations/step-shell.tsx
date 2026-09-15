import { DocsLink } from "@/components/ui/docs-link";
import { cn } from "@/lib/utils";
import type { DocsTopic } from "@/lib/docs";
import type * as React from "react";

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
  hero?: boolean;
  stagger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-stretch gap-5",
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
            "mt-1 leading-loose text-balance text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground",
            hero ? "mx-auto mt-2 max-w-md" : "max-w-prose",
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
