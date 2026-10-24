"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import Link from "@/components/ui/link";
import { toast } from "sonner";
import { SquareTerminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { CapabilityTip } from "@/components/apps/app-capabilities";
import { gqlAction } from "@/lib/graphql-client";
import { DocsLink } from "@/components/ui/docs-link";
import { FeatureRow } from "@/components/apps/settings/settings-shared";

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
  canConsole: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initial);
  const [confirmOn, setConfirmOn] = React.useState(false);

  function apply(v: boolean) {
    setEnabled(v);
    startTransition(async () => {
      const res = await gqlAction(SET_ENABLED, { appId, enabled: v });
      if (res.ok) {
        toast.success(v ? "Console is on" : "Console is off");
        router.refresh();
      } else {
        setEnabled(!v);
        toast.error(res.error);
      }
    });
  }

  return (
    <FeatureRow
      id="console"
      icon={SquareTerminal}
      title="Console"
      description="Open a terminal inside the running container, as its own user and with no sandbox. No SSH needed."
      control={
        <>
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
        </>
      }
    >
      <ConfirmAction
        open={confirmOn}
        onOpenChange={setConfirmOn}
        title="Turn on the console?"
        description={
          <>
            Anyone holding the console Capability gets a{" "}
            <strong>shell inside this app&apos;s container</strong>, with the
            container&apos;s own privileges.{" "}
            <DocsLink topic="console.overview" />
          </>
        }
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
    </FeatureRow>
  );
}
