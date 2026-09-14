"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Globe } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { BetaChip } from "@/components/shared/beta-chip";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";

// ChangeAddress is the migration verb: the host got a new IP, or the instance moved.
export function ChangeAddress({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [address, setAddress] = React.useState(server.host);
  const [port, setPort] = React.useState(
    server.agentPort ? String(server.agentPort) : "",
  );
  const [refusal, setRefusal] = React.useState<string | null>(null);

  function openDialog() {
    setAddress(server.host);
    setPort(server.agentPort ? String(server.agentPort) : "");
    setRefusal(null);
    setOpen(true);
  }

  function save(force: boolean) {
    startTransition(async () => {
      const res = await gqlAction<{ updateServerAddress: string | null }>(
        `mutation ChangeServerAddress($id: String!, $address: String!, $agentPort: Int, $force: Boolean) {
          updateServerAddress(id: $id, address: $address, agentPort: $agentPort, force: $force)
        }`,
        {
          id: server.id,
          address: address.trim(),
          agentPort: port.trim() ? Number(port.trim()) : null,
          force,
        },
      );
      if (!res.ok) {
        // Shown inline (verbatim) where the "Save anyway" escape sits next to it.
        setRefusal(res.error);
        return;
      }
      setOpen(false);
      toast.success("Server address updated");
      if (res.data?.updateServerAddress)
        toast.warning(res.data.updateServerAddress);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            Change address
            <BetaChip />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Where Deplo reaches this server&rsquo;s agent. Change it when the
            host got a new IP or you moved it.
          </p>
        </div>
        <Button variant="outline" onClick={openDialog} disabled={pending}>
          <Globe className="size-4" />
          Change address
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Change address for {server.name}?</DialogTitle>
              <DialogDescription>
                Deplo checks that the agent answers at the new address before
                saving. Apps and databases on the server are not touched.
              </DialogDescription>
            </DialogHeader>
            {server.isDeploHost && (
              <p className="text-sm text-destructive">
                This server runs Deplo itself - a wrong address here cuts this
                dashboard off from its own host.
              </p>
            )}
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="server-address"
                info="IP or DNS name. App URLs follow it immediately; custom domains keep pointing at the old address until you update their DNS records."
                docs="servers.address"
              >
                Address
              </FieldLabel>
              <Input
                id="server-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="203.0.113.7 or server.example.com"
                autoFocus
              />
            </div>
            {server.agentPort !== null && (
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="server-agent-port"
                  info="The port the Deplo agent listens on (default 9443). Change it only if you moved the agent."
                  docs="servers.address"
                >
                  Agent port
                </FieldLabel>
                <Input
                  id="server-agent-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>
            )}
            {refusal && (
              <div className="rounded-md border border-destructive/40 bg-destructive-wash-strong p-3 text-sm">
                <p>{refusal}</p>
                <p className="mt-1 text-muted-foreground">
                  Save anyway if the host is not up at the new address yet -
                  Deplo keeps checking its health there.
                </p>
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              {refusal && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => save(true)}
                  disabled={pending || !address.trim()}
                >
                  {pending ? "Saving" : "Save anyway"}
                </Button>
              )}
              <Button type="submit" disabled={pending || !address.trim()}>
                {pending ? "Saving" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
