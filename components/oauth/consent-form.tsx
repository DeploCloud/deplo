"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Globe, Loader2, Pencil, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { ConsentShell } from "@/components/oauth/consent-shell";
import { PermissionPicker } from "@/components/settings/permission-picker";
import { ScopePicker } from "@/components/settings/tokens/scope-picker/picker";
import type { ScopeSelection } from "@/components/settings/tokens/scope-picker/selection";
import { gqlAction } from "@/lib/graphql-client";
import { scopeLabel } from "@/components/settings/tokens/scope-label";
import { TOKEN_PRESETS, presetIdFor } from "@/lib/token-presets";
import type { Capability } from "@/lib/types/identity";
import type { ScopeTreeTeam } from "@/lib/data/tokens/scope-tree";
import type { ConsentClientDTO } from "@/lib/data/mcp-clients";

const AUTHORIZE = /* GraphQL */ `
  mutation (
    $clientId: String!
    $capabilities: [String!]
    $teamIds: [String!]
    $projectIds: [String!]
    $folderIds: [String!]
    $appIds: [String!]
    $expectedTeamId: String
  ) {
    authorizeMcpClient(
      clientId: $clientId
      capabilities: $capabilities
      teamIds: $teamIds
      projectIds: $projectIds
      folderIds: $folderIds
      appIds: $appIds
      expectedTeamId: $expectedTeamId
    )
  }
`;

async function postConsent(body: {
  accept: boolean;
  scope?: string;
  oauth_query?: string;
}): Promise<{ url?: string; error?: string }> {
  try {
    const res = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      url?: string;
      error_description?: string;
      message?: string;
    };
    if (!res.ok || !json.url)
      return {
        error:
          json.error_description ||
          json.message ||
          `Deplo could not finish the connection (${res.status})`,
      };
    return { url: json.url };
  } catch {
    return { error: "Deplo could not reach its own sign-in service" };
  }
}

