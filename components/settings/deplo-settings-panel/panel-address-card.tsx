"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import {
  CheckCircle2,
  Globe,
  LifeBuoy,
  Loader2,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InfoTip } from "@/components/ui/info-tip";
import { CopyButton } from "@/components/shared/copy-button";
import { CloudflareNote } from "@/components/domains/cloudflare-note";
import { RevealChip } from "@/components/shared/reveal-chip";
import { PanelAddressDialog } from "@/components/settings/panel-address-dialog";
import { usePanelHttps } from "./panel-http-card";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { PanelDns } from "@/lib/data/instance-settings/panel-address";
import type { InstanceSettings } from "@/lib/data/instance-settings/settings-store";

export const SOURCE_LABEL: Record<InstanceSettings["panelUrlSource"], string> =
  {
    stored: "Set here",
    environment: "From the installer",
    request: "Guessed from your browser",
  };

export const hostPart = (url: string) => url.replace(/^https?:\/\//i, "");

export function PanelAddressCard({ settings }: { settings: InstanceSettings }) {
  const router = useRouter();
  // What Traefik routes today, not what Deplo would mint now: an older install is on its own zone.
  const { cert } = usePanelHttps();
  const routedFallbackUrl = cert?.fallbackDomain
    ? `https://${cert.fallbackDomain}`
    : null;
  const current = settings.storedPanelUrl ?? settings.panelUrl;
  const routed = cert && !cert.unavailable ? cert : null;
  const scheme = (routed ? routed.enabled : !current.startsWith("http://"))
    ? "https"
    : "http";
  const [value, setValue] = React.useState(hostPart(current));
  const [confirming, setConfirming] = React.useState(false);

  const [seen, setSeen] = React.useState(settings);
  if (seen !== settings) {
    setSeen(settings);
    setValue(hostPart(current));
  }

  const host = value.trim();
  const target = host ? `${scheme}://${host}` : "";
  const dirty = target !== current;

  const [dns, setDns] = React.useState<PanelDns | null>(null);
  const checkDns = React.useCallback(async () => {
    const res = await gqlAction<{ panelDns: PanelDns }, PanelDns | null>(
      `mutation PanelDns { panelDns { status host resolved } }`,
      undefined,
      (d) => d.panelDns,
    );
    if (res.ok && res.data) setDns(res.data);
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void checkDns();
  }, [checkDns]);

  async function save() {
    const res = await gqlAction(
      `mutation SetPanelUrl($url: String) { setPanelUrl(url: $url) { panelUrl } }`,
      { url: target },
    );
    if (res.ok) {
      router.refresh();
      void checkDns();
    }
    return res;
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <Globe className="size-4" />
          Panel address
          <InfoTip
            content="Install commands, deploy hooks and invite links are built from this address. Point its DNS at this server first."
            docs="panel.address"
          />
        </CardTitle>
        {settings.panelUrlSource !== "stored" && (
          <Badge variant="muted">{SOURCE_LABEL[settings.panelUrlSource]}</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && target) setConfirming(true);
          }}
        >
          <div className="relative w-full max-w-sm">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-sm text-muted-foreground select-none">
              {scheme}://
            </span>
            <Input
              id="panel-url"
              aria-label="Panel address"
              value={value}
              onChange={(e) => setValue(hostPart(e.target.value))}
              placeholder="deplo.example.com"
              autoComplete="off"
              spellCheck={false}
              className={`w-full font-mono text-sm ${
                scheme === "https"
                  ? "pl-[calc(0.75rem_+_8ch)]"
                  : "pl-[calc(0.75rem_+_7ch)]"
              }`}
            />
          </div>
          <Button type="submit" disabled={!dirty || !target}>
            Save
          </Button>
        </form>

        <PanelDnsBlock dns={dns} serverIp={settings.deploHostIp} />

        <PanelFallbackRow
          url={routedFallbackUrl ?? settings.panelFallbackUrl}
          panelUrl={settings.panelUrl}
          disabled={settings.panelFallbackDisabled}
        />
      </CardContent>

      <PanelAddressDialog
        open={confirming}
        onOpenChange={setConfirming}
        url={dirty ? target : ""}
        title={`Move the panel to ${target}?`}
        confirmLabel="Change address"
        successMessage={`Deplo now calls itself ${target}`}
        onConfirm={save}
      />
    </Card>
  );
}

function AddServerHint({ className }: { className?: string }) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      Add this server on Settings, Servers and Deplo can tell you which address
      to point it at.
    </p>
  );
}

function PanelDnsBlock({
  dns,
  serverIp,
}: {
  dns: PanelDns | null;
  serverIp: string | null;
}) {
  if (!dns)
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Checking where this address points
      </p>
    );

  if (dns.status === "cloudflare")
    return <CloudflareNote serverIp={serverIp} />;

  if (dns.status === "valid")
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <CheckCircle2 className="size-4 text-[var(--success)]" />
        <span className="font-mono">{dns.host}</span>
        <span className="text-muted-foreground">points at this server</span>
      </p>
    );

  if (dns.status === "unknown") return serverIp ? null : <AddServerHint />;

  const off = dns.status === "misconfigured";
  return (
    <div>
      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
        {off && <TriangleAlert className="size-4 text-[var(--warning)]" />}
        {off ? "It resolves somewhere else" : "It does not resolve yet"}
      </p>
      {off && dns.resolved.length > 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          Answers with{" "}
          <span className="font-mono">{dns.resolved.join(", ")}</span>
        </p>
      )}
      {serverIp ? (
        <div className="mt-1 overflow-x-auto rounded-lg border border-border">
          <div className="grid min-w-[22rem] grid-cols-[3.5rem_1fr_auto] gap-x-4 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span>Type</span>
            <span>Name</span>
            <span>Value</span>
          </div>
          <div className="grid min-w-[22rem] grid-cols-[3.5rem_1fr_auto] items-center gap-x-4 px-3 py-1.5 font-mono text-sm">
            <span>A</span>
            <span className="truncate">{dns.host}</span>
            <span className="flex items-center gap-1">
              {serverIp}
              <CopyButton value={serverIp} className="size-6" />
            </span>
          </div>
        </div>
      ) : (
        <AddServerHint className="mt-1" />
      )}
    </div>
  );
}

function PanelFallbackRow({
  url,
  panelUrl,
  disabled,
}: {
  url: string | null;
  panelUrl: string;
  disabled: boolean;
}) {
  const [revealed, setRevealed] = React.useState(false);
  if (!url || url === panelUrl) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <LifeBuoy className="size-4 text-muted-foreground" />
          Backup address
          <Badge variant="muted">{disabled ? "Off" : "Always on"}</Badge>
          <InfoTip
            content="Deplo generates this address from the server's own IP, so it resolves here with no DNS to set up. Use the address above day to day."
            docs="panel.address"
          />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {disabled
            ? "Turned off under Advanced. The panel answers on the address above and nowhere else."
            : "Works even when the domain above stops answering."}
        </p>
      </div>
      {!disabled && (
        <div className="flex w-full items-center gap-1">
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
    </div>
  );
}
