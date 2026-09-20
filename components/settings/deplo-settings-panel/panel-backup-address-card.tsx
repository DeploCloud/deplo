"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { LifeBuoy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { gqlAction } from "@/lib/graphql-client";
import type { InstanceSettings } from "@/lib/data/instance-settings/settings-store";
import { hostPart } from "./panel-address-card";
import { usePanelHttps } from "./panel-http-card";

export function PanelBackupAddressCard({
  settings,
}: {
  settings: InstanceSettings;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // What Traefik routes today, not what Deplo would mint now: an older install is on its own zone.
  const { cert } = usePanelHttps();
  const url = cert?.fallbackDomain
    ? `https://${cert.fallbackDomain}`
    : settings.panelFallbackUrl;
  const off = settings.panelFallbackDisabled;
  const isOwnAddress = !!url && url === settings.panelUrl;

  async function apply(enabled: boolean) {
    const res = await gqlAction(
      `mutation SetPanelFallback($enabled: Boolean!) {
        setPanelFallback(enabled: $enabled) { panelFallbackDisabled }
      }`,
      { enabled },
    );
    if (res.ok) router.refresh();
    return res;
  }

  function toggle(turningOff: boolean) {
    if (turningOff) return setConfirming(true);
    startTransition(async () => {
      const res = await apply(true);
      if (!res.ok) toast.error(res.error);
      else toast.success(`The panel answers at ${hostPart(url ?? "")} again`);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LifeBuoy className="size-4 text-muted-foreground" />
          Backup address
        </CardTitle>
        <CardDescription>
          The generated address that answers when your domain does not.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border p-3">
          {!url ? (
            <p className="text-sm text-muted-foreground">
              Add this server under Settings, Servers and Deplo generates one.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{hostPart(url)}</span>
                <Badge variant="muted">{off ? "Off" : "On"}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {isOwnAddress
                  ? "This is the panel's own address right now. Give it a domain first."
                  : off
                    ? "It routes nowhere. Your domain is the only way to the panel."
                    : "It resolves to this server, so it answers with no DNS to set up."}
              </p>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <FieldLabel
            htmlFor="panel-fallback"
            info="Recovering a panel whose domain broke then means a command on the server, over SSH."
            docs="panel.backupAddress"
          >
            Turn the backup address off
          </FieldLabel>
          <Switch
            id="panel-fallback"
            checked={off}
            disabled={pending || !url || isOwnAddress}
            onCheckedChange={toggle}
            aria-label="Turn the backup address off"
          />
        </div>
      </CardContent>

      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title="Turn the backup address off?"
        description={
          <>
            The panel answers at{" "}
            <strong>{hostPart(settings.panelUrl)} and nowhere else</strong>.
          </>
        }
        consequence={
          <>
            If that domain, its DNS or its certificate breaks, the way back in
            is a command on the server, over SSH.{" "}
            <DocsLink topic="panel.backupAddress" />
          </>
        }
        confirmLabel="Turn it off"
        successMessage={`${hostPart(url ?? "")} no longer reaches the panel`}
        onConfirm={() => apply(false)}
      />
    </Card>
  );
}
