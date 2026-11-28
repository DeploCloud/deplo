"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { servicesOf } from "@/lib/deploy/compose-lint/document";
import { toast } from "sonner";
import {
  Star,
  Trash2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Network,
  Pencil,
  TriangleAlert,
} from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Bone } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RowActions } from "@/components/shared/row-actions";
import { cn } from "@/lib/utils";
import { domainRoutingWarning } from "@/lib/domain-issues";
import { dnsRecordsFor } from "@/lib/host-address";
import { DomainNameField } from "./domain-name-field";
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
import {
  OptimisticList,
  useOptimisticRow,
} from "@/components/shared/optimistic-list";
import { gqlAction } from "@/lib/graphql-client";
import { useAppCan } from "@/components/apps/app-capabilities";
import { deriveWwwRedirect } from "@/lib/www-redirect";
import type { AddressAway, Domain } from "@/lib/types/domain";
import type { StrayRecord } from "@/lib/deploy/cloudflare";
import { DocsLink } from "@/components/ui/docs-link";
import { type DomainZone } from "./domain-zone-line";
import { DomainBadges } from "./domain-badges";
import { DomainClusterLines } from "./domain-cluster-lines";
import { AutoDnsField } from "./auto-dns-field";
import { coveringZone } from "@/lib/dns-zone";

type Row = Domain & {
  serviceName: string;
  appSlug: string;
  autoDns?: boolean;
};

export const DOMAIN_SORT = {
  domain: (d: Row) => `${d.name}${d.pathPrefix ?? ""}`,
  container: (d: Row) => (d.service ?? "").trim() || d.serviceName,
  status: (d: Row) =>
    d.proxied && d.status !== "valid" ? "cloudflare" : d.status,
};

// Keyed here, not in the page: keys don't survive the RSC boundary, so a row could never hide.
const ROW =
  "max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-2 max-md:px-3 max-md:py-3 max-md:[&>td]:p-0";

export function DomainRows({
  domains,
  strays = {},
  staysOn = {},
  away = {},
  native = {},
  siblings = domains,
  ...rest
}: {
  domains: Row[];
  strays?: Record<string, StrayRecord>;
  staysOn?: Record<string, string>;
  /** A load-balanced App's generated addresses whose server is away, by id. */
  away?: Record<string, AddressAway>;
  /** Domains answered by the cluster's own DNS zone, by id (ADR-0049). */
  native?: Record<string, DomainZone>;
} & Omit<
  React.ComponentProps<typeof DomainRow>,
  "domain" | "stray" | "staysOn" | "away" | "native"
>) {
  return (
    <OptimisticList>
      {domains.map((d) => (
        <DomainRow
          key={d.id}
          domain={d}
          siblings={siblings}
          stray={strays[d.id] ?? null}
          staysOn={staysOn[d.id] ?? null}
          away={away[d.id] ?? null}
          native={native[d.id] ?? null}
          {...rest}
        />
      ))}
    </OptimisticList>
  );
}

function AddressChip({ value }: { value: string }) {
  return (
    <>
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
        {value}
      </code>
      <CopyButton value={value} className="size-6" />
    </>
  );
}

