"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Globe, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Countdown, useEvery } from "@/components/shared/live-state";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";

// The server's addresses, found and proven by Deplo, and the one choice left: which one its generated addresses use (ADR-0050).

const AUTOMATIC = "__auto__";
const LEAVES_AFTER_MS = 30 * 60_000;

export type ServerAddressView = {
  address: string;
  family: "ipv4" | "ipv6";
  isPrivate: boolean;
  state: "inUse" | "leaving" | "checking" | "notChecked" | "notUsed";
  problem: string;
  leavesAt: string | null;
};

const BADGE: Record<ServerAddressView["state"], string> = {
  inUse: "In use",
  leaving: "Failing",
  checking: "Checking",
  notChecked: "Not checked",
  notUsed: "Not used",
};

// What a generated address can carry: any IPv4 it reaches, or a public IPv6.
const canCarry = (a: ServerAddressView) =>
  (a.state === "inUse" || a.state === "leaving") &&
  (a.family === "ipv4" || !a.isPrivate);

export function AddressFamilyPanel({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const current =
    server.preferredAddress ?? server.generatedAddressFamily ?? AUTOMATIC;
  const [asked, setAsked] = React.useState<string | null>(null);
  const [addresses, setAddresses] = React.useState<ServerAddressView[] | null>(
    server.addresses ?? null,
  );

  const load = React.useCallback(async () => {
    const res = await gqlAction<{
      server: { addresses: ServerAddressView[] } | null;
    }>(
      /* GraphQL */ `
        query ServerAddresses($id: String!) {
          server(id: $id) {
            addresses {
              address
              family
              isPrivate
              state
              problem
              leavesAt
            }
          }
        }
      `,
      { id: server.id },
    );
    if (res.ok && res.data?.server) setAddresses(res.data.server.addresses);
  }, [server.id]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!server.addresses) void load();
  }, [load, server.addresses]);
  // Checked every 2 minutes on Deplo's side; the card follows on its own.
  useEvery(10_000, () => void load());

  const choices = (addresses ?? []).filter(canCarry);
  const askedPrivate = addresses?.some(
    (a) => a.address === asked && a.isPrivate,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4" />
          Addresses
          <InfoTip
            content={
              <>
                Deplo finds this server&apos;s addresses and uses one once it
                reaches the server. Nobody types one.
              </>
            }
            docs="servers.generatedAddresses"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {addresses === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading its addresses
          </p>
        ) : addresses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Deplo is finding this server&apos;s addresses.
          </p>
        ) : (
          <ul className="space-y-3">
            {addresses.map((a) => (
              <li key={a.address} className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-sm">
                    {a.address}
                  </span>
                  <Badge
                    variant={a.state === "inUse" ? "secondary" : "outline"}
                  >
                    {a.state === "checking" && (
                      <Loader2 className="size-3 animate-spin" />
                    )}
                    {BADGE[a.state]}
                  </Badge>
                  {a.address === server.generatedAddress && (
                    <Badge variant="info">Primary</Badge>
                  )}
                  {a.isPrivate && <Badge variant="outline">Private</Badge>}
                </div>
                {a.problem && (
                  <p className="text-xs text-muted-foreground">{a.problem}</p>
                )}
                {a.state === "leaving" && a.leavesAt && (
                  <Countdown
                    until={a.leavesAt}
                    total={LEAVES_AFTER_MS}
                    label="Leaves unless it reaches the server again"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="flex items-center gap-1.5 text-sm">
            Generated addresses
            <InfoTip content="The address in this server's generated addresses. Automatic uses a reachable IPv4, else IPv6. A private one answers only inside its network." />
          </div>
          <Select
            value={current}
            onValueChange={(next) => next !== current && setAsked(next)}
          >
            <SelectTrigger
              className="w-full sm:w-72"
              aria-label="Address its generated addresses use"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
              {server.generatedAddressFamily && !server.preferredAddress && (
                <SelectItem value={server.generatedAddressFamily} disabled>
                  {server.generatedAddressFamily === "ipv6"
                    ? "IPv6 only"
                    : "IPv4 only"}
                </SelectItem>
              )}
              {choices.map((a) => (
                <SelectItem key={a.address} value={a.address}>
                  <span className="font-mono">{a.address}</span>
                  {a.isPrivate && <Badge variant="outline">Private</Badge>}
                </SelectItem>
              ))}
              {server.preferredAddress &&
                !choices.some((a) => a.address === server.preferredAddress) && (
                  <SelectItem value={server.preferredAddress} disabled>
                    <span className="font-mono">{server.preferredAddress}</span>
                  </SelectItem>
                )}
            </SelectContent>
          </Select>
        </div>
        <ConfirmAction
          open={asked !== null}
          onOpenChange={(v) => !v && setAsked(null)}
          title={
            asked === AUTOMATIC
              ? `Pick ${server.name}'s address automatically?`
              : `Use ${asked} on ${server.name}?`
          }
          description={
            askedPrivate
              ? "Its generated addresses move there now, and answer only inside its private network."
              : "Its generated addresses move there now."
          }
          confirmLabel="Change"
          variant="default"
          successMessage="Addresses updated"
          onConfirm={async () => {
            const next = asked ?? AUTOMATIC;
            const res = await gqlAction<{ setServerPreferredAddress: number }>(
              /* GraphQL */ `
                mutation SetServerPreferredAddress(
                  $id: String!
                  $address: String
                ) {
                  setServerPreferredAddress(id: $id, address: $address)
                }
              `,
              { id: server.id, address: next === AUTOMATIC ? null : next },
            );
            if (res.ok) {
              setAsked(null);
              await load();
              router.refresh();
            }
            return res;
          }}
        />
      </CardContent>
    </Card>
  );
}
