"use client";

import * as React from "react";
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
  Signpost,
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
import { useOptimisticRow } from "@/components/shared/optimistic-list";
import { gqlAction } from "@/lib/graphql-client";
import { useAppCan } from "@/components/apps/app-capabilities";
import { deriveWwwRedirect } from "@/lib/www-redirect";
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
  isCompose,
  showContainer,
  serverIp,
  siblings = [],
}: {
  domain: Row;
  /** Every domain of the SAME app, so the Edit dialog can DERIVE this hostname's
   * `www` pairing from the rows that exist rather than from a stored flag. The
   * page already holds them; passing them keeps the derivation in one direction
   * (rows ⇒ state), so a companion removed by hand shows up as "No redirect" on
   * the next render instead of a lie. */
  siblings?: { name: string; redirectTo?: string | null }[];
  /** The app's compose YAML (compose stacks only) so the Edit dialog can
   * offer the service selector. Absent/null ⇒ a single-image project. */
  compose?: string | null;
  /** Whether the app really is a compose stack (`usesComposeStack`, resolved by
   * the page). NOT inferred from `compose` here: an app can carry leftover
   * compose text while deploying a repo/image, and that inference would make
   * the Container cell warn "no service" about a domain that routes fine. */
  isCompose: boolean;
  /** Whether the table renders the Container column at all (resolved by the page:
   * only when the app has more than one container to route to, or a row on a
   * stack names none). With one container every row would print the same name,
   * so the column is dropped and this cell with it — the header count and the
   * cells must agree, hence a prop rather than a per-row decision. */
  showContainer: boolean;
  /** The public IPv4 of the server THIS project is deployed on — the address a
   * custom domain's A record must resolve to. Surfaced in the misconfigured hint
   * so the user knows exactly where to point DNS. It is server-specific (a
   * project on another server needs a different IP), so it is resolved per
   * project and passed in, never a shared constant. */
  serverIp?: string;
}) {
  const router = useRouter();
  // Every entry in the row menu except Visit changes routing, so one permission
  // greys them all out - the row itself stays readable.
  const canManage = useAppCan("manage_domains");
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // Removing takes the row off the table on the click; the domain is gone from
  // the app the moment the mutation is sent and the routing reload follows it.
  const { hide, restore } = useOptimisticRow(domain.id);
  const [editOpen, setEditOpen] = React.useState(false);
  const services = React.useMemo(() => composeServices(compose), [compose]);

  // What this hostname's router actually reaches. A compose stack routes to the
  // compose service the domain NAMES (required on a stack — `buildComposeStack`
  // skips a route that names none, so an empty one is genuinely unrouted); a
  // single-image app has exactly one container, `deplo-<slug>` (the
  // `container_name` renderCompose writes, and what lib/data/console calls it).
  // Same thing the Logs/Console picker shows for the same app: the service name
  // on a stack, the container name when there is only one — NOT the App's
  // display name, which is identical on every row of this page and names no
  // container at all.
  const service = (domain.service ?? "").trim();
  const container = service || `deplo-${domain.appSlug}`;
  // A compose row that names no service: the stack renderer has no target to
  // wire, so the hostname reaches nothing until one is picked.
  const unrouted = isCompose && !service;

  // The `www` pairing this hostname is currently in, read off the app's rows.
  const www = React.useMemo(
    () => deriveWwwRedirect(domain.name, siblings),
    [domain.name, siblings],
  );

  // Edit-dialog form state: name lives here; the routing knobs in `config`.
  const [name, setName] = React.useState(domain.name);
  const [config, setConfig] = React.useState<DomainConfigState>(() =>
    initialDomainConfig(domain, undefined, www),
  );

  const effectiveProvider = domain.certProvider ?? "letsencrypt";
  const scheme = effectiveProvider === "none" ? "http" : "https";
  const middlewares = domain.middlewares ?? [];
  const proxied = domain.status === "cloudflare";
  // A proxied domain is now put on the Cloudflare certificate provider
  // automatically, so the certificate chip and the DNS chip would BOTH read
  // "Cloudflare" — two badges, inches apart, saying the same word. They collapse
  // into one: Cloudflare fronts this domain and issues its certificate. The pair
  // only splits back apart when the two genuinely differ (a proxied domain the
  // user moved onto Let's Encrypt), which is exactly when it's worth two chips.
  const oneCloudflareChip = proxied && effectiveProvider === "cloudflare";

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
    const resolved = resolveDomainConfig(config, services.length > 0, trimmedName);
    if (!resolved.ok) {
      toast.error(resolved.error);
      return;
    }
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
            // The pairing is derived, so this is the CURRENT value unless the
            // user changed it — the server no-ops when it already matches.
            www: resolved.www,
          },
        },
      );
      if (res.ok) {
        // A rename re-checks the NEW hostname's DNS server-side, so the toast
        // reports what the check found — same as the add does. A flat "updated"
        // after typing a hostname nothing points at reads as "and it works".
        const status = res.data?.updateDomain.status;
        if (trimmedName === domain.name || status === "valid")
          toast.success("Domain updated");
        else if (status === "cloudflare")
          toast.warning(
            "Domain updated - proxied through Cloudflare, so deplo can’t confirm it reaches this app; check its origin IP on the row",
          );
        else if (status === "misconfigured")
          toast.warning(
            "Domain updated, but its DNS points at another address - see the hint on its row",
          );
        else
          toast.warning(
            "Domain updated - point its DNS at the server and it verifies automatically",
          );
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
          {domain.redirectTo && (
            // This hostname serves nothing — it answers 301 to the canonical
            // half of its www pair. Said as a chip in the same row as the rest,
            // because "what does this hostname do" is the question this cell
            // answers, and a redirect is the whole answer for this one.
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
            // The merged chip — see `oneCloudflareChip`. Cloudflare's brand
            // orange (a deliberate exception to the token-only rule) marks who
            // is in front of the domain; the `https://` link above it and the
            // notice below carry the rest, so this stays a label, not a lecture.
            <Badge
              variant="outline"
              className="gap-1 border-[#f38020]/40 bg-[#f38020]/15 text-[#f38020]"
            >
              <Cloud className="size-3" />
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
          {proxied && !oneCloudflareChip && (
            // Marks WHO sits in front of the domain, nothing more. What that
            // proxy hides — and the two things the user has to check because of
            // it — is the notice below the row, not a tooltip here: the chip and
            // the notice are inches apart in the same cell, so saying it twice
            // would just teach people to ignore both.
            //
            // Only rendered when the certificate chip does NOT already say
            // "Cloudflare" (the user moved this proxied domain onto Let's
            // Encrypt); otherwise the merged chip above stands for both.
            //
            // Cloudflare's brand orange — a deliberate brand-color exception to
            // the token-only rule. Alpha tints keep the fill/border legible on
            // both the light and dark theme.
            <Badge
              variant="outline"
              className="gap-1 border-[#f38020]/40 bg-[#f38020]/15 text-[#f38020]"
            >
              <Cloud className="size-3" />
              Cloudflare DNS
            </Badge>
          )}
        </div>
        {(domain.status === "misconfigured" || domain.status === "pending") && (
          // A pending domain has no DNS record yet; a misconfigured one
          // resolves somewhere other than this app's server. Both need the
          // same fix, so both get the instructions: the A record must resolve
          // to THIS app's server IP, which is server-specific (an app on
          // another server needs a different address) — so the concrete IP is
          // shown, never a generic one. No "then Verify" chore: the page
          // re-checks DNS automatically while it's open.
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
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
                  — the IP of the server this app runs on (unique to this
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
          </div>
        )}
        {proxied && (
          // The one status deplo cannot settle for the user. Cloudflare's
          // anycast IPs are shared by every proxied domain alive, so the origin
          // behind them is invisible from DNS (lib/deploy/cloudflare.ts) — this
          // row looks identical whether Cloudflare forwards here or to a
          // stranger's server. Rather than imply a verification that never
          // happened, say so and hand over the two things only the user can
          // check, both in the Cloudflare dashboard: the record's origin IP and
          // the SSL/TLS mode. Same shape as the pending/misconfigured hint
          // above, and deliberately one quiet line — the likely case is that
          // everything is fine, so this is a "confirm this", not an alarm.
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
            {serverIp ? (
              <>
                <span>
                  Proxied through Cloudflare, which hides where this domain
                  really points — deplo can’t confirm it reaches this app. In
                  Cloudflare, this record’s origin must be
                </span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                  {serverIp}
                </code>
                <CopyButton value={serverIp} className="size-6" />
                <span>
                  with SSL/TLS set to{" "}
                  <span className="font-medium text-foreground">Full</span>.
                </span>
              </>
            ) : (
              <span>
                Proxied through Cloudflare, which hides where this domain really
                points — deplo can’t confirm it reaches this app. In Cloudflare,
                point this record’s origin at the IP of the server this app runs
                on, with SSL/TLS set to{" "}
                <span className="font-medium text-foreground">Full</span>.
              </span>
            )}
          </div>
        )}
      </TableCell>
      {showContainer && (
        <TableCell className="w-56">
          {unrouted ? (
            <SimpleTooltip content="This domain doesn't name a container, so nothing serves it. Edit the domain to pick one.">
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
                Not set
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
            <DropdownMenuItem onSelect={() => openEdit()} disabled={!canManage}>
              <Pencil className="size-4" />
              Edit
            </DropdownMenuItem>
            {domain.status !== "valid" && (
              <DropdownMenuItem
                onClick={() =>
                  // Verify reports what the check actually FOUND, not a blanket
                  // "verified": a domain can settle on pending/misconfigured and
                  // the toast must say so (the page keeps re-checking it
                  // automatically either way).
                  startTransition(async () => {
                    const res = await gqlAction<{
                      verifyDomain: { id: string; status: string };
                    }>(
                      /* GraphQL */ `mutation($id: String!) {
                        verifyDomain(id: $id) { id status }
                      }`,
                      { id: domain.id },
                    );
                    if (!res.ok) {
                      toast.error(res.error);
                      return;
                    }
                    const status = res.data?.verifyDomain.status;
                    if (status === "valid")
                      toast.success("Domain verified — routing is live");
                    else if (status === "cloudflare")
                      toast.warning(
                        "Proxied through Cloudflare — deplo can’t confirm this domain reaches this app; check its origin IP on the row",
                      );
                    else if (status === "misconfigured")
                      toast.warning(
                        "This domain’s DNS points at another address — see the hint on its row",
                      );
                    else
                      toast.warning(
                        "No DNS record found yet — it’s re-checked automatically",
                      );
                    router.refresh();
                  })
                }
                disabled={pending || !canManage}
              >
                <RefreshCw className="size-4" />
                Verify
              </DropdownMenuItem>
            )}
            {/* A redirecting hostname can never be the canonical host — it
                serves nothing. The pair is flipped from the Redirect setting of
                the domain that DOES serve, and the server refuses this too. */}
            {!domain.primary && !domain.redirectTo && (
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
                disabled={pending || !canManage || domain.status === "misconfigured"}
              >
                <Star className="size-4" />
                Set as primary
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirmOpen(true)}
              disabled={!canManage}
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
          optimistic
          onConfirm={async () => {
            hide();
            const res = await gqlAction<{ removeDomain: boolean }>(
              `mutation($id: String!) { removeDomain(id: $id) }`,
              { id: domain.id },
            );
            if (!res.ok) restore();
            // No revalidatePath on the GraphQL API — refresh so the row list
            // settles on what the server actually serves.
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
                Changes apply instantly when the app is running,
                otherwise on the next deploy.
              </DialogDescription>
            </DialogHeader>
            <form className="grid gap-4" onSubmit={onSubmitEdit}>
              <div className="space-y-4">
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor={`edit-name-${domain.id}`}
                    info="Fully-qualified hostname, e.g. app.example.com. Its DNS A record must point at this server to verify."
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
                  proxied={proxied}
                  hostname={name}
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
                  {pending ? "Saving…" : "Save changes"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}
