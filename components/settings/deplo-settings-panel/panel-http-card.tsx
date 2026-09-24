"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { PanelAddressDialog } from "@/components/settings/panel-address-dialog";
import { gqlAction } from "@/lib/graphql-client";
import { SettingItem } from "./setting-item";

export type PanelHttps = {
  domain: string | null;
  fallbackDomain: string | null;
  enabled: boolean;
  certificateTrusted: boolean | null;
  unavailable: string | null;
};

const PANEL_HTTPS_FIELDS =
  "domain fallbackDomain enabled certificateTrusted unavailable";

export function usePanelHttps(): {
  cert: PanelHttps | null;
  loading: boolean;
  setCert: (c: PanelHttps | null) => void;
} {
  const [cert, setCert] = React.useState<PanelHttps | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    void (async () => {
      const res = await gqlAction<{ panelHttps: PanelHttps }>(
        `mutation PanelHttps { panelHttps { ${PANEL_HTTPS_FIELDS} } }`,
      );
      setLoading(false);
      if (res.ok) setCert(res.data?.panelHttps ?? null);
    })();
  }, []);

  return { cert, loading, setCert };
}

export function PanelHttpCard() {
  const router = useRouter();
  const { cert, loading, setCert } = usePanelHttps();
  const [confirming, setConfirming] = React.useState(false);

  async function turnOff() {
    const res = await gqlAction<{ setPanelHttps: PanelHttps }>(
      `mutation SetPanelHttps($enabled: Boolean!) {
        setPanelHttps(enabled: $enabled) { ${PANEL_HTTPS_FIELDS} }
      }`,
      { enabled: !cert?.enabled },
    );
    if (!res.ok) return res;
    setCert(res.data?.setPanelHttps ?? null);
    router.refresh();
    return res;
  }

  const enabled = cert?.enabled ?? true;
  const untrusted = !!cert?.enabled && cert.certificateTrusted === false;
  return (
    <SettingItem
      icon={ShieldCheck}
      title="HTTPS"
      htmlFor="panel-http"
      info="Off serves the panel over plain http, for an internal network where no certificate can be issued. Passwords then cross the network in clear."
      docs="panel.https"
      badge={
        cert &&
        (!cert.enabled ? (
          <Badge variant="destructive">Off</Badge>
        ) : untrusted ? (
          <Badge variant="warning">Self-signed</Badge>
        ) : (
          <Badge variant="muted">On</Badge>
        ))
      }
      description={<HttpsStatus cert={cert} loading={loading} />}
      control={
        <Switch
          id="panel-http"
          checked={enabled}
          disabled={loading || !cert || !!cert.unavailable}
          onCheckedChange={() => setConfirming(true)}
          aria-label="HTTPS"
        />
      }
    >
      {cert?.domain && (
        <PanelAddressDialog
          open={confirming}
          onOpenChange={(o) => !o && setConfirming(false)}
          url={`${enabled ? "http" : "https"}://${cert.domain}`}
          title={
            enabled
              ? `Serve the panel at http://${cert.domain}?`
              : `Serve the panel at https://${cert.domain}?`
          }
          confirmLabel={enabled ? "Turn HTTPS off" : "Turn HTTPS on"}
          successMessage={
            enabled
              ? "The panel is now served over http"
              : "The panel is now served over https"
          }
          notes={[
            enabled
              ? {
                  severity: "critical" as const,
                  text: "Anyone signing in sends their password unencrypted, and that is on you",
                }
              : {
                  severity: "manual" as const,
                  text: "The address has to reach this server from the internet for the certificate to be issued",
                },
            {
              severity: "minor" as const,
              text: "The proxy restarts: sites on this server are unreachable for a few seconds",
            },
          ]}
          onConfirm={turnOff}
        />
      )}
    </SettingItem>
  );
}

function HttpsStatus({
  cert,
  loading,
}: {
  cert: PanelHttps | null;
  loading: boolean;
}) {
  if (loading)
    return <span className="block h-4 w-64 animate-pulse rounded bg-muted" />;
  if (!cert) return null;
  if (cert.unavailable) return cert.unavailable;
  if (!cert.enabled)
    return (
      <span className="text-[var(--warning)]">
        Anyone signing in sends their password unencrypted.
      </span>
    );
  if (cert.certificateTrusted === false)
    return "The browser does not recognise this certificate. Set your own domain under General to get one it does.";
  return "Let's Encrypt issues the certificate, and renews it on its own.";
}
