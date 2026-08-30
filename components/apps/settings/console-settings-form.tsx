"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { SquareTerminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { CapabilityTip } from "@/components/apps/app-capabilities";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The master switch for one app's container console. Turning it ON is a real
 * decision - a shell inside the running container - so it asks once; turning it
 * off is immediate and closes the sessions already open.
 */

const SET_ENABLED = /* GraphQL */ `
  mutation ($appId: String!, $enabled: Boolean!) {
    setConsoleEnabled(appId: $appId, enabled: $enabled)
  }
`;

export function ConsoleSettingsForm({
  appId,
  slug,
  enabled: initial,
  canConsole,
}: {
  appId: string;
  slug: string;
  enabled: boolean;
  /** Whether the viewer may actually open it once it is on. */
  canConsole: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initial);
  const [confirmOn, setConfirmOn] = React.useState(false);

  function apply(v: boolean) {
    setEnabled(v); // optimistic
    startTransition(async () => {
      const res = await gqlAction(SET_ENABLED, { appId, enabled: v });
      if (res.ok) {
        toast.success(v ? "Console is on" : "Console is off");
        router.refresh();
      } else {
        setEnabled(!v); // rollback
        toast.error(res.error);
      }
    });
  }

  return (
    <div id="console" className="scroll-mt-20 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-56 flex-1 space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <SquareTerminal className="size-4 text-muted-foreground" />
            Console
          </p>
          <p className="text-sm text-muted-foreground">
            Open a terminal inside the running container, as its own user and
            with no sandbox. No SSH needed.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {enabled &&
            (canConsole ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/apps/${slug}/console`}>Open console</Link>
              </Button>
            ) : (
              <CapabilityTip cap="open_app_console">
                <Button size="sm" variant="outline" disabled>
                  Open console
                </Button>
              </CapabilityTip>
            ))}
          <Switch
            checked={enabled}
            onCheckedChange={(v) => (v ? setConfirmOn(true) : apply(false))}
            disabled={pending}
            aria-label="Console"
          />
        </div>
      </div>

      <ConfirmAction
        open={confirmOn}
        onOpenChange={setConfirmOn}
        title="Turn on the console?"
        description="Anyone holding the console Capability gets a shell inside this app's container, with the container's own privileges. You can turn it back off at any time."
        confirmLabel="Turn it on"
        variant="default"
        onConfirm={async () => {
          const res = await gqlAction(SET_ENABLED, { appId, enabled: true });
          if (res.ok) {
            setEnabled(true);
            router.refresh();
          }
          return res;
        }}
        successMessage="Console is on"
      />
    </div>
  );
}
