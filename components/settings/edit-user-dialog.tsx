"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  Crown,
  KeyRound,
  Loader2,
  ShieldCheck,
  Trash2,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DeleteUserDialog } from "@/components/settings/delete-user-dialog";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { UserDetailDTO } from "@/lib/data/members";

/* ------------------------------------------------------------------ */
/* Instance-wide user editor (shared)                                  */
/* ------------------------------------------------------------------ */

/** Header/identity seed — the minimum any caller already has on hand. */
export interface EditUserSeedUser {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
}

/**
 * Optional instant-render seed of the editable global flags. Callers that list
 * users already hold these (the settings Users panel), so the editor renders
 * immediately; callers that don't (the team Members page) omit it and the
 * editor initialises from the fetched `userDetail` instead.
 */
export interface EditUserSeedFlags {
  isInstanceAdmin: boolean;
  /** Owns the instance — see the owner lock in the component body. */
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
  teamCount: number;
}

/** The three instance-wide grants, exactly as the server holds them. */
interface Grants {
  isInstanceAdmin: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
}

const UPDATE_USER = /* GraphQL */ `
  mutation ($input: UpdateUserAdminInput!) {
    updateUserAdmin(input: $input) {
      userId
    }
  }
`;

/**
 * The instance-admin editor for ONE user's global account. The same dialog opened
 * from Settings → Users (seeded from the list row) and from the team Members page
 * (no seed; it fetches the user first). Every field here is instance-wide, NOT
 * team-scoped — that distinction is why this is separate from the member
 * permissions editor. Backed by `userDetail`/`updateUserAdmin`/`deleteUser`, all
 * instance-admin only.
 *
 * The layout is three NAMED sections rather than a flat stack of switches, because
 * a bare toggle never says what it is: an admin flipping "Publish ports" has to be
 * told they are editing PERMISSIONS, and permissions that reach every team and
 * every server at that.
 *
 *  - **Permissions** — the three grants. STAGED: they apply on "Save changes", so
 *    a mis-click is undone by closing the dialog.
 *  - **Password** — an admin reset, staged with the same button.
 *  - **Danger zone** — suspend and delete. These apply IMMEDIATELY (each behind its
 *    own confirm), which is why they are quarantined from the staged fields above
 *    instead of hiding among them.
 *
 * Because `updateUserAdmin` replaces the whole flag set, the immediate actions send
 * {@link Grants} as the SERVER holds them ({@link savedGrants}) rather than what the
 * form currently shows — suspending someone must not silently commit a permission
 * toggle the admin flipped but has not saved.
 */
