"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Bone } from "@/components/ui/skeleton";
import { ConnectDnsDialog } from "./connect-dialog";
import { ConnectedRow, type ConnectedDns } from "./connected-row";
import type { DnsTeam } from "./team-access";

export function TeamDnsCard({
  providers,
  teams,
  activeTeamId,
  loading = false,
}: {
  providers: ConnectedDns[];
  teams: DnsTeam[];
  activeTeamId: string;
  loading?: boolean;
}) {
  const [connecting, setConnecting] = React.useState(false);

  return (
    <Card
      // The old /settings/dns address lands here.
      id="automatic-dns"
      className="scroll-mt-20 md:col-span-2 xl:col-span-3"
    >
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Automatic DNS
          <InfoTip
            content="Deplo creates the DNS record when you add a domain under one of these to an app."
            docs="domains.automaticDns"
          />
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => setConnecting(true)}
        >
          <Plus className="size-4" />
          <span className="sm:hidden">Connect</span>
          <span className="max-sm:hidden">Connect a domain</span>
        </Button>
      </CardHeader>
      <CardContent>
        {providers.length === 0 ? (
          <Bone box loading={loading} className="w-full rounded-xl">
            <p className="w-full rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No domains connected yet.
            </p>
          </Bone>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {providers.map((p) => (
              <ConnectedRow key={p.id} provider={p} teams={teams} />
            ))}
          </ul>
        )}
      </CardContent>
      <ConnectDnsDialog
        open={connecting}
        onOpenChange={setConnecting}
        teams={teams}
        activeTeamId={activeTeamId}
      />
    </Card>
  );
}