export function DomainRow({
  domain,
  compose,
  isCompose,
  showContainer,
  serverIp,
  serverIpv6,
  suggestedDomain,
  stray,
  staysOn,
  away = null,
  noHealthCheck = false,
  siblings = [],
  native = null,
  dnsZones = [],
  cluster = null,
  everyServer = null,
  autoDnsZones = [],
  tunnels = false,
}: {
  domain: Row;
  /** The Tunnels experiment is on, so a domain may be served through Cloudflare Tunnel. */
  tunnels?: boolean;
  /** Domains connected for automatic DNS that the viewer may use in this team. */
  autoDnsZones?: string[];
  /** The records a domain answering on every server needs when a person keeps them: one per healthy server. */
  everyServer?: { a: string[]; aaaa: string[] } | null;
  /** The App runs on a cluster, and whether the viewer can put a tunnel domain on it. */
  cluster?: { canMove: boolean } | null;
  /** Answered by the cluster's own DNS zone (ADR-0049), and the CNAME it needs when outside it. */
  native?: DomainZone | null;
  /** The zones of the App's cluster it could be answered through. */
  dnsZones?: { id: string; name: string }[];
  /** The App has no health check, so a failover counts it ready 3 s after it starts. */
  noHealthCheck?: boolean;
  /** The server a cluster App's domain stays pointed at through a failover; null when it follows the App. */
  staysOn?: string | null;
  away?: AddressAway | null;
  siblings?: { name: string; redirectTo?: string | null }[];
  compose?: string | null;
  isCompose: boolean;
  showContainer: boolean;
  serverIp?: string | null;
  serverIpv6?: string | null;
  suggestedDomain?: string;
  stray?: StrayRecord | null;
}) {
  const byHand = domain.answersEverywhere === true && everyServer != null;
  const records = byHand
    ? [
        ...everyServer.a.map((value) => ({ type: "A", value })),
        ...everyServer.aaaa.map((value) => ({ type: "AAAA", value })),
      ]
    : dnsRecordsFor(serverIp, serverIpv6);
  const strayTarget =
    records.find((r) => r.type === stray?.type)?.value ?? null;
  const router = useRouter();
  const canManage = useAppCan("manage_domains");
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const { hide, restore } = useOptimisticRow(domain.id);
  const [editOpen, setEditOpen] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const services = React.useMemo(
    () => Object.keys(servicesOf(compose ?? null) ?? {}),
    [compose],
  );

  const service = (domain.service ?? "").trim();
  const container = service || `deplo-${domain.appSlug}`;
  const routingWarning = domainRoutingWarning(domain, isCompose, services);

  const www = React.useMemo(
    () => deriveWwwRedirect(domain.name, siblings),
    [domain.name, siblings],
  );

  const [name, setName] = React.useState(domain.name);
  // A record someone turned orange in Cloudflare by hand still opens as proxied.
  const edited = () =>
    initialDomainConfig(
      cluster == null && domain.autoDns && domain.status === "cloudflare"
        ? { ...domain, proxied: true }
        : domain,
      undefined,
      www,
    );
  const [config, setConfig] = React.useState<DomainConfigState>(edited);
  const [wantsTunnel, setWantsTunnel] = React.useState(domain.tunnel === true);
  // Off a cluster, the record Deplo keeps (or makes for a new name) follows the tunnel and proxy switches.
  const renamed = name.trim().toLowerCase() !== domain.name;
  const zone = coveringZone(autoDnsZones, name);
  const autoDns =
    cluster == null && (renamed ? zone !== null : domain.autoDns === true);
  const tunnel =
    cluster == null ? autoDns && wantsTunnel : domain.tunnel === true;

  const effectiveProvider = domain.certProvider ?? "letsencrypt";
  const scheme =
    domain.proxied || effectiveProvider !== "none" ? "https" : "http";
  const cloudflare = domain.status === "cloudflare";
  const proxied = cloudflare || Boolean(domain.proxied);
  // The detection belongs to the saved name: a renamed domain is checked afresh.
  const cloudflareDetected =
    cloudflare && name.trim().toLowerCase() === domain.name;

  function call(
    fn: () => Promise<{ ok: boolean; error?: string; data?: string }>,
    ok: string,
  ) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.data ?? ok);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  const canSetPrimary =
    !pending && canManage && domain.status !== "misconfigured";
  function setPrimary() {
    call(
      () =>
        gqlAction<{ setPrimaryDomain: boolean }, undefined>(
          `mutation($id: String!) { setPrimaryDomain(id: $id) }`,
          { id: domain.id },
          () => undefined,
        ),
      "Set as primary",
    );
  }

  function openEdit() {
    setName(domain.name);
    setConfig(edited());
    setWantsTunnel(domain.tunnel === true);
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
            entrypoint: resolved.entrypoint,
            certProvider: resolved.certProvider,
            middlewares: resolved.middlewares,
            securityHeaders: resolved.securityHeaders,
            corsOrigins: resolved.corsOrigins,
            pathPrefix: resolved.pathPrefix,
            stripPrefix: resolved.stripPrefix,
            service: resolved.service,
            proxied: resolved.proxied,
            ...(cluster == null ? { tunnel } : {}),
            www: resolved.www,
          },
        },
      );
      if (res.ok) {
        const status = res.data?.updateDomain.status;
        if (trimmedName === domain.name || status === "valid")
          toast.success("Domain updated");
        else if (status === "cloudflare")
          toast.success(
            "Domain updated - Cloudflare is proxying it. Make sure its record points at this server.",
          );
        else if (resolved.proxied)
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
      router.refresh();
    });
  }

  function verify() {
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
    <TableRow className={ROW}>
      <TableCell className="max-md:basis-full">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`${scheme}://${domain.name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="group/visit inline-flex cursor-pointer items-center gap-1.5 font-medium hover:underline"
          >
            {domain.name}
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover/visit:text-foreground" />
          </a>
          <DomainBadges
            domain={domain}
            effectiveProvider={effectiveProvider}
            cloudflare={cloudflare}
            onCluster={cluster != null}
          />
        </div>
        {!proxied &&
          !native &&
          (domain.status === "misconfigured" ||
            domain.status === "pending") && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
              {domain.ssl && (
                <span className="order-last">
                  It keeps answering meanwhile.
                </span>
              )}
              <DocsLink topic="domains.dnsStates" className="order-last" />
              {stray ? (
                <>
                  <span>
                    Its{" "}
                    <span className="font-medium text-foreground">
                      {stray.type} record
                    </span>{" "}
                    points at{" "}
                    <span className="font-mono text-foreground">
                      {stray.address}
                    </span>
                    , not this server.{" "}
                    {strayTarget
                      ? "Point it at"
                      : "Remove it, or point it at this server."}
                  </span>
                  {strayTarget && (
                    <>
                      <AddressChip value={strayTarget} />
                      <span>or remove it.</span>
                    </>
                  )}
                </>
              ) : byHand && records.length > 0 ? (
                <>
                  <span>
                    Add one record for{" "}
                    <span className="font-mono text-foreground">
                      {domain.name}
                    </span>{" "}
                    per server of the cluster:
                  </span>
                  {records.map((r) => (
                    <span
                      key={`${r.type} ${r.value}`}
                      className="inline-flex items-center gap-1"
                    >
                      <span className="font-medium text-foreground">
                        {r.type}
                      </span>
                      <AddressChip value={r.value} />
                    </span>
                  ))}
                  <span>It&rsquo;s re-checked automatically.</span>
                </>
              ) : records.length > 0 ? (
                <>
                  <span>
                    {domain.status === "pending"
                      ? "This domain doesn’t resolve yet."
                      : "This domain’s DNS doesn’t point here."}{" "}
                    Add an{" "}
                    <span className="font-medium text-foreground">
                      {records[0].type} record
                    </span>{" "}
                    for{" "}
                    <span className="font-mono text-foreground">
                      {domain.name}
                    </span>{" "}
                    →
                  </span>
                  <AddressChip value={records[0].value} />
                  {records[1] && (
                    <>
                      <span>
                        and an{" "}
                        <span className="font-medium text-foreground">
                          {records[1].type} record
                        </span>{" "}
                        →
                      </span>
                      <AddressChip value={records[1].value} />
                    </>
                  )}
                  <span>
                    - the server this app runs on. It’s re-checked
                    automatically.
                  </span>
                </>
              ) : (
                <span>
                  {domain.status === "pending"
                    ? "This domain doesn’t resolve yet."
                    : "This domain’s DNS doesn’t point here."}{" "}
                  Point its{" "}
                  <span className="font-medium text-foreground">A record</span>{" "}
                  (and AAAA for IPv6) at the server this app is deployed on.
                  It’s re-checked automatically.
                </span>
              )}
              {domain.status === "misconfigured" && (
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
        <DomainClusterLines
          domain={domain}
          staysOn={staysOn}
          away={away}
          native={native}
          dnsZones={dnsZones}
          noHealthCheck={noHealthCheck}
          cluster={cluster}
        />
      </TableCell>
      {showContainer && (
        <TableCell className="w-56 max-md:basis-full">
          {routingWarning ? (
            <SimpleTooltip content={routingWarning}>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
                {service || "Not set"}
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
          <StatusBadge
            status={
              domain.proxied && domain.status !== "valid"
                ? "cloudflare"
                : domain.status
            }
          />
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
      <TableCell className="text-right max-md:ml-auto">
        <RowActions
          title={domain.name}
          actions={[
            !domain.primary &&
              !domain.redirectTo && {
                label: "Set as primary",
                icon: Star,
                disabled: !canSetPrimary,
                onSelect: setPrimary,
              },
            {
              label: "Edit",
              icon: Pencil,
              disabled: !canManage,
              onSelect: () => openEdit(),
            },
            {
              label: "Remove",
              icon: Trash2,
              destructive: true,
              disabled: !canManage,
              onSelect: () => setConfirmOpen(true),
            },
          ]}
        >
          <div className="flex items-center justify-end gap-1">
            {!domain.primary && !domain.redirectTo && (
              <SimpleTooltip content="Make this the canonical host">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Set ${domain.name} as primary`}
                  onClick={setPrimary}
                  disabled={!canSetPrimary}
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
        </RowActions>
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
                <DomainNameField
                  id={`edit-name-${domain.id}`}
                  value={name}
                  onChange={setName}
                  suggestedDomain={suggestedDomain}
                  disabled={pending || !canManage}
                />
                {autoDns && (
                  <AutoDnsField
                    id={`edit-${domain.id}-cf`}
                    zone={zone ?? "Cloudflare"}
                    tunnel={tunnel}
                    onTunnel={tunnels ? setWantsTunnel : undefined}
                    proxied={config.proxied}
                    onProxied={(on) => setConfig({ ...config, proxied: on })}
                  />
                )}
                <DomainConfigFields
                  state={config}
                  onChange={setConfig}
                  services={services}
                  idPrefix={`edit-${domain.id}`}
                  proxied={cloudflareDetected}
                  hostname={name}
                  serverIp={serverIp}
                  tunnel={tunnel}
                  autoDns={autoDns}
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

