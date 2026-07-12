"use client";

import * as React from "react";
import { Play, Square, Plug, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useGraphqlMutation } from "@/lib/use-graphql";
import { gqlAction } from "@/lib/graphql-client";
import { McpConnectDialog } from "./mcp-connect-dialog";
import type { PluginListing } from "@/lib/plugins/manifest";
import type { InstalledPluginDTO } from "@/lib/data/plugins";

const INSTALL = `mutation($catalogId: String!) {
  installPlugin(catalogId: $catalogId) { id catalogId status url }
}`;
const UNINSTALL = `mutation($id: String!) { uninstallPlugin(id: $id) }`;
const START = `mutation($id: String!) { startPlugin(id: $id) }`;
const STOP = `mutation($id: String!) { stopPlugin(id: $id) }`;

/** Logo tile (data-URI / repo path / letter fallback), like a template card. */
function Logo({ src, name }: { src?: string | null; name: string }) {
  return (
    <div className="flex size-11 items-center justify-center overflow-hidden rounded-lg border border-border p-1.5">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="size-full object-contain" loading="lazy" />
      ) : (
        <span className="text-lg font-semibold text-foreground">{name.slice(0, 1)}</span>
      )}
    </div>
  );
}

function Shell({
  children,
  header,
}: {
  children: React.ReactNode;
  header: React.ReactNode;
}) {
  return (
    <Card className="group relative flex flex-col gap-3 p-5 transition-colors hover:border-foreground/20">
      {header}
      {children}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Catalog card — an installable plugin (Install)                         */
/* ------------------------------------------------------------------ */

export function CatalogPluginCard({
  listing,
  installed,
}: {
  listing: PluginListing;
  /** True when this plugin already has an InstalledPlugin row for the team. */
  installed: boolean;
}) {
  const { run, pending } = useGraphqlMutation<{ installPlugin: { url: string; catalogId: string } }>(
    INSTALL,
  );
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [endpoint, setEndpoint] = React.useState("");

  async function install() {
    const data = await run({ catalogId: listing.id });
    if (!data) {
      toast.error("Install failed");
      return;
    }
    toast.success(`Installed ${listing.name}`);
    // For the MCP plugin, surface the connect dialog with the live plugin-path /mcp.
    if (data.installPlugin.catalogId === "mcp") {
      setEndpoint(`${data.installPlugin.url}/mcp`);
      setConnectOpen(true);
    }
  }

  return (
    <Shell
      header={
        <div className="flex items-start justify-between gap-2">
          <Logo src={listing.logo} name={listing.name} />
          {listing.tags[0] && (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {listing.tags[0]}
            </span>
          )}
        </div>
      }
    >
      <div className="flex-1">
        <h3 className="font-medium">{listing.name}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {listing.description}
        </p>
      </div>
      <Button
        size="sm"
        variant={installed ? "outline" : "default"}
        className="mt-1 w-full"
        onClick={install}
        disabled={pending}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
        {installed ? "Reinstall" : "Install"}
      </Button>
      <McpConnectDialog open={connectOpen} onOpenChange={setConnectOpen} endpoint={endpoint} />
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* Installed card — Start / Stop / Connect / Uninstall + live status   */
/* ------------------------------------------------------------------ */

export function InstalledPluginCard({
  plugin,
  name,
  logo,
}: {
  plugin: InstalledPluginDTO;
  /** Display name from the catalog (the row stores only catalogId). */
  name: string;
  logo?: string | null;
}) {
  const start = useGraphqlMutation<{ startPlugin: boolean }>(START);
  const stop = useGraphqlMutation<{ stopPlugin: boolean }>(STOP);
  const [connectOpen, setConnectOpen] = React.useState(false);
  const busy = start.pending || stop.pending;
  const isMcp = plugin.catalogId === "mcp";
  const running = plugin.status === "running";

  return (
    <Shell
      header={
        <div className="flex items-start justify-between gap-2">
          <Logo src={logo} name={name} />
          <StatusBadge status={plugin.status} />
        </div>
      }
    >
      <div className="flex-1">
        <h3 className="font-medium">{name}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          v{plugin.version} · host-managed container
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => stop.run({ id: plugin.id })}
            disabled={busy}
          >
            {stop.pending ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => start.run({ id: plugin.id })}
            disabled={busy}
          >
            {start.pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Start
          </Button>
        )}

        {isMcp && (
          <Button size="sm" variant="outline" onClick={() => setConnectOpen(true)}>
            <Plug className="size-4" />
            Connect
          </Button>
        )}

        <ConfirmAction
          trigger={
            <Button size="sm" variant="ghost" className="ml-auto text-destructive">
              Uninstall
            </Button>
          }
          title={`Uninstall ${name}?`}
          description="This stops and removes the plugin's container and its route. Your own API tokens are unaffected."
          confirmLabel="Uninstall"
          successMessage={`Uninstalled ${name}`}
          onConfirm={() => gqlAction(UNINSTALL, { id: plugin.id })}
        />
      </div>

      {isMcp && (
        <McpConnectDialog
          open={connectOpen}
          onOpenChange={setConnectOpen}
          endpoint={`${plugin.url}/mcp`}
        />
      )}
    </Shell>
  );
}
