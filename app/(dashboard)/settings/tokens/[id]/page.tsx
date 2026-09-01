import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  hasCapability,
  isInstanceAdmin,
  requireActiveTeamId,
} from "@/lib/membership";
import { requireUser } from "@/lib/auth";
import { getToken, listScopeTree } from "@/lib/data/tokens";

import { PageHeader } from "@/components/shared/page-header";
import { UserAvatar } from "@/components/shared/user-avatar";
import { TokenEditor } from "@/components/settings/tokens/token-editor";

import { instancePublicBaseUrl } from "@/lib/data/instance-settings";
import { TimeAgo } from "@/components/shared/time-ago";

export async function generateMetadata(
  props: PageProps<"/settings/tokens/[id]">,
) {
  const { id } = await props.params;
  const token = await getToken(id);
  return {
    title: token ? `Settings · ${token.name}` : "Settings · API tokens",
  };
}

export default async function TokenPage(
  props: PageProps<"/settings/tokens/[id]">,
) {
  const { id } = await props.params;
  const [token, user, canManage, canGrantInstanceAdmin, tree, activeTeamId] =
    await Promise.all([
      getToken(id),
      requireUser(),
      hasCapability("manage_tokens"),
      isInstanceAdmin(),
      listScopeTree(),
      requireActiveTeamId(),
    ]);
  // Someone else's token, in a team you're not in, resolves to nothing here -
  // exactly as it does in the data layer. There is no id to guess your way into.
  if (!token) notFound();
  // SOMEONE ELSE's token is editable only from the team it was created in:
  // re-authoring it is bounded by what you may do there (`updateToken`).
  const editableHere =
    token.createdByUserId === user.id || token.homeTeamId === activeTeamId;
  const canEdit = canManage && editableHere;

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
          docs="tokens.overview"
          title={token.name}
          description={
            <>
              <code className="font-mono">{`${token.prefix}${"•".repeat(8)}`}</code>
              {" · created "}
              <TimeAgo at={token.createdAt} />
              {token.createdByUsername ? (
                <>
                  {" by "}
                  <UserAvatar
                    username={token.createdByUsername}
                    avatarColor={token.createdByAvatarColor}
                    avatarUrl={token.createdByAvatarUrl}
                    size="xs"
                    className="inline-block align-text-bottom"
                  />{" "}
                  {token.createdByUsername}
                </>
              ) : (
                ""
              )}
              {" · "}
              {token.lastUsedAt ? (
                <>
                  last used <TimeAgo at={token.lastUsedAt} />
                </>
              ) : (
                "never used"
              )}
            </>
          }
        />
      </div>
      {token.oauthClientName ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Created by connecting {token.oauthClientName}.{" "}
          {canEdit
            ? "Changes take effect on its next call, without connecting it again."
            : "It is also listed under Settings → MCP Server."}
        </p>
      ) : null}
      {!editableHere ? (
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
        // An OAuth connection edits here like any other token: approving the consent screen
        // mints an ordinary row and re-approving DELETES it for a fresh one, so there is
        // never a second copy of the permissions to drift from this one.
        canEdit={canEdit}
        canGrantInstanceAdmin={canGrantInstanceAdmin}
        publicUrl={await instancePublicBaseUrl()}
      />
    </div>
  );
}
