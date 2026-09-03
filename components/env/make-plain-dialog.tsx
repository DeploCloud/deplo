"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import { gqlAction } from "@/lib/graphql-client";

const MAKE_PLAIN = /* GraphQL */ `
  mutation MakeEnvPlain($id: String!, $key: String!, $value: String!) {
    makeEnvPlain(id: $id, key: $key, value: $value) {
      id
      type
    }
  }
`;

/**
 * Turn one secret variable back into a plain one. The value has to be typed
 * again: a secret is write-only, so nothing here can read the old one out.
 */
export function MakePlainDialog({
  open,
  onOpenChange,
  id,
  varKey,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  id: string;
  /** The variable's name, and what the reload looks it up by. */
  varKey: string;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState("");
  const [pending, setPending] = React.useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() || pending) return;
    setPending(true);
    void (async () => {
      const res = await gqlAction(MAKE_PLAIN, { id, key: varKey, value });
      setPending(false);
      if (res.ok) {
        onOpenChange(false);
        setValue("");
        toast.success(`${varKey} is a plain variable now`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    })();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setValue("");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make {varKey} plain</DialogTitle>
          <DialogDescription>
            A secret is write-only, so Deplo cannot show you what it holds. Type
            the value it should have as a plain variable.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="make-plain-value">Value</Label>
            <Input
              id="make-plain-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim() || pending}>
              Make it plain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
