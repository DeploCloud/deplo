import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  hasCapability,
  isInstanceAdmin,
  requireActiveTeamId,
} from "@/lib/membership";
import { getToken, listScopeTree } from "@/lib/data/tokens";

import { PageHeader } from "@/components/shared/page-header";
import { TokenEditor } from "@/components/settings/tokens/token-editor";
import { timeAgo } from "@/lib/utils";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings";

export async function generateMetadata(
  props: PageProps<"/settings/tokens/[id]">,
) {
  const { id } = await props.params;
  const token = await getToken(id);
  return { title: token ? `Settings · ${token.name}` : "Settings · API tokens" };
}

export default async function TokenPage(
  props: PageProps<"/settings/tokens/[id]">,
) {
  const { id } = await props.params;
  const [token, canManage, canGrantInstanceAdmin, tree, activeTeamId] =
    await Promise.all([
      getToken(id),
      hasCapability("manage_tokens"),
      isInstanceAdmin(),
      listScopeTree(),
      requireActiveTeamId(),
    ]);
  // Someone else's token, in a team you're not in, resolves to nothing here -
  // exactly as it does in the data layer. There is no id to guess your way into.
  if (!token) notFound();
  // Your own token, opened from another team: it is REVOKABLE here but not
  // editable, because re-authoring it is bounded by what you may do in the team
  // it acts in (`updateToken`). Say so instead of failing on Save.
  const managedHere = token.homeTeamId === activeTeamId;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/settings/tokens"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          All tokens
        </Link>
        <PageHeader
          title={token.name}
          description={
            <>
              <code className="font-mono">{`${token.prefix}${"•".repeat(8)}`}</code>
              {" · created "}
              {timeAgo(token.createdAt)}
              {token.createdByUsername ? ` by ${token.createdByUsername}` : ""}
              {" · "}
              {token.lastUsedAt
                ? `last used ${timeAgo(token.lastUsedAt)}`
                : "never used"}
            </>
          }
        />
      </div>
      {token.oauthClientName && managedHere ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          This token was created by connecting {token.oauthClientName}. Change
          what it can do under{" "}
          <Link
            href="/settings/mcp"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Settings → MCP Server
          </Link>
          .
        </p>
      ) : null}
      {!managedHere ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          This token is managed in {token.homeTeamName || "another team"}. You
          can revoke it here, but not change what it does.
        </p>
      ) : null}
      <TokenEditor
        mode="edit"
        token={token}
        tree={tree}
        activeTeamId={activeTeamId}
        canManage={canManage}
        // A connection's permissions are chosen on the consent screen and
        // changed by connecting again, so this form is read-only for one: two
        // editors over one credential is how the two drift apart. Same for a
        // token managed in another team. Revoking stays available in both
        // cases: it is the lever that must never be a dead end.
        canEdit={canManage && !token.oauthClientName && managedHere}
        canGrantInstanceAdmin={canGrantInstanceAdmin}
        publicUrl={await instancePublicBaseUrl()}
      />
    </div>
  );
}
