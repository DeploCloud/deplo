"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter, useSearchParams } from "@/lib/nav";
import { toast } from "sonner";
import {
  CheckCircle2,
  CircleFadingArrowUp,
  Globe,
  LifeBuoy,
  Loader2,
  Pencil,
  Server as ServerIcon,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { CopyButton } from "@/components/shared/copy-button";
import { CloudflareNote } from "@/components/domains/cloudflare-note";
import { RevealChip } from "@/components/shared/reveal-chip";
import { PanelAddressDialog } from "@/components/settings/panel-address-dialog";
import {
  DeploUpdatesTab,
  type FleetSummary,
} from "@/components/settings/deplo-updates-tab";
import {
  DeploDiagnosticsCard,
  type DiagnosticHost,
} from "@/components/settings/deplo-diagnostics-card";
import { LogsRetentionCard } from "@/components/settings/logs-retention-card";
import { GravatarCard } from "@/components/settings/gravatar-card";
import {
  InstanceOwnerCard,
  type OwnerCandidate,
} from "@/components/settings/instance-owner-card";
import { gqlAction } from "@/lib/graphql-client";
import type { InstanceSettings, PanelDns } from "@/lib/data/instance-settings";

/**
 * Settings, Deplo: the instance itself. Two knobs live here because they are the
 * two facts that belong to no team and to no single host, and because both used to
 * be install-time environment variables that only an SSH session could change: 1.
 */

type CertificateAccount = {
  serverId: string;
  serverName: string;
  email: string | null;
  unavailable: string | null;
  customCertificates: number;
  expiresInDays: number | null;
};

type PanelHttps = {
  domain: string | null;
  enabled: boolean;
  certificateTrusted: boolean | null;
  unavailable: string | null;
};

const ACCOUNT_FIELDS =
  "serverId serverName email unavailable customCertificates expiresInDays";

const PANEL_HTTPS_FIELDS = "domain enabled certificateTrusted unavailable";

const TABS = ["general", "advanced", "updates"] as const;
type TabId = (typeof TABS)[number];

export function DeploSettingsPanel({
  settings,
  viewerIsOwner,
  ownerCandidates,
  fleet,
  hosts,
}: {
  settings: InstanceSettings;
  viewerIsOwner: boolean;
  ownerCandidates: OwnerCandidate[];
  fleet: FleetSummary;
  hosts: DiagnosticHost[];
}) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const active: TabId = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as TabId)
    : "general";

  function selectTab(tab: string) {
    const next = new URLSearchParams(params.toString());
    if (tab === "general") next.delete("tab");
    else next.set("tab", tab);
    const s = next.toString();
    // The native History API, not `router.replace`: the panels are already in the
    // browser and re-running every server read would be a page load to move an
    // underline.
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }

  return (
    <Tabs value={active} onValueChange={selectTab} className="space-y-3">
      <UnderlineTabsList>
        <UnderlineTabsTrigger value="general">
          <Globe className="size-4" />
          General
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="advanced">
          <SlidersHorizontal className="size-4" />
          Advanced
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="updates">
          <CircleFadingArrowUp className="size-4" />
          Updates
        </UnderlineTabsTrigger>
      </UnderlineTabsList>

      <TabsContent value="general">
        {/* Direct grid children, so the address and the certificates share one
            row's height instead of each ending wherever its own content stops. */}
        <div className="grid gap-4 lg:grid-cols-2">
          <PanelAddressCard settings={settings} />
          <CertificatesCard />
          {/* Last, because handing the instance over is the most consequential
              thing on this page - the same reason a team's delete card sits at
              the bottom of Settings, General. */}
          <div className="lg:col-span-2">
            <InstanceOwnerCard
              ownerName={settings.ownerName}
              viewerIsOwner={viewerIsOwner}
              candidates={ownerCandidates}
            />
          </div>
        </div>
      </TabsContent>

      <TabsContent value="advanced">
        <div className="grid gap-4 lg:grid-cols-2">
          <LogsRetentionCard logMaxDays={settings.logMaxDays} />
          <GravatarCard enabled={settings.gravatarEnabled} />
          <div className="lg:col-span-2">
            <DeploDiagnosticsCard
              version={settings.version}
              panelUrl={settings.panelUrl}
              panelUrlSource={SOURCE_LABEL[settings.panelUrlSource]}
              deploHostName={settings.deploHostName}
              expectedAgentVersion={fleet.expected}
              hosts={hosts}
            />
          </div>
          {/* Last: the most consequential switch on the page, same reason the
              ownership card sits at the bottom of General. */}
          <div className="lg:col-span-2">
            <PanelHttpCard />
          </div>
        </div>
      </TabsContent>

      {/* Mounted throughout, so the changelog it fetched survives a flip to
          General and back - and so nothing is fetched until it is opened. */}
      <TabsContent
        value="updates"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        <DeploUpdatesTab
          active={active === "updates"}
          version={settings.version}
          fleet={fleet}
        />
      </TabsContent>
    </Tabs>
  );
}

