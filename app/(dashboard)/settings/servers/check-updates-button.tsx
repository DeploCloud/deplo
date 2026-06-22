"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";

/**
 * "Check for updates" — force the control plane to re-resolve the latest agent
 * release from GitHub right now, bypassing the in-process cache, then refresh the
 * page so every server's outdated badge reflects the fresh "latest".
 *
 * Without this, a newly published agent release isn't reflected until the release
 * memo's TTL elapses (lib/agent/release.ts). The button is the operator's
 * immediate bust; gated server-side by `manage_infra`.
 */
export function CheckUpdatesButton() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function check() {
    startTransition(async () => {
      const res = await gqlAction<{ checkAgentUpdates: string }>(
        `mutation CheckAgentUpdates {
          checkAgentUpdates
        }`,
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const latest = res.data?.checkAgentUpdates;
      toast.success(
        latest ? `Latest agent version is v${latest}` : "Checked for updates",
      );
      // Re-run the server-side reads so the outdated badges recompute against the
      // freshly resolved "expected" version.
      router.refresh();
    });
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => check()}
      disabled={pending}
    >
      <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
      {pending ? "Checking…" : "Check for updates"}
    </Button>
  );
}
