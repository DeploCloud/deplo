"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  Globe,
  Loader2,
  Pencil,
  Server as ServerIcon,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { DeploMark } from "@/components/logo";
import { gqlAction } from "@/lib/graphql-client";
import type { InstanceSettings } from "@/lib/data/instance-settings";

/**
 * Settings, Deplo: the instance itself.
 *
 * Two knobs live here because they are the two facts that belong to no team and
 * to no single host, and because both used to be install-time environment
 * variables that only an SSH session could change:
 *
 *  1. The address Deplo hands out for itself (install commands, deploy hooks,
 *     invite links), and whether it is served over https at all. Deplo cannot
 *     move its own DNS, so the honest thing to offer alongside the field is
 *     proof: the Check button asks the address whether it reaches this instance
 *     and reports what answered instead when it does not.
 *  2. The account certificates are issued under, read from and written to each
 *     host's own proxy, and shown per host so a fleet that disagrees with itself
 *     says so rather than hiding behind one field.
 *
 * The certificate half is fetched after mount, never during the page render: a
 * settings page must not be as slow as the sickest server it describes.
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
  provider: string | null;
  unavailable: string | null;
};

const ACCOUNT_FIELDS =
  "serverId serverName email unavailable customCertificates expiresInDays";

const PANEL_HTTPS_FIELDS = "domain enabled provider unavailable";

export function DeploSettingsPanel({ settings }: { settings: InstanceSettings }) {
  return (
    <>
      <PanelAddressCard settings={settings} />
      <CertificatesCard />
      <InstanceCard settings={settings} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The panel address                                                   */
/* ------------------------------------------------------------------ */

const SOURCE_LABEL: Record<InstanceSettings["panelUrlSource"], string> = {
  stored: "Set here",
  environment: "From the installer",
  request: "Guessed from your browser",
};

