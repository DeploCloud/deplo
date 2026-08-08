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
import { InfoTip } from "@/components/ui/info-tip";
import { UpdateCard } from "@/components/settings/update-card";
import {
  InstanceOwnerCard,
  type OwnerCandidate,
} from "@/components/settings/instance-owner-card";
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
 * Both cards carry their explanation in ONE InfoTip on the title, like their
 * siblings on Settings, General: the live address, the badges and the switch
 * state say what is true right now, so a paragraph restating them would be
 * furniture. Copy here only appears when something is wrong or about to change.
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
  unavailable: string | null;
};

const ACCOUNT_FIELDS =
  "serverId serverName email unavailable customCertificates expiresInDays";

const PANEL_HTTPS_FIELDS = "domain enabled unavailable";

export function DeploSettingsPanel({
  settings,
  viewerIsOwner,
  ownerCandidates,
}: {
  settings: InstanceSettings;
  viewerIsOwner: boolean;
  ownerCandidates: OwnerCandidate[];
}) {
  return (
    <div className="space-y-4">
      <PanelAddressCard settings={settings} />
      <CertificatesCard />
      {/* After the two settings: updating Deplo is a state to read and an action
          to take, not a knob, and the page opens on what can be changed. It lives
          here rather than on Settings, General because only an instance admin can
          act on it; the dashboard banner is what tells everyone else a release
          exists. */}
      <UpdateCard />
      {/* Last, because handing the instance over is the most consequential thing
          on this page - the same reason a team's delete card sits at the bottom
          of Settings, General. */}
      <InstanceOwnerCard
        ownerName={settings.ownerName}
        viewerIsOwner={viewerIsOwner}
        candidates={ownerCandidates}
      />
    </div>
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
      {/* The badge says where the address in the field came from, which is the
          whole story for one nobody set here - no sentence needed under it. */}
      <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <Globe className="size-4" />
          Panel address
          <InfoTip content="Install commands, deploy hooks and invite links are built from this address. Point its DNS at this server first: Deplo can hand the address out, it cannot move your DNS." />
        </CardTitle>
        <Badge variant="muted">{SOURCE_LABEL[settings.panelUrlSource]}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
          <Input
            id="panel-url"
            aria-label="Panel address"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="deplo.example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            className="w-full max-w-sm font-mono text-sm"
          />
          <Button type="submit" disabled={pending || !dirty}>
            {pending ? "Saving" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={checking || pending || !value.trim()}
            onClick={() => void check(value.trim())}
          >
            {checking ? <Loader2 className="size-4 animate-spin" /> : null}
            {checking ? "Checking" : "Check"}
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
        </form>

        {/* What the address itself answered, verbatim when it did not: a DNS
            failure and a 502 need different fixes. */}
        {reach ? (
          reach.ok ? (
            <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
              <Check className="size-4 shrink-0" />
              That address reaches this Deplo.
            </p>
          ) : (
            <p className="flex items-start gap-1.5 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {reach.error}
            </p>
          )
        ) : null}

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
 * Says nothing while https is on - the address above already starts with it -
 * and speaks up only when the switch is off or the choice is not Deplo's.
 *
 * Fetched after mount for the same reason the accounts are: it reads the live
 * proxy config off the host, and the settings page must not be as slow as the
 * sickest server it describes.
 */
function PanelHttpsRow() {
  const router = useRouter();
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
      // The scheme moved the STORED address with it, and that address is what
      // the card above renders: without this it would keep showing the old one.
      router.refresh();
      toast.success(
        enabled
          ? "The panel is now served over https"
          : "The panel is now served over http",
      );
    });
  }

  if (loading) return <div className="h-14 animate-pulse rounded-lg bg-muted/50" />;
  if (!cert) return null;

  return (
    <>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-muted-foreground" />
            HTTPS
            <InfoTip content="Turn this off when the address cannot get a certificate: it does not resolve publicly yet, port 80 is closed, or the server is on an internal network. You can turn it back on once it can." />
          </div>
          {cert.unavailable ? (
            <p className="mt-1 text-sm text-muted-foreground">{cert.unavailable}</p>
          ) : cert.enabled ? null : (
            <p className="mt-1 text-sm text-[var(--warning)]">
              Anyone signing in sends their password unencrypted.
            </p>
          )}
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
                ? "The address has to reach this server from the internet for the certificate to be issued."
                : "Anyone signing in sends their password unencrypted."}{" "}
              The proxy restarts, so sites on this server are unreachable for a
              few seconds. Then continue on {confirming ? "https" : "http"}://
              {cert.domain} and sign in again.
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
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            Certificates
            <InfoTip content="Deplo issues HTTPS certificates for your apps through Let's Encrypt. Expiry and revocation notices go to this address, on every server, so use one somebody reads." />
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
                      {/* Nothing renews a certificate someone installed by hand,
                          and the tab that holds it is not one anybody opens on a
                          normal day. This is where certificates are thought about,
                          so the expiry says so here. */}
                      <CertificateExpiry account={account} />
                      <span
                        className={
                          account.unavailable
                            ? "text-xs text-muted-foreground"
                            : "font-mono text-xs text-muted-foreground"
                        }
                      >
                        {account.unavailable ?? (account.email || "No address set")}
                      </span>
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
              <p className="text-sm text-muted-foreground">No servers connected yet.</p>
            )}
          </form>
        </CardContent>
      </Card>

      <Dialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register certificates to {email.trim()}?</DialogTitle>
            <DialogDescription>
              Deplo restarts the proxy on {manageable.length} server
              {manageable.length === 1 ? "" : "s"}, so sites there are unreachable
              for a few seconds. Certificates already issued keep working.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
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
 *
 * Only ever shown while it MATTERS: a certificate the operator installed by hand
 * is renewed by hand too, so the three weeks before it lapses are the whole
 * warning, and there is nothing to say in the eleven months before that.
 */
function CertificateExpiry({ account }: { account: CertificateAccount }) {
  const days = account.expiresInDays;
  if (account.customCertificates === 0 || days === null || days > 21) return null;
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
