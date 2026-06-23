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
} from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusBadge } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  DomainConfigFields,
  initialDomainConfig,
  resolveDomainConfig,
  type DomainConfigState,
} from "@/components/domains/domain-config-fields";
import { gqlAction } from "@/lib/graphql-client";
import type { Domain } from "@/lib/types";

type Row = Domain & { projectName: string; projectSlug: string };

/**
 * The menu-primitive set used to render the row's action list once and reuse it
 * for BOTH the ⋯ dropdown (left-click) and the right-click context menu — same
 * items, same handlers, no duplication. Radix dropdown and context menus share
 * an isomorphic API, so the renderer just takes whichever component set applies.
 */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
};

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};
const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};

/** Service names declared in a compose file, parsed in the browser (js-yaml is
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
}: {
  domain: Row;
  /** The project's compose YAML (compose stacks only) so the Edit dialog can
   * offer the service selector. Absent/null ⇒ a single-image project. */
  compose?: string | null;
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

  // The row's actions, rendered once for whichever menu primitive is passed.
  // Shared by the ⋯ dropdown (left-click) and the right-click context menu.
  const menu = (K: MenuKit) => (
    <>
      <K.Item asChild>
        <a
          href={`${scheme}://${domain.name}`}
          target="_blank"
          rel="noopener noreferrer"
          className="cursor-pointer"
        >
          <ExternalLink className="size-4" />
          Visit
        </a>
      </K.Item>
      <K.Item
        onSelect={(e: Event) => {
          e.preventDefault();
          openEdit();
        }}
      >
        <Pencil className="size-4" />
        Edit
      </K.Item>
      {domain.status !== "valid" && (
        <K.Item
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
        </K.Item>
      )}
      {!domain.primary && (
        <K.Item
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
          disabled={pending}
        >
          <Star className="size-4" />
          Set as primary
        </K.Item>
      )}
      <K.Separator />
      <K.Item
        variant="destructive"
        onSelect={(e: Event) => {
          e.preventDefault();
          setConfirmOpen(true);
        }}
      >
        <Trash2 className="size-4" />
        Remove
      </K.Item>
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow onContextMenu={(e) => e.stopPropagation()}>
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
                <Badge
                  variant="outline"
                  className="gap-1"
                  title={middlewares.join(", ")}
                >
                  <Layers className="size-3" />
                  {middlewares.length === 1
                    ? middlewares[0]
                    : `${middlewares.length} middlewares`}
                </Badge>
              )}
              {domain.pathPrefix && (
                <Badge
                  variant="outline"
                  className="gap-1 font-mono"
                  title={
                    domain.stripPrefix
                      ? `path ${domain.pathPrefix} (stripped)`
                      : `path ${domain.pathPrefix}`
                  }
                >
                  <Route className="size-3" />
                  {domain.pathPrefix}
                </Badge>
              )}
            </div>
            {domain.redirectTo && (
              <p className="text-xs text-muted-foreground">
                → {domain.redirectTo}
              </p>
            )}
          </TableCell>
          <TableCell>
            <Link
              href={`/projects/${domain.projectSlug}`}
              className="cursor-pointer text-sm text-muted-foreground hover:text-foreground"
            >
              {domain.projectName}
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
                {menu(DROPDOWN_KIT)}
              </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmAction
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={`Remove ${domain.name}?`}
              description="The domain will stop routing to this project. You can re-add it later."
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
                    <span className="font-medium">{domain.projectName}</span>.
                    Changes apply instantly when the project is running,
                    otherwise on the next deploy.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor={`edit-name-${domain.id}`}>Domain</Label>
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
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {menu(CONTEXT_KIT)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
