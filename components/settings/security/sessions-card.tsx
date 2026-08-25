"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Laptop, LogOut, Monitor, Smartphone, Tablet } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { EmptyState } from "@/components/shared/empty-state";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { UserSessionDTO } from "@/lib/data/sessions";
import type { DeviceKind } from "@/lib/user-agent";

const DEVICE_ICON: Record<
  DeviceKind,
  React.ComponentType<{ className?: string }>
> = {
  desktop: Monitor,
  mobile: Smartphone,
  tablet: Tablet,
  unknown: Laptop,
};

/**
 * Every device signed in to this account, with a way to end any of them.
 */
export function SessionsCard({ sessions }: { sessions: UserSessionDTO[] }) {
  const router = useRouter();
  // A signed-out device leaves the table on the click. The session row is gone
  // server-side by the time the mutation answers, so leaving it on screen with
  // a live "Sign out" under the cursor only invites a second, doomed click.
  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(sessions, (s) => s.id);
  const others = rows.filter((s) => !s.current).length;

  async function revoke(
    id: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    remove(id);
    const res = await gqlAction(
      `mutation ($id: String!) { revokeSession(id: $id) }`,
      {
        id,
      },
    );
    if (!res.ok) {
      restore(id);
      return res;
    }
    toast.success("Device signed out");
    router.refresh();
    return { ok: true };
  }

  async function revokeOthers(): Promise<
    { ok: true } | { ok: false; error: string }
  > {
    // Every other device goes at once; a refusal puts all of them back, and the
    // refresh below is what settles which ones actually ended.
    const ids = rows.filter((s) => !s.current).map((s) => s.id);
    ids.forEach(remove);
    const res = await gqlAction<{ revokeOtherSessions: number }, number>(
      `mutation { revokeOtherSessions }`,
      {},
      (d) => d.revokeOtherSessions,
    );
    if (!res.ok) {
      ids.forEach(restore);
      return res;
    }
    const n = res.data ?? 0;
    toast.success(
      n === 0
        ? "No other devices were signed in"
        : `Signed out ${n} other device${n === 1 ? "" : "s"}`,
    );
    router.refresh();
    return { ok: true };
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Signed-in devices
          <InfoTip content="Every browser or client currently holding a session for this account. Sign one out and its next request is rejected." />
        </CardTitle>
        <ConfirmAction
          trigger={
            <Button variant="outline" size="sm" disabled={others === 0}>
              <LogOut className="size-4" />
              Sign out everywhere else
            </Button>
          }
          title="Sign out every other device"
          description={
            <>
              {others === 1
                ? "One other device is signed in. It"
                : `${others} other devices are signed in. They`}{" "}
              will have to sign in again, with a code if you use two-factor
              authentication. This device stays signed in.
            </>
          }
          confirmLabel="Sign them out"
          variant="destructive"
          confirmDisabled={others === 0}
          optimistic
          onConfirm={revokeOthers}
        />
      </CardHeader>
      <CardContent>
        {/**
         * Defensive rather than expected: a cookie-authenticated page always has at least
         * its own session, so an empty list means the row was swept between the read and
         * the render.
         */}
        {rows.length === 0 ? (
          <EmptyState
            icon={Monitor}
            title="No signed-in devices"
            description="Nothing currently holds a session for this account."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>IP address</TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    Last seen
                    <InfoTip content="Sessions refresh as they are used, so this is accurate to about fifteen minutes rather than to the second." />
                  </span>
                </TableHead>
                <TableHead>Signed in</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const Icon = DEVICE_ICON[s.device];
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{s.label}</span>
                        {s.current && (
                          <Badge variant="secondary">This device</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {s.ipAddress ?? "Unknown"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {timeAgo(s.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {timeAgo(s.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {s.current ? (
                        <SimpleTooltip content="This is the device you are using. Use Sign out in the account menu to end it.">
                          <span>
                            <Button variant="ghost" size="sm" disabled>
                              Sign out
                            </Button>
                          </span>
                        </SimpleTooltip>
                      ) : (
                        <ConfirmAction
                          trigger={
                            <Button variant="ghost" size="sm">
                              Sign out
                            </Button>
                          }
                          title={`Sign out ${s.label}`}
                          description="That device will have to sign in again. If you do not recognise it, change your password too."
                          confirmLabel="Sign it out"
                          variant="destructive"
                          optimistic
                          onConfirm={() => revoke(s.id)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
