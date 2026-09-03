"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { LogOut, MonitorSmartphone } from "lucide-react";

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
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { EmptyState } from "@/components/shared/empty-state";
import { DeviceMark } from "@/components/shared/device-brand";
import { titleClass } from "@/components/shared/page-header";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { UserSessionDTO } from "@/lib/data/sessions";

/**
 * Every device signed in to this account, with a way to end any of them. The one
 * you are holding comes first and on its own: it is the row a person checks the
 * others against.
 */
export function DevicesPanel({ sessions }: { sessions: UserSessionDTO[] }) {
  const router = useRouter();
  // A signed-out device leaves the table on the click. The session row is gone
  // server-side by the time the mutation answers, so leaving it on screen with
  // a live "Sign out" under the cursor only invites a second, doomed click.
  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(sessions, (s) => s.id);
  const current = rows.find((s) => s.current);
  const others = rows.filter((s) => !s.current);

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
    const ids = others.map((s) => s.id);
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
    <div className="space-y-6">
      {current && <ThisDevice session={current} />}

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className={titleClass.section}>
            <span className="inline-flex items-center gap-2">
              Other devices
              <InfoTip
                content="Every other browser or client holding a session for this account. Sign one out and its next request is rejected."
                docs="team.sessions"
              />
            </span>
          </h2>
          <ConfirmAction
            trigger={
              <Button
                variant="outline"
                size="sm"
                disabled={others.length === 0}
              >
                <LogOut className="size-4" />
                Sign out everywhere else
              </Button>
            }
            title="Sign out every other device"
            description={
              <>
                {others.length === 1
                  ? "One other device is signed in. It"
                  : `${others.length} other devices are signed in. They`}{" "}
                will have to sign in again, with a code if you use two-factor
                authentication. This device stays signed in.
              </>
            }
            confirmLabel="Sign them out"
            variant="destructive"
            confirmDisabled={others.length === 0}
            optimistic
            onConfirm={revokeOthers}
          />
        </div>

        {others.length === 0 ? (
          <EmptyState
            icon={MonitorSmartphone}
            title="No other devices"
            docs="team.sessions"
            description="This is the only thing holding a session for your account."
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
                    <InfoTip
                      content="Sessions refresh as they are used, so this is accurate to about fifteen minutes rather than to the second."
                      docs="team.sessions"
                    />
                  </span>
                </TableHead>
                <TableHead>Signed in</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {others.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <span className="flex items-center gap-3">
                      <DeviceMark os={s.os} browser={s.browser} />
                      <span className="font-medium">{s.label}</span>
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
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          Sign out
                        </Button>
                      }
                      title="Sign out device?"
                      description={`${s.label} will have to sign in again. If you do not recognise it, change your password too.`}
                      confirmLabel="Sign it out"
                      variant="destructive"
                      optimistic
                      onConfirm={() => revoke(s.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

/**
 * The session making this request. It carries no Sign out: ending it is what the
 * account menu's Sign out does.
 */
function ThisDevice({ session }: { session: UserSessionDTO }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center">
      <DeviceMark os={session.os} browser={session.browser} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{session.label}</span>
          <Badge variant="secondary">This device</Badge>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {session.ipAddress ? `${session.ipAddress} · ` : ""}
          signed in {timeAgo(session.createdAt)}
        </p>
      </div>
    </div>
  );
}
