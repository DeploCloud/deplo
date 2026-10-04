"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { StepShell } from "@/components/settings/migrations/step-shell";
import { MovePreview } from "./move-preview";
import type { MoveIn } from "./use-move-in";

export function MoveConnectStep({
  move,
  onBack,
  onConnected,
}: {
  move: MoveIn;
  onBack: () => void;
  onConnected: () => void;
}) {
  return (
    <StepShell
      hero
      title="Connect to your old Deplo"
      lead="Paste the move code it shows. Nothing moves until you start."
      docs="deplo.move"
    >
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await move.connect()) onConnected();
        }}
      >
        <div className="grid gap-2">
          <FieldLabel
            htmlFor="move-url"
            info="Its https address: a move carries every secret, so it never runs over plain http."
          >
            Old Deplo address
          </FieldLabel>
          <Input
            id="move-url"
            value={move.url}
            onChange={(e) => move.setUrl(e.target.value)}
            placeholder="https://deplo.acme.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="grid gap-2">
          <FieldLabel
            htmlFor="move-code"
            info="On the old Deplo: Settings, Migrations, then Move this Deplo to another machine."
          >
            Move code
          </FieldLabel>
          <Input
            id="move-code"
            type="password"
            value={move.code}
            onChange={(e) => move.setCode(e.target.value)}
            placeholder="dmove_…"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="flex justify-between">
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" disabled={move.connecting || !move.filled}>
            {move.connecting && <Loader2 className="size-4 animate-spin" />}
            Connect
          </Button>
        </div>
      </form>
    </StepShell>
  );
}

export function MoveReviewStep({
  move,
  onBack,
}: {
  move: MoveIn;
  onBack: () => void;
}) {
  if (!move.preview) return null;
  return (
    <StepShell
      hero
      title="Review the move"
      lead={
        <>
          <strong>Everything here is replaced</strong> by the old Deplo&rsquo;s
          teams, apps and servers.
        </>
      }
      docs="deplo.move"
    >
      <MovePreview
        preview={move.preview}
        checking={move.connecting}
        onCheckAgain={() => void move.connect()}
        onStart={move.start}
        onBack={onBack}
      />
    </StepShell>
  );
}
