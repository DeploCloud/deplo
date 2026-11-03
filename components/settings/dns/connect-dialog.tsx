"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { useRouter } from "@/lib/nav";
import { gqlAction } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DocsLink } from "@/components/ui/docs-link";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DNS_PROVIDER_META,
  ProviderMark,
  type DnsProviderId,
} from "./provider-mark";
import { TeamAccess, type DnsTeam } from "./team-access";

const PROVIDERS = Object.keys(DNS_PROVIDER_META) as DnsProviderId[];

type Checked = { zoneName: string; tunnels: boolean };

export function ConnectDnsDialog({
  open,
  onOpenChange,
  teams,
  activeTeamId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: DnsTeam[];
  activeTeamId: string;
}) {
  const router = useRouter();
  const initialTeams = () =>
    teams.some((t) => t.id === activeTeamId) ? [activeTeamId] : [];
  const [provider, setProvider] = React.useState<DnsProviderId>(PROVIDERS[0]);
  const [zone, setZone] = React.useState("");
  const [token, setToken] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>(initialTeams);
  const [shared, setShared] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setZone("");
      setToken("");
      setSelected(initialTeams());
      setShared(false);
    }
  }
  const meta = DNS_PROVIDER_META[provider];
  const ready =
    zone.trim() !== "" && token.trim() !== "" && selected.length > 0;

  async function connect() {
    setPending(true);
    const checked = await gqlAction<{ checkDnsProvider: Checked }, Checked>(
      /* GraphQL */ `
        mutation CheckDnsProvider(
          $provider: DnsProviderKind!
          $zone: String!
          $apiToken: String!
        ) {
          checkDnsProvider(
            provider: $provider
            zone: $zone
            apiToken: $apiToken
          ) {
            zoneName
            tunnels
          }
        }
      `,
      { provider, zone: zone.trim(), apiToken: token.trim() },
      (d) => d.checkDnsProvider,
    );
    if (!checked.ok) {
      setPending(false);
      toast.error(checked.error);
      return;
    }
    const zoneName = checked.data?.zoneName ?? zone.trim();
    const saved = await gqlAction(
      /* GraphQL */ `
        mutation SaveDnsProvider(
          $provider: DnsProviderKind!
          $zone: String!
          $apiToken: String!
          $teamIds: [String!]!
          $shared: Boolean!
        ) {
          saveDnsProvider(
            provider: $provider
            zone: $zone
            apiToken: $apiToken
            teamIds: $teamIds
            shared: $shared
          ) {
            id
          }
        }
      `,
      {
        provider,
        zone: zoneName,
        apiToken: token.trim(),
        teamIds: selected,
        shared,
      },
    );
    setPending(false);
    if (!saved.ok) {
      toast.error(saved.error);
      return;
    }
    if (checked.data?.tunnels === false)
      toast.warning(
        `${zoneName} is connected, without Cloudflare Tunnels: the token lacks Cloudflare Tunnel: Edit`,
      );
    else toast.success(`${zoneName} is connected`);
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a domain</DialogTitle>
          <DialogDescription>
            Deplo creates the DNS record when you add a domain under it to an
            app. <DocsLink topic="domains.automaticDns" />
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !pending) void connect();
          }}
        >
          <div className="space-y-2">
            <FieldLabel
              htmlFor="dns-provider"
              info="Where your domain's DNS records live."
            >
              DNS provider
            </FieldLabel>
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as DnsProviderId)}
            >
              <SelectTrigger id="dns-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((id) => (
                  <SelectItem key={id} value={id}>
                    <span className="flex items-center gap-2">
                      <ProviderMark provider={id} size="xs" />
                      {DNS_PROVIDER_META[id].label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="dns-zone"
              info={`The domain as it is listed in your ${meta.label} account. Every name under it gets automatic DNS.`}
              docs="domains.automaticDnsConnect"
            >
              Domain
            </FieldLabel>
            <Input
              id="dns-zone"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="dns-token"
              info="Deplo keeps it encrypted, and uses it only to create and delete this domain's records and tunnels."
              docs="domains.automaticDnsConnect"
            >
              API token
            </FieldLabel>
            <Input
              id="dns-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {meta.tokenHint}{" "}
              <a
                href={meta.tokenUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Create one
              </a>
            </p>
          </div>
          <div className="space-y-3">
            <p className="text-sm font-medium">Who can use it</p>
            <TeamAccess
              idPrefix="dns-connect"
              teams={teams}
              selected={selected}
              shared={shared}
              onSelected={setSelected}
              onShared={setShared}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !ready}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
