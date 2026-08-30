import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getOAuthClientForConsent,
  listConnectableTeamIds,
} from "@/lib/data/mcp-clients";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { listScopeTree } from "@/lib/data/tokens";
import { hasCapability, requireActiveTeamId } from "@/lib/membership";
import { rebuildOauthQuery } from "@/lib/auth/oauth-query";
import { publicBaseUrl } from "@/lib/public-url";
import { ConsentForm } from "@/components/oauth/consent-form";
import { ConsentRefusal } from "@/components/oauth/consent-refusal";

/**
 * The OAuth consent screen - deplo's half of connecting an AI client. It is a
 * token-minting form, because approving it mints a real API token.
 */
export default async function OAuthConsentPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await props.searchParams;
  const clientId = typeof params.client_id === "string" ? params.client_id : "";
  const scope = typeof params.scope === "string" ? params.scope : "";

  // Must survive the round trip byte for byte - see `rebuildOauthQuery`.
  const oauthQuery = rebuildOauthQuery(params);

  if (!clientId) redirect("/settings/mcp");

  // Refusing to render without the provider's signature is not the security boundary -
  // the consent endpoint verifies it for real (and its expiry), and the mint
  // requires the record that endpoint writes.
  if (typeof params.sig !== "string" || !params.sig)
    return (
      <ConsentRefusal
        title="This approval link isn't valid"
        detail="Start the connection again from the app you were using."
      />
    );

  const publicOrigin = publicBaseUrl();

  const client = await getOAuthClientForConsent(clientId);
  if (!client)
    return (
      <ConsentRefusal
        title="That app isn't registered"
        detail="The connection request didn't name an app deplo knows. Start the connection again from the app you were using."
      />
    );

  const [
    canManageMcp,
    canManageTokens,
    settings,
    tree,
    activeTeamId,
    connectableTeamIds,
  ] = await Promise.all([
    hasCapability("manage_mcp"),
    hasCapability("manage_tokens"),
    getMcpSettings(),
    listScopeTree(),
    // The form MUST start on the active team, not on the first one in the
    // tree: the mint resolves the team from the session, so a dropdown showing
    // anything else would connect the client somewhere the person never read.
    requireActiveTeamId(),
    // What the scope picker starts ticked. Only the teams the mint would
    // actually accept - ticking one it refuses is a failed Authorize, not a
    // connection.
    listConnectableTeamIds(),
  ]);

  if (!canManageMcp || !canManageTokens)
    return (
      <ConsentRefusal
        clientName={client.name}
        title="You can't connect an app to this team"
        detail="Connecting an AI client needs permission to manage MCP access and to manage API tokens. Ask a team admin to grant them, or to make the connection."
      />
    );

  if (!settings.enabled)
    return (
      <ConsentRefusal
        clientName={client.name}
        title="This team has turned off MCP access"
        detail="An admin can switch it back on under Settings → MCP Server."
      />
    );

  return (
    <ConsentForm
      client={client}
      scope={scope}
      oauthQuery={oauthQuery}
      tree={tree}
      activeTeamId={activeTeamId}
      connectableTeamIds={connectableTeamIds}
      publicOrigin={publicOrigin}
      username={user.name || user.username}
    />
  );
}
