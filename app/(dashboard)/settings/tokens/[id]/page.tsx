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
  // A token of another team resolves to nothing here, exactly as it does in the
  // data layer — there is no id to guess your way into.
  if (!token) notFound();

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
      {token.oauthClientName ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          This token was created by connecting {token.oauthClientName}. Change
          what it can do, or revoke it, under{" "}
          <Link
            href="/settings/mcp"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Settings → MCP Server
          </Link>
          .
        </p>
      ) : null}
      <TokenEditor
        mode="edit"
        token={token}
        tree={tree}
        activeTeamId={activeTeamId}
        // A connection's permissions are chosen on the consent screen and
        // changed by connecting again, so this form is read-only for one: two
        // editors over one credential is how the two drift apart. Revoking
        // still works from the list and from Settings → MCP.
        canManage={canManage && !token.oauthClientName}
        canGrantInstanceAdmin={canGrantInstanceAdmin}
        publicUrl={await instancePublicBaseUrl()}
      />
    </div>
  );
}
