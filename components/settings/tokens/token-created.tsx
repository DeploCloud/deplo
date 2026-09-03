"use client";

import Link from "@/components/ui/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";
import { CommandLine } from "@/components/shared/code-block";

/**
 * The one time a token's secret is ever shown.
 */
export function TokenCreated({
  raw,
  name,
  granted,
  scope,
  publicUrl,
}: {
  raw: string;
  name: string;
  granted: number;
  /** One short line describing what it reaches. */
  scope: string;
  publicUrl: string;
}) {
  const host = publicUrl.replace(/\/+$/, "") || "https://your-deplo-host";
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <Check className="size-5 text-[var(--success)]" />
          Token created
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Copy it now. Deplo stores only a hash of this token, so this is the
          only time it can be shown.
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
          {raw}
        </code>
        <CopyButton value={raw} />
      </div>

      <div>
        <p className="text-sm font-medium">Try it</p>
        <div className="mt-1">
          <CommandLine
            command={`curl -H "Authorization: Bearer ${raw}" -H "Content-Type: application/json" -d '{"query":"{ me { username } }"}' ${host}/api/graphql`}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {name} · {granted === 0 ? "View only" : `${granted} permissions`} ·{" "}
        {scope}
      </p>

      <div className="flex gap-2">
        <Button asChild>
          <Link href="/settings/tokens">Done</Link>
        </Button>
      </div>
    </div>
  );
}
