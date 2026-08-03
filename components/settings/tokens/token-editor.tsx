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
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { PermissionPicker } from "@/components/settings/permission-picker";
import { TokenCreated } from "@/components/settings/tokens/token-created";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types";
import { CAPABILITY_CATEGORIES, CAPABILITY_META } from "@/lib/capabilities";
import { sameCapabilities } from "@/lib/membership-shared";
import type { TokenPreset } from "@/lib/token-presets";
import type { ApiTokenDTO } from "@/lib/data/tokens";

/** The projects a token's scope can name, as the editor needs them. */
export interface ScopeProject {
  id: string;
  name: string;
  color: string | null;
  appCount: number;
}

/**
 * The API-token editor: the same page shape as the role editor, because it is
 * the same decision. Forty permissions, a search box and a summary of what the
 * credential ends up able to do do not fit in a modal, and a token is no less
 * consequential than a role — it is a role someone can paste into a script.
 */
export function TokenEditor({
  mode,
  token,
  preset,
  projects,
  canManage,
  canGrantInstanceAdmin,
  publicUrl,
}: {
  mode: "create" | "edit";
  /** The token being edited. */
  token?: ApiTokenDTO;
  /** The template a new token was started from (chosen in the "New token" menu). */
  preset?: TokenPreset | null;
  /** Every project of the team, for the scope picker. */
  projects: ScopeProject[];
  canManage: boolean;
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
        token?.capabilities ?? preset?.capabilities ?? (["view"] as Capability[]),
      projectIds: token?.projectIds ?? [],
      instanceAdmin: token?.instanceAdmin ?? false,
    }),
    [token, preset],
  );

  const [name, setName] = React.useState(initial.name);
  const [caps, setCaps] = React.useState<Capability[]>(initial.capabilities);
  const [scope, setScope] = React.useState<string[]>(initial.projectIds);
  const [instanceAdmin, setInstanceAdmin] = React.useState(
    initial.instanceAdmin,
  );

  const readOnly = !canManage;
  const scoped = scope.length > 0;
  const granted = caps.filter((c) => c !== "view").length;
  const sensitive = caps.filter((c) => CAPABILITY_META[c].sensitive).length;
  const dirty =
    name !== initial.name ||
    instanceAdmin !== initial.instanceAdmin ||
    scope.length !== initial.projectIds.length ||
    scope.some((id) => !initial.projectIds.includes(id)) ||
    !sameCapabilities(caps, initial.capabilities);

  // The two are mutually exclusive by rule (the server refuses the pair), so the
  // UI never lets them disagree: naming a project turns the bit off rather than
  // leaving a switch on screen that would be ignored.
  function toggleProject(id: string, on: boolean) {
    setScope((prev) => {
      const next = on ? [...prev, id] : prev.filter((p) => p !== id);
      if (next.length > 0) setInstanceAdmin(false);
      return next;
    });
  }

  const scopeNames = projects
    .filter((p) => scope.includes(p.id))
    .map((p) => p.name);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly || !name.trim()) return;
    const input = {
      name,
      capabilities: caps,
      projectIds: scope,
      instanceAdmin,
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
        scopeNames={scopeNames}
        publicUrl={publicUrl}
      />
    );

  return (
    <form className="grid items-start gap-6 xl:grid-cols-[1fr_320px]" onSubmit={submit}>
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
                          user, every team and every server — not just this team.
                          Only turn it on for a token that manages Deplo itself.
                        </p>
                        {scoped && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            A token limited to projects can&apos;t administer the
                            instance.
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
          <CardHeader>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              Scope
              <InfoTip content="Which projects this token can reach. Leave every box unticked and it reaches the whole team." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This team has no projects yet, so the token covers everything its
                permissions allow. Create a project first if you want to limit a
                token to part of the team.
              </p>
            ) : (
              <>
                <div className="max-h-64 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
                  {projects.map((p) => (
                    <label
                      key={p.id}
                      htmlFor={`scope-${p.id}`}
                      className={
                        readOnly
                          ? "flex items-center gap-3 px-3 py-2.5"
                          : "flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent"
                      }
                    >
                      <Checkbox
                        id={`scope-${p.id}`}
                        checked={scope.includes(p.id)}
                        disabled={readOnly}
                        onCheckedChange={(v) => toggleProject(p.id, v === true)}
                      />
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: p.color ?? "var(--muted-foreground)" }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {p.name}
                      </span>
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                        {p.appCount} {p.appCount === 1 ? "app" : "apps"}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {!scoped ? (
                    <>
                      Whole team. This token reaches every app, database and
                      setting its permissions allow.
                    </>
                  ) : (
                    <>
                      Limited to{" "}
                      <span className="font-medium text-foreground">
                        {scopeNames.length === 1
                          ? scopeNames[0]
                          : `${scopeNames.length} projects`}
                      </span>
                      . This token can only reach apps in{" "}
                      {scopeNames.length === 1 ? "that project" : "those projects"}
                      {" — "}
                      team-wide permissions such as Manage members, Manage roles
                      and Manage team settings stop applying, even while they are
                      ticked below.
                    </>
                  )}
                </p>
              </>
            )}
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
      <aside className="h-fit space-y-4 xl:sticky xl:top-20">
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
                  <dt className="shrink-0 text-muted-foreground">Started from</dt>
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
                <dt className="shrink-0 text-muted-foreground">Scope</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-medium">
                  {!scoped
                    ? "Whole team"
                    : scopeNames.length === 1
                      ? scopeNames[0]
                      : `${scopeNames.length} projects`}
                </dd>
              </div>
              {mode === "edit" && (
                <>
                  <div className="flex items-center gap-3">
                    <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      Acts as
                      <InfoTip
                        content={`A token can never do more than the member who created it. If ${
                          token!.createdByUsername ?? "they"
                        } loses a permission, this token loses it too.`}
                      />
                    </dt>
                    <dd className="min-w-0 flex-1 truncate text-right font-medium">
                      {token!.createdByUsername ?? "—"}
                    </dd>
                  </div>
                  <div className="flex items-center gap-3">
                    <dt className="shrink-0 text-muted-foreground">Last used</dt>
                    <dd className="min-w-0 flex-1 truncate text-right font-medium">
                      {token!.lastUsedAt ? timeAgo(token!.lastUsedAt) : "Never used"}
                    </dd>
                  </div>
                </>
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
                        n === 0 ? "text-muted-foreground/60" : "text-muted-foreground"
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
              <Badge variant="outline" className="w-full justify-center gap-1.5">
                <FolderTree className="size-3" />
                Limited to projects
              </Badge>
            )}
            {instanceAdmin && (
              <Badge variant="outline" className="w-full justify-center gap-1.5">
                <ServerCog className="size-3" />
                Instance admin
              </Badge>
            )}

            {!readOnly && (
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={pending || !name.trim() || (mode === "edit" && !dirty)}
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
          description="Every client using it loses access immediately, including any deploy hook that sends it. This can't be undone; create a new token if you still need one."
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