export function ConsentForm({
  client,
  scope,
  oauthQuery,
  tree,
  activeTeamId,
  connectableTeamIds,
  publicOrigin,
  username,
}: {
  client: ConsentClientDTO;
  scope: string;
  oauthQuery: string;
  tree: ScopeTreeTeam[];
  activeTeamId: string;
  connectableTeamIds: string[];
  publicOrigin: string | null;
  username: string;
}) {
  const mcpPreset = TOKEN_PRESETS.find((p) => p.id === "mcp");
  const [capabilities, setCapabilities] = useState<Capability[]>(
    mcpPreset?.capabilities ?? ["view"],
  );
  const [selection, setSelection] = useState<ScopeSelection>({
    teamIds: [],
    projectIds: [],
    folderIds: [],
    appIds: [],
  });
  const [editing, setEditing] = useState<null | "access" | "permissions">(null);

  const wrongOrigin =
    typeof window !== "undefined" &&
    !!publicOrigin &&
    window.location.origin !== publicOrigin;

  const [pending, setPending] = useState(false);
  const presetId = useMemo(() => presetIdFor(capabilities), [capabilities]);
  const preset = TOKEN_PRESETS.find((p) => p.id === presetId);

  const scoped =
    selection.teamIds.length +
      selection.projectIds.length +
      selection.folderIds.length +
      selection.appIds.length >
    0;
  const teamNames = useMemo(
    () => Object.fromEntries(tree.map((t) => [t.id, t.name])),
    [tree],
  );
  const accessLabel = scoped
    ? scopeLabel({ scoped: true, ...selection }, teamNames)
    : {
        text:
          connectableTeamIds.length === 1
            ? (teamNames[connectableTeamIds[0]] ?? "1 team")
            : `Every team you can connect (${connectableTeamIds.length})`,
        empty: false,
      };
  const accessTeams = (
    selection.teamIds.length
      ? selection.teamIds
      : scoped
        ? []
        : connectableTeamIds
  )
    .map((id) => tree.find((t) => t.id === id))
    .filter((t): t is ScopeTreeTeam => !!t)
    .slice(0, 3);

  async function onApprove(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const done = await postConsent({
      accept: true,
      ...(scope ? { scope } : {}),
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    });
    if (!done.url) {
      setPending(false);
      toast.error(done.error || "Deplo could not finish the connection");
      return;
    }
    const minted = await gqlAction(AUTHORIZE, {
      clientId: client.clientId,
      capabilities,
      teamIds: selection.teamIds,
      projectIds: selection.projectIds,
      folderIds: selection.folderIds,
      appIds: selection.appIds,
      expectedTeamId: activeTeamId,
    });
    if (!minted.ok) {
      setPending(false);
      toast.error(minted.error || "Deplo refused the connection");
      return;
    }
    window.location.assign(done.url);
  }

  async function onSwitchAccount() {
    setPending(true);
    await gqlAction(`mutation { logout }`, {});
    const here = window.location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(here)}`);
  }

  async function onDeny() {
    setPending(true);
    const done = await postConsent({
      accept: false,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    });
    window.location.assign(done.url ?? "/settings/mcp");
  }

  return (
    <ConsentShell>
      {wrongOrigin ? (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            You opened Deplo at a different address from the one it publishes (
            {publicOrigin}). Approving will be refused. Open Deplo at that
            address and start the connection again.
          </span>
        </p>
      ) : null}

      <Card>
        <form className="grid gap-6 p-6" onSubmit={onApprove}>
          <div className="grid justify-items-center gap-4 text-center">
            <Avatar className="size-14">
              <AvatarImage src={client.icon ?? undefined} alt="" />
              <AvatarFallback className="bg-muted text-base font-semibold">
                {client.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Connect {client.name} to Deplo
              </h1>
              {client.redirectOrigin ? (
                <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                  <Globe className="size-3.5 shrink-0" />
                  <span className="truncate">{client.redirectOrigin}</span>
                  <InfoTip
                    content="Where Deplo sends it back after you approve. It is the one thing this app cannot make up about itself."
                    docs="tokens.oauth"
                  />
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">
                  Give it only what it needs.
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-2">
            <FieldLabel
              info="What the app may do, and what it may reach. It can never do more than you can."
              docs="tokens.oauth"
            >
              What it gets
            </FieldLabel>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border text-sm">
              <SummaryRow
                label="Access"
                onClick={() => setEditing("access")}
                disabled={pending}
              >
                {accessTeams.length ? (
                  <span className="flex -space-x-1.5">
                    {accessTeams.map((t) => (
                      <TeamAvatar
                        key={t.id}
                        name={t.name}
                        avatarUrl={t.avatarUrl}
                        size="md"
                        className="border-2 border-card"
                      />
                    ))}
                  </span>
                ) : null}
                <span className="truncate font-medium">{accessLabel.text}</span>
              </SummaryRow>
              <SummaryRow
                label="Permissions"
                onClick={() => setEditing("permissions")}
                disabled={pending}
              >
                <span className="truncate font-medium">
                  {preset ? preset.name : `${capabilities.length} selected`}
                </span>
              </SummaryRow>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={onDeny}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Authorize
            </Button>
          </div>
        </form>
      </Card>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Connecting as {username} · Not you?{" "}
        <button
          type="button"
          onClick={() => void onSwitchAccount()}
          disabled={pending}
          className="cursor-pointer font-medium underline underline-offset-2 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
        >
          Log out
        </button>
      </p>

      <Dialog
        open={editing === "access"}
        onOpenChange={(open) => setEditing(open ? "access" : null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>What {client.name} can reach</DialogTitle>
            <DialogDescription className="mt-1">
              Nothing ticked means every team you can connect, now and later.
              Tick teams, projects, folders or apps to limit it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(null);
            }}
          >
            <ScopePicker
              tree={tree}
              selection={selection}
              onChange={setSelection}
              info="Which teams this app may work in, and how much of each. Nothing ticked is every team you can connect agents to; a tick limits it to that."
              docs="tokens.scope"
            />

            <DialogFooter>
              <Button type="submit">Done</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editing === "permissions"}
        onOpenChange={(open) => setEditing(open ? "permissions" : null)}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>What {client.name} may do</DialogTitle>
            <DialogDescription className="mt-1">
              Start from a template, then tick exactly what it needs.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(null);
            }}
          >
            <div className="grid gap-3">
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="consent-preset"
                  info="A starting set you can then adjust. Custom appears once the ticks stop matching one."
                  docs="tokens.capabilities"
                >
                  Template
                </FieldLabel>
                <Select
                  value={presetId ?? CUSTOM}
                  onValueChange={(id) => {
                    const next = TOKEN_PRESETS.find((p) => p.id === id);
                    if (next) setCapabilities(next.capabilities);
                  }}
                >
                  <SelectTrigger id="consent-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOKEN_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                    {presetId ? null : (
                      <SelectItem value={CUSTOM} disabled>
                        Custom
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {preset ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {preset.description}
                  </p>
                ) : null}
              </div>
              <PermissionPicker
                capabilities={capabilities}
                onChange={setCapabilities}
                scroll
                hint="Tick exactly what this app should be able to do. A secret can never be read over MCP, whatever is ticked here."
              />
            </div>

            <DialogFooter>
              <Button type="submit">Done</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </ConsentShell>
  );
}

const CUSTOM = "custom";

function SummaryRow({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Change ${label.toLowerCase()}`}
      className="flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-60"
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-2">
        {children}
      </span>
      <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