/* ------------------------------------------------------------------ */
/* The panel address                                                   */
/* ------------------------------------------------------------------ */

/** Where the address came from. The diagnostics dump names all three; the card's
 *  badge shows only the two the reader could not already tell. */
const SOURCE_LABEL: Record<InstanceSettings["panelUrlSource"], string> = {
  stored: "Set here",
  environment: "From the installer",
  request: "Guessed from your browser",
};

/** An address without its scheme: the field edits the host, the prefix is fixed. */
const hostPart = (url: string) => url.replace(/^https?:\/\//i, "");

function PanelAddressCard({ settings }: { settings: InstanceSettings }) {
  const router = useRouter();
  const current = settings.storedPanelUrl ?? settings.panelUrl;
  // The scheme is the HTTPS setting's, not something to type here: it moves with
  // the switch under Advanced and with nothing else.
  const scheme = current.startsWith("http://") ? "http" : "https";
  const [value, setValue] = React.useState(hostPart(current));
  const [confirming, setConfirming] = React.useState(false);

  // Adopt a fresh server render (a save ends in router.refresh()) as the new
  // baseline, the supported "adjust state during render" pattern.
  const [seen, setSeen] = React.useState(settings);
  if (seen !== settings) {
    setSeen(settings);
    setValue(hostPart(current));
  }

  const host = value.trim();
  const target = host ? `${scheme}://${host}` : "";
  const dirty = target !== current;

  // What DNS says about the address the panel actually answers on. Read once on
  // open and again after a save, never while typing: the answer is about the
  // stored address, and resolving on every keystroke would answer about neither.
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
    // Opening the page IS the read - the same scoped exemption the certificate
    // accounts and the https row below take.
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
      {/* The badge says where an address NOBODY set here came from. "Set here"
          was the field below saying what the field below already is. */}
      <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <Globe className="size-4" />
          Panel address
          <InfoTip
            content="Install commands, deploy hooks and invite links are built from this address. Deplo can hand it out, it cannot move your DNS: point the record below at this server first."
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
          {/* Default size, not `sm`: it sits on a row with an h-9 Input. */}
          <Button type="submit" disabled={!dirty || !target}>
            Save
          </Button>
        </form>

        <PanelDnsBlock dns={dns} serverIp={settings.deploHostIp} />

        <PanelFallbackRow
          url={settings.panelFallbackUrl}
          panelUrl={settings.panelUrl}
        />
      </CardContent>

      {/* Mounted with the card, not with the dialog: the consequences are
          counted while the address is being typed, so the confirm opens on its
          numbers. An address that is not a change is not counted at all. */}
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

/**
 * Where the panel's address actually points, so the DNS instruction appears only
 * when there is a record to create - and never in front of one that already works.
 */
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

  // Nothing to check: a bare IP needs no record, and without the host's own
  // address Deplo cannot say which one to point at.
  if (dns.status === "unknown")
    return serverIp ? null : (
      <p className="text-sm text-muted-foreground">
        Add this server on Settings, Servers and Deplo can tell you which
        address to point it at.
      </p>
    );

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
        <p className="mt-1 text-sm text-muted-foreground">
          Add this server on Settings, Servers and Deplo can tell you which
          address to point it at.
        </p>
      )}
    </div>
  );
}

