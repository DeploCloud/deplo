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

export function ChangeAddress({ server }: { server: ServerSummary }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [address, setAddress] = React.useState(server.host);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  function openDialog() {
    setAddress(server.host);
    setRefusal(null);
    setOpen(true);
  }

  function save() {
    startTransition(async () => {
      const res = await gqlAction<{ updateServerAddress: string | null }>(
        `mutation ChangeServerAddress($id: String!, $address: String!) {
          updateServerAddress(id: $id, address: $address)
        }`,
        { id: server.id, address: address.trim() },
      );
      if (!res.ok) {
        setRefusal(res.error);
        return;
      }
      setOpen(false);
      toast.success("Server address updated");
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
            Where this server’s apps are reached. Change it when the machine got
            a new IP or you moved it.
          </p>
        </div>
        <Button variant="outline" onClick={openDialog} disabled={pending}>
          <Globe className="size-4" />
          Change address
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <ChangeAddressForm
            server={server}
            address={address}
            onAddressChange={setAddress}
            refusal={refusal}
            pending={pending}
            onSave={save}
            onCancel={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface ChangeAddressFormProps {
  server: Pick<ServerSummary, "name" | "isDeploHost">;
  address: string;
  onAddressChange: (value: string) => void;
  refusal: string | null;
  pending: boolean;
  onSave: () => void;
  onCancel: () => void;
}

// Every server links in (ADR-0040): no check, nothing to force.
export function ChangeAddressForm({
  server,
  address,
  onAddressChange,
  refusal,
  pending,
  onSave,
  onCancel,
}: ChangeAddressFormProps) {
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <DialogHeader>
        <DialogTitle>Change address for {server.name}?</DialogTitle>
        <DialogDescription>
          Apps and databases on the server are not touched.
        </DialogDescription>
      </DialogHeader>
      {server.isDeploHost && (
        <p className="text-sm text-destructive">
          This server runs Deplo itself - a wrong address here breaks the
          addresses of its apps.
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
          onChange={(e) => onAddressChange(e.target.value)}
          placeholder="203.0.113.7 or server.example.com"
          autoFocus
        />
      </div>
      {refusal && (
        <div className="rounded-md border border-destructive/40 bg-destructive-wash-strong p-3 text-sm">
          <p>{refusal}</p>
        </div>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !address.trim()}>
          {pending ? "Saving" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
