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

// The server's addresses, found and proven by Deplo, and the one choice left: which family it uses (ADR-0050).

type Family = "ipv4" | "ipv6";
const AUTOMATIC = "__auto__";
const LEAVES_AFTER_MS = 30 * 60_000;

type Address = {
  address: string;
  family: Family;
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

const CHOICE: Record<string, string> = {
  [AUTOMATIC]: "Automatic",
  ipv6: "IPv6 only",
  ipv4: "IPv4 only",
};

export function AddressFamilyPanel({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [value, setValue] = React.useState<string>(
    server.generatedAddressFamily ?? AUTOMATIC,
  );
  const [asked, setAsked] = React.useState<string | null>(null);
  const [addresses, setAddresses] = React.useState<Address[] | null>(null);

  const load = React.useCallback(async () => {
    const res = await gqlAction<{ server: { addresses: Address[] } | null }>(
      /* GraphQL */ `
        query ServerAddresses($id: String!) {
          server(id: $id) {
            addresses {
              address
              family
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
    void load();
  }, [load]);
  // Checked every 2 minutes on Deplo's side; the card follows on its own.
  useEvery(10_000, () => void load());

  const has = (f: Family) =>
    !addresses ||
    addresses.some((a) => a.family === f && a.state !== "notUsed");

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
          <div className="text-sm">Use</div>
          <Select
            value={value}
            onValueChange={(next) => next !== value && setAsked(next)}
          >
            <SelectTrigger
              className="w-full sm:w-56"
              aria-label="Addresses to use"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
              <SelectItem value="ipv6" disabled={!has("ipv6")}>
                IPv6 only
              </SelectItem>
              <SelectItem value="ipv4" disabled={!has("ipv4")}>
                IPv4 only
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ConfirmAction
          open={asked !== null}
          onOpenChange={(v) => !v && setAsked(null)}
          title={`Use ${CHOICE[asked ?? AUTOMATIC]} on ${server.name}?`}
          description="Its generated names move to the new address, and its domains' records follow."
          confirmLabel="Change"
          variant="default"
          successMessage="Addresses updated"
          onConfirm={async () => {
            const next = asked ?? AUTOMATIC;
            const res = await gqlAction<{ setServerAddressFamily: number }>(
              /* GraphQL */ `
                mutation SetServerAddressFamily(
                  $id: String!
                  $family: AddressFamily
                ) {
                  setServerAddressFamily(id: $id, family: $family)
                }
              `,
              { id: server.id, family: next === AUTOMATIC ? null : next },
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
