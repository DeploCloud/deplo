"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";

import { useRouter } from "@/lib/nav";
import { gqlAction } from "@/lib/graphql-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { ConnectWizard } from "./connect-wizard";
import { DNS_PROVIDER_META, ProviderMark } from "./provider-mark";
import { TeamAccess, type DnsTeam } from "./team-access";

export interface ConnectedDns {
  id: string;
  provider: "cloudflare";
  zoneName: string;
  shared: boolean;
  teams: DnsTeam[];
}

export function DnsSettings({
  providers,
  teams,
  activeTeamId,
}: {
  providers: ConnectedDns[];
  teams: DnsTeam[];
  activeTeamId: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(providers.length === 0);
  const [runId, setRunId] = React.useState(0);

  if (adding || providers.length === 0)
    return (
      <ConnectWizard
        key={runId}
        teams={teams}
        activeTeamId={activeTeamId}
        onCancel={providers.length > 0 ? () => setAdding(false) : undefined}
        onDone={() => {
          setAdding(false);
          setRunId((n) => n + 1);
          router.refresh();
        }}
      />
    );

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Your domains</h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Connect a domain
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {providers.map((p) => (
          <ConnectedRow key={p.id} provider={p} teams={teams} />
        ))}
      </ul>
    </div>
  );
}

function ConnectedRow({
  provider,
  teams,
}: {
  provider: ConnectedDns;
  teams: DnsTeam[];
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  // A team you no longer manage domains in still shows, so it can be taken off.
  const choices = [
    ...teams,
    ...provider.teams.filter((t) => !teams.some((c) => c.id === t.id)),
  ];

  return (
    <li className="flex flex-wrap items-center gap-3 p-4">
      <ProviderMark provider={provider.provider} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-sm">{provider.zoneName}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {DNS_PROVIDER_META[provider.provider].label} ·{" "}
          {provider.teams.map((t) => t.name).join(", ") || "No team"}
        </p>
      </div>
      <Badge variant="muted">
        {provider.shared ? "Anyone in these teams" : "Only you"}
      </Badge>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button variant="outline" size="sm" onClick={() => setRemoving(true)}>
          Disconnect
        </Button>
      </div>

      <EditAccessDialog
        open={editing}
        onOpenChange={setEditing}
        provider={provider}
        teams={choices}
        onSaved={() => router.refresh()}
      />
      <ConfirmAction
        open={removing}
        onOpenChange={setRemoving}
        title={`Disconnect ${provider.zoneName}?`}
        description="New domains under it no longer get their DNS created."
        consequence="Domains served through its Cloudflare Tunnels stop working, and their DNS records are deleted."
        confirmLabel="Disconnect"
        successMessage={`${provider.zoneName} disconnected`}
        onConfirm={async () => {
          const res = await gqlAction<
            { removeDnsProvider: string | null },
            string | null
          >(
            /* GraphQL */ `
              mutation RemoveDnsProvider($id: String!) {
                removeDnsProvider(id: $id)
              }
            `,
            { id: provider.id },
            (d) => d.removeDnsProvider,
          );
          if (res.ok && res.data) toast.warning(res.data);
          router.refresh();
          return res;
        }}
      />
    </li>
  );
}

function EditAccessDialog({
  open,
  onOpenChange,
  provider,
  teams,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ConnectedDns;
  teams: DnsTeam[];
  onSaved: () => void;
}) {
  const [selected, setSelected] = React.useState(() =>
    provider.teams.map((t) => t.id),
  );
  const [shared, setShared] = React.useState(provider.shared);
  const [pending, setPending] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(provider.teams.map((t) => t.id));
      setShared(provider.shared);
    }
  }

  async function save() {
    setPending(true);
    const res = await gqlAction(
      /* GraphQL */ `
        mutation UpdateDnsProvider(
          $id: String!
          $teamIds: [String!]!
          $shared: Boolean!
        ) {
          updateDnsProvider(id: $id, teamIds: $teamIds, shared: $shared) {
            id
          }
        }
      `,
      { id: provider.id, teamIds: selected, shared },
    );
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Saved");
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Who can use {provider.zoneName}?</DialogTitle>
          <DialogDescription>
            Domains added in these teams get their DNS created for them.
          </DialogDescription>
        </DialogHeader>
        <TeamAccess
          idPrefix={`dns-edit-${provider.id}`}
          teams={teams}
          selected={selected}
          shared={shared}
          onSelected={setSelected}
          onShared={setShared}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || selected.length === 0}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
