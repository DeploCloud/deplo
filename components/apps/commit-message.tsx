"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";

// CommitMessage - three lines of a commit message, with "Read more" when longer.
export function CommitMessage({
  message,
  sha,
}: {
  message: string;
  sha?: string;
}) {
  const ref = React.useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: sub-pixel line heights round scrollHeight up with nothing hidden.
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [message]);

  return (
    <>
      <p
        ref={ref}
        className="line-clamp-3 text-sm leading-relaxed whitespace-pre-wrap"
      >
        {message}
      </p>
      {clamped && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setOpen(true)}
        >
          Read more
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Commit message</DialogTitle>
            <DialogDescription>
              {sha
                ? `The full message of commit ${sha.slice(0, 7)}.`
                : "The full commit message for this build."}
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <CopyButton
              value={message}
              className="absolute top-2 right-2 z-10"
            />
            <p className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-surface p-4 pr-12 text-sm leading-relaxed whitespace-pre-wrap">
              {message}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
