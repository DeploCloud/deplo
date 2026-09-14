"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";

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
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";

// InstallCommand mints a fresh one-time bootstrap command for this host.
export function InstallCommand({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [command, setCommand] = React.useState<string | null>(null);

  function reissue() {
    startTransition(async () => {
      const res = await gqlAction<{
        reissueServerBootstrap: { installCommand: string };
      }>(
        `mutation ReissueServerBootstrap($id: String!) {
          reissueServerBootstrap(id: $id) { installCommand }
        }`,
        { id: server.id },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.data) setCommand(res.data.reissueServerBootstrap.installCommand);
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" />
            Install command
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {server.provisioning
              ? "This server is still waiting for its agent. Run the command on the box to finish setting it up."
              : "Mint a fresh one-time setup command, for reinstalling the agent on this box."}
          </p>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => reissue()}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {server.provisioning
              ? "Show install command"
              : "Reissue install command"}
          </Button>
        </CardContent>
      </Card>

      <Dialog
        open={command !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCommand(null);
            router.refresh();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install command for {server.name}</DialogTitle>
            <DialogDescription>
              Run this once on the server. It installs Docker and the Deplo
              agent, which <strong>calls home to finish provisioning</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Install command (shown once)</Label>
            {command ? <CommandLine command={command} /> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              The command embeds a single-use token that expires in about an
              hour. If you lose it, reissue another from here.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setCommand(null);
                router.refresh();
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
