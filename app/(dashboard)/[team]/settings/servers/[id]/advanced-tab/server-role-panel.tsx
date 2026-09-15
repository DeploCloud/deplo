"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Hammer } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import {
  ServerRoleOptions,
  type ServerRole,
} from "@/components/servers/server-role-options";
import { BetaChip } from "@/components/shared/beta-chip";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";

export function ServerRolePanel({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [role, setRole] = React.useState(server.role);

  const stuckOnStorage = server.role === "storage" && !server.dockerVersion;

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction<{ setServerRole: { id: string } }>(
        `mutation SetServerRole($id: String!, $role: String!) {
          setServerRole(id: $id, role: $role) { id }
        }`,
        { id: server.id, role },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        role === "build"
          ? `${server.name} now only builds`
          : role === "storage"
            ? `${server.name} now only holds backups`
            : `${server.name} runs apps again`,
      );
      router.refresh();
    });
  }

  const needsEmptying = role !== "everything" && server.role === "everything";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hammer className="size-4" />
          What this server is for
          <BetaChip />
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          A build server compiles images for apps that run on your other
          servers, so those can stay small.
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save}>
          <ServerRoleOptions
            value={role}
            onChange={setRole}
            disabled={(r: ServerRole) =>
              r === "storage" ? pending : pending || stuckOnStorage
            }
          />
          {stuckOnStorage && (
            <Badge variant="warning">
              This server was installed without Docker, so it can only hold
              backups. Re-run the install command on the host to change that.
            </Badge>
          )}
          {needsEmptying && (
            <Badge variant="warning">
              Apps and databases have to be moved off this server first.
            </Badge>
          )}
          {role === "everything" && server.role === "build" && (
            <Badge variant="warning">
              This server has no proxy installed, so apps deployed here will run
              but stay unreachable on their domains. Re-run the install command
              on the host to add one.
            </Badge>
          )}
          <div>
            <Button type="submit" disabled={pending || role === server.role}>
              {pending ? "Saving" : "Save"}
            </Button>
          </div>
        </form>
        {server.role !== "storage" && <BuildFallbackRow server={server} />}
      </CardContent>
    </Card>
  );
}

function BuildFallbackRow({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [on, setOn] = React.useState(server.buildFallback);

  function toggle(next: boolean) {
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation SetServerBuildFallback($id: String!, $buildFallback: Boolean) {
          setServerBuildFallback(id: $id, buildFallback: $buildFallback) { id }
        }`,
        { id: server.id, buildFallback: next },
      );
      if (!res.ok) {
        setOn(server.buildFallback);
        toast.error(res.error);
        return;
      }
      toast.success(
        next
          ? `${server.name} will build as a fallback`
          : `${server.name} will not build as a fallback`,
      );
      router.refresh();
    });
  }

  return (
    <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          Build as a fallback
          <InfoTip
            content={
              <>
                When an app&apos;s build server cannot be reached, this host
                compiles for it instead. Only apps whose own server has the same
                CPU architecture.
              </>
            }
            docs="build.serversHowItWorks"
          />
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {on
            ? "Compiles for apps whose own build server is down."
            : "Never asked to build for another server's apps."}
        </p>
      </div>
      <Switch
        checked={on}
        onCheckedChange={toggle}
        disabled={pending}
        aria-label="Build as a fallback"
      />
    </div>
  );
}
