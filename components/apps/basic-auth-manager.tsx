"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dices,
  Eye,
  EyeOff,
  Globe,
  Pencil,
  Plus,
  SearchX,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import {
  EnvFilters,
  creatorFacet,
  editorFacet,
  updatedFacet,
  useEnvFilters,
} from "@/components/env/env-filters";
import { BasicAuthPasswordCell } from "@/components/apps/basic-auth-password-cell";
import {
  PendingCards,
  usePendingCreate,
} from "@/components/shared/pending-create";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { BasicAuthUserDTO } from "@/lib/data/basic-auth";

/**
 * One credential as the shared variables toolbar sees it. `key` is that
 * toolbar's identifying-name field (see `FilterableVar`) — here the username, so
 * the search box matches on it and the A–Z sort orders by it.
 */
type CredentialRow = BasicAuthUserDTO & { key: string };

/**
 * App Settings → Access. Username/password credentials that gate EVERY domain of
 * the app: when one or more exist, the deploy/reroute pipeline puts a generated
 * Traefik `basicauth` middleware in front of all the app's hostnames.
 *
 * Built as the ACCESS twin of the Environment tab, deliberately: same search,
 * same people/updated filters, same sort, same "Add" on the toolbar, same
 * authorship metadata — because the questions are the same ones ("who set this
 * up?", "what changed last week?", "what is the value?"). It differs where the
 * thing itself differs: credentials are few and each carries a revealable
 * password, so they are CARDS in a grid rather than rows in a table, and the
 * password is fetched on demand instead of riding the page's props.
 *
 * Edits are LIVE: every add/change/delete re-applies the app's routing to the
 * running container (the same label-only reroute the "Reload" action performs —
 * no rebuild), so the copy here promises immediacy and means it.
 */
