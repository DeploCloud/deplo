"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Cloud, Fingerprint, Plus, Usb } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InfoTip, FieldLabel } from "@/components/ui/info-tip";
import { Label } from "@/components/ui/label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { BetaChip } from "@/components/shared/beta-chip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EmptyState } from "@/components/shared/empty-state";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import { describeUserAgent } from "@/lib/user-agent";
import {
  createPasskeyCredential,
  passkeyError,
  passkeysSupported,
} from "@/lib/passkey-client";
import type { PasskeyDTO, PasskeyKind } from "@/lib/data/passkeys";

const START = /* GraphQL */ `
  mutation StartPasskeyRegistration($password: String!) {
    startPasskeyRegistration(password: $password)
  }
`;

const FINISH = /* GraphQL */ `
  mutation FinishPasskeyRegistration($response: JSON!, $name: String!) {
    finishPasskeyRegistration(response: $response, name: $name) {
      id
    }
  }
`;

/** What each kind of authenticator is, in the words a person would use. */
const KIND: Record<
  PasskeyKind,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  synced: { label: "Synced", icon: Cloud },
  device: { label: "This device", icon: Fingerprint },
  securityKey: { label: "Security key", icon: Usb },
};

/**
 * Why this instance cannot register a passkey, or null when it can. Resolved
 * from props during render - reading `window.location` would disagree with the
 * server's HTML and break hydration.
 */
export function passkeyBlockedReason(
  panelUrl: string | null,
  rpId: string | null,
): string | null {
  if (!panelUrl)
    return "Set this instance's address in Settings -> Deplo before adding a passkey.";
  if (!rpId) return `Passkeys need https. This panel answers on ${panelUrl}.`;
  return null;
}

/**
 * The passkeys on this account: add, rename, remove.
 */
