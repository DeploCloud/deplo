"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import yaml from "js-yaml";
import { toast } from "sonner";
import {
  MoreHorizontal,
  ShieldCheck,
  ShieldOff,
  Star,
  Trash2,
  ExternalLink,
  RefreshCw,
  Network,
  Pencil,
  Layers,
  Route,
  TriangleAlert,
  Cloud,
} from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/shared/status-badge";
import { CopyButton } from "@/components/shared/copy-button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  DomainConfigFields,
  initialDomainConfig,
  resolveDomainConfig,
  type DomainConfigState,
} from "@/components/domains/domain-config-fields";
import { gqlAction } from "@/lib/graphql-client";
import type { Domain } from "@/lib/types";

type Row = Domain & { serviceName: string; appSlug: string };

/** App names declared in a compose file, parsed in the browser (js-yaml is
 * a client-safe dep). [] for a missing/malformed compose ⇒ single-image edit. */
function composeServices(compose?: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  try {
    const doc = yaml.load(compose) as
      | { services?: Record<string, unknown> }
      | undefined;
    const svc = doc?.services;
    return svc && typeof svc === "object" && !Array.isArray(svc)
      ? Object.keys(svc)
      : [];
  } catch {
    return [];
  }
}

export function DomainRow({
  domain,
  compose,
  serverIp,
}: {
  domain: Row;
  /** The app's compose YAML (compose stacks only) so the Edit dialog can
   * offer the service selector. Absent/null ⇒ a single-image project. */
  compose?: string | null;
  /** The public IPv4 of the server THIS project is deployed on — the address a
   * custom domain's A record must resolve to. Surfaced in the misconfigured hint
   * so the user knows exactly where to point DNS. It is server-specific (a
   * project on another server needs a different IP), so it is resolved per
   * project and passed in, never a shared constant. */
  serverIp?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const services = React.useMemo(() => composeServices(compose), [compose]);

  // Edit-dialog form state: name lives here; the routing knobs in `config`.
  const [name, setName] = React.useState(domain.name);
  const [config, setConfig] = React.useState<DomainConfigState>(() =>
    initialDomainConfig(domain),
  );

  const effectiveProvider = domain.certProvider ?? "letsencrypt";
  const scheme = effectiveProvider === "none" ? "http" : "https";
  const middlewares = domain.middlewares ?? [];

  function call(
    fn: () => Promise<{ ok: boolean; error?: string; data?: string }>,
    ok: string,
  ) {
    startTransition(async () => {
      const res = await fn();
      // Prefer the mutation's own message (it reports whether routing was applied
      // instantly or deferred to the next deploy), falling back to the caller's.
      if (res.ok) {
        toast.success(res.data ?? ok);
        // No revalidatePath on the GraphQL API — refresh the RSC tree so the
        // page re-reads the mutated domain/routing state.
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function openEdit() {
    // Reset the form to the domain's current values so a cancelled edit never
    // leaks stale input into the next open.
    setName(domain.name);
    setConfig(initialDomainConfig(domain));
    setEditOpen(true);
  }

  function saveEdit() {
    const trimmedName = name.trim();
    if (trimmedName.length < 3) {
      toast.error("Enter a valid domain name");
      return;
    }
    const resolved = resolveDomainConfig(config, services.length > 0);
    if (!resolved.ok) {
      toast.error(resolved.error);
      return;
    }
    startTransition(async () => {
      const res = await gqlAction<{ updateDomain: { id: string } }, undefined>(
        `mutation($id: String!, $patch: DomainPatchInput!) {
          updateDomain(id: $id, patch: $patch) { id }
        }`,
        {
          id: domain.id,
          patch: {
            name: trimmedName,
            port: resolved.port,
            // null ⇒ auto entrypoint (the data layer derives it); a value ⇒ manual.
            entrypoint: resolved.entrypoint,
            certProvider: resolved.certProvider,
            middlewares: resolved.middlewares,
            pathPrefix: resolved.pathPrefix,
            stripPrefix: resolved.stripPrefix,
            service: resolved.service,
          },
        },
        () => undefined,
      );
      if (res.ok) {
        toast.success("Domain updated");
        setEditOpen(false);
        // No revalidatePath on the GraphQL API — refresh so the edited row
        // reflects the new routing config.
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`${scheme}://${domain.name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer font-medium hover:underline"
          >
            {domain.name}
          </a>
          {domain.primary && (
            <Badge variant="secondary" className="gap-1">
              <Star className="size-3" />
              Primary
            </Badge>
          )}
          {domain.port != null && (
            <Badge variant="outline" className="gap-1 font-mono">
              <Network className="size-3" />:{domain.port}
            </Badge>
          )}
          {effectiveProvider === "none" ? (
            <Badge variant="outline" className="gap-1">
              <ShieldOff className="size-3 text-muted-foreground" />
              HTTP
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <ShieldCheck className="size-3 text-success" />
              {effectiveProvider === "cloudflare"
                ? "Cloudflare"
                : "Let's Encrypt"}
            </Badge>
          )}
          {middlewares.length > 0 && (
            <SimpleTooltip content={middlewares.join(", ")}>
              <Badge variant="outline" className="gap-1">
                <Layers className="size-3" />
                {middlewares.length === 1
                  ? middlewares[0]
                  : `${middlewares.length} middlewares`}
              </Badge>
            </SimpleTooltip>
          )}
          {domain.pathPrefix && (
            <SimpleTooltip
              content={
                domain.stripPrefix
                  ? `path ${domain.pathPrefix} (stripped)`
                  : `path ${domain.pathPrefix}`
              }
            >
              <Badge variant="outline" className="gap-1 font-mono">
                <Route className="size-3" />
                {domain.pathPrefix}
              </Badge>
            </SimpleTooltip>
          )}
        </div>
        {domain.redirectTo && (
          <p className="text-xs text-muted-foreground">
            → {domain.redirectTo}
          </p>
        )}
        {domain.status === "misconfigured" && (
          // A misconfigured domain resolves somewhere other than this
          // app's server. Tell the user exactly where to point DNS: the
          // A record must resolve to THIS app's server IP, which is
          // server-specific (an app on another server needs a different
          // address) — so the concrete IP is shown, never a generic one.
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
            {serverIp ? (
              <>
                <span>
                  This domain’s DNS doesn’t point here. Add an{" "}
                  <span className="font-medium text-foreground">
                    A record
                  </span>{" "}
                  for{" "}
                  <span className="font-mono text-foreground">
                    {domain.name}
                  </span>{" "}
                  →
                </span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                  {serverIp}
                </code>
                <CopyButton value={serverIp} className="size-6" />
                <span>
                  — the IP of the server this app runs on (unique to this
                  server), then Verify.
                </span>
              </>
            ) : (
              <span>
                This domain’s DNS doesn’t point here. Point its{" "}
                <span className="font-medium text-foreground">A record</span>{" "}
                at the IP of the server this app is deployed on (unique to
                that server), then Verify.
              </span>
            )}
          </div>
        )}
        {domain.status === "cloudflare" && (
          // The domain resolves to Cloudflare's proxy IPs (orange-cloud), which
          // mask the origin — so we can't match this server's IP directly, but
          // the setup is correct: Cloudflare forwards to this origin and serves
          // TLS at its edge. Tell the user the one thing they still control —
          // that Cloudflare's origin must target THIS server's IP, and to use a
          // Full SSL mode so the edge trusts the origin cert.
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <Cloud className="size-3.5 shrink-0" />
            <span>
              Proxied through{" "}
              <span className="font-medium text-foreground">Cloudflare</span> —
              DNS is delegated correctly and TLS is served at Cloudflare’s edge.
              In Cloudflare, point this record’s origin at
            </span>
            {serverIp ? (
              <>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                  {serverIp}
                </code>
                <CopyButton value={serverIp} className="size-6" />
              </>
            ) : (
              <span className="font-medium text-foreground">
                this app’s server
              </span>
            )}
            <span>
              and set SSL/TLS to{" "}
              <span className="font-medium text-foreground">Full</span>.
            </span>
          </div>
        )}
      </TableCell>
      <TableCell>
        <Link
          href={`/apps/${domain.appSlug}`}
          className="cursor-pointer text-sm text-muted-foreground hover:text-foreground"
        >
          {domain.serviceName}
        </Link>
      </TableCell>
      <TableCell>
        <StatusBadge status={domain.status} />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Domain menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem asChild>
              <a
                href={`${scheme}://${domain.name}`}
                target="_blank"
                rel="noopener noreferrer"
                className="cursor-pointer"
              >
                <ExternalLink className="size-4" />
                Visit
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                openEdit();
              }}
            >
              <Pencil className="size-4" />
              Edit
            </DropdownMenuItem>
            {domain.status !== "valid" && (
              <DropdownMenuItem
                onClick={() =>
                  call(
                    () =>
                      gqlAction<{ verifyDomain: { id: string } }, undefined>(
                        `mutation($id: String!) { verifyDomain(id: $id) { id } }`,
                        { id: domain.id },
                        () => undefined,
                      ),
                    "Domain verified",
                  )
                }
                disabled={pending}
              >
                <RefreshCw className="size-4" />
                Verify
              </DropdownMenuItem>
            )}
            {!domain.primary && (
              <DropdownMenuItem
                onClick={() =>
                  call(
                    () =>
                      gqlAction<{ setPrimaryDomain: boolean }, undefined>(
                        `mutation($id: String!) { setPrimaryDomain(id: $id) }`,
                        { id: domain.id },
                        () => undefined,
                      ),
                    "Set as primary",
                  )
                }
                // A misconfigured domain has no working DNS to this server, so it
                // can't be the canonical host — disabled here, and the server
                // rejects it too.
                disabled={pending || domain.status === "misconfigured"}
              >
                <Star className="size-4" />
                Set as primary
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(e) => {
                e.preventDefault();
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="size-4" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Remove ${domain.name}?`}
          description="The domain will stop routing to this app. You can re-add it later."
          confirmLabel="Remove domain"
          successMessage="Domain removed"
          onConfirm={async () => {
            const res = await gqlAction<{ removeDomain: boolean }>(
              `mutation($id: String!) { removeDomain(id: $id) }`,
              { id: domain.id },
            );
            // No revalidatePath on the GraphQL API — refresh so the removed row
            // disappears from the RSC-rendered list.
            if (res.ok) router.refresh();
            return res;
          }}
        />
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto text-left">
            <DialogHeader>
              <DialogTitle>Edit domain</DialogTitle>
              <DialogDescription>
                Routing for{" "}
                <span className="font-medium">{domain.serviceName}</span>.
                Changes apply instantly when the app is running,
                otherwise on the next deploy.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <FieldLabel
                  htmlFor={`edit-name-${domain.id}`}
                  info={
                    <>
                      The fully-qualified hostname that routes to this app,
                      e.g. <code className="font-mono">app.example.com</code>.
                      Its DNS A record must point at this server for the domain
                      to verify.
                    </>
                  }
                >
                  Domain
                </FieldLabel>
                <Input
                  id={`edit-name-${domain.id}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="app.example.com"
                  className="font-mono text-sm"
                />
              </div>
              <DomainConfigFields
                state={config}
                onChange={setConfig}
                services={services}
                idPrefix={`edit-${domain.id}`}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setEditOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button onClick={saveEdit} disabled={pending || !name.trim()}>
                {pending ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}
