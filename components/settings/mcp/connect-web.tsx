"use client";

import { TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { CodeBlock } from "@/components/shared/code-block";

/**
 * The one line someone pastes into claude.ai or ChatGPT.
 *
 * No token here on purpose: a web client cannot be handed one, which is the
 * whole reason deplo runs an OAuth server. Paste the URL, sign in, pick what the
 * app may do — the copying is the product.
 *
 * The card stays visible on an http instance and says why it will not work,
 * rather than disappearing: the failure would otherwise be narrated by someone
 * else's error message, in someone else's words.
 */
export function ConnectWeb({ publicUrl }: { publicUrl: string | null }) {
  const reachable = !!publicUrl && publicUrl.startsWith("https://");
  const url = `${publicUrl ?? "https://your-deplo-host"}/api/mcp`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Connect a web app
          <InfoTip content="You will be asked to sign in to deplo and choose what the app may do. Nothing is shared until you approve it." />
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste this into Claude or ChatGPT and sign in to deplo when asked.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <CodeBlock code={url} />
        {reachable ? null : (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <span>
              Claude and ChatGPT can only connect to an address they can reach
              over https. Set one under Settings → General.
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
