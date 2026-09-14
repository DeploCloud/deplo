"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { toast } from "sonner";
import {
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
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";

type CertificateAccount = {
  serverId: string;
  serverName: string;
  email: string | null;
  unavailable: string | null;
  customCertificates: number;
  expiresInDays: number | null;
};

const ACCOUNT_FIELDS =
  "serverId serverName email unavailable customCertificates expiresInDays";

// CertificatesCard: the one certificate account email, across the whole fleet.
export function CertificatesCard() {
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
    // Prefill only when the fleet agrees with itself: guessing which host is the
    // right one would be a silent vote for one of them.
    const found = [
      ...new Set(next.map((a) => a.email).filter((e): e is string => !!e)),
    ];
    setEmail(found.length === 1 ? found[0] : "");
  }, []);

  React.useEffect(() => {
    // Opening the page IS the read: it synchronises with the servers' agents and
    // `load` manages its own state.
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
              content="Let's Encrypt sends expiry and revocation notices here, on every server, so use an address somebody reads."
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
              <div className="h-[5.5rem] animate-pulse rounded-lg bg-surface-strong" />
            ) : error ? (
              <p className="text-sm text-muted-foreground">{error}</p>
            ) : accounts && accounts.length > 0 ? (
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
                          and this tab is not one anybody opens on a normal day. */}
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

// CertificateExpiry: when this host's own certificates run out.
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
