"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Globe } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BetaChip } from "@/components/shared/beta-chip";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";

type Family = "ipv4" | "ipv6";
const AUTOMATIC = "__auto__";

interface Choices {
  ipv4: string | null;
  ipv6: string | null;
  inUse: string | null;
}

export function AddressFamilyPanel({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [value, setValue] = React.useState<string>(
    server.generatedAddressFamily ?? AUTOMATIC,
  );
  const [choices, setChoices] = React.useState<Choices | null>(null);

  const load = React.useCallback(async () => {
    const res = await gqlAction<{
      server: { generatedAddresses: Choices } | null;
    }>(
      /* GraphQL */ `
        query ServerGeneratedAddresses($id: String!) {
          server(id: $id) {
            generatedAddresses {
              ipv4
              ipv6
              inUse
            }
          }
        }
      `,
      { id: server.id },
    );
    if (res.ok && res.data?.server)
      setChoices(res.data.server.generatedAddresses);
  }, [server.id]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function pick(next: string) {
    const previous = value;
    setValue(next);
    startTransition(async () => {
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
      if (!res.ok) {
        setValue(previous);
        toast.error(res.error);
        return;
      }
      const moved = res.data?.setServerAddressFamily ?? 0;
      toast.success(
        moved > 0
          ? `Generated addresses updated. ${moved} ${moved === 1 ? "app answers" : "apps answer"} on the new one after the next deploy.`
          : "Generated addresses updated",
      );
      await load();
      router.refresh();
    });
  }

  const has = (f: Family) => (choices ? choices[f] !== null : true);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4" />
          Generated addresses
          <BetaChip />
          <InfoTip
            content={
              <>
                The free .deplo.site addresses apps on this server get. Pick
                IPv6 when visitors reach this server over IPv6 only.
              </>
            }
            docs="servers.generatedAddresses"
          />
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          {choices?.inUse
            ? `New addresses point at ${choices.inUse}.`
            : choices
              ? "Deplo doesn't know an address for this server yet."
              : "Checking this server's addresses..."}
        </p>
      </CardHeader>
      <CardContent>
        <Select value={value} onValueChange={pick} disabled={pending}>
          <SelectTrigger
            className="w-full sm:w-56"
            aria-label="Generated addresses"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
            <SelectItem value="ipv4" disabled={!has("ipv4")}>
              IPv4{choices?.ipv4 ? ` (${choices.ipv4})` : ""}
            </SelectItem>
            <SelectItem value="ipv6" disabled={!has("ipv6")}>
              IPv6{choices?.ipv6 ? ` (${choices.ipv6})` : ""}
            </SelectItem>
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  );
}
