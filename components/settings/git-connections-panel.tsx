"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { GitConnectionDTO } from "@/lib/data/git-connections";

export interface GitProviderChoice {
  id: string;
  label: string;
  defaultBaseUrl: string | null;
  defaultUsername: string;
  tokenScopes: string;
  hasApi: boolean;
  tokenHelpUrl: string;
}

/**
 * Git hosts other than GitHub. Sits BELOW the GitHub card on purpose: GitHub is
 * the recommended path and these are beta, so the page reads in that order
 * rather than presenting five equal choices.
 */
export function GitConnectionsPanel({
  connections,
  providers,
}: {
  connections: GitConnectionDTO[];
  providers: GitProviderChoice[];
}) {
  const router = useRouter();
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<GitConnectionDTO | null>(null);
  const [deleting, setDeleting] = React.useState<GitConnectionDTO | null>(null);
  const [testingId, setTestingId] = React.useState<string | null>(null);

  async function test(conn: GitConnectionDTO) {
    setTestingId(conn.id);
    const res = await gqlAction(
      `mutation ($id: String!) { testGitConnection(id: $id) { id health } }`,
      { id: conn.id },
    );
    setTestingId(null);
    if (res.ok) toast.success(`${conn.label} is working`);
    else toast.error(res.error);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <GitBranch className="size-4" />
            Other git providers
            <Badge variant="info" className="text-[10px] font-normal">
              Beta
            </Badge>
            <InfoTip content="Deploy from GitLab, Bitbucket, Gitea or any git server. Paste an access token once and reuse it across apps. Still new - expect the odd rough edge, and tell us about it." />
          </CardTitle>
        </div>
        <Button size="sm" onClick={() => setConnectOpen(true)}>
          {connections.length ? "Connect another" : "Connect a provider"}
        </Button>
      </CardHeader>
      <CardContent>
        {connections.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="No other provider connected"
            description="GitHub is the recommended way to deploy. Connect another host if your code lives there."
          />
        ) : (
          <div className="space-y-3">
            {connections.map((conn) => (
              <div key={conn.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {conn.label}
                      <a
                        href={conn.baseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Open ${conn.label}`}
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {conn.baseUrl.replace(/^https?:\/\//, "")}
                      {conn.accountLogin ? ` · ${conn.accountLogin}` : ""}
                      {conn.appCount > 0
                        ? ` · ${conn.appCount} app${conn.appCount === 1 ? "" : "s"}`
                        : ""}
                    </p>
                  </div>
                  {conn.hasApi && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => test(conn)}
                      disabled={testingId === conn.id}
                    >
                      {testingId === conn.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      Test connection
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setEditing(conn)}
                    aria-label="Edit connection"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleting(conn)}
                    aria-label="Remove connection"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                {conn.health === "failing" ? (
                  <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <AlertTriangle className="size-3.5 text-destructive" />
                      This connection stopped working
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {conn.healthError ||
                        "The provider rejected the stored token."}
                    </p>
                    <Button
                      size="sm"
                      className="mt-2"
                      onClick={() => setEditing(conn)}
                    >
                      Replace the token
                    </Button>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="gap-1.5">
                      <CheckCircle2 className="size-3 text-[var(--success)]" />
                      {conn.lastCheckedAt
                        ? `Checked ${timeAgo(conn.lastCheckedAt)}`
                        : "Connected"}
                    </Badge>
                    {conn.tokenExpiresAt && (
                      <Badge variant="muted">
                        Token expires {conn.tokenExpiresAt.slice(0, 10)}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Both dialogs are mounted only while open, so their fields seed from
          their initial state instead of an effect that resets them. */}
      {connectOpen && (
        <ConnectDialog
          onClose={() => setConnectOpen(false)}
          providers={providers}
        />
      )}
      {editing && (
        <EditDialog connection={editing} onClose={() => setEditing(null)} />
      )}
      <ConfirmAction
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Remove this connection?"
        description={
          deleting && deleting.appCount > 0
            ? `${deleting.appCount} app${deleting.appCount === 1 ? "" : "s"} deploy through it. They stop auto-deploying and private clones fail until you reconnect.`
            : "Private clones through it will fail until you reconnect."
        }
        confirmLabel="Remove"
        successMessage="Connection removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation ($id: String!) { removeGitConnection(id: $id) }`,
            { id: deleting!.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Connect                                                             */
/* ------------------------------------------------------------------ */

function ConnectDialog({
  onClose,
  providers,
}: {
  onClose: () => void;
  providers: GitProviderChoice[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [providerId, setProviderId] = React.useState(
    providers[0]?.id ?? "gitlab",
  );
  const provider =
    providers.find((p) => p.id === providerId) ?? providers[0] ?? null;
  const [label, setLabel] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState(
    providers[0]?.defaultBaseUrl ?? "",
  );
  const [username, setUsername] = React.useState(
    providers[0]?.defaultUsername ?? "",
  );
  const [token, setToken] = React.useState("");

  // Switching provider re-seeds the prefilled fields: a gitlab.com address and
  // an "oauth2" username mean nothing once the choice is Gitea.
  function pickProvider(id: string) {
    const next = providers.find((p) => p.id === id);
    setProviderId(id);
    setBaseUrl(next?.defaultBaseUrl ?? "");
    setUsername(next?.defaultUsername ?? "");
  }

  const helpUrl = provider?.tokenHelpUrl ?? "";
  const canSubmit = Boolean(baseUrl.trim() && token.trim() && !pending);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($input: ConnectGitProviderInput!) {
          connectGitProvider(input: $input) { id label }
        }`,
        {
          input: {
            provider: providerId,
            label: label.trim() || provider?.label || providerId,
            baseUrl: baseUrl.trim(),
            username: username.trim(),
            token: token.trim(),
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Provider connected");
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a git provider</DialogTitle>
          <DialogDescription>
            Paste an access token once. Every app in this team can then deploy
            from that host.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div className="space-y-2">
              <FieldLabel htmlFor="git-provider">Provider</FieldLabel>
              <Select value={providerId} onValueChange={pickProvider}>
                <SelectTrigger id="git-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.id === "git" ? "Any other git server" : p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <FieldLabel
                htmlFor="git-base-url"
                info="The address you open in a browser, not the API address. A bare domain becomes https://."
              >
                Address
              </FieldLabel>
              <Input
                id="git-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://git.example.com"
                autoFocus
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="git-username"
                  info="The account the token belongs to. Leave the suggested value unless your provider says otherwise."
                >
                  Username
                </FieldLabel>
                <Input
                  id="git-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={provider?.defaultUsername || "your-username"}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="git-label">Name</FieldLabel>
                <Input
                  id="git-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={provider?.label ?? "My git server"}
                />
              </div>
            </div>

            <div className="space-y-2">
              <FieldLabel htmlFor="git-token">Access token</FieldLabel>
              <Input
                id="git-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="glpat-…"
                autoComplete="off"
              />
              {provider?.tokenScopes && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Needs {provider.tokenScopes}.{" "}
                  {helpUrl && (
                    <a
                      href={helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Create one
                    </a>
                  )}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Edit / rotate                                                       */
/* ------------------------------------------------------------------ */

function EditDialog({
  connection,
  onClose,
}: {
  connection: GitConnectionDTO;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [label, setLabel] = React.useState(connection.label);
  const [username, setUsername] = React.useState(connection.username);
  const [token, setToken] = React.useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($id: String!, $input: UpdateGitConnectionInput!) {
          updateGitConnection(id: $id, input: $input) { id }
        }`,
        {
          id: connection.id,
          input: {
            label: label.trim() || null,
            username: username.trim() || null,
            token: token.trim() || null,
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Connection saved");
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit connection</DialogTitle>
          <DialogDescription>
            Rename it, or paste a new token to replace the stored one. Leaving
            the token empty keeps the current one.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <FieldLabel htmlFor="edit-git-label">Name</FieldLabel>
                <Input
                  id="edit-git-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="edit-git-username">Username</FieldLabel>
                <Input
                  id="edit-git-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="edit-git-token">New access token</FieldLabel>
              <Input
                id="edit-git-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Leave empty to keep the current token"
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