export function PasskeysCard({
  passkeys,
  panelUrl,
  rpId,
  addOpen,
  onAddOpenChange,
}: {
  passkeys: PasskeyDTO[];
  /** This instance's canonical address, or null if the operator never set one. */
  panelUrl: string | null;
  /** The hostname passkeys are bound to, or null when this instance can't have any. */
  rpId: string | null;
  /** Owned by the page, so the Account protection card can open it too. */
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const blocked = passkeyBlockedReason(panelUrl, rpId);

  // `sm`, matching the card-header buttons on this page (the house rule reserves
  // the default height for rows that hold a form control).
  const addButton = (
    <Button size="sm" disabled={blocked !== null}>
      <Plus className="size-4" />
      Add passkey
    </Button>
  );

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Passkeys
          {/**
           * A promise about support, not a warning: the ceremony is covered by tests end to
           * end, but no real fleet has carried it yet, and the rpID is welded to the panel's
           * address in a way operators will meet the first time they move it.
           */}
          <BetaChip />
          <InfoTip
            content="Sign in with your fingerprint, face or device PIN instead of a password, and it counts as your second factor."
            docs="team.passkeys"
          />
        </CardTitle>
        {blocked ? (
          <SimpleTooltip content={blocked}>
            <span>{addButton}</span>
          </SimpleTooltip>
        ) : (
          <AddPasskeyDialog
            trigger={addButton}
            panelUrl={panelUrl}
            rpId={rpId}
            open={addOpen}
            onOpenChange={onAddOpenChange}
          />
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {passkeys.length === 0 ? (
          <EmptyState
            className="flex-1 py-10"
            icon={Fingerprint}
            title="No passkeys yet"
            docs="team.passkeys"
            description="Add one and this device signs you in without a password."
          />
        ) : (
          <ul className="space-y-2">
            {passkeys.map((p) => {
              const kind = KIND[p.kind];
              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border p-3"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
                    <kind.icon className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {p.name}
                      </span>
                      {/* A credential minted for another panel address. */}
                      {!p.usableHere && (
                        <SimpleTooltip content="Registered for a different address of this panel, so this browser will not offer it. Remove it.">
                          <Badge variant="secondary">Not usable here</Badge>
                        </SimpleTooltip>
                      )}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {kind.label}
                      {p.createdAt ? ` · added ${timeAgo(p.createdAt)}` : ""}
                    </p>
                  </div>
                  <span className="ml-auto flex shrink-0 gap-1">
                    <RenamePasskey
                      passkey={p}
                      onDone={() => router.refresh()}
                    />
                    <DeletePasskey
                      passkey={p}
                      onDone={() => router.refresh()}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Add: password, then the ceremony, then the label. The password is taken BEFORE
 * the browser prompt rather than after, so a person who cannot produce it is not
 * asked for their fingerprint first.
 */
function AddPasskeyDialog({
  trigger,
  panelUrl,
  rpId,
  open,
  onOpenChange: setOpen,
}: {
  trigger: React.ReactNode;
  panelUrl: string | null;
  rpId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");

  // Seeded when the dialog opens, in the event handler rather than an effect:
  // `navigator` is a browser-only read, and the default should describe the
  // device sitting in front of the person right now.
  function onOpenChange(next: boolean) {
    if (next) setName(describeUserAgent(navigator.userAgent).label);
    else setPassword("");
    setOpen(next);
  }

  async function add() {
    // The reason the server could not know: the browser is on some other host,
    // so the platform would refuse the ceremony without sending anything. Caught
    // before the password is spent on a round trip that cannot succeed.
    if (rpId && window.location.hostname !== rpId)
      return {
        ok: false as const,
        error: `Passkeys only work on ${panelUrl}. You are on ${window.location.host}.`,
      };
    if (!passkeysSupported())
      return { ok: false as const, error: "This browser can't use passkeys." };
    const options = await gqlAction<
      { startPasskeyRegistration: unknown },
      unknown
    >(START, { password }, (d) => d.startPasskeyRegistration);
    if (!options.ok) return options;
    let response: unknown;
    try {
      response = await createPasskeyCredential(options.data);
    } catch (e) {
      return { ok: false as const, error: passkeyError(e, panelUrl) };
    }
    const saved = await gqlAction(FINISH, { response, name });
    if (!saved.ok) return saved;
    toast.success("Passkey added");
    router.refresh();
    return { ok: true as const };
  }

  return (
    <ConfirmAction
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      title="Add passkey"
      description="Your device will ask for your fingerprint, face or PIN. Nothing leaves it but a public key."
      confirmLabel="Add passkey"
      variant="default"
      confirmDisabled={!password || !name.trim()}
      extra={
        <>
          <div className="space-y-2">
            <Label htmlFor="passkey-password">Current password</Label>
            <Input
              id="passkey-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="passkey-name"
              info="Only you see this. Name it after the device holding it, so you know which one to remove later."
              docs="team.passkeys"
            >
              Name
            </FieldLabel>
            <Input
              id="passkey-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
            />
          </div>
        </>
      }
      onConfirm={add}
    />
  );
}

/** Relabel. No password: a name is not a credential. */
function RenamePasskey({
  passkey,
  onDone,
}: {
  passkey: PasskeyDTO;
  onDone: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(passkey.name);

  return (
    <ConfirmAction
      trigger={
        <Button variant="ghost" size="sm">
          Rename
        </Button>
      }
      open={open}
      onOpenChange={(next) => {
        // Reset on OPEN, not on close: a name half-typed and abandoned must not
        // be what the field shows the next time.
        if (next) setName(passkey.name);
        setOpen(next);
      }}
      title={`Rename ${passkey.name}`}
      description="Only you see this name."
      confirmLabel="Rename"
      variant="default"
      confirmDisabled={!name.trim()}
      successMessage="Passkey renamed"
      extra={
        <div className="space-y-2">
          <Label htmlFor={`passkey-rename-${passkey.id}`}>Name</Label>
          <Input
            id={`passkey-rename-${passkey.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            autoFocus
          />
        </div>
      }
      onConfirm={async () => {
        const res = await gqlAction(
          `mutation ($id: String!, $name: String!) { renamePasskey(id: $id, name: $name) }`,
          { id: passkey.id, name },
        );
        if (res.ok) onDone();
        return res;
      }}
    />
  );
}

/** Remove. Password required - this is taking a sign-in credential away. */
function DeletePasskey({
  passkey,
  onDone,
}: {
  passkey: PasskeyDTO;
  onDone: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");

  return (
    <ConfirmAction
      trigger={
        <Button variant="ghost" size="sm">
          Remove
        </Button>
      }
      open={open}
      onOpenChange={(next) => {
        if (!next) setPassword("");
        setOpen(next);
      }}
      title="Remove passkey?"
      description={`${passkey.name} stops signing you in. The passkey stays on that device until you delete it there too.`}
      confirmLabel="Remove"
      variant="destructive"
      confirmDisabled={!password}
      successMessage="Passkey removed"
      extra={
        <div className="space-y-2">
          <Label htmlFor={`passkey-delete-${passkey.id}`}>
            Current password
          </Label>
          <Input
            id={`passkey-delete-${passkey.id}`}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </div>
      }
      onConfirm={async () => {
        const res = await gqlAction(
          `mutation ($id: String!, $password: String!) { deletePasskey(id: $id, password: $password) }`,
          { id: passkey.id, password },
        );
        if (res.ok) onDone();
        return res;
      }}
    />
  );
}
