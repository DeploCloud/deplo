"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  ScopePicker,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { useGraphqlMutation } from "@/lib/use-graphql";
import { gqlAction } from "@/lib/graphql-client";
import { scopeLabel } from "@/components/settings/tokens/scope-label";
import { TOKEN_PRESETS, presetIdFor } from "@/lib/token-presets";
import type { Capability } from "@/lib/types";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { ConsentClientDTO } from "@/lib/data/mcp-clients";

const AUTHORIZE = /* GraphQL */ `
  mutation (
    $clientId: String!
    $capabilities: [String!]
    $teamIds: [String!]
    $projectIds: [String!]
    $folderIds: [String!]
    $appIds: [String!]
    $scope: String
    $oauthQuery: String
  ) {
    authorizeMcpClient(
      clientId: $clientId
      capabilities: $capabilities
      teamIds: $teamIds
      projectIds: $projectIds
      folderIds: $folderIds
      appIds: $appIds
      scope: $scope
      oauthQuery: $oauthQuery
    ) {
      redirectUrl
    }
  }
`;

const DENY = /* GraphQL */ `
  mutation ($oauthQuery: String) {
    denyMcpClient(oauthQuery: $oauthQuery) {
      redirectUrl
    }
  }
`;

const SWITCH_TEAM = /* GraphQL */ `
  mutation ($teamId: String!) {
    switchTeam(teamId: $teamId)
  }
`;

/**
 * The consent screen's form. Approving it MINTS an API token, which is why it
 * is the token editor's controls rather than a yes/no button: the person is
 * choosing what a third party may do inside their team, and a screen that only
 * says "Allow" cannot tell them.
 *
 * Defaults to the "MCP & AI agents" preset — written for this threat model, and
 * the reason this is one click for anyone who does not want to think about it.
 */
export function ConsentForm({
  client,
  scope,
  oauthQuery,
  tree,
  activeTeamId,
}: {
  client: ConsentClientDTO;
  scope: string;
  oauthQuery: string;
  tree: ScopeTreeTeam[];
  /** The team the mint will actually use — the dropdown must start here. */
  activeTeamId: string;
}) {
  const router = useRouter();
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
  const [advanced, setAdvanced] = useState(false);
  const [teamId, setTeamId] = useState(activeTeamId);
  const teamName = tree.find((t) => t.id === teamId)?.name;

  const [pending, setPending] = useState(false);
  const switchTeam = useGraphqlMutation(SWITCH_TEAM);

  const presetId = useMemo(() => presetIdFor(capabilities), [capabilities]);
  const preset = TOKEN_PRESETS.find((p) => p.id === presetId);
  const busy = pending || switchTeam.pending;

  const scoped =
    selection.teamIds.length +
      selection.projectIds.length +
      selection.folderIds.length +
      selection.appIds.length >
    0;
  // "Access" is what this repo calls a token's reach and "Permissions" what it
  // calls its capabilities (token-editor.tsx's own summary rows) — same words
  // here, so the two screens do not name one thing twice.
  const accessLabel = scoped
    ? scopeLabel({ scoped: true, ...selection })
    : { text: teamName ?? "This team", empty: false };

  /**
   * `gqlAction`, not `useGraphqlMutation`: its `error` is React state, so
   * reading it straight after the await gets the value from BEFORE the failure —
   * the server's refusal would be swallowed and the button would look inert.
   * The message is surfaced verbatim, as the house rule says.
   */
  async function onApprove(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const picked = selection.teamIds.length
      ? selection
      : { ...selection, teamIds: [teamId] };
    const res = await gqlAction<
      { authorizeMcpClient: { redirectUrl: string } },
      string
    >(
      AUTHORIZE,
      {
        clientId: client.clientId,
        capabilities,
        teamIds: picked.teamIds,
        projectIds: picked.projectIds,
        folderIds: picked.folderIds,
        appIds: picked.appIds,
        scope: scope || null,
        oauthQuery: oauthQuery || null,
      },
      (d) => d.authorizeMcpClient.redirectUrl,
    );
    if (!res.ok || !res.data) {
      setPending(false);
      toast.error(res.ok ? "deplo did not get a redirect back" : res.error);
      return;
    }
    // A full-page navigation, not router.push: the destination is the client's
    // own site, and what answers there is an OAuth redirect.
    window.location.assign(res.data);
  }

  async function onDeny() {
    setPending(true);
    const res = await gqlAction<
      { denyMcpClient: { redirectUrl: string } },
      string
    >(DENY, { oauthQuery: oauthQuery || null }, (d) => d.denyMcpClient.redirectUrl);
    window.location.assign(res.ok && res.data ? res.data : "/settings/mcp");
  }

  return (
    <ConsentShell>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {client.name} wants to connect to deplo
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {client.redirectOrigin
              ? `It will be sent back to ${client.redirectOrigin}. Give it only what it needs.`
              : "Give it only what it needs."}
          </p>
        </CardHeader>
        <CardContent>
          <form className="grid gap-6" onSubmit={onApprove}>
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="consent-team"
                info="The app will act inside this team only. Switch teams to connect it somewhere else."
              >
                Team
              </FieldLabel>
              <Select
                value={teamId}
                onValueChange={(next) => {
                  setTeamId(next);
                  setSelection({
                    teamIds: [],
                    projectIds: [],
                    folderIds: [],
                    appIds: [],
                  });
                  void switchTeam.run({ teamId: next }).then(() => {
                    router.refresh();
                  });
                }}
                disabled={busy}
              >
                <SelectTrigger id="consent-team" className="w-full">
                  <SelectValue placeholder="Pick a team" />
                </SelectTrigger>
                <SelectContent>
                  {tree.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <FieldLabel info="What the app may do, and what it may reach. It can never do more than you can.">
                What it gets
              </FieldLabel>
              <dl className="grid gap-2 rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center gap-3">
                  <dt className="shrink-0 text-muted-foreground">Access</dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-medium">
                    {accessLabel.text}
                  </dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="shrink-0 text-muted-foreground">Permissions</dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-medium">
                    {preset ? preset.name : `${capabilities.length} selected`}
                  </dd>
                </div>
              </dl>
              {preset ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {preset.description}
                </p>
              ) : null}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAdvanced(true)}
                  disabled={busy}
                >
                  Advanced
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onDeny}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !teamId}>
                Authorize
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* The whole permission surface, opened on demand so the default path is
          one dropdown and one button. Access comes first: what an app can REACH
          is the question people answer before what it may DO, and narrowing the
          reach changes which permissions still mean anything. */}
      <Dialog open={advanced} onOpenChange={setAdvanced}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Access and permissions</DialogTitle>
            <DialogDescription className="mt-1">
              What {client.name} can reach, and what it may do there.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              setAdvanced(false);
            }}
          >
            <div className="grid gap-3">
              <FieldLabel info="Tick nothing and it reaches the whole team above. Tick a project, folder or app to narrow it to that.">
                Access
              </FieldLabel>
              <ScopePicker
                tree={tree}
                selection={selection}
                onChange={setSelection}
                info="What this app can reach. Tick nothing and it reaches the whole team you picked."
              />
            </div>

            <div className="grid gap-3">
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="consent-preset"
                  info="A starting set you can then adjust. Custom appears once the ticks stop matching one."
                >
                  Permissions
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

/** Radix needs a value for the "matches no preset" state; it is never chosen. */
const CUSTOM = "custom";
