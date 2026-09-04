import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getOAuthClientForConsent,
  listConnectableTeamIds,
} from "@/lib/data/mcp-clients";
import { listScopeTree } from "@/lib/data/tokens";
import { requireActiveTeamId } from "@/lib/membership";
import { rebuildOauthQuery } from "@/lib/auth/oauth-query";
import { publicBaseUrl } from "@/lib/public-url";
import { ConsentForm } from "@/components/oauth/consent-form";
import { ConsentRefusal } from "@/components/oauth/consent-refusal";

/**
 * The OAuth consent screen - Deplo's half of connecting an AI client. It is a
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
        detail="The connection request didn't name an app Deplo knows. Start the connection again from the app you were using."
      />
    );

  const [tree, activeTeamId, connectableTeamIds] = await Promise.all([
    listScopeTree(),
    requireActiveTeamId(),
    // The teams an unscoped connection will act in: where this person may
    // connect agents and MCP is on. Named on the form, so Authorize is read.
    listConnectableTeamIds(),
  ]);

  if (connectableTeamIds.length === 0)
    return (
      <ConsentRefusal
        clientName={client.name}
        title="You can't connect an app to any of your teams"
        detail="Connecting an AI client needs the permission to connect AI agents in a team that has MCP turned on. Ask a team admin."
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