/**
 * The generated address the panel also answers on, whatever its domain is doing.
 */
function PanelFallbackRow({
  url,
  panelUrl,
}: {
  url: string | null;
  panelUrl: string;
}) {
  const [revealed, setRevealed] = React.useState(false);
  // Nothing to say when the panel is already reached this way: it would be the
  // same address twice, one of them labelled the fallback.
  if (!url || url === panelUrl) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <LifeBuoy className="size-4 text-muted-foreground" />
          Backup address
          <Badge variant="muted">Always on</Badge>
          <InfoTip
            content="Deplo generates this address from the server's own IP, so it resolves here with no DNS to set up. Use the address above day to day."
            docs="panel.address"
          />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Works even when the domain above stops answering. It cannot be turned
          off.
        </p>
      </div>
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
    </div>
  );
}

/** Read the panel's own route off the host that serves it. */
function usePanelHttps(): {
  cert: PanelHttps | null;
  loading: boolean;
  setCert: (c: PanelHttps | null) => void;
} {
  const [cert, setCert] = React.useState<PanelHttps | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    // Opening the page IS the read, same as the certificate accounts below.
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

/**
 * How the panel is served: the certificate's own state, which the switch below it
 * does not say. Reads the card's `cert` rather than its own, one query per tab.
 */
function PanelServingRow({
  cert,
  loading,
}: {
  cert: PanelHttps | null;
  loading: boolean;
}) {
  // The real box, not a guessed height, so the row settles in place instead of
  // growing out of a bar that was never the same size as it.
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
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="size-4 text-muted-foreground" />
        HTTPS
        {cert.enabled ? (
          untrusted ? (
            <Badge variant="warning">Self-signed</Badge>
          ) : (
            <Badge variant="muted">Always on</Badge>
          )
        ) : (
          <Badge variant="destructive">Off</Badge>
        )}
        <InfoTip
          content="The panel is served over HTTPS and nothing else. Plain http is an advanced opt-out for an address no certificate can be issued for."
          docs="panel.https"
        />
      </div>
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

/**
 * The one way to serve the panel over plain http, under Advanced because the one
 * case for it is an address no certificate can be issued for.
 */
function PanelHttpCard() {
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
            info="Every password and every session cookie then crosses the network in clear, and passkeys stop working entirely. Leave it on HTTPS unless the address genuinely cannot be issued a certificate."
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

      {/**
       * The SAME confirm the address field opens, because this is the same move:
       * the scheme is half of an origin, so turning https off takes every passkey
       * with it exactly as a new hostname would.
       */}
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

/** The HTTPS row's fixed half, drawn while loading too so the box is already
 *  the height it will settle at. */
function HttpsLabel() {
  return (
    <div className="flex items-center gap-2 text-sm font-medium">
      <ShieldCheck className="size-4 text-muted-foreground" />
      HTTPS
      <InfoTip
        content="The panel is served over HTTPS and nothing else. Plain http is an advanced opt-out for an address no certificate can be issued for."
        docs="panel.https"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Certificates                                                        */
/* ------------------------------------------------------------------ */

function CertificatesCard() {
  const [accounts, setAccounts] = React.useState<CertificateAccount[] | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [email, setEmail] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await gqlAction<{
      serverCertificateAccounts: CertificateAccount[];
    }>(
      `mutation ServerCertificateAccounts {
        serverCertificateAccounts { ${ACCOUNT_FIELDS} }
      }`,
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const next = res.data?.serverCertificateAccounts ?? [];
    setAccounts(next);
    // Prefill only when the fleet agrees with itself. When it does not, the
    // field starts empty: guessing which host is the right one would be a
    // silent vote for one of them.
    const found = [
      ...new Set(next.map((a) => a.email).filter((e): e is string => !!e)),
    ];
    setEmail(found.length === 1 ? found[0] : "");
  }, []);

  React.useEffect(() => {
    // Opening the page IS the read: it synchronises with an external system (the
    // servers' agents) and `load` manages its own state. Same scoped exemption as
    // the server Advanced tab's host probe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const manageable = (accounts ?? []).filter((a) => !a.unavailable);
  const dirty =
    email.trim() !== "" &&
    manageable.some((a) => a.email !== email.trim().toLowerCase());

  function apply() {
    startTransition(async () => {
      const res = await gqlAction<{
        setCertificateEmail: CertificateAccount[];
      }>(
        `mutation SetCertificateEmail($email: String!) {
          setCertificateEmail(email: $email) { ${ACCOUNT_FIELDS} }
        }`,
        { email: email.trim() },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setConfirming(false);
      const next = res.data?.setCertificateEmail ?? [];
      setAccounts(next);
      const done = next.filter(
        (a) => !a.unavailable && a.email === email.trim().toLowerCase(),
      );
      const failed = next.filter((a) => a.unavailable);
      if (done.length === 0) {
        toast.error("No server accepted the change");
      } else {
        toast.success(
          `Certificates on ${done.length} server${done.length === 1 ? "" : "s"} are now registered to ${email.trim()}`,
        );
      }
      // Skipped hosts are named, not folded into the count: an operator who does
      // not know a host was left behind finds out when its certificate expires.
      if (failed.length > 0) {
        toast.warning(
          `Left alone: ${failed.map((a) => `${a.serverName} (${a.unavailable})`).join(", ")}`,
        );
      }
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            Certificates
            <InfoTip
              content="Deplo issues HTTPS certificates for your apps through Let's Encrypt. Expiry and revocation notices go to this address, on every server, so use one somebody reads."
              docs="panel.certEmail"
            />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) setConfirming(true);
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="acme-email"
                type="email"
                aria-label="Certificate account email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ops@example.com"
                autoComplete="off"
                disabled={pending || loading}
                className="w-full max-w-xs"
              />
              <Button type="submit" disabled={pending || loading || !dirty}>
                {pending ? "Applying" : "Save"}
              </Button>
            </div>

            {loading ? (
              <div className="h-[5.5rem] animate-pulse rounded-lg bg-muted/50" />
            ) : error ? (
              <p className="text-sm text-muted-foreground">{error}</p>
            ) : accounts && accounts.length > 0 ? (
              // One bordered list, not a stack of boxes: these rows are the same
              // fact per host, and reading down the column is how a fleet that
              // disagrees with itself becomes visible.
              <div className="divide-y divide-border rounded-lg border border-border">
                {accounts.map((account) => (
                  <div
                    key={account.serverId}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5 pr-2 pl-3"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                      <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{account.serverName}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      {/**
                       * Nothing renews a certificate someone installed by hand, and the tab that holds it
                       * is not one anybody opens on a normal day.
                       */}
                      <CertificateExpiry account={account} />
                      <span
                        className={
                          account.unavailable
                            ? "text-xs text-muted-foreground"
                            : "font-mono text-xs text-muted-foreground"
                        }
                      >
                        {account.unavailable ??
                          (account.email || "No address set")}
                      </span>
                      {/* Straight to THIS server's certificates: the fleet-wide
                          email is edited above, everything else about a host's
                          certificates belongs to the host. */}
                      <Button variant="ghost" size="sm" asChild>
                        <Link
                          href={`/settings/servers/${account.serverId}?tab=certificates`}
                        >
                          <Pencil className="size-4" />
                          Edit
                        </Link>
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No servers connected yet.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={confirming}
        onOpenChange={(o) => !o && setConfirming(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register certificates to {email.trim()}?</DialogTitle>
            <DialogDescription>
              Deplo restarts the proxy on {manageable.length} server
              {manageable.length === 1 ? "" : "s"}.{" "}
              <strong>Sites there blink for a few seconds.</strong>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={apply} disabled={pending}>
              {pending ? "Applying" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * When this host's own certificates run out.
 */
function CertificateExpiry({ account }: { account: CertificateAccount }) {
  const days = account.expiresInDays;
  if (account.customCertificates === 0 || days === null || days > 21)
    return null;
  return (
    <Badge variant="destructive">
      <TriangleAlert className="size-3" />
      {days < 0
        ? "Certificate expired"
        : days === 0
          ? "Certificate expires today"
          : `Certificate expires in ${days} day${days === 1 ? "" : "s"}`}
    </Badge>
  );
}