function PanelAddressCard({ settings }: { settings: InstanceSettings }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [checking, setChecking] = React.useState(false);
  const [value, setValue] = React.useState(settings.storedPanelUrl ?? settings.panelUrl);
  const [reach, setReach] = React.useState<{ ok: boolean; error: string | null } | null>(null);

  // Adopt a fresh server render (a save ends in router.refresh()) as the new
  // baseline, the supported "adjust state during render" pattern.
  const [seen, setSeen] = React.useState(settings);
  if (seen !== settings) {
    setSeen(settings);
    setValue(settings.storedPanelUrl ?? settings.panelUrl);
  }

  const dirty = value.trim() !== (settings.storedPanelUrl ?? settings.panelUrl);

  async function check(url: string) {
    setChecking(true);
    const res = await gqlAction<{ checkPanelUrl: { ok: boolean; error: string | null } }>(
      `mutation CheckPanelUrl($url: String!) {
        checkPanelUrl(url: $url) { ok error }
      }`,
      { url },
    );
    setChecking(false);
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    setReach(res.data?.checkPanelUrl ?? null);
    return res.data?.checkPanelUrl ?? null;
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation SetPanelUrl($url: String) { setPanelUrl(url: $url) { panelUrl } }`,
        { url: value.trim() || null },
      );
      // Surfaces the validation refusals verbatim: they name the fix.
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        value.trim() ? `Deplo now calls itself ${value.trim()}` : "Panel address cleared",
      );
      router.refresh();
      // Saving does not make an address answer, so the answer is checked right
      // after: a stored address that nothing routes to would quietly break every
      // install command copied from here.
      if (value.trim()) {
        const result = await check(value.trim());
        if (result && !result.ok) toast.warning(result.error ?? "That address did not answer");
      } else {
        setReach(null);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4" />
          Panel address
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          The address Deplo uses for itself in install commands, deploy hooks and
          invite links.
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save}>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground">In use right now</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm break-all">{settings.panelUrl}</span>
              <Badge variant="muted">{SOURCE_LABEL[settings.panelUrlSource]}</Badge>
              {reach ? (
                reach.ok ? (
                  <Badge variant="muted" className="gap-1">
                    <Check className="size-3" />
                    Answers
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1">
                    <TriangleAlert className="size-3" />
                    No answer
                  </Badge>
                )
              ) : null}
            </div>
            {reach && !reach.ok ? (
              <p className="mt-1 text-sm text-destructive">{reach.error}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <FieldLabel
              htmlFor="panel-url"
              info="A domain like deplo.example.com becomes https://. Point its DNS at this server and route it to the panel first: Deplo can hand out the address, but it cannot move your DNS."
            >
              Address
            </FieldLabel>
            <Input
              id="panel-url"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="deplo.example.com"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              className="max-w-md font-mono text-sm"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending || !dirty}>
              {pending ? "Saving" : "Save address"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={checking || pending || !value.trim()}
              onClick={() => void check(value.trim())}
            >
              {checking ? <Loader2 className="size-4 animate-spin" /> : null}
              {checking ? "Checking" : "Check it answers"}
            </Button>
            {settings.storedPanelUrl ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setValue("");
                  setReach(null);
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          {settings.storedPanelUrl ? null : (
            <p className="text-xs text-muted-foreground">
              Nothing is set here yet, so Deplo uses the address it was installed
              with. Saving one takes over from it.
            </p>
          )}
        </form>
        <PanelHttpsRow />
      </CardContent>
    </Card>
  );
}

/**
 * How the panel itself is served, on the card about the panel's own address -
 * because it is a fact about that address, not about the fleet's certificates
 * below.
 *
 * The off switch is the one that matters: a Deplo on a domain that cannot get a
 * certificate yet greets its first visitor with a browser warning, on a page
 * nobody has logged into. Plain http is the way out of that, and it has to be
 * reachable from the panel, because the alternative is an SSH session.
 *
 * Fetched after mount for the same reason the accounts are: it reads the live
 * proxy config off the host, and the settings page must not be as slow as the
 * sickest server it describes.
 */
function PanelHttpsRow() {
  const [cert, setCert] = React.useState<PanelHttps | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [confirming, setConfirming] = React.useState<boolean | null>(null);
  const [pending, startTransition] = React.useTransition();

  const load = React.useCallback(async () => {
    const res = await gqlAction<{ panelHttps: PanelHttps }>(
      `mutation PanelHttps { panelHttps { ${PANEL_HTTPS_FIELDS} } }`,
    );
    setLoading(false);
    if (res.ok) setCert(res.data?.panelHttps ?? null);
  }, []);

  React.useEffect(() => {
    // Opening the page IS the read: same scoped exemption as the accounts below.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function toggle(enabled: boolean) {
    startTransition(async () => {
      const res = await gqlAction<{ setPanelHttps: PanelHttps }>(
        `mutation SetPanelHttps($enabled: Boolean!) {
          setPanelHttps(enabled: $enabled) { ${PANEL_HTTPS_FIELDS} }
        }`,
        { enabled },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setCert(res.data?.setPanelHttps ?? null);
      setConfirming(null);
      toast.success(
        enabled
          ? "The panel is now served over https"
          : "The panel is now served over http",
      );
    });
  }

  if (loading) return <div className="mt-4 h-14 animate-pulse rounded-lg bg-muted/50" />;
  if (!cert) return null;

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-muted-foreground" />
            HTTPS
            <InfoTip content="Turn this off when the address cannot get a certificate: it does not resolve publicly yet, port 80 is closed, or the server is on an internal network. You can turn it back on once it can." />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {cert.unavailable
              ? cert.unavailable
              : cert.enabled
                ? `The panel is served at https://${cert.domain}, with a certificate Deplo renews.`
                : `The panel is served at http://${cert.domain}, with no certificate.`}
          </p>
        </div>
        <Switch
          checked={cert.enabled}
          disabled={pending || !!cert.unavailable}
          onCheckedChange={setConfirming}
          aria-label="Serve the panel over HTTPS"
        />
      </div>

      {/* A confirm, like every other action that interrupts something: applying
          this recreates the proxy on that host, which takes this page down with
          it for a few seconds. */}
      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirming
                ? `Serve the panel at https://${cert.domain}?`
                : `Serve the panel at http://${cert.domain}?`}
            </DialogTitle>
            <DialogDescription>
              {confirming
                ? "Deplo requests a certificate and renews it. The address has to reach this server from the internet for that to work."
                : "Anyone signing in sends their password unencrypted, so use this only until the address can get a certificate."}{" "}
              Deplo restarts the proxy on this server to apply it, so sites there,
              this page included, are unreachable for a few seconds. Then continue
              on {confirming ? "https" : "http"}://{cert.domain} and sign in again:
              the session cookie changes with the address.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => toggle(confirming!)} disabled={pending}>
              {pending ? "Applying" : confirming ? "Turn HTTPS on" : "Turn HTTPS off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Certificates                                                        */
/* ------------------------------------------------------------------ */

function CertificatesCard() {
  const [accounts, setAccounts] = React.useState<CertificateAccount[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [email, setEmail] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await gqlAction<{ serverCertificateAccounts: CertificateAccount[] }>(
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
    const found = [...new Set(next.map((a) => a.email).filter((e): e is string => !!e))];
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
    email.trim() !== "" && manageable.some((a) => a.email !== email.trim().toLowerCase());

  function apply() {
    startTransition(async () => {
      const res = await gqlAction<{ setCertificateEmail: CertificateAccount[] }>(
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
      const done = next.filter((a) => !a.unavailable && a.email === email.trim().toLowerCase());
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
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            Certificates
            <InfoTip content="Deplo issues HTTPS certificates for your apps through Let's Encrypt. This is the account they are registered to, and where expiry warnings are sent." />
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            The email address your Let&rsquo;s Encrypt certificates are registered
            to, on every server.
          </p>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) setConfirming(true);
            }}
          >
            <div className="space-y-2">
              <FieldLabel
                htmlFor="acme-email"
                info="Let's Encrypt sends expiry and revocation notices here. Use an address someone reads: it is the only warning before a certificate lapses."
              >
                Account email
              </FieldLabel>
              <Input
                id="acme-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ops@example.com"
                autoComplete="off"
                disabled={pending || loading}
                className="max-w-md"
              />
            </div>

            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="h-10 animate-pulse rounded bg-muted/50" />
                ))}
              </div>
            ) : error ? (
              <p className="text-sm text-muted-foreground">{error}</p>
            ) : accounts && accounts.length > 0 ? (
              <div className="space-y-2">
                {accounts.map((account) => (
                  <div
                    key={account.serverId}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-border p-3"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                      <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{account.serverName}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {/* Nothing renews a certificate someone installed by hand,
                          and the tab that holds it is not one anybody opens on a
                          normal day. This is where certificates are thought about,
                          so the expiry says so here. */}
                      <CertificateExpiry account={account} />
                      {account.unavailable ? (
                        <span className="text-xs text-muted-foreground">{account.unavailable}</span>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          {account.email || "No address set"}
                        </span>
                      )}
                      {/* Straight to THIS server's certificates: the fleet-wide
                          email is edited above, everything else about a host's
                          certificates belongs to the host. */}
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/settings/servers/${account.serverId}?tab=certificates`}>
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

            <Button type="submit" disabled={pending || loading || !dirty}>
              {pending ? "Applying" : "Save email"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Dialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register certificates to {email.trim()}?</DialogTitle>
            <DialogDescription>
              Deplo updates the proxy on {manageable.length} server
              {manageable.length === 1 ? "" : "s"} and restarts each one, so sites
              on that server are unreachable for the few seconds it takes to come
              back. Certificates already issued keep working: only where the
              renewal notices go changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={apply} disabled={pending}>
              {pending ? "Applying" : "Save email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * When this host's own certificates run out.
 *
 * Only ever shown while it MATTERS: a certificate the operator installed by hand
 * is renewed by hand too, so the three weeks before it lapses are the whole
 * warning, and there is nothing to say in the eleven months before that.
 */
function CertificateExpiry({ account }: { account: CertificateAccount }) {
  const days = account.expiresInDays;
  if (account.customCertificates === 0 || days === null || days > 21) return null;
  return (
    <Badge variant="destructive" className="gap-1">
      <TriangleAlert className="size-3" />
      {days < 0
        ? "Certificate expired"
        : days === 0
          ? "Certificate expires today"
          : `Certificate expires in ${days} day${days === 1 ? "" : "s"}`}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* This instance                                                       */
/* ------------------------------------------------------------------ */

function InstanceCard({ settings }: { settings: InstanceSettings }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DeploMark size={16} className="text-current" />
          This instance
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          What is running, and where.
        </p>
      </CardHeader>
      <CardContent className="grid gap-x-8 sm:grid-cols-2">
        <Row label="Deplo version" value={<span className="font-mono">{settings.version}</span>} />
        <Row
          label="Runs on"
          value={
            settings.deploHostId ? (
              <Link
                href={`/settings/servers/${settings.deploHostId}`}
                className="underline underline-offset-4 hover:text-foreground"
              >
                {settings.deploHostName}
              </Link>
            ) : (
              // Legitimate: the panel's own box is a server like any other and an
              // operator may simply not have added it yet.
              <span className="text-muted-foreground">Not added as a server</span>
            )
          }
        />
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}
