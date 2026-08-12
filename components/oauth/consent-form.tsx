"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/info-tip";
import { ConsentShell } from "@/components/oauth/consent-shell";
import { PermissionPicker } from "@/components/settings/permission-picker";
import {
  ScopePicker,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { useGraphqlMutation } from "@/lib/use-graphql";
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

  const authorize = useGraphqlMutation<{
    authorizeMcpClient: { redirectUrl: string };
  }>(AUTHORIZE, { refresh: false });
  const deny = useGraphqlMutation<{ denyMcpClient: { redirectUrl: string } }>(
    DENY,
    { refresh: false },
  );
  const switchTeam = useGraphqlMutation(SWITCH_TEAM);

  const presetId = useMemo(() => presetIdFor(capabilities), [capabilities]);
  const presetName =
    TOKEN_PRESETS.find((p) => p.id === presetId)?.name ?? "Custom";
  const busy = authorize.pending || deny.pending || switchTeam.pending;

  async function onApprove(e: React.FormEvent) {
    e.preventDefault();
    const picked = selection.teamIds.length
      ? selection
      : { ...selection, teamIds: [teamId] };
    const res = await authorize.run({
      clientId: client.clientId,
      capabilities,
      teamIds: picked.teamIds,
      projectIds: picked.projectIds,
      folderIds: picked.folderIds,
      appIds: picked.appIds,
      scope: scope || null,
      oauthQuery: oauthQuery || null,
    });
    // A full-page navigation, not router.push: the destination is the client's
    // own site, and the response that follows is an OAuth redirect.
    if (res) window.location.assign(res.authorizeMcpClient.redirectUrl);
    else if (authorize.error) toast.error(authorize.error);
  }

  async function onDeny() {
    const res = await deny.run({ oauthQuery: oauthQuery || null });
    if (res) window.location.assign(res.denyMcpClient.redirectUrl);
    else window.location.assign("/settings/mcp");
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
              <FieldLabel info="What the app may do in this team. It can never do more than you can.">
                Access
              </FieldLabel>
              <p className="text-sm text-muted-foreground">
                {presetName}
                {presetId === "mcp"
                  ? " — reads the team and restarts or redeploys an app, with nothing that can leak a secret or destroy data."
                  : ""}
              </p>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAdvanced((v) => !v)}
                  disabled={busy}
                >
                  {advanced ? "Hide advanced" : "Advanced"}
                </Button>
              </div>
            </div>

            {advanced ? (
              <div className="grid gap-6">
                <PermissionPicker
                  capabilities={capabilities}
                  onChange={setCapabilities}
                  disabled={busy}
                  hint="Tick exactly what this app should be able to do. Secrets can never be read over MCP, whatever is ticked here."
                />
                <ScopePicker
                  tree={tree}
                  selection={selection}
                  onChange={setSelection}
                  disabled={busy}
                  info="What the app can reach. Tick nothing and it reaches the whole team you picked above."
                />
              </div>
            ) : null}

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
    </ConsentShell>
  );
}
