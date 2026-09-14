"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import yaml from "@/lib/yaml";
import { toast } from "sonner";
import {
  ShieldCheck,
  ShieldOff,
  Star,
  Trash2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Network,
  Pencil,
  Layers,
  Route,
  Signpost,
  TriangleAlert,
} from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isReservedSharedName } from "@/lib/deploy/compose-lint/networks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { CopyButton } from "@/components/shared/copy-button";
import { CloudflareIcon } from "@/components/shared/brand-icons";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  DomainConfigFields,
  initialDomainConfig,
  resolveDomainConfig,
  type DomainConfigState,
} from "@/components/domains/domain-config-fields";
import { useOptimisticRow } from "@/components/shared/optimistic-list";
import { gqlAction } from "@/lib/graphql-client";
import { useAppCan } from "@/components/apps/app-capabilities";
import { deriveWwwRedirect } from "@/lib/www-redirect";
import type { Domain } from "@/lib/types/domain";
import { DocsLink } from "@/components/ui/docs-link";

type Row = Domain & { serviceName: string; appSlug: string };

// Parsed in the browser (js-yaml is a client-safe dep); [] for a missing or malformed compose ⇒ single-image edit.
function composeServices(compose?: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  try {
    const doc = yaml.load(compose) as
      { services?: Record<string, unknown> } | undefined;
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
  isCompose,
  showContainer,
  serverIp,
  siblings = [],
}: {
  domain: Row;
  // Every domain of the app: the `www` pairing is derived from the rows that exist, so a companion removed by hand can't leave a stored flag lying.
  siblings?: { name: string; redirectTo?: string | null }[];
  // The app's compose YAML for the service selector; absent or null ⇒ a single-image project.
  compose?: string | null;
  // NOT inferred from `compose`: an app can carry leftover compose text while deploying a repo or image.
  isCompose: boolean;
  // A prop, not a per-row decision: the header count and the cells must agree.
  showContainer: boolean;
  // The IPv4 of the server THIS app is on - server-specific, never a constant.
  serverIp?: string;
}) {
  const router = useRouter();
  // One capability covers every row action except Visit: they all change routing.
  const canManage = useAppCan("manage_domains");
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const { hide, restore } = useOptimisticRow(domain.id);
  const [editOpen, setEditOpen] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const services = React.useMemo(() => composeServices(compose), [compose]);

  const service = (domain.service ?? "").trim();
  const container = service || `deplo-${domain.appSlug}`;
  // No service means the stack renderer has no target to wire, so the hostname reaches nothing until one is picked.
  const unrouted = isCompose && !service;
  const missing =
    isCompose &&
    Boolean(service) &&
    services.length > 0 &&
    !services.includes(service);
  // A name the platform answers to on the shared network: the renderer refuses to route it, and older rows predate that refusal.
  const reserved = isCompose && isReservedSharedName(service);

  const www = React.useMemo(
    () => deriveWwwRedirect(domain.name, siblings),
    [domain.name, siblings],
  );

  const [name, setName] = React.useState(domain.name);
  const [config, setConfig] = React.useState<DomainConfigState>(() =>
    initialDomainConfig(domain, undefined, www),
  );

  const effectiveProvider = domain.certProvider ?? "letsencrypt";
  // A proxied host is visited AT the proxy, which serves its HTTPS.
  const scheme =
    domain.proxied || effectiveProvider !== "none" ? "https" : "http";
  const middlewares = domain.middlewares ?? [];
  const cloudflare = domain.status === "cloudflare";
  // Detected (anycast) or declared by the owner: either way DNS cannot see the origin and the host is routed.
  const proxied = cloudflare || Boolean(domain.proxied);
  // A proxied domain is put on the Cloudflare provider automatically, so both chips would read "Cloudflare".
  const oneCloudflareChip = cloudflare && effectiveProvider === "cloudflare";

  function call(
    fn: () => Promise<{ ok: boolean; error?: string; data?: string }>,
    ok: string,
  ) {
    startTransition(async () => {
      const res = await fn();
      // The mutation's own message reports whether routing was applied instantly or deferred to the next deploy.
      if (res.ok) {
        toast.success(res.data ?? ok);
        // No revalidatePath on the GraphQL API - refresh re-reads the RSC tree.
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function openEdit() {
    // Reset to the domain's current values so a cancelled edit never leaks stale input into the next open.
    setName(domain.name);
    setConfig(initialDomainConfig(domain, undefined, www));
    setEditOpen(true);
  }

  function onSubmitEdit(e: React.FormEvent) {
    e.preventDefault();
    saveEdit();
  }

  function saveEdit() {
    const trimmedName = name.trim();
    if (trimmedName.length < 3) {
      toast.error("Enter a valid domain name");
      return;
    }
    const resolved = resolveDomainConfig(
      config,
      services.length > 0,
      trimmedName,
    );
    if (!resolved.ok) {
      toast.error(resolved.error);
      return;
    }
    setEditOpen(false);
    startTransition(async () => {
      const res = await gqlAction<{
        updateDomain: { id: string; status: string };
      }>(
        `mutation($id: String!, $patch: DomainPatchInput!) {
          updateDomain(id: $id, patch: $patch) { id status }
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
            proxied: resolved.proxied,
            // Derived, so this is the current value unless the user changed it - the server no-ops on a match.
            www: resolved.www,
          },
        },
      );
      if (res.ok) {
        // A rename re-checks the new hostname's DNS server-side, so the toast reports what that check found.
        const status = res.data?.updateDomain.status;
        if (trimmedName === domain.name || status === "valid")
          toast.success("Domain updated");
        else if (status === "cloudflare")
          toast.success(
            "Domain updated - Cloudflare is proxying it. Make sure its record points at this server.",
          );
        else if (resolved.proxied)
          // A proxied host's DNS verdict says nothing; what matters is that it is still routed.
          toast.success("Domain updated - routed through your proxy");
        else if (status === "misconfigured")
          toast.warning(
            "Domain updated, but its DNS points at another address - see the hint on its row",
          );
        else
          toast.warning(
            "Domain updated - point its DNS at the server and it verifies automatically",
          );
      } else {
        setEditOpen(true);
        toast.error(res.error);
      }
      // No revalidatePath on the GraphQL API - refresh re-reads the RSC tree.
      router.refresh();
    });
  }

  function verify() {
    // Its own flag, not the row's shared `pending`, and set before the transition so the spin starts on the click.
    setVerifying(true);
    startTransition(async () => {
      try {
        await runVerify();
      } finally {
        setVerifying(false);
      }
    });
  }

  async function runVerify() {
    const res = await gqlAction<{
      verifyDomain: { id: string; status: string };
    }>(
      /* GraphQL */ `
        mutation ($id: String!) {
          verifyDomain(id: $id) {
            id
            status
          }
        }
      `,
      { id: domain.id },
    );
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const status = res.data?.verifyDomain.status;
    if (status === "valid") toast.success("Domain verified - routing is live");
    else if (domain.proxied)
      toast.success("Routing re-applied - its DNS answers with your proxy");
    else if (status === "cloudflare")
      toast.success(
        "Cloudflare is proxying this domain. Make sure its record points at this server.",
      );
    else if (status === "misconfigured")
      toast.warning(
        "This domain\u2019s DNS points at another address - see the hint on its row",
      );
    else
      toast.warning(
        "No DNS record found yet - it\u2019s re-checked automatically",
      );
    router.refresh();
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          {/* The name IS the way to visit it - the row needs no button of its own. */}
          <a
            href={`${scheme}://${domain.name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="group/visit inline-flex cursor-pointer items-center gap-1.5 font-medium hover:underline"
          >
            {domain.name}
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover/visit:text-foreground" />
          </a>
          {domain.primary && (
            <Badge variant="secondary" className="gap-1">
              <Star className="size-3" />
              Primary
            </Badge>
          )}
          {domain.redirectTo && (
            // This hostname serves nothing - it answers 301 to the canonical half of its www pair.
            <SimpleTooltip
              content={`Answers a permanent redirect (301) to ${domain.redirectTo}. Edit ${domain.redirectTo} to change or remove the pair.`}
            >
              <Badge variant="outline" className="gap-1 font-mono">
                <Signpost className="size-3" />→ {domain.redirectTo}
              </Badge>
            </SimpleTooltip>
          )}
          {domain.port != null && (
            <Badge variant="outline" className="gap-1 font-mono">
              <Network className="size-3" />:{domain.port}
            </Badge>
          )}
          {oneCloudflareChip ? (
            <Badge
              variant="outline"
              className="gap-1 border-[#f38020]/40 bg-[#f38020]/15 text-[#f38020]"
            >
              <CloudflareIcon className="size-3" />
              Cloudflare
            </Badge>
          ) : effectiveProvider === "none" ? (
            <Badge variant="outline" className="gap-1">
              <ShieldOff className="size-3 text-muted-foreground" />
              HTTP
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <ShieldCheck className="size-3 text-success" />
              {effectiveProvider === "cloudflare"
                ? "Cloudflare"
                : effectiveProvider === "custom"
                  ? "Server certificate"
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
          {cloudflare && !oneCloudflareChip && (
            // Only when the certificate chip does not already say "Cloudflare"; otherwise the merged chip stands for both.
            <Badge
              variant="outline"
              className="gap-1 border-[#f38020]/40 bg-[#f38020]/15 text-[#f38020]"
            >
              <CloudflareIcon className="size-3" />
              Cloudflare DNS
            </Badge>
          )}
        </div>
        {!proxied &&
          (domain.status === "misconfigured" ||
            domain.status === "pending") && (
            // A pending domain has no DNS record yet; a misconfigured one resolves somewhere other than this app's server.
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
              <DocsLink topic="domains.dnsStates" className="order-last" />
              {serverIp ? (
                <>
                  <span>
                    {domain.status === "pending"
                      ? "This domain doesn’t resolve yet."
                      : "This domain’s DNS doesn’t point here."}{" "}
                    Add an{" "}
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
                    - the IP of the server this app runs on (unique to this
                    server). It’s re-checked automatically.
                  </span>
                </>
              ) : (
                <span>
                  {domain.status === "pending"
                    ? "This domain doesn’t resolve yet."
                    : "This domain’s DNS doesn’t point here."}{" "}
                  Point its{" "}
                  <span className="font-medium text-foreground">A record</span>{" "}
                  at the IP of the server this app is deployed on (unique to
                  that server). It’s re-checked automatically.
                </span>
              )}
              {domain.status === "misconfigured" && (
                // The way out for a record that can't point here; the switch itself lives in Advanced settings.
                <span>
                  Or turn on{" "}
                  <span className="font-medium text-foreground">
                    Behind a proxy
                  </span>{" "}
                  if a CDN or another proxy answers for it.
                </span>
              )}
            </div>
          )}
      </TableCell>
      {showContainer && (
        <TableCell className="w-56">
          {unrouted || missing || reserved ? (
            <SimpleTooltip
              content={
                reserved
                  ? `“${service}” is a name Deplo's own network uses, so nothing serves this domain. Rename the container in the compose file, or point this domain at another one.`
                  : missing
                    ? `This app's compose file has no container “${service}” any more, so nothing serves this domain. Edit the domain to pick one.`
                    : "This domain doesn't name a container, so nothing serves it. Edit the domain to pick one."
              }
            >
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
                {missing || reserved ? service : "Not set"}
              </span>
            </SimpleTooltip>
          ) : (
            <SimpleTooltip
              content={
                service
                  ? `Compose service “${service}” in the stack deplo-${domain.appSlug}`
                  : "This app runs a single container"
              }
            >
              <span className="font-mono text-xs text-muted-foreground">
                {container}
              </span>
            </SimpleTooltip>
          )}
        </TableCell>
      )}
      <TableCell>
        <span className="flex items-center gap-1">
          {/* A declared proxy can never beat the DNS verdict, so it reads "Proxied" like a detected one. */}
          <StatusBadge
            status={
              domain.proxied && domain.status !== "valid"
                ? "cloudflare"
                : domain.status
            }
          />
          {/* Beside the chip it argues with: a domain that is not valid yet is when someone re-checks it. */}
          {domain.status !== "valid" && (
            <SimpleTooltip content="Check this domain's DNS again">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Verify ${domain.name}`}
                onClick={verify}
                disabled={pending || !canManage}
              >
                <RefreshCw
                  className={cn("size-3.5", verifying && "animate-spin")}
                />
              </Button>
            </SimpleTooltip>
          )}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {/* A redirecting hostname can never be primary - it serves nothing, and the server refuses it too. */}
          {!domain.primary && !domain.redirectTo && (
            <SimpleTooltip content="Make this the canonical host">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Set ${domain.name} as primary`}
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
                // No working DNS to this server, so it can't be the canonical host - the server rejects it too.
                disabled={
                  pending || !canManage || domain.status === "misconfigured"
                }
              >
                <Star className="size-4" />
              </Button>
            </SimpleTooltip>
          )}
          <SimpleTooltip content="Remove this domain">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${domain.name}`}
              onClick={() => setConfirmOpen(true)}
              disabled={!canManage}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip content="Edit this domain">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${domain.name}`}
              onClick={() => openEdit()}
              disabled={!canManage}
            >
              <Pencil className="size-4" />
            </Button>
          </SimpleTooltip>
        </div>
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Remove domain?"
          description={
            <>
              Removing <strong>{domain.name}</strong> stops it routing to this
              app. You can add it back at any time.
            </>
          }
          confirmLabel="Remove domain"
          successMessage="Domain removed"
          optimistic
          onConfirm={async () => {
            hide();
            const res = await gqlAction<{ removeDomain: boolean }>(
              `mutation($id: String!) { removeDomain(id: $id) }`,
              { id: domain.id },
            );
            if (!res.ok) restore();
            // No revalidatePath on the GraphQL API - refresh re-reads the RSC tree.
            router.refresh();
            return res;
          }}
        />
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent className="text-left">
            <DialogHeader>
              <DialogTitle>Edit domain</DialogTitle>
              <DialogDescription>
                Routing for{" "}
                <span className="font-medium">{domain.serviceName}</span>.
                Changes apply instantly when the app is running, otherwise on
                the next deploy.
              </DialogDescription>
            </DialogHeader>
            <form className="grid gap-4" onSubmit={onSubmitEdit}>
              <div className="space-y-4">
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor={`edit-name-${domain.id}`}
                    info="Fully-qualified hostname, e.g. app.example.com. Its DNS A record must point at this server to verify."
                    docs="domains.dnsRecord"
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
                  proxied={cloudflare}
                  hostname={name}
                  serverIp={serverIp}
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
                <Button type="submit" disabled={pending || !name.trim()}>
                  <span className="grid place-items-center">
                    <span
                      className={cn(
                        "col-start-1 row-start-1",
                        pending && "invisible",
                      )}
                    >
                      Save changes
                    </span>
                    {pending && (
                      <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                    )}
                  </span>
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}