export function EditUserDialog({
  user,
  seed,
  isSelf,
  open,
  onOpenChange,
}: {
  user: EditUserSeedUser;
  /** Present ⇒ render immediately; absent ⇒ fetch then render. */
  seed?: EditUserSeedFlags;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  // Email and the team list are never in a list row, so they are always fetched.
  // The editable flags come from `seed` when the caller has them (instant render)
  // or from this same fetch otherwise.
  const [detail, setDetail] = React.useState<UserDetailDTO | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Staged form state — committed by "Save changes".
  const [admin, setAdmin] = React.useState(seed?.isInstanceAdmin ?? false);
  const [exposePorts, setExposePorts] = React.useState(
    seed?.canExposePorts ?? false,
  );
  const [mountHostVolumes, setMountHostVolumes] = React.useState(
    seed?.canMountHostVolumes ?? false,
  );
  const [password, setPassword] = React.useState("");

  // Server truth. `suspended` is NOT a form field: the danger zone applies it
  // immediately, so this only ever mirrors what the server confirmed.
  const [suspended, setSuspended] = React.useState(seed?.suspended ?? false);
  const [savedGrants, setSavedGrants] = React.useState<Grants>({
    isInstanceAdmin: seed?.isInstanceAdmin ?? false,
    canExposePorts: seed?.canExposePorts ?? false,
    canMountHostVolumes: seed?.canMountHostVolumes ?? false,
  });

  const [confirmSuspend, setConfirmSuspend] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  // The two narrow grants are folded away (the house "Advanced" affordance) so the
  // section leads with the permission that actually matters. Folded away is not
  // hidden, though: a grant that is ON opens the panel, or the admin would have to
  // go looking for state nothing on screen mentions.
  const [advancedOpen, setAdvancedOpen] = React.useState(
    Boolean(seed?.canExposePorts || seed?.canMountHostVolumes),
  );
  // Whether the caller seeded the editable flags. Stable per dialog instance
  // (a boolean, not the inline-rebuilt `seed` object), so it is safe both as an
  // effect dependency and read during render.
  const hasSeed = seed != null;

  React.useEffect(() => {
    let cancelled = false;
    gqlAction<{ userDetail: UserDetailDTO }, UserDetailDTO>(
      `query ($userId: String!) {
        userDetail(userId: $userId) {
          userId
          username
          name
          email
          avatarColor
          createdAt
          isInstanceAdmin
          isInstanceOwner
          suspended
          canExposePorts
          canMountHostVolumes
          teams { teamId teamName role }
        }
      }`,
      { userId: user.userId },
      (d) => d.userDetail,
    ).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setDetail(res.data);
        // The fetch is the freshest truth there is, so it always refreshes the
        // server-side baseline (a seeded list row can be minutes old)…
        setSavedGrants({
          isInstanceAdmin: res.data.isInstanceAdmin,
          canExposePorts: res.data.canExposePorts,
          canMountHostVolumes: res.data.canMountHostVolumes,
        });
        setSuspended(res.data.suspended);
        // …but it seeds the FORM only when the caller had nothing to seed it
        // with — never clobber a switch the admin just flipped.
        if (!hasSeed) {
          setAdmin(res.data.isInstanceAdmin);
          setExposePorts(res.data.canExposePorts);
          setMountHostVolumes(res.data.canMountHostVolumes);
          if (res.data.canExposePorts || res.data.canMountHostVolumes)
            setAdvancedOpen(true);
        }
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user.userId, hasSeed]);

  // Ready once the toggles are authoritative — instantly when seeded, otherwise
  // the moment the fetch resolves (setDetail re-renders and flips this true).
  const ready = hasSeed || detail != null;
  const createdAt = seed?.createdAt ?? detail?.createdAt ?? null;
  const teams = detail?.teams ?? null;
  const teamCount = teams?.length ?? seed?.teamCount ?? 0;

  // The instance owner's account is editable only by the owner themselves — no
  // other admin may demote, suspend, reset or delete them, because all of those
  // are routes to the same takeover (see lib/data/instance-owner.ts).
  // Server-enforced; the form goes read-only so the operator sees the rule
  // instead of a toast.
  const isOwner = seed?.isInstanceOwner ?? detail?.isInstanceOwner ?? false;
  const ownerLocked = isOwner && !isSelf;
  // The flags nobody may flip on the owner, the owner included: ownership leaves
  // only through a transfer that names a successor.
  const ownerFlagsLocked = isOwner;
  // Suspending and deleting are both refused for your own account and for the
  // owner's, so for those two the whole section would be dead buttons.
  const showDanger = !isSelf && !isOwner;

  const dirty =
    admin !== savedGrants.isInstanceAdmin ||
    exposePorts !== savedGrants.canExposePorts ||
    mountHostVolumes !== savedGrants.canMountHostVolumes ||
    password.length > 0;

  /**
   * One write for every caller here. `updateUserAdmin` replaces the whole flag
   * set, so anything the caller doesn't name is sent as the server's own current
   * value — that is what keeps an immediate suspend from committing unsaved
   * permission edits.
   */
  function commit(patch: {
    grants?: Grants;
    suspended?: boolean;
    newPassword?: string;
  }) {
    const grants = patch.grants ?? savedGrants;
    return gqlAction<{ updateUserAdmin: { userId: string } }, { userId: string }>(
      UPDATE_USER,
      {
        input: {
          userId: user.userId,
          isInstanceAdmin: grants.isInstanceAdmin,
          canExposePorts: grants.canExposePorts,
          canMountHostVolumes: grants.canMountHostVolumes,
          suspended: patch.suspended ?? suspended,
          newPassword: patch.newPassword || undefined,
        },
      },
      (d) => d.updateUserAdmin,
    );
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const grants: Grants = {
        isInstanceAdmin: admin,
        canExposePorts: exposePorts,
        canMountHostVolumes: mountHostVolumes,
      };
      const res = await commit({ grants, newPassword: password || undefined });
      if (res.ok) {
        setSavedGrants(grants);
        setPassword("");
        toast.success("User updated");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  /** Reactivating is safe, so it applies on the spot — no confirm to sit through. */
  function reactivate() {
    startTransition(async () => {
      const res = await commit({ suspended: false });
      if (res.ok) {
        setSuspended(false);
        toast.success("Account reactivated");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Avatar className="size-10 shrink-0">
              <AvatarFallback
                style={{ backgroundColor: user.avatarColor, color: "#000" }}
              >
                {user.username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <DialogTitle className="flex flex-wrap items-center gap-2">
                @{user.username}
                {/* The badges read the SAVED state, never the form: the header
                    says who this account is, the form below says what you are
                    about to change it into. */}
                {isOwner ? (
                  <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                    <Crown className="size-3" />
                    Owner
                  </Badge>
                ) : (
                  savedGrants.isInstanceAdmin && (
                    <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                      <ShieldCheck className="size-3" />
                      Admin
                    </Badge>
                  )
                )}
                {suspended && (
                  <Badge variant="destructive" className="gap-1 px-1.5 py-0">
                    <Ban className="size-3" />
                    Suspended
                  </Badge>
                )}
              </DialogTitle>
              <DialogDescription className="truncate">
                {user.name && user.name !== user.username
                  ? `${user.name} · `
                  : ""}
                {detail?.email ?? "Instance-wide account & permissions."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={onSubmit}>
          {!ready ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading user…
            </div>
          ) : (
            <>
              {ownerLocked && (
                <p className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                  This account owns the instance. Only its owner can change it —
                  no other admin can demote, suspend, reset or delete them.
                  Ownership moves only when the owner transfers it.
                </p>
              )}

              {/* Who this is — read-only, so it never competes with the
                  editable sections below. */}
              <div className="grid grid-cols-3 gap-2 rounded-lg border border-border p-3">
                <Meta
                  label="Joined"
                  value={createdAt ? timeAgo(createdAt) : "—"}
                />
                <Meta label="Teams" value={String(teamCount)} />
                <Meta label="Sign-in" value={suspended ? "Blocked" : "Allowed"} />
              </div>
              {teams && teams.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {teams.map((t) => (
                    <span
                      key={t.teamId}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
                    >
                      <span className="font-medium">{t.teamName}</span>
                      <span className="capitalize text-muted-foreground">
                        {t.role}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <Section
                icon={ShieldCheck}
                title="Permissions"
                description="Instance-wide: these apply in every team and on every server. What this person may do inside one team is a separate thing, set on that team's Members page."
              >
                <ToggleRow
                  title="Instance admin"
                  detail={
                    ownerFlagsLocked
                      ? "The instance owner is always an instance admin. Transfer ownership first."
                      : "Manage every user, mint registration links, and administer every team and server."
                  }
                  checked={admin}
                  disabled={isSelf || ownerFlagsLocked}
                  onChange={setAdmin}
                />
                {isSelf && (
                  <p className="text-xs text-muted-foreground">
                    You can&apos;t change your own admin status — another
                    instance admin has to do it.
                  </p>
                )}

                <Accordion
                  type="single"
                  collapsible
                  value={advancedOpen ? "advanced" : ""}
                  onValueChange={(v) => setAdvancedOpen(v === "advanced")}
                >
                  <AccordionItem value="advanced" className="border-none">
                    <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:no-underline">
                      Advanced grants
                    </AccordionTrigger>
                    <AccordionContent className="space-y-2 pb-1 pt-1">
                      <ToggleRow
                        title="Publish ports"
                        detail="Declare published ports in a compose stack — a service's ports: (bound to the host) or expose:. Public domains and routes don't need this."
                        checked={admin || exposePorts}
                        disabled={admin || ownerLocked}
                        onChange={setExposePorts}
                      />
                      <ToggleRow
                        title="Mount host volumes"
                        detail="Bind-mount host filesystem paths into containers (compose and single-container)."
                        checked={admin || mountHostVolumes}
                        disabled={admin || ownerLocked}
                        onChange={setMountHostVolumes}
                      />
                      {admin && (
                        <p className="text-xs text-muted-foreground">
                          Instance admins hold both implicitly — these two only
                          matter once the admin switch above is off.
                        </p>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </Section>

              <Section
                icon={KeyRound}
                title="Password"
                description="Set a new password for this account. Nobody is emailed about it — hand it over yourself."
              >
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="reset-pw"
                    info={
                      <>
                        Leave blank to keep the current password. A new one must
                        be at least 8 characters, and replaces theirs the moment
                        you save.
                      </>
                    }
                  >
                    New password (optional)
                  </FieldLabel>
                  <Input
                    id="reset-pw"
                    type="password"
                    value={password}
                    disabled={ownerLocked}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      ownerLocked
                        ? "Only the instance owner can reset their own password"
                        : "Leave blank to keep the current password"
                    }
                  />
                </div>
              </Section>

              {showDanger && (
                <Section
                  icon={AlertTriangle}
                  title="Danger zone"
                  tone="destructive"
                  description="Unlike everything above, these apply the moment you confirm them — they don't wait for Save changes."
                >
                  <ActionRow
                    title={suspended ? "Reactivate account" : "Suspend account"}
                    detail={
                      suspended
                        ? "Let this person sign in again. Everything they had is still there."
                        : "Sign them out and block sign-in. Teams, apps and data are all kept, and you can undo it here at any time."
                    }
                    action={
                      suspended ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={reactivate}
                        >
                          <UserCheck className="size-4" />
                          Reactivate
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={pending}
                          onClick={() => setConfirmSuspend(true)}
                        >
                          <Ban className="size-4" />
                          Suspend
                        </Button>
                      )
                    }
                  />
                  <ActionRow
                    title="Delete account"
                    detail="Permanently removes this person and — if you say so — what they own. There is no undo; suspending is the reversible answer."
                    action={
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={pending}
                        onClick={() => setConfirmDelete(true)}
                      >
                        <Trash2 className="size-4" />
                        Delete…
                      </Button>
                    }
                  />
                </Section>
              )}
            </>
          )}

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
                !ready ||
                pending ||
                ownerLocked ||
                !dirty ||
                (password.length > 0 && password.length < 8)
              }
            >
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>

        {/* Both danger-zone confirms live OUTSIDE the form above: each renders its
            own form, and a submit from a portalled subtree still propagates up the
            React tree. */}
        <ConfirmAction
          open={confirmSuspend}
          onOpenChange={setConfirmSuspend}
          title={`Suspend @${user.username}?`}
          description="They are signed out immediately and can't sign back in until you reactivate them. Team memberships, apps and everything they own are kept — nothing is deleted."
          confirmLabel="Suspend account"
          successMessage="Account suspended"
          onConfirm={async () => {
            const res = await commit({ suspended: true });
            if (res.ok) {
              setSuspended(true);
              router.refresh();
            }
            return res;
          }}
        />
        {confirmDelete && (
          <DeleteUserDialog
            userId={user.userId}
            username={user.username}
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            // The account this dialog edits no longer exists — close it too,
            // rather than leave a form pointed at a deleted user.
            onDeleted={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

/**
 * A named group of controls. The heading is the whole point: it tells the admin
 * WHAT they are editing before they touch a switch, which a bare row of toggles
 * never did.
 */
function Section({
  icon: Icon,
  title,
  description,
  tone = "default",
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  tone?: "default" | "destructive";
  children: React.ReactNode;
}) {
  const danger = tone === "destructive";
  return (
    <section
      className={cn(
        "space-y-3 rounded-lg border p-3",
        danger ? "border-destructive/40 bg-destructive/5" : "border-border",
      )}
    >
      <header className="space-y-1">
        <h3
          className={cn(
            "flex items-center gap-2 text-sm font-semibold",
            danger && "text-destructive",
          )}
        >
          <Icon className="size-4 shrink-0" />
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function ToggleRow({
  title,
  detail,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {/* The title is a <p>, not a <label>, so the switch carries the name
          itself — otherwise it announces as a bare "switch, off". */}
      <Switch
        aria-label={title}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

/** A row whose control fires straight away — the danger zone's shape. */
function ActionRow({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
