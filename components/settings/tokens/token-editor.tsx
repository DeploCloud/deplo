"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  Loader2,
  Trash2,
  ShieldAlert,
  FolderTree,
  ServerCog,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { PermissionPicker } from "@/components/settings/permission-picker";
import {
  ScopePicker,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { TokenCreated } from "@/components/settings/tokens/token-created";
import { revokeDescription } from "@/components/settings/tokens/revoke-copy";
import { gqlAction } from "@/lib/graphql-client";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types";
import { CAPABILITY_CATEGORIES, CAPABILITY_META } from "@/lib/capabilities";
import { sameCapabilities } from "@/lib/membership-shared";
import type { TokenPreset } from "@/lib/token-presets";
import type {
  ApiTokenDTO,
  ScopeTreeFolder,
  ScopeTreeTeam,
} from "@/lib/data/tokens";

/**
 * The API-token editor: a full-width page, reached from the token LIST.
 *
 * A page and not a dialog because forty permissions, a search box, a project
 * scope and a summary of what the credential ends up able to do do not fit in a
 * modal. Full width and not a master-detail rail because nobody compares two
 * tokens side by side — the list is where you scan them, and the space a rail
 * would take is space the permission checkboxes actually use.
 */
export function TokenEditor({
  mode,
  token,
  preset,
  tree,
  activeTeamId,
  canManage,
  canEdit = canManage,
  canGrantInstanceAdmin,
  publicUrl,
}: {
  mode: "create" | "edit";
  /** The token being edited. */
  token?: ApiTokenDTO;
  /** Revoking takes away THIS team's access, so the dialog has to name it. */
  activeTeamId: string;
  /** The template a new token was started from (chosen in the "New token" menu). */
  preset?: TokenPreset | null;
  /** Every team, project and app the actor can reach — the scope picker's tree. */
  tree: ScopeTreeTeam[];
  canManage: boolean;
  /**
   * Whether the form itself may be changed here. Defaults to `canManage`, and is
   * false for a token MANAGED in another team: only that team can re-author it,
   * while revoking stays available to everyone who can see it.
   */
  canEdit?: boolean;
  /** Only an instance admin may hand out instance administration. */
  canGrantInstanceAdmin: boolean;
  /** This deplo's public URL, for the copy-paste curl after minting. */
  publicUrl: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const [created, setCreated] = React.useState<string | null>(null);

  const initial = React.useMemo(
    () => ({
      name: token?.name ?? "",
      capabilities:
        token?.capabilities ??
        preset?.capabilities ??
        (["view"] as Capability[]),
      scope: {
        teamIds: token?.teamIds ?? [],
        projectIds: token?.projectIds ?? [],
        folderIds: token?.folderIds ?? [],
        appIds: token?.appIds ?? [],
      } as ScopeSelection,
      instanceAdmin: token?.instanceAdmin ?? false,
      // A token that already has one keeps it unless the picker is touched;
      // a new one defaults to 90 days rather than forever, because the
      // credential nobody ever revokes is the one nobody ever chose an end
      // for. "Never" stays one click away.
      expiry: token ? "keep" : "90",
    }),
    [token, preset],
  );

  const [name, setName] = React.useState(initial.name);
  const [caps, setCaps] = React.useState<Capability[]>(initial.capabilities);
  const [scope, setScope] = React.useState<ScopeSelection>(initial.scope);
  const [instanceAdmin, setInstanceAdmin] = React.useState(
    initial.instanceAdmin,
  );
  const [expiry, setExpiry] = React.useState<string>(initial.expiry);

  const readOnly = !canEdit;
  const revokeCopy = {
    teams: token?.teamsReached ?? [],
    activeTeamId,
    scoped: token?.scoped ?? false,
  };
  const picked =
    scope.teamIds.length +
    scope.projectIds.length +
    scope.folderIds.length +
    scope.appIds.length;
  const scoped = picked > 0;
  const granted = caps.filter((c) => c !== "view").length;
  const sensitive = caps.filter((c) => CAPABILITY_META[c].sensitive).length;
  const dirty =
    name !== initial.name ||
    expiry !== initial.expiry ||
    instanceAdmin !== initial.instanceAdmin ||
    !sameScope(scope, initial.scope) ||
    !sameCapabilities(caps, initial.capabilities);

  // The two are mutually exclusive by rule (the server refuses the pair), so the
  // UI never lets them disagree: narrowing the scope turns the bit off rather
  // than leaving a switch on screen that would be ignored.
  function changeScope(next: ScopeSelection) {
    if (
      next.teamIds.length +
        next.projectIds.length +
        next.folderIds.length +
        next.appIds.length >
      0
    )
      setInstanceAdmin(false);
    setScope(next);
  }

  const scopeLabel = describeScope(scope, tree);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly || !name.trim()) return;
    const input = {
      name,
      capabilities: caps,
      teamIds: scope.teamIds,
      projectIds: scope.projectIds,
      folderIds: scope.folderIds,
      appIds: scope.appIds,
      instanceAdmin,
      // `undefined` (omitted) means "leave it as it is", which is the only
      // thing "keep" can mean; `null` clears it. The server refuses a date in
      // the past, so the instant is computed at submit and not at render.
      expiresAt: expiresAtFor(expiry),
    };
    startTransition(async () => {
      if (mode === "create") {
        const res = await gqlAction<
          { createToken: { raw: string } },
          { raw: string }
        >(
          `mutation($input: CreateTokenInput!) { createToken(input: $input) { raw } }`,
          { input },
          (d) => d.createToken,
        );
        if (res.ok && res.data) {
          setCreated(res.data.raw);
          router.refresh();
        } else if (!res.ok) {
          toast.error(res.error);
        }
        return;
      }
      const res = await gqlAction(
        `mutation($input: UpdateTokenInput!) { updateToken(input: $input) }`,
        { input: { ...input, id: token!.id } },
      );
      if (res.ok) {
        toast.success("Token saved");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  // The secret takes over the page rather than opening a dialog: a modal is
  // dismissible by Escape and by clicking away, and this is the one screen in
  // deplo that must not be dismissible by accident. It also leaves nobody
  // standing on a filled-in form for a token that already exists.
  if (created)
    return (
      <TokenCreated
        raw={created}
        name={name.trim()}
        granted={granted}
        scope={scopeLabel}
        publicUrl={publicUrl}
      />
    );

  return (
    <form
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]"
      onSubmit={submit}
    >
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <FieldLabel
                htmlFor="token-name"
                info="Shown in this list and in the activity log. Name it after the thing that will use it, so you know what you are revoking later."
              >
                Name
              </FieldLabel>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="GitHub Actions deploy"
                maxLength={40}
                autoFocus={mode === "create"}
                disabled={readOnly}
              />
            </div>

            <div className="space-y-2">
              <FieldLabel
                htmlFor="token-expiry"
                info="After this, the token stops working everywhere and whatever uses it starts failing. Pick the shortest span the job actually needs."
              >
                Expires
              </FieldLabel>
              <Select
                value={expiry}
                onValueChange={setExpiry}
                disabled={readOnly}
              >
                <SelectTrigger id="token-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mode === "edit" && (
                    <SelectItem value="keep">
                      {token?.expiresAt
                        ? `Keep ${new Date(token.expiresAt).toLocaleDateString()}`
                        : "Keep no expiry"}
                    </SelectItem>
                  )}
                  <SelectItem value="30">In 30 days</SelectItem>
                  <SelectItem value="90">In 90 days</SelectItem>
                  <SelectItem value="365">In a year</SelectItem>
                  <SelectItem value="never">Never</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === "edit" && (
              <p className="text-xs text-muted-foreground">
                The full token was shown once when it was created. Deplo keeps
                only a hash of it, so it can&apos;t be shown again — revoke this
                one and create another if it was lost.
              </p>
            )}

            {canGrantInstanceAdmin && (
              <Accordion type="single" collapsible>
                <AccordionItem value="advanced" className="border-b-0">
                  <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:no-underline">
                    Advanced
                  </AccordionTrigger>
                  <AccordionContent className="pt-2">
                    <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-sm font-medium">
                          <ServerCog className="size-3.5 text-muted-foreground" />
                          Instance admin
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Lets this token administer the whole instance — every
                          user, every team and every server — not just this
                          team. Only turn it on for a token that manages Deplo
                          itself.
                        </p>
                        {scoped && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            A token limited to projects can&apos;t administer
                            the instance.
                          </p>
                        )}
                      </div>
                      <Switch
                        checked={instanceAdmin}
                        onCheckedChange={setInstanceAdmin}
                        disabled={readOnly || scoped}
                        aria-label="Instance admin"
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <ScopePicker
              tree={tree}
              selection={scope}
              onChange={changeScope}
              disabled={readOnly}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <PermissionPicker
              capabilities={caps}
              onChange={setCaps}
              disabled={readOnly}
              hint="Every action deplo can gate, one permission each. Tick exactly what this token should be able to do — search by what you want it to reach."
            />
          </CardContent>
        </Card>
      </div>

      {/* Right rail: what this token will be able to do, and the primary action —
          sticky on desktop so it stays reachable while scrolling the list. */}
      <aside className="h-fit space-y-4 lg:sticky lg:top-20">
        <Card>
          <CardHeader>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Summary
              <InfoTip content="Exactly what a client holding this token will be able to do." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-2.5 text-sm">
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Name</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {name.trim() || "—"}
                </dd>
              </div>
              {mode === "create" && (
                <div className="flex items-center gap-3">
                  <dt className="shrink-0 text-muted-foreground">
                    Started from
                  </dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-medium">
                    {preset ? preset.name : "Nothing (blank)"}
                  </dd>
                </div>
              )}
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Permissions</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium tabular-nums">
                  {granted} of {ALL_CAPABILITIES.length - 1}
                </dd>
              </div>
              {sensitive > 0 && (
                <div className="flex items-center gap-3">
                  <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    <ShieldAlert className="size-3.5 text-amber-500" />
                    Sensitive
                  </dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-medium tabular-nums">
                    {sensitive}
                  </dd>
                </div>
              )}
              <div className="flex items-center gap-3">
                <dt className="shrink-0 text-muted-foreground">Access</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {scopeLabel}
                </dd>
              </div>
              {mode === "edit" && (
                <div className="flex items-center gap-3">
                  <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    Acts as
                    <InfoTip
                      content={`A token can never do more than the member who created it. If ${
                        token!.createdByUsername ?? "they"
                      } loses a permission, this token loses it too.`}
                    />
                  </dt>
                  <dd className="flex min-w-0 flex-1 items-center justify-end gap-1.5 truncate text-right font-medium">
                    {token!.createdByUsername && (
                      <UserAvatar
                        username={token!.createdByUsername}
                        avatarColor={token!.createdByAvatarColor}
                        avatarUrl={token!.createdByAvatarUrl}
                        size="sm"
                      />
                    )}
                    {token!.createdByUsername ?? "—"}
                  </dd>
                </div>
              )}
            </dl>

            <div className="space-y-1.5">
              {CAPABILITY_CATEGORIES.map((cat) => {
                const n = cat.caps.filter((c) => caps.includes(c)).length;
                return (
                  <div
                    key={cat.key}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span
                      className={
                        n === 0
                          ? "text-muted-foreground/60"
                          : "text-muted-foreground"
                      }
                    >
                      {cat.label}
                    </span>
                    <Badge
                      variant={n === 0 ? "muted" : "secondary"}
                      className="tabular-nums"
                    >
                      {n}/{cat.caps.length}
                    </Badge>
                  </div>
                );
              })}
            </div>

            {scoped && (
              <Badge
                variant="outline"
                className="w-full justify-center gap-1.5"
              >
                <FolderTree className="size-3" />
                Limited access
              </Badge>
            )}
            {instanceAdmin && (
              <Badge
                variant="outline"
                className="w-full justify-center gap-1.5"
              >
                <ServerCog className="size-3" />
                Instance admin
              </Badge>
            )}

            {!readOnly && (
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={
                  pending || !name.trim() || (mode === "edit" && !dirty)
                }
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                {mode === "create"
                  ? "Create token"
                  : dirty
                    ? "Save changes"
                    : "Saved"}
              </Button>
            )}

            {mode === "edit" && (
              <p className="text-xs text-muted-foreground">
                Changes take effect on the token&apos;s next call.
              </p>
            )}

            {mode === "edit" && canManage && (
              <Button
                type="button"
                variant="outline"
                className="w-full text-destructive hover:text-destructive"
                onClick={() => setRevokeOpen(true)}
              >
                <Trash2 className="size-4" />
                Revoke token
              </Button>
            )}
          </CardContent>
        </Card>
      </aside>

      {mode === "edit" && (
        <ConfirmAction
          open={revokeOpen}
          onOpenChange={setRevokeOpen}
          title={`Revoke ${token!.name}?`}
          description={revokeDescription(revokeCopy)}
          confirmLabel="Revoke token"
          successMessage="Token revoked"
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation($id: String!) { revokeToken(id: $id) }`,
              { id: token!.id },
            );
            if (res.ok) {
              router.push("/settings/tokens");
              router.refresh();
            }
            return res;
          }}
        />
      )}
    </form>
  );
}

/** Order-blind equality, so re-ticking the same boxes isn't "dirty". */
function sameScope(a: ScopeSelection, b: ScopeSelection): boolean {
  const eq = (x: string[], y: string[]) =>
    x.length === y.length && x.every((v) => y.includes(v));
  return (
    eq(a.teamIds, b.teamIds) &&
    eq(a.projectIds, b.projectIds) &&
    eq(a.folderIds, b.folderIds) &&
    eq(a.appIds, b.appIds)
  );
}

/** One short line for the summary rail: name one node, else count them. */
function describeScope(scope: ScopeSelection, tree: ScopeTreeTeam[]): string {
  const total =
    scope.teamIds.length +
    scope.projectIds.length +
    scope.folderIds.length +
    scope.appIds.length;
  if (total === 0) return "Everything I can access";
  if (total === 1) {
    const only =
      scope.teamIds[0] ??
      scope.projectIds[0] ??
      scope.folderIds[0] ??
      scope.appIds[0];
    return nameOf(tree, only) ?? "1 item";
  }
  const parts: string[] = [];
  const n = (v: number, one: string) => `${v} ${v === 1 ? one : `${one}s`}`;
  if (scope.teamIds.length) parts.push(n(scope.teamIds.length, "team"));
  if (scope.projectIds.length)
    parts.push(n(scope.projectIds.length, "project"));
  if (scope.folderIds.length) parts.push(n(scope.folderIds.length, "folder"));
  if (scope.appIds.length) parts.push(n(scope.appIds.length, "app"));
  return parts.join(", ");
}

/** Find any node in the tree by id — teams, projects, folders (nested) or apps. */
function nameOf(tree: ScopeTreeTeam[], id: string): string | null {
  const inFolder = (f: ScopeTreeFolder): string | null => {
    if (f.id === id) return f.name;
    return (
      f.apps.find((a) => a.id === id)?.name ??
      f.folders.reduce<string | null>((hit, c) => hit ?? inFolder(c), null)
    );
  };
  for (const t of tree) {
    if (t.id === id) return t.name;
    for (const p of t.projects) {
      if (p.id === id) return p.name;
      const inProject =
        p.apps.find((a) => a.id === id)?.name ??
        p.folders.reduce<string | null>((hit, f) => hit ?? inFolder(f), null);
      if (inProject) return inProject;
    }
    const inTeam =
      t.looseApps.find((a) => a.id === id)?.name ??
      t.folders.reduce<string | null>((hit, f) => hit ?? inFolder(f), null);
    if (inTeam) return inTeam;
  }
  return null;
}

/**
 * The instant a picked span lands on, in the shape the API takes.
 *
 * `undefined` (the "keep" option) is OMITTED from the mutation, which is what
 * leaves an existing expiry alone; `null` clears it. Computed at submit rather
 * than at render so a form left open overnight cannot post a date the server has
 * already decided is in the past.
 */
function expiresAtFor(choice: string): string | null | undefined {
  if (choice === "keep") return undefined;
  if (choice === "never") return null;
  const days = Number(choice);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