export function BasicAuthManager({
  appId,
  users,
  domains,
}: {
  appId: string;
  users: BasicAuthUserDTO[];
  /** Hostnames this login gates — every domain of the app, primary first. Empty
   *  when the app has none yet, which is worth SAYING: the credential is stored
   *  and correct, it just has nothing to stand in front of. */
  domains: string[];
}) {
  const [editing, setEditing] = React.useState<BasicAuthUserDTO | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<BasicAuthUserDTO | null>(null);
  const router = useRouter();
  // Credentials being created right now: the dialog already closed, and each
  // one holds its place in the grid as a pulsing card until the routing is live.
  const { pending } = usePendingCreate();

  const rows = React.useMemo<CredentialRow[]>(
    () => users.map((u) => ({ ...u, key: u.username })),
    [users],
  );

  // One app's credentials: what/when/who is all there is to slice by — a Project
  // or an App filter would have exactly one value here. "Added by" is not
  // persistent, so it only appears once more than one person has added one.
  const facets = React.useMemo(
    () => [
      creatorFacet(rows, "credential"),
      editorFacet(rows, "credential"),
      updatedFacet<CredentialRow>(),
    ],
    [rows],
  );
  const {
    state: filters,
    setState: setFilters,
    clear,
    shown,
    counts,
  } = useEnvFilters(rows, facets);

  const hasUsers = rows.length > 0;
  const hasMatches = shown.length > 0;

  // The page's one action. It rides the toolbar (the end of the search/sort row)
  // when there is something to act on, and the empty state otherwise — the first
  // credential has to be reachable from a page that has no toolbar yet.
  const addButton = (
    <Button
      size="sm"
      onClick={() => {
        setEditing(null);
        setDialogOpen(true);
      }}
    >
      <Plus className="size-4" />
      Add credential
    </Button>
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex w-fit items-center gap-2 text-sm font-medium">
          HTTP Basic Auth
          <InfoTip content="A browser login in front of every domain of this app — the quickest way to keep a staging or internal app private. Changes take effect within seconds, with no redeploy." />
        </h3>
        <p className="text-sm text-muted-foreground">
          Anyone who reaches this app has to sign in with one of these
          credentials first. Passwords are encrypted at rest and revealed one at
          a time.
        </p>
      </div>

      <ProtectionStatus count={rows.length} domains={domains} />

      {hasUsers && (
        <EnvFilters
          state={filters}
          onChange={setFilters}
          onClear={clear}
          facets={facets}
          counts={counts}
          actions={addButton}
          noun="credentials"
          keySortLabel="Username (A–Z)"
        />
      )}

      {!hasUsers && pending.length === 0 ? (
        <EmptyState
          icon={ShieldOff}
          title="No login required"
          description="Add a credential to put a username and password in front of every domain of this app."
          action={addButton}
        />
      ) : !hasMatches && pending.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No matching credentials"
          description="No credential matches the current search and filters."
          action={
            <Button variant="outline" size="sm" onClick={clear}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((row) => (
            <CredentialCard
              key={row.id}
              user={row}
              onEdit={() => {
                setEditing(row);
                setDialogOpen(true);
              }}
              onDelete={() => setDeleting(row)}
            />
          ))}
          <PendingCards lines={1} />
        </div>
      )}

      <BasicAuthDialog
        key={editing?.id ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        appId={appId}
        editing={editing}
      />
      <ConfirmAction
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={
          deleting ? `Delete the “${deleting.username}” login?` : "Delete login?"
        }
        description={
          rows.length === 1
            ? "This is the last credential — deleting it drops the login prompt entirely, and every domain of this app becomes reachable by anyone within seconds."
            : "This removes the credential. The login it grants stops working within seconds; the app's other credentials keep working."
        }
        confirmLabel="Delete"
        successMessage="Credential deleted — that login no longer works"
        onConfirm={async () => {
          const res = await gqlAction<{ removeBasicAuthUser: boolean }>(
            `mutation($id: String!) { removeBasicAuthUser(id: $id) }`,
            { id: deleting!.id },
          );
          // Refresh either way: the delete commits BEFORE the routing is
          // re-applied, so an error can still mean the row is gone. Re-reading
          // is the only way the list stays honest about what exists.
          router.refresh();
          return res;
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/**
 * What the credentials below actually DO right now, in one line: protected or
 * open, and which hostnames it covers. Derived from the rows and the app's real
 * domains — never a stored flag — so it cannot drift from what Traefik is
 * enforcing.
 */
function ProtectionStatus({
  count,
  domains,
}: {
  count: number;
  domains: string[];
}) {
  const on = count > 0;
  const Icon = on ? ShieldCheck : ShieldOff;
  const listed = domains.slice(0, 3);
  const rest = domains.length - listed.length;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3",
        on
          ? "border-[var(--success)]/30 bg-[var(--success)]/[0.06]"
          : "border-border bg-muted/40",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          on ? "text-[var(--success)]" : "text-muted-foreground",
        )}
      />
      <p className="text-sm">
        <span className="font-medium">{on ? "Protected" : "Open to anyone"}</span>
        <span className="text-muted-foreground">
          {" — "}
          {on
            ? `${count} ${count === 1 ? "credential can" : "credentials can"} sign in.`
            : "anyone with the URL can reach this app."}
        </span>
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {domains.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {on
              ? "This app has no domain yet — the login will cover every domain you add."
              : "This app has no domain yet."}
          </span>
        ) : (
          <>
            <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {listed.map((d) => (
              <Badge
                key={d}
                variant="muted"
                // A long hostname is cut to keep the strip on one line; the full
                // one is a hover away, so the chip never becomes a riddle.
                title={d}
                className="max-w-[13rem] truncate font-mono text-[10px] font-normal"
              >
                {d}
              </Badge>
            ))}
            {rest > 0 && (
              <SimpleTooltip content={domains.slice(3).join(", ")}>
                <span className="text-xs text-muted-foreground">+{rest} more</span>
              </SimpleTooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One credential                                                      */
/* ------------------------------------------------------------------ */

/**
 * A credential tile: who signs in, the (revealable) password, and the audit line
 * the Environment tab shows as its "Last modified / Modified by" columns —
 * "added by @ada three months ago, password last changed by @linus yesterday".
 */
function CredentialCard({
  user,
  onEdit,
  onDelete,
}: {
  user: BasicAuthUserDTO;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/[0.06] text-muted-foreground"
          >
            <UserRound className="size-4" />
          </span>
          <div className="min-w-0">
            <p
              className="truncate font-mono text-sm font-medium"
              title={user.username}
            >
              {user.username}
            </p>
            <p className="text-xs text-muted-foreground">Username</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SimpleTooltip content="Change password">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onEdit}
              aria-label={`Change ${user.username}'s password`}
            >
              <Pencil className="size-4" />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip content="Delete">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              aria-label={`Delete ${user.username}`}
            >
              <Trash2 className="size-4" />
            </Button>
          </SimpleTooltip>
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs text-muted-foreground">Password</p>
        <BasicAuthPasswordCell id={user.id} username={user.username} />
      </div>

      <div className="mt-auto space-y-1.5 border-t border-border pt-3">
        <MetaRow label="Added" author={user.createdBy} at={user.createdAt} />
        <MetaRow
          label="Last change"
          // Falls back to the creator exactly as the variables table does: a
          // credential nobody has rotated was last "changed" by whoever added it.
          author={user.updatedBy ?? user.createdBy}
          at={user.updatedAt}
        />
      </div>
    </Card>
  );
}

/** One line of the card's audit block: who, and when. */
function MetaRow({
  label,
  author,
  at,
}: {
  label: string;
  author: BasicAuthUserDTO["createdBy"];
  at: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[5.5rem] shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <EnvAuthorCell author={author} />
      <SimpleTooltip content={new Date(at).toLocaleString()}>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {timeAgo(at)}
        </span>
      </SimpleTooltip>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add / change password                                               */
/* ------------------------------------------------------------------ */

// Unambiguous alphabet — no 0/O/1/l/I — because these passwords get read out
// loud, pasted into a chat, and typed by hand into a browser prompt.
const PASSWORD_ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A 20-character password from the platform CSPRNG, so the obvious path is also
 *  the strong one — nobody has to invent a password to protect an app. */
function generatePassword(): string {
  const bytes = new Uint32Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length],
  ).join("");
}

function BasicAuthDialog({
  open,
  onOpenChange,
  appId,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  editing: BasicAuthUserDTO | null;
}) {
  const [username, setUsername] = React.useState(editing?.username ?? "");
  const [password, setPassword] = React.useState("");
  const [visible, setVisible] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const { create } = usePendingCreate();
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    // Changing a password has nowhere to show progress — the card looks
    // identical before and after — so that one still resolves in the dialog.
    if (editing) {
      startTransition(async () => {
        const res = await gqlAction<{
          updateBasicAuthUserPassword: { id: string };
        }>(
          `mutation($id: String!, $password: String!) {
              updateBasicAuthUserPassword(id: $id, password: $password) { id }
            }`,
          { id: editing.id, password },
        );
        if (res.ok) {
          toast.success("Password updated — live on every domain");
          onOpenChange(false);
        } else {
          // The dialog stays open (a rejected password must keep what was
          // typed), but the list behind it is refreshed anyway: the row is
          // written before the routing is applied, so an error can still leave
          // a change the user needs to see.
          toast.error(res.error);
        }
        router.refresh();
      });
      return;
    }

    // Adding: the credential belongs in the grid, so it goes there NOW as a
    // pulsing placeholder and the dialog gets out of the way. What was typed is
    // kept aside — an error puts the form back exactly as it was.
    const typed = { username: username.trim(), password };
    onOpenChange(false);
    setUsername("");
    setPassword("");
    setVisible(false);
    create(
      { label: typed.username, note: "Adding credential…" },
      () =>
        gqlAction<{ addBasicAuthUser: { id: string } }>(
          `mutation($appId: String!, $username: String!, $password: String!) {
              addBasicAuthUser(appId: $appId, username: $username, password: $password) { id }
            }`,
          { appId, username: typed.username, password: typed.password },
        ),
      {
        success: "Credential added — every domain now asks for this login",
        onError: () => {
          setUsername(typed.username);
          setPassword(typed.password);
          onOpenChange(true);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Change password — ${editing.username}`
              : "Add basic-auth credential"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Set a new password for this user. The username can't be changed, and the old password stops working within seconds."
              : "This login will be required on every domain of the app, within seconds of saving."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="basic-auth-username">Username</Label>
              <Input
                id="basic-auth-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="alice"
                className="font-mono text-sm"
                disabled={!!editing}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="basic-auth-password">Password</Label>
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Input
                    id="basic-auth-password"
                    // Typed passwords stay covered; a GENERATED one is shown, so
                    // it can be copied out before the dialog closes — it is about
                    // to be handed to someone.
                    type={visible ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editing ? "Enter a new password" : "Password"}
                    className="pr-9 font-mono text-sm"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setVisible((v) => !v)}
                    aria-label={visible ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {visible ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                <SimpleTooltip content="Generate a strong password">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label="Generate a strong password"
                    onClick={() => {
                      setPassword(generatePassword());
                      setVisible(true);
                    }}
                  >
                    <Dices className="size-4" />
                  </Button>
                </SimpleTooltip>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending || !password.trim() || (!editing && !username.trim())
              }
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
