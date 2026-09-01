"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plug,
  Trash2,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/info-tip";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { GitProviderMark } from "@/components/shared/brand-icons";
import { useGithubOwnerConnect } from "@/components/apps/github-connect-button";
import { GitGraphic } from "@/components/settings/git-graphic";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { GitConnectionDTO } from "@/lib/data/git-connections";
import type { GithubAppDTO } from "@/lib/data/github";

export interface GitProviderChoice {
  id: string;
  label: string;
  defaultBaseUrl: string | null;
  defaultUsername: string;
  tokenScopes: string;
  hasApi: boolean;
  tokenHelpUrl: string;
}

/** Whether an App can drive pull request previews, and where to fix it. */
type PreviewReadiness = Record<string, { ready: boolean; settingsUrl: string }>;

/**
 * The whole Git settings page: one header, one grid of connected hosts, one empty
 * state.
 */
export function GitPanel({
  githubApps,
  connections,
  providers,
  previewReadiness,
  next,
  isInstanceAdmin,
}: {
  githubApps: GithubAppDTO[];
  connections: GitConnectionDTO[];
  /** The provider catalogue, passed down rather than fetched: it is static. */
  providers: GitProviderChoice[];
  previewReadiness?: PreviewReadiness;
  /**
   * Where to send the browser once a provider is connected: the page that linked
   * here (`?next=`), already validated server-side.
   */
  next?: string | null;
  /** Gates the one advanced option: pointing a connection inside the network. */
  isInstanceAdmin: boolean;
}) {
  const router = useRouter();
  const [connectProviderId, setConnectProviderId] = React.useState<
    string | null
  >(null);
  const [editing, setEditing] = React.useState<GitConnectionDTO | null>(null);
  const [deleting, setDeleting] = React.useState<GitConnectionDTO | null>(null);
  const [deletingApp, setDeletingApp] = React.useState<GithubAppDTO | null>(
    null,
  );
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

  // Both kinds of card leave the page on the click and come back only if the
  // server refuses.
  const {
    visible: apps,
    remove: hideApp,
    restore: restoreApp,
  } = useOptimisticRemove(githubApps, (a) => a.id);
  const {
    visible: conns,
    remove: hideConn,
    restore: restoreConn,
  } = useOptimisticRemove(connections, (c) => c.id);

  const empty = apps.length === 0 && conns.length === 0;
  const connectProvider =
    providers.find((p) => p.id === connectProviderId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        docs="git.providers"
        title="Git"
        description="Connect the hosts your code lives on, for imports and auto-deploys."
        actions={
          <ConnectMenu
            providers={providers}
            onPick={(id) => setConnectProviderId(id)}
          />
        }
      />

      {empty ? (
        <EmptyState
          graphic={<GitGraphic />}
          title="No git host connected"
          docs="git.providers"
          description="Connect a host and its repositories are yours to import and deploy on every push."
        />
      ) : (
        // `items-start` because a card carrying a failure block is genuinely
        // taller than one that is fine, and the grid's default stretch would
        // pad the healthy card with an empty void to match it.
        <div className="grid items-start gap-4 sm:grid-cols-2 3xl:grid-cols-3">
          {apps.map((app) => (
            <GithubAppCard
              key={app.id}
              app={app}
              readiness={previewReadiness?.[app.id]}
              onRemove={() => setDeletingApp(app)}
            />
          ))}
          {conns.map((conn) => (
            <ConnectionCard
              key={conn.id}
              conn={conn}
              testing={testingId === conn.id}
              onTest={() => test(conn)}
              onEdit={() => setEditing(conn)}
              onRemove={() => setDeleting(conn)}
            />
          ))}
        </div>
      )}

      {/* The dialogs are mounted only while open, so their fields seed from
          their initial state instead of an effect that resets them. */}
      {connectProvider && (
        <ConnectDialog
          provider={connectProvider}
          isInstanceAdmin={isInstanceAdmin}
          next={next}
          onClose={() => setConnectProviderId(null)}
        />
      )}
      {editing && (
        <EditDialog connection={editing} onClose={() => setEditing(null)} />
      )}

      <ConfirmAction
        open={deletingApp !== null}
        onOpenChange={(v) => !v && setDeletingApp(null)}
        title="Remove GitHub App?"
        description="Apps importing from this App will stop auto-deploying and private clones will fail until you reconnect."
        confirmLabel="Remove"
        successMessage="GitHub App removed"
        optimistic
        onConfirm={async () => {
          const id = deletingApp!.id;
          hideApp(id);
          const res = await gqlAction(
            `mutation ($id: String!) { removeGithubApp(id: $id) }`,
            { id },
          );
          if (!res.ok) restoreApp(id);
          router.refresh();
          return res;
        }}
      />
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
        optimistic
        onConfirm={async () => {
          const id = deleting!.id;
          hideConn(id);
          const res = await gqlAction(
            `mutation ($id: String!) { removeGitConnection(id: $id) }`,
            { id },
          );
          if (!res.ok) restoreConn(id);
          router.refresh();
          return res;
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connect menu                                                        */
/* ------------------------------------------------------------------ */

/**
 * The page's one add button.
 */
function ConnectMenu({
  providers,
  onPick,
}: {
  providers: GitProviderChoice[];
  onPick: (id: string) => void;
}) {
  const { items, dialog, pending } = useGithubOwnerConnect();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plug className="size-4" />
            )}
            Connect
            <ChevronDown className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {/* Every host in the menu wears the same coloured mark it wears on its
              card below, so picking one is recognising a logo rather than reading
              a list. */}
          {/* GitHub creates the App under whoever owns it, and the two owners
              live at different addresses on github.com - so the owner is picked
              here, before the browser leaves. */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <GitProviderMark provider="github" className="size-5" />
              GitHub
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {items}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {providers.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => onPick(p.id)}>
              <GitProviderMark provider={p.id} className="size-5" />
              {p.label}
              <Badge
                variant="info"
                className="ml-auto text-[10px] font-normal uppercase"
              >
                Beta
              </Badge>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

/**
 * The shell both kinds of card share: mark, title block, kebab. One component so
 * a GitHub App and a token connection can never drift into two different card
 * shapes sitting side by side in the same grid.
 */
function HostCard({
  provider,
  title,
  href,
  subtitle,
  menu,
  children,
}: {
  provider: string;
  title: string;
  /** The host's own page. Reached from the menu, as "Manage". */
  href: string;
  subtitle: string;
  menu: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <GitProviderMark provider={provider} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {subtitle}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-1 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Actions for ${title}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {/**
             * Rendered HERE rather than by each card, so no host can end up without a way back
             * to its own settings page - which is where repository access, tokens and
             * everything else Deplo does not own is actually changed.
             */}
            <DropdownMenuItem asChild>
              <a href={href} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
                Manage
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {menu}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {children}
    </Card>
  );
}

function GithubAppCard({
  app,
  readiness,
  onRemove,
}: {
  app: GithubAppDTO;
  readiness?: { ready: boolean; settingsUrl: string };
  onRemove: () => void;
}) {
  return (
    <HostCard
      provider="github"
      title={app.name}
      href={app.htmlUrl}
      subtitle={`${app.installations.length} installation${app.installations.length === 1 ? "" : "s"}`}
      menu={
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 className="size-4" />
          Remove
        </DropdownMenuItem>
      }
    >
      {/* A missing readiness entry means GitHub could not be asked - no badge,
          no accusation. */}
      {readiness && !readiness.ready && (
        <div className="mt-3 rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
          <p className="text-xs font-medium">
            This App cannot see pull requests yet
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Pull request previews need the pull request event and permission to
            comment. GitHub only lets you change that on its own settings page.
          </p>
          <Button asChild size="sm" className="mt-2">
            <a
              href={readiness.settingsUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Update on GitHub
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        </div>
      )}

      {app.installations.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {app.installations.map((inst) => (
            <Badge key={inst.id} variant="secondary" className="gap-1.5">
              <CheckCircle2 className="size-3 text-[var(--success)]" />
              {inst.accountLogin}
            </Badge>
          ))}
        </div>
      )}
    </HostCard>
  );
}

function ConnectionCard({
  conn,
  testing,
  onTest,
  onEdit,
  onRemove,
}: {
  conn: GitConnectionDTO;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <HostCard
      provider={conn.provider}
      title={conn.label}
      href={conn.baseUrl}
      subtitle={
        conn.baseUrl.replace(/^https?:\/\//, "") +
        (conn.accountLogin ? ` · ${conn.accountLogin}` : "") +
        (conn.appCount > 0
          ? ` · ${conn.appCount} app${conn.appCount === 1 ? "" : "s"}`
          : "")
      }
      menu={
        <>
          {/* Only a provider with an API can be asked whether its token still
              works; for the rest the item would always fail. */}
          {conn.hasApi && (
            <DropdownMenuItem onSelect={onTest} disabled={testing}>
              {testing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plug className="size-4" />
              )}
              Test connection
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 className="size-4" />
            Remove
          </DropdownMenuItem>
        </>
      }
    >
      {conn.health === "failing" ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <AlertTriangle className="size-3.5 text-destructive" />
            This connection stopped working
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {conn.healthError || "The provider rejected the stored token."}
          </p>
          <Button size="sm" className="mt-2" onClick={onEdit}>
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
          {/* An address inside the network is an instance-admin exception, so it
              is stated on the card rather than left to whoever remembers making
              it. */}
          {conn.allowPrivateEndpoint && (
            <Badge variant="muted">On your own network</Badge>
          )}
        </div>
      )}
    </HostCard>
  );
}

/* ------------------------------------------------------------------ */
/* Connect                                                             */
/* ------------------------------------------------------------------ */

/**
 * The provider is already chosen, it was picked in the Connect menu, so this
 * dialog only asks for what Deplo cannot know: the address and the token.
 */
function ConnectDialog({
  provider,
  isInstanceAdmin,
  next,
  onClose,
}: {
  provider: GitProviderChoice;
  isInstanceAdmin: boolean;
  next?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [label, setLabel] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState(provider.defaultBaseUrl ?? "");
  const [username, setUsername] = React.useState(provider.defaultUsername);
  const [token, setToken] = React.useState("");
  const [allowPrivate, setAllowPrivate] = React.useState(false);

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
            provider: provider.id,
            label: label.trim() || provider.label,
            baseUrl: baseUrl.trim(),
            username: username.trim(),
            token: token.trim(),
            allowPrivateEndpoint: allowPrivate,
          },
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Provider connected");
      onClose();
      // Straight back to whatever sent the user here (the create-app wizard's source
      // picker, an app's source settings), where the new connection is now in the list.
      if (next) router.push(next);
      else router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <GitProviderMark provider={provider.id} className="size-7" />
            Connect {provider.label}
          </DialogTitle>
          <DialogDescription>
            Paste a token once. Every app in this team can deploy from it.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div className="space-y-2">
              <FieldLabel
                htmlFor="git-base-url"
                info="The address you open in a browser, not the API address. A bare domain becomes https://."
                docs="git.connectionType"
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
                  docs="git.connectionType"
                >
                  Username
                </FieldLabel>
                <Input
                  id="git-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={provider.defaultUsername || "your-username"}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor="git-label">Name</FieldLabel>
                <Input
                  id="git-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={provider.label}
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
                placeholder="glpat-"
                autoComplete="off"
              />
              {provider.tokenScopes && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Needs {provider.tokenScopes}.{" "}
                  {provider.tokenHelpUrl && (
                    <a
                      href={provider.tokenHelpUrl}
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

            {/**
             * Self-hosted GitLab/Gitea is often on the same private network as the fleet, and
             * the SSRF guard on the address refuses that outright - so the ordinary form would
             * reject a perfectly normal setup.
             */}
            {isInstanceAdmin && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
                <Checkbox
                  checked={allowPrivate}
                  onCheckedChange={(v) => setAllowPrivate(v === true)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">
                    This git server is on my own network
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Allows a private address like 10.0.0.5 or a hostname that
                    resolves to one. Off by default so a mistyped address cannot
                    reach inside your network.
                  </span>
                </span>
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={pending}>
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
            <Button variant="outline" onClick={onClose} disabled={pending}>
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
