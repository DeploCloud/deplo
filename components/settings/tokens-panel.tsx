"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, KeyRound, Trash2, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/shared/copy-button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EmptyState } from "@/components/shared/empty-state";
import { timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { ApiTokenDTO } from "@/lib/data/tokens";

export function TokensPanel({ tokens }: { tokens: ApiTokenDTO[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const [createdToken, setCreatedToken] = React.useState<string | null>(null);
  const [revokeId, setRevokeId] = React.useState<string | null>(null);

  function create() {
    startTransition(async () => {
      const res = await gqlAction<
        { createToken: { raw: string } },
        { raw: string }
      >(
        `mutation($name: String!) { createToken(name: $name) { raw } }`,
        { name },
        (d) => d.createToken,
      );
      if (res.ok && res.data) {
        setCreatedToken(res.data.raw);
        setCreateOpen(false);
        setName("");
        router.refresh();
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">API Tokens</h3>
          <p className="text-sm text-muted-foreground">
            Tokens authenticate the Deplo CLI and API. Treat them like
            passwords.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="size-4" />
              Create Token
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create API token</DialogTitle>
              <DialogDescription>
                Give it a descriptive name so you can revoke it later.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CI deploy token"
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button onClick={create} disabled={pending || !name.trim()}>
                {pending ? "Creating…" : "Create token"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {tokens.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API tokens"
          description="Create a token to use the Deplo CLI and API."
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-muted-foreground">
                      {t.prefix}…
                    </code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.lastUsedAt ? timeAgo(t.lastUsedAt) : "Never"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {timeAgo(t.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setRevokeId(t.id)}
                      aria-label="Revoke token"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Show created token once */}
      <Dialog
        open={createdToken !== null}
        onOpenChange={(v) => !v && setCreatedToken(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="size-5 text-[var(--success)]" />
              Token created
            </DialogTitle>
            <DialogDescription>
              Copy it now for security it won&apos;t be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
              {createdToken}
            </code>
            {createdToken && <CopyButton value={createdToken} />}
          </div>
          <DialogFooter>
            <Button onClick={() => setCreatedToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmAction
        open={revokeId !== null}
        onOpenChange={(v) => !v && setRevokeId(null)}
        title="Revoke token?"
        description="Any client using this token will immediately lose access."
        confirmLabel="Revoke token"
        successMessage="Token revoked"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: String!) { revokeToken(id: $id) }`,
            { id: revokeId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}
