"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { ShieldAlert, Trash2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CommandLine } from "@/components/shared/code-block";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";
import { DocsLink } from "@/components/ui/docs-link";
import { ConsequenceNote } from "@/components/shared/confirm-action";
import { ChangeAddress } from "./change-address";

export function DangerZone({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirm, setConfirm] = React.useState(false);
  const [uninstall, setUninstall] = React.useState<string | null>(null);

  function remove() {
    startTransition(async () => {
      const res = await gqlAction<{
        removeServer: { uninstallCommand: string; warning: string | null };
      }>(
        `mutation RemoveServer($id: String!) {
          removeServer(id: $id) { uninstallCommand warning }
        }`,
        { id: server.id },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      setConfirm(false);
      toast.success(`${server.name} removed - now clean up the host`);
      if (res.data.removeServer.warning)
        toast.warning(res.data.removeServer.warning);
      setUninstall(res.data.removeServer.uninstallCommand);
    });
  }

  return (
    <>
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="size-4 text-destructive" />
            Danger zone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ChangeAddress server={server} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">Remove this server</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {server.isDeploHost
                  ? "This server runs Deplo itself, so it cannot be removed - doing so would cut this dashboard off from its own server."
                  : "Deplo stops trusting this server and forgets it. Nothing on the host is uninstalled; you get the command for that."}
              </p>
            </div>
            <SimpleTooltip
              content={
                server.isDeploHost
                  ? "The host running Deplo cannot be removed"
                  : "Revoke this agent's trust and forget the server"
              }
              side="left"
            >
              <span>
                <Button
                  variant="destructive"
                  onClick={() => setConfirm(true)}
                  disabled={pending || server.isDeploHost}
                >
                  <Trash2 className="size-4" />
                  Remove server
                </Button>
              </span>
            </SimpleTooltip>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {server.name}?</DialogTitle>
            <DialogDescription>
              This revokes the agent&rsquo;s trust and{" "}
              <strong>forgets the server</strong>. Move or delete its apps and
              databases first. <DocsLink topic="servers.remove" />
            </DialogDescription>
          </DialogHeader>
          <ConsequenceNote>
            Nothing on the host is uninstalled: the agent, Traefik and the Deplo
            network keep running. The command to remove them comes next.
          </ConsequenceNote>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove()}
              disabled={pending}
            >
              {pending ? "Removing" : "Remove server"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={uninstall !== null}
        onOpenChange={(open) => {
          if (!open) {
            setUninstall(null);
            router.push("/settings/servers");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finish the cleanup on {server.name}</DialogTitle>
            <DialogDescription>
              Deplo no longer trusts this server, but{" "}
              <strong>its agent is still running there</strong>. Run this on the
              host, as root.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Uninstall command</Label>
            {uninstall ? <CommandLine command={uninstall} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Removes the agent, its certificates, the{" "}
              <code>deplo-traefik</code> container and the Deplo network.{" "}
              <strong className="text-foreground">Your data survives</strong> -
              add <code>--purge-data</code> to delete it too, irreversibly.{" "}
              <DocsLink topic="servers.remove" />
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setUninstall(null);
                router.push("/settings/servers");
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
