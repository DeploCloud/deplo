"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "@/lib/nav";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/result";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  noun: "app" | "database";
  name: string;
  rename: (next: string) => Promise<ActionResult<unknown>>;
};

export function RenameDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {props.noun}</DialogTitle>
        </DialogHeader>
        <RenameForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

// Mounted only while the dialog is open, so every open starts from the current name.
function RenameForm({ onOpenChange, noun, name, rename }: Props) {
  const router = useRouter();
  const id = React.useId();
  const [draft, setDraft] = React.useState(name);
  const [pending, startTransition] = React.useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = draft.trim();
    if (!next || next === name) return onOpenChange(false);
    startTransition(async () => {
      const res = await rename(next);
      if (!res.ok) return void toast.error(res.error);
      toast.success(noun === "app" ? "App renamed" : "Database renamed");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <form className="grid gap-4" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Label htmlFor={id}>Name</Label>
        <Input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !draft.trim()}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
