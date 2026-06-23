"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy } from "lucide-react";
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
import { gqlAction } from "@/lib/graphql-client";

/**
 * Register a new instance user by minting a single-use registration link
 * (instance-admin only). Whoever opens the link creates their own account and
 * team — like the first-run setup. Controlled (no trigger of its own) so it can
 * be opened from the Users settings header or the overview "Add new" menu.
 */
export function RegisterUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [link, setLink] = React.useState<string | null>(null);

  function mint() {
    startTransition(async () => {
      const res = await gqlAction<
        { mintRegistrationLink: string },
        { link: string }
      >(`mutation { mintRegistrationLink }`, {}, (d) => ({
        link: d.mintRegistrationLink,
      }));
      if (res.ok && res.data) {
        setLink(res.data.link);
        router.refresh();
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  function copy() {
    if (link) {
      navigator.clipboard.writeText(link);
      toast.success("Registration link copied");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setLink(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a new user</DialogTitle>
          <DialogDescription>
            Generate a single-use link. Whoever opens it creates their own
            account and team — like the first-run setup.
          </DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Share this link. It works once and expires in 14 days.
            </p>
            <div className="flex gap-2">
              <Input readOnly value={link} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                onClick={copy}
                aria-label="Copy link"
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            A fresh link is generated each time and can only be used once.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {link ? "Done" : "Cancel"}
          </Button>
          {!link && (
            <Button onClick={mint} disabled={pending}>
              {pending ? "Generating…" : "Generate link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
