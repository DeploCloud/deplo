"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { LifeBuoy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SettingItem } from "./setting-item";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { RevealChip } from "@/components/shared/reveal-chip";
import { CopyButton } from "@/components/shared/copy-button";
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
  const [revealed, setRevealed] = React.useState(false);

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
      else toast.success("The backup address answers again");
    });
  }

  return (
    <SettingItem
      icon={LifeBuoy}
      title="Backup address"
      htmlFor="panel-fallback"
      info="The generated address that answers when your domain does not. Without it, recovering a panel whose domain broke means a command on the server, over SSH."
      docs="panel.backupAddress"
      badge={url && <Badge variant="muted">{off ? "Off" : "On"}</Badge>}
      description={
        !url
          ? "Add this server under Settings, Servers and Deplo generates one."
          : isOwnAddress
            ? "This is the panel's own address right now. Give it a domain first."
            : off
              ? "It routes nowhere. Your domain is the only way to the panel."
              : "It resolves to this server, so it answers with no DNS to set up."
      }
      control={
        <Switch
          id="panel-fallback"
          checked={!!url && !off}
          disabled={pending || !url || isOwnAddress}
          onCheckedChange={(on) => toggle(!on)}
          aria-label="Backup address"
        />
      }
    >
      {url && (
        <div className="flex items-center gap-1">
          <RevealChip
            value={url}
            revealed={revealed}
            onToggle={() => setRevealed((v) => !v)}
            labels={{
              reveal: "Reveal the backup address",
              hide: "Hide the backup address",
            }}
          />
          <CopyButton value={url} />
        </div>
      )}
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
        successMessage="The backup address no longer reaches the panel"
        onConfirm={() => apply(false)}
      />
    </SettingItem>
  );
}
