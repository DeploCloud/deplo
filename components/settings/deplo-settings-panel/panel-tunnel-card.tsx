"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CloudflareIcon } from "@/components/shared/brand-icons";
import { PanelAddressDialog } from "@/components/settings/panel-address-dialog";
import { CLOUDFLARE_TOKEN_URL } from "@/lib/cloudflare/token-url";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";
import type { InstanceSettings } from "@/lib/data/instance-settings/settings-store";
import { hostPart } from "./panel-address-card";
import { SettingItem } from "./setting-item";

export type PanelTunnel = {
  enabled: boolean;
  hostname: string | null;
  status: "healthy" | "degraded" | "down" | "inactive" | "unknown" | null;
  connections: number;
  error: string | null;
  unavailable: string | null;
  backupUrl: string | null;
  warning: string | null;
};

const FIELDS =
  "enabled hostname status connections error unavailable backupUrl warning";

type Pending =
  { kind: "on"; host: string; token: string } | { kind: "off"; host: string };

export function PanelTunnelCard({ settings }: { settings: InstanceSettings }) {
  const router = useRouter();
  const [tunnel, setTunnel] = React.useState<PanelTunnel | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const [pending, setPending] = React.useState<Pending | null>(null);
  // What the confirm last showed, so its text holds still while it closes.
  const [shown, setShown] = React.useState<Pending | null>(null);
  if (pending && pending !== shown) setShown(pending);
  const view = pending ?? shown;

  React.useEffect(() => {
    void (async () => {
      const res = await gqlAction<{ panelTunnel: PanelTunnel }>(
        `mutation PanelTunnel { panelTunnel { ${FIELDS} } }`,
      );
      setLoading(false);
      if (res.ok) setTunnel(res.data?.panelTunnel ?? null);
    })();
  }, []);

  const on = tunnel ? tunnel.enabled : !!settings.panelTunnelHostname;
  const hostname = tunnel?.hostname ?? settings.panelTunnelHostname;
  const connected =
    !!tunnel && (tunnel.status === "healthy" || tunnel.connections > 0);

  function settle(res: ActionResult<PanelTunnel | null>) {
    if (!res.ok) return res;
    const next = res.data ?? null;
    setTunnel(next);
    if (next?.warning) toast.warning(next.warning);
    router.refresh();
    return res;
  }

  async function turnOn(host: string, token: string) {
    return settle(
      await gqlAction<{ setPanelTunnel: PanelTunnel }, PanelTunnel | null>(
        `mutation SetPanelTunnel($hostname: String!, $apiToken: String) {
          setPanelTunnel(hostname: $hostname, apiToken: $apiToken) { ${FIELDS} }
        }`,
        { hostname: host, apiToken: token || null },
        (d) => d.setPanelTunnel,
      ),
    );
  }

  async function turnOff(host: string) {
    return settle(
      await gqlAction<{ disablePanelTunnel: PanelTunnel }, PanelTunnel | null>(
        `mutation DisablePanelTunnel($url: String) {
          disablePanelTunnel(url: $url) { ${FIELDS} }
        }`,
        { url: `https://${host}` },
        (d) => d.disablePanelTunnel,
      ),
    );
  }

  return (
    <SettingItem
      icon={CloudflareIcon}
      title="Cloudflare Tunnel"
      htmlFor="panel-tunnel"
      info="Cloudflare carries the panel's traffic over a connection this server opens, so the panel works behind a home or office router."
      docs="panel.tunnel"
      badge={
        !loading &&
        (!on ? (
          <Badge variant="muted">Off</Badge>
        ) : connected ? (
          <Badge variant="muted">Connected</Badge>
        ) : (
          <Badge variant="warning">Not connected</Badge>
        ))
      }
      description={
        <TunnelStatus tunnel={tunnel} loading={loading} hostname={hostname} />
      }
      control={
        <Switch
          id="panel-tunnel"
          checked={on}
          disabled={loading || (!on && !!tunnel?.unavailable)}
          onCheckedChange={(next) =>
            next ? setEditing(true) : setLeaving(true)
          }
          aria-label="Cloudflare Tunnel"
        />
      }
    >
      {on && hostname && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">https://{hostname}</span>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Change address
          </Button>
        </div>
      )}

      <TunnelSetupDialog
        open={editing}
        onOpenChange={setEditing}
        current={on ? hostname : null}
        onContinue={(host, token) => {
          setEditing(false);
          setPending({ kind: "on", host, token });
        }}
      />
      <TunnelOffDialog
        open={leaving}
        onOpenChange={setLeaving}
        backupUrl={tunnel?.backupUrl ?? null}
        onContinue={(host) => {
          setLeaving(false);
          setPending({ kind: "off", host });
        }}
      />
      <PanelAddressDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        url={view ? `https://${view.host}` : ""}
        title={
          view?.kind === "off"
            ? `Move the panel to https://${view.host}?`
            : `Serve the panel at https://${view?.host ?? ""}?`
        }
        unchangedDescription="The address stays, and Cloudflare starts carrying its traffic."
        confirmLabel={
          view?.kind === "off"
            ? "Turn off the tunnel"
            : on
              ? "Change address"
              : "Turn on the tunnel"
        }
        successMessage={
          view?.kind === "off"
            ? `The panel moved to https://${view.host}`
            : `Cloudflare now serves the panel at https://${view?.host ?? ""}`
        }
        notes={
          view?.kind === "off"
            ? [
                {
                  severity: "manual" as const,
                  text: "This address has to reach this server from the internet, or the panel stays on the tunnel",
                },
                {
                  severity: "minor" as const,
                  text: "Deplo deletes the tunnel and its DNS record in Cloudflare",
                },
                PROXY_RESTARTS,
              ]
            : [
                {
                  severity: "minor" as const,
                  text: `Deplo creates the tunnel in Cloudflare and points ${view?.host ?? "the address"} at it`,
                },
                PROXY_RESTARTS,
              ]
        }
        onConfirm={() =>
          view?.kind === "off"
            ? turnOff(view.host)
            : turnOn(view?.host ?? "", view?.kind === "on" ? view.token : "")
        }
      />
    </SettingItem>
  );
}

