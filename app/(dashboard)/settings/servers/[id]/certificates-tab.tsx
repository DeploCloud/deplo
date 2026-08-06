"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "./server-detail-tabs";

/**
 * The Certificates tab: certificates the operator bought or generated elsewhere,
 * installed on this host's proxy.
 *
 * Deplo issues Let's Encrypt certificates by itself, so this is the escape hatch,
 * not the happy path: a wildcard from the company CA, a certificate an employer
 * mandates, a domain whose DNS cannot answer an HTTP challenge. They live on the
 * host and are read back from it, so the list is what is actually being served,
 * fetched when the tab opens, never during the page render.
 */

type Certificate = {
  id: string;
  subject: string;
  domains: string[];
  issuer: string;
  notBefore: string;
  notAfter: string;
  expired: boolean;
  expiresInDays: number;
};

const CERT_FIELDS = "id subject domains issuer notBefore notAfter expired expiresInDays";

export function ServerCertificatesTab({ server }: { server: ServerSummary }) {
  const [certificates, setCertificates] = React.useState<Certificate[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<Certificate | null>(null);

  const read = React.useCallback(
    () =>
      gqlAction<{ serverCertificates: Certificate[] }>(
        `mutation ServerCertificates($id: String!) {
          serverCertificates(id: $id) { ${CERT_FIELDS} }
        }`,
        { id: server.id },
      ),
    [server.id],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await read();
    setLoading(false);
    if (!res.ok) {
      // Includes "Deplo did not install the proxy on this server", the one that
      // tells the operator this tab is not for them, so it is shown verbatim.
      setError(res.error);
      setCertificates(null);
      return;
    }
    setCertificates(res.data?.serverCertificates ?? []);
  }, [read]);

  /**
   * What the host has, after a write said it failed.
   *
   * Installing recreates the proxy — and on the server running Deplo, this panel
   * is behind that same proxy, so the reply to the write can die with the old
   * container while the write itself succeeded. A failure is therefore a question,
   * not an answer: ask the host what it is holding, and treat a list that changed
   * as the write having landed. Returns null when nothing changed, i.e. when the
   * failure was real.
   */
  const settled = React.useCallback(
    async (before: Certificate[]): Promise<Certificate[] | null> => {
      const res = await read();
      if (!res.ok) return null;
      const now = res.data?.serverCertificates ?? [];
      const ids = new Set(before.map((c) => c.id));
      const same = now.length === before.length && now.every((c) => ids.has(c.id));
      if (same) return null;
      setCertificates(now);
      return now;
    },
    [read],
  );

  React.useEffect(() => {
    // Opening the tab IS the read: it synchronises with an external system (this
    // server's agent). Same scoped exemption as the Advanced tab's host probe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4" />
              Custom certificates
              <InfoTip content="Deplo issues free certificates automatically. Add one here only when you already have your own: a wildcard, a company CA, or a domain that cannot be verified over HTTP." />
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Certificates you provide yourself. To use one, set a domain&rsquo;s
              certificate to &ldquo;Installed on the server&rdquo;.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setAdding(true)} disabled={loading || !!error}>
              <Plus className="size-4" />
              Add certificate
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !certificates ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded bg-muted/50" />
              ))}
            </div>
          ) : error ? (
            <p className="text-sm text-muted-foreground">{error}</p>
          ) : certificates && certificates.length > 0 ? (
            <div className="space-y-2">
              {certificates.map((certificate) => (
                <CertificateRow
                  key={certificate.id}
                  certificate={certificate}
                  onRemove={() => setRemoving(certificate)}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No certificates of your own here. Domains on this server get a free
              one from Let&rsquo;s Encrypt automatically.
            </p>
          )}
        </CardContent>
      </Card>

      <AddCertificateDialog
        server={server}
        open={adding}
        installed={certificates ?? []}
        settled={settled}
        onOpenChange={setAdding}
        onInstalled={setCertificates}
      />
      <RemoveCertificateDialog
        server={server}
        certificate={removing}
        installed={certificates ?? []}
        settled={settled}
        onOpenChange={(open) => !open && setRemoving(null)}
        onRemoved={(next) => {
          setCertificates(next);
          setRemoving(null);
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* One certificate                                                     */
/* ------------------------------------------------------------------ */

function CertificateRow({
  certificate,
  onRemove,
}: {
  certificate: Certificate;
  onRemove: () => void;
}) {
  // Counted on the server: a viewer whose own clock is wrong would otherwise be
  // told the wrong thing about a certificate that is fine.
  const days = certificate.expiresInDays;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border p-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{certificate.subject}</span>
          {certificate.expired ? (
            <Badge variant="destructive" className="gap-1">
              <TriangleAlert className="size-3" />
              Expired
            </Badge>
          ) : days <= 21 ? (
            // Three weeks is the window in which a renewal has to be pasted in by
            // hand: nothing renews these, and nothing else will say so.
            <Badge variant="destructive" className="gap-1">
              <TriangleAlert className="size-3" />
              {days <= 0 ? "Expires today" : `${days} day${days === 1 ? "" : "s"} left`}
            </Badge>
          ) : (
            <Badge variant="muted">
              Expires {new Date(certificate.notAfter).toLocaleDateString()}
            </Badge>
          )}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {certificate.domains.join(", ") || "No domains"}
        </p>
        <p className="text-xs text-muted-foreground">Issued by {certificate.issuer}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={onRemove}>
        <Trash2 className="size-4" />
        Remove
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add                                                                 */
/* ------------------------------------------------------------------ */

function AddCertificateDialog({
  server,
  open,
  installed,
  settled,
  onOpenChange,
  onInstalled,
}: {
  server: ServerSummary;
  open: boolean;
  installed: Certificate[];
  settled: (before: Certificate[]) => Promise<Certificate[] | null>;
  onOpenChange: (open: boolean) => void;
  onInstalled: (certificates: Certificate[]) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [certificate, setCertificate] = React.useState("");
  const [privateKey, setPrivateKey] = React.useState("");

  function done() {
    // The key is dropped the moment this closes, however it closed. It is the one
    // thing typed here that has no read path anywhere else, and leaving it in
    // state would put it back on screen the next time the dialog opens.
    setCertificate("");
    setPrivateKey("");
    onOpenChange(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction<{ addServerCertificate: Certificate[] }>(
        `mutation AddServerCertificate($id: String!, $input: ServerCertificateInput!) {
          addServerCertificate(id: $id, input: $input) { ${CERT_FIELDS} }
        }`,
        { id: server.id, input: { certificate, privateKey } },
      );
      if (!res.ok) {
        // A failed reply is not a failed install: recreating the proxy can kill
        // the connection carrying it. Ask the host before saying it went wrong.
        const after = await settled(installed);
        if (!after) {
          // "That private key does not belong to that certificate" and friends:
          // each names the fix, so they are surfaced as they came.
          toast.error(res.error);
          return;
        }
        done();
        toast.success(`Certificate installed on ${server.name}`);
        return;
      }
      onInstalled(res.data?.addServerCertificate ?? []);
      done();
      toast.success(`Certificate installed on ${server.name}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && (o ? onOpenChange(o) : done())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a certificate to {server.name}</DialogTitle>
          <DialogDescription>
            Paste the certificate and its private key. Then set a domain&rsquo;s
            certificate to &ldquo;Installed on the server&rdquo; to serve it with
            this one. The proxy restarts, so sites here blink for a few seconds.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="certificate-pem"
              info="Paste the full chain: your certificate first, then any intermediates your provider gave you. Usually the file named fullchain.pem."
            >
              Certificate
            </FieldLabel>
            <Textarea
              id="certificate-pem"
              value={certificate}
              onChange={(e) => setCertificate(e.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----"
              spellCheck={false}
              autoComplete="off"
              rows={7}
              disabled={pending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="certificate-key"
              info="The key this certificate was issued for. It is sent to the server and can never be read back. A key with a passphrase has to be decrypted first."
            >
              Private key
            </FieldLabel>
            <Textarea
              id="certificate-key"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN PRIVATE KEY-----"
              spellCheck={false}
              autoComplete="off"
              rows={5}
              disabled={pending}
              className="font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={done} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !certificate.trim() || !privateKey.trim()}
            >
              {pending ? "Installing" : "Install certificate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Remove                                                              */
/* ------------------------------------------------------------------ */

function RemoveCertificateDialog({
  server,
  certificate,
  installed,
  settled,
  onOpenChange,
  onRemoved,
}: {
  server: ServerSummary;
  certificate: Certificate | null;
  installed: Certificate[];
  settled: (before: Certificate[]) => Promise<Certificate[] | null>;
  onOpenChange: (open: boolean) => void;
  onRemoved: (certificates: Certificate[]) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  function remove() {
    if (!certificate) return;
    startTransition(async () => {
      const res = await gqlAction<{ removeServerCertificate: Certificate[] }>(
        `mutation RemoveServerCertificate($id: String!, $certificateId: String!) {
          removeServerCertificate(id: $id, certificateId: $certificateId) { ${CERT_FIELDS} }
        }`,
        { id: server.id, certificateId: certificate.id },
      );
      if (!res.ok) {
        // Same as installing: recreating the proxy can take the reply with it, so
        // the host has the last word on whether this happened.
        const after = await settled(installed);
        if (!after) {
          toast.error(res.error);
          return;
        }
        onRemoved(after);
        toast.success(`Certificate for ${certificate.subject} removed`);
        return;
      }
      onRemoved(res.data?.removeServerCertificate ?? []);
      toast.success(`Certificate for ${certificate.subject} removed`);
    });
  }

  return (
    <Dialog open={certificate !== null} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove the certificate for {certificate?.subject}?</DialogTitle>
          <DialogDescription>
            {certificate?.domains.join(", ")} fall back to a free Let&rsquo;s
            Encrypt certificate, which this server requests again once the proxy
            comes back. If those domains cannot be verified over HTTP, they will
            have no certificate until you install another one.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={remove} disabled={pending}>
            {pending ? "Removing" : "Remove certificate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
