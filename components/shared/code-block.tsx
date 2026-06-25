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
      {/* Copy sits in the top-right; the scroll area below reserves room (pr-12)
          so a long first line never slides under it. */}
      <div className="absolute right-2 top-2 z-10">
        <CopyButton value={code} />
      </div>
      {/* Bounded box that scrolls on BOTH axes — long lines scroll sideways and a
          tall block scrolls vertically, instead of stretching/overflowing the page. */}
      <pre className="max-h-[60vh] overflow-auto p-4 pr-12 text-xs leading-relaxed">
        <code className="font-mono text-zinc-200">{code}</code>
      </pre>
    </div>
  );
}

/** Inline command with copy button — for install one-liners. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-[#0a0a0a] px-3 py-2">
      <span className="select-none font-mono text-sm leading-relaxed text-muted-foreground">
        $
      </span>
      {/* WRAP the command (break-all) instead of scrolling it: the whole
          one-liner — long bootstrap token and all — stays visible and fully
          selectable, so it copies correctly by hand too, with zero horizontal
          overflow. min-w-0 keeps this flex child from forcing the row wider than
          its container (the classic flexbox min-width:auto overflow). */}
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-sm leading-relaxed text-zinc-200">
        {command}
      </code>
      <CopyButton value={command} className="shrink-0" />
    </div>
  );
}
