import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

export function CodeBlock({
  code,
  className,
  language,
  filename,
}: {
  code: string;
  className?: string;
  language?: string;
  filename?: string;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border border-border bg-[#0a0a0a] dark:bg-[#0a0a0a]",
        className,
      )}
    >
      {(filename || language) && (
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">
            {filename ?? language}
          </span>
        </div>
      )}
      {/* The scroll area reserves room (pr-12) so a long first line never slides under Copy. */}
      <div className="absolute top-2 right-2 z-10">
        <CopyButton value={code} />
      </div>
      {/* Bounded box that scrolls on both axes rather than stretching the page. */}
      <pre className="max-h-[60vh] overflow-auto p-4 pr-12 text-xs leading-relaxed">
        <code className="font-mono text-zinc-200">{code}</code>
      </pre>
    </div>
  );
}

// CommandLine - inline command with copy button, for install one-liners.
export function CommandLine({
  command,
  truncate,
}: {
  command: string;
  truncate?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg border border-border bg-[#0a0a0a] px-3 py-2",
        truncate ? "items-center" : "items-start",
      )}
    >
      <span className="font-mono text-sm leading-relaxed text-muted-foreground select-none">
        $
      </span>
      {/* Wrapped (break-all) rather than scrolled, so the whole one-liner stays visible and selectable. */}
      <code
        className={cn(
          "min-w-0 flex-1 font-mono text-sm leading-relaxed text-zinc-200",
          truncate ? "truncate" : "break-all whitespace-pre-wrap",
        )}
      >
        {command}
      </code>
      <CopyButton value={command} className="shrink-0" />
    </div>
  );
}