const NO_OP_ACTIONS = [
  { label: "Edit", icon: Pencil, disabled: true },
  { label: "Remove", icon: Trash2, destructive: true, disabled: true },
];

// A primary domain's row while the tab loads, shaped like the common case: a port, a provider
// chip and a status still being checked.
export function DomainRowSkeleton() {
  return (
    <TableRow className={ROW}>
      <TableCell className="max-md:basis-full">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Bone>web-app.example.com</Bone>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
          <Bone box>
            <Badge variant="secondary" className="gap-1">
              <Star className="size-3" />
              Primary
            </Badge>
          </Bone>
          <Bone box>
            <Badge variant="outline" className="gap-1 font-mono">
              <Network className="size-3" />
              :3000
            </Badge>
          </Bone>
          <Bone box>
            <Badge variant="outline" className="gap-1">
              <CloudflareIcon className="size-3" />
              Cloudflare
            </Badge>
          </Bone>
        </div>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1">
          <Bone box>
            <StatusBadge status="cloudflare" />
          </Bone>
          <Bone box>
            <Button variant="ghost" size="icon-sm" disabled>
              <RefreshCw className="size-3.5" />
            </Button>
          </Bone>
        </span>
      </TableCell>
      <TableCell className="text-right max-md:ml-auto">
        <RowActions title="Domain" actions={NO_OP_ACTIONS}>
          <div className="flex items-center justify-end gap-1">
            {[Trash2, Pencil].map((Icon, i) => (
              <Bone box key={i}>
                <Button variant="ghost" size="icon-sm" disabled>
                  <Icon className="size-4" />
                </Button>
              </Bone>
            ))}
          </div>
        </RowActions>
      </TableCell>
    </TableRow>
  );
}
