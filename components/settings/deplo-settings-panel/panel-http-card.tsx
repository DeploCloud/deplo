"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { PanelAddressDialog } from "@/components/settings/panel-address-dialog";
import { gqlAction } from "@/lib/graphql-client";

type PanelHttps = {
  domain: string | null;
  enabled: boolean;
  certificateTrusted: boolean | null;
  unavailable: string | null;
};

const PANEL_HTTPS_FIELDS = "domain enabled certificateTrusted unavailable";

// usePanelHttps: reads the panel's own route off the host that serves it.
function usePanelHttps(): {
  cert: PanelHttps | null;
  loading: boolean;
  setCert: (c: PanelHttps | null) => void;
} {
  const [cert, setCert] = React.useState<PanelHttps | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    // Opening the page IS the read, same as the certificate accounts.
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

// PanelHttpCard: the one way to serve the panel over plain http.
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
    // The scheme moved the STORED address with it, and that address is what the
    // General tab renders: without this it would keep showing the old one.
    router.refresh();
    return res;
  }

  const enabled = cert?.enabled ?? true;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4 text-muted-foreground" />
          Serve the panel over plain HTTP
        </CardTitle>
        <CardDescription>
          For a panel on an internal network, where no certificate can be
          issued.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <PanelServingRow cert={cert} loading={loading} />
        <div className="flex items-center justify-between gap-4">
          <FieldLabel
            htmlFor="panel-http"
            info="Every password and session cookie then crosses the network in clear, and passkeys stop working entirely."
            docs="panel.https"
          >
            Turn HTTPS off
          </FieldLabel>
          <Switch
            id="panel-http"
            checked={!enabled}
            disabled={loading || !cert || !!cert.unavailable}
            onCheckedChange={() => setConfirming(true)}
            aria-label="Serve the panel over plain HTTP"
          />
        </div>
      </CardContent>

      {/* The SAME confirm the address field opens: the scheme is half of an origin,
          so turning https off takes every passkey with it as a new hostname would. */}
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
    </Card>
  );
}

// PanelServingRow: the certificate's own state, which the switch below it does not say.
function PanelServingRow({
  cert,
  loading,
}: {
  cert: PanelHttps | null;
  loading: boolean;
}) {
  // The real box, not a guessed height, so the row settles in place.
  if (loading)
    return (
      <div className="rounded-lg border border-border p-3">
        <HttpsLabel />
        <span className="mt-2 block h-4 w-64 animate-pulse rounded bg-muted" />
      </div>
    );
  if (!cert) return null;

  const untrusted = cert.enabled && cert.certificateTrusted === false;
  return (
    <div className="rounded-lg border border-border p-3">
      <HttpsLabel>
        {cert.enabled ? (
          untrusted ? (
            <Badge variant="warning">Self-signed</Badge>
          ) : (
            <Badge variant="muted">Always on</Badge>
          )
        ) : (
          <Badge variant="destructive">Off</Badge>
        )}
      </HttpsLabel>
      {cert.unavailable ? (
        <p className="mt-1 text-sm text-muted-foreground">{cert.unavailable}</p>
      ) : !cert.enabled ? (
        <p className="mt-1 text-sm text-[var(--warning)]">
          Anyone signing in sends their password unencrypted.
        </p>
      ) : untrusted ? (
        <p className="mt-1 text-sm text-muted-foreground">
          The browser does not recognise this certificate. Set your own domain
          under General to get one it does.
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          Let&apos;s Encrypt issues the certificate, and renews it on its own.
        </p>
      )}
    </div>
  );
}

// HttpsLabel: the HTTPS row's fixed half, drawn while loading too so the box is
// already the height it will settle at.
function HttpsLabel({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium">
      <ShieldCheck className="size-4 text-muted-foreground" />
      HTTPS
      {children}
      <InfoTip
        content="The panel is served over HTTPS and nothing else. Plain http is an advanced opt-out for an address no certificate can be issued for."
        docs="panel.https"
      />
    </div>
  );
}