const PROXY_RESTARTS = {
  severity: "minor" as const,
  text: "The proxy restarts: sites on this server are unreachable for a few seconds",
};

function TunnelStatus({
  tunnel,
  loading,
  hostname,
}: {
  tunnel: PanelTunnel | null;
  loading: boolean;
  hostname: string | null;
}) {
  if (loading) return " ";
  if (!tunnel?.enabled) {
    if (tunnel?.unavailable) return tunnel.unavailable;
    return "Reach the panel through Cloudflare, with no port to open on this server.";
  }
  if (tunnel.status === "unknown")
    return tunnel.error ?? "Cloudflare did not say how the tunnel is doing.";
  if (tunnel.status === "healthy" || tunnel.connections > 0)
    return `Cloudflare serves ${hostname}, certificate included.`;
  return (
    <span className="text-[var(--warning)]">
      The tunnel is not connected. Check that this server can reach the
      internet.
    </span>
  );
}

function HostInput({
  id,
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-sm text-muted-foreground select-none">
        https://
      </span>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(hostPart(e.target.value))}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        className="w-full pl-[calc(0.75rem_+_8ch)] font-mono text-sm"
      />
    </div>
  );
}

function TunnelSetupDialog({
  open,
  onOpenChange,
  current,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: string | null;
  onContinue: (host: string, token: string) => void;
}) {
  const [host, setHost] = React.useState(current ?? "");
  const [token, setToken] = React.useState("");
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setHost(current ?? "");
      setToken("");
    }
  }

  const ready = !!host.trim() && (!!token.trim() || !!current);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {current
              ? "Change the tunnel's address"
              : "Serve the panel through Cloudflare"}
          </DialogTitle>
          <DialogDescription>
            Deplo creates the tunnel and its DNS record in your Cloudflare
            account.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) onContinue(host.trim(), token.trim());
          }}
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <FieldLabel
                htmlFor="panel-tunnel-host"
                info="A name in a domain on your Cloudflare account. Deplo points it at the tunnel."
              >
                Address
              </FieldLabel>
              <HostInput
                id="panel-tunnel-host"
                value={host}
                onChange={setHost}
                placeholder="deplo.example.com"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <FieldLabel
                htmlFor="panel-tunnel-token"
                info="Deplo keeps it encrypted, and uses it to create, check and delete the tunnel."
              >
                Cloudflare API token
              </FieldLabel>
              <Input
                id="panel-tunnel-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={current ? "Leave empty to keep the saved one" : ""}
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Needs Cloudflare Tunnel: Edit and DNS: Edit.{" "}
                <a
                  href={CLOUDFLARE_TOKEN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Create one
                </a>
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TunnelOffDialog({
  open,
  onOpenChange,
  backupUrl,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  backupUrl: string | null;
  onContinue: (host: string) => void;
}) {
  const [host, setHost] = React.useState("");
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setHost(backupUrl ? hostPart(backupUrl) : "");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn off the Cloudflare Tunnel?</DialogTitle>
          <DialogDescription>
            The panel moves to the address below, and{" "}
            <strong>Cloudflare stops carrying its traffic</strong>.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (host.trim()) onContinue(host.trim());
          }}
        >
          <div className="space-y-2">
            <FieldLabel
              htmlFor="panel-tunnel-off-host"
              info="Its backup address by default. A domain works too, once its DNS points at this server."
            >
              Move the panel to
            </FieldLabel>
            <HostInput
              id="panel-tunnel-off-host"
              value={host}
              onChange={setHost}
              placeholder="deplo.example.com"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!host.trim()}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
