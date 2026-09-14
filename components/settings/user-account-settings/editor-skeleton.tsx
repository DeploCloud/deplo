"use client";

import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ROW_SHELL, sectionShell } from "./section-shell";

// EditorSkeleton - the stand-in shown until the account is loaded.
export function EditorSkeleton({ withDanger }: { withDanger: boolean }) {
  return (
    <>
      {/* Each identity cell is a 16px line over a 20px one, which is what the
          two <p>s in Meta measure. */}
      <div className="grid grid-cols-3 gap-2 rounded-lg border border-border p-3">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <TextLine box="h-4" bar="h-3 w-12" />
            <TextLine box="h-5" bar="h-4 w-16" />
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Skeleton className="h-[22px] w-32 rounded-full" />
      </div>

      <SkeletonSection>
        <SkeletonRow />
        <TextLine box="h-6" bar="h-4 w-28" />
      </SkeletonSection>

      <SkeletonSection>
        <Skeleton className="h-9 w-full" />
      </SkeletonSection>

      {withDanger && (
        <SkeletonSection tone="destructive">
          <SkeletonRow button />
          <SkeletonRow button />
        </SkeletonSection>
      )}
    </>
  );
}

function SkeletonSection({
  tone = "default",
  children,
}: {
  tone?: "default" | "destructive";
  children: React.ReactNode;
}) {
  return (
    <div className={sectionShell(tone)}>
      <TextLine box="h-5" bar="h-4 w-28" />
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function SkeletonRow({ button }: { button?: boolean }) {
  return (
    <div className={ROW_SHELL}>
      <TextLine box="h-5" bar="h-4 w-36" />
      <Skeleton
        className={button ? "h-8 w-24 rounded-md" : "h-5 w-9 rounded-full"}
      />
    </div>
  );
}

// A bar inside a box the height of the text line it replaces - without the box
// every section would come up a few pixels short, which is the jump this removes.
function TextLine({ box, bar }: { box: string; bar: string }) {
  return (
    <div className={cn("flex items-center", box)}>
      <Skeleton className={bar} />
    </div>
  );
}
