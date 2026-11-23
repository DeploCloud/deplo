"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Globe, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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

// The server's addresses, found and proven by Deplo, and the choice between Automatic
// (reachable IPv4 first, else reachable IPv6) or one specific detected address (ADR-0050).

type Family = "ipv4" | "ipv6";
const AUTOMATIC = "__auto__";
const LEGACY_PREFIX = "__legacy__:";
const LEAVES_AFTER_MS = 30 * 60_000;

type Address = {
  address: string;
  family: Family;
  isPrivate: boolean;
  state: "inUse" | "leaving" | "checking" | "notChecked" | "notUsed";
  problem: string;
  leavesAt: string | null;
};

const BADGE: Record<Address["state"], string> = {
  inUse: "In use",
  leaving: "Failing",
  checking: "Checking",
  notChecked: "Not checked",
  notUsed: "Not used",
};

function initialChoice(server: ServerSummary): string {
  if (server.preferredAddress) return server.preferredAddress;
  if (server.generatedAddressFamily)
    return `${LEGACY_PREFIX}${server.generatedAddressFamily}`;
  return AUTOMATIC;
}

export function AddressFamilyPanel({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const moveExistingId = React.useId();
  const [value, setValue] = React.useState<string>(() => initialChoice(server));
  const [asked, setAsked] = React.useState<string | null>(null);
  const [moveExisting, setMoveExisting] = React.useState(true);
  const [addresses, setAddresses] = React.useState<Address[] | null>(
    () => server.initialAddresses ?? null,
  );
  const [primaryAddress, setPrimaryAddress] = React.useState<string | null>(
    () => server.initialPrimaryAddress ?? null,
  );

  const load = React.useCallback(async () => {
    const res = await gqlAction<{
      server: {
        preferredAddress: string | null;
        generatedAddressFamily: Family | null;
        primaryAddress: string | null;
        addresses: Address[];
      } | null;
    }>(
      /* GraphQL */ `
        query ServerAddresses($id: String!) {
          server(id: $id) {
            preferredAddress
            generatedAddressFamily
            primaryAddress
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
    if (res.ok && res.data?.server) {
      const s = res.data.server;
      setAddresses(s.addresses);
      setPrimaryAddress(s.primaryAddress);
      setValue(
        s.preferredAddress
          ? s.preferredAddress
          : s.generatedAddressFamily
            ? `${LEGACY_PREFIX}${s.generatedAddressFamily}`
            : AUTOMATIC,
      );
    }
  }, [server.id]);

  React.useEffect(() => {
    void load();
  }, [load]);
  // Checked every 2 minutes on Deplo's side; the card follows on its own.
  useEvery(10_000, () => void load());

  const isLegacy = value.startsWith(LEGACY_PREFIX);
  const legacyLabel =
    value === `${LEGACY_PREFIX}ipv6` ? "IPv6 only" : "IPv4 only";

  // Keep a previously selected address visible in the selector even while addresses are loading.
  const selectableAddresses = React.useMemo(() => {
    const list = addresses ?? [];
    if (
      value !== AUTOMATIC &&
      !isLegacy &&
      !list.some((a) => a.address === value)
    ) {
      return [
        {
          address: value,
          family: (value.includes(":") ? "ipv6" : "ipv4") as Family,
          isPrivate: false,
          state: "checking" as const,
          problem: "",
          leavesAt: null,
        },
        ...list,
      ];
    }
    return list;
  }, [addresses, value, isLegacy]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4" />
          Addresses
          <InfoTip
            content={
              <>
                Deplo finds this server&apos;s addresses and prefers a reachable
                IPv4, falling back to IPv6 automatically. You can also pick one
                specific detected address.
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
                  {primaryAddress === a.address && (
                    <Badge variant="default">Primary</Badge>
                  )}
                  {a.isPrivate && <Badge variant="outline">Private</Badge>}
                  <Badge
                    variant={a.state === "inUse" ? "secondary" : "outline"}
                  >
                    {a.state === "checking" && (
                      <Loader2 className="size-3 animate-spin" />
                    )}
                    {BADGE[a.state]}
                  </Badge>
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
          <div className="text-sm">Primary address</div>
          <Select
            value={value}
            onValueChange={(next) => {
              if (next === value || next.startsWith(LEGACY_PREFIX)) return;
              setMoveExisting(true);
              setAsked(next);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-80"
              aria-label="Primary address to use"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTOMATIC}>
                Automatic (reachable IPv4, else IPv6)
              </SelectItem>
              {isLegacy && (
                <SelectItem value={value} disabled>
                  {legacyLabel}
                </SelectItem>
              )}
              {selectableAddresses.map((a) => (
                <SelectItem
                  key={a.address}
                  value={a.address}
                  disabled={a.state === "notUsed"}
                >
                  <span className="font-mono">{a.address}</span>
                  {a.isPrivate && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      (Private)
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ConfirmAction
          open={asked !== null}
          onOpenChange={(v) => !v && setAsked(null)}
          title={
            asked === AUTOMATIC
              ? `Use automatic address selection on ${server.name}?`
              : `Use ${asked} as primary on ${server.name}?`
          }
          description={
            asked === AUTOMATIC
              ? "Deplo will pick a reachable IPv4 first, or fall back to IPv6 when IPv4 does not answer."
              : "New generated addresses and DNS hints on this server will use this IP."
          }
          extra={
            <label
              htmlFor={moveExistingId}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm"
            >
              <Checkbox
                id={moveExistingId}
                checked={moveExisting}
                onCheckedChange={(v) => setMoveExisting(v === true)}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block font-medium">
                  Update existing generated domains
                </span>
                <span className="block text-xs text-muted-foreground">
                  Move existing .deplo.site addresses on this server to the new
                  primary IP.
                </span>
              </span>
            </label>
          }
          confirmLabel="Change"
          variant="default"
          successMessage="Primary address updated"
          onConfirm={async () => {
            const next = asked ?? AUTOMATIC;
            const res = await gqlAction<{
              setServerPreferredAddress: number;
            }>(
              /* GraphQL */ `
                mutation SetServerPreferredAddress(
                  $id: String!
                  $address: String
                  $moveExisting: Boolean
                ) {
                  setServerPreferredAddress(
                    id: $id
                    address: $address
                    moveExisting: $moveExisting
                  )
                }
              `,
              {
                id: server.id,
                address: next === AUTOMATIC ? null : next,
                moveExisting,
              },
            );
            if (res.ok) {
              setValue(next);
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
