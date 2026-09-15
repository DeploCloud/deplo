import Link from "@/components/ui/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { isInstanceAdmin, requireActiveTeamId } from "@/lib/membership";
import { getToken } from "@/lib/data/tokens/listing";
import { listScopeTree } from "@/lib/data/tokens/scope-tree";

import { PageHeader } from "@/components/shared/page-header";
import { TokenEditor } from "@/components/settings/tokens/token-editor";
import { timeAgo } from "@/lib/utils";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings/settings-store";

export async function generateMetadata(
  props: PageProps<"/[team]/settings/tokens/[id]">,
) {
  const { id } = await props.params;
  const token = await getToken(id);
  return {
    title: token ? `Settings · ${token.name}` : "Settings · API tokens",
  };
}

export default async function TokenPage(
  props: PageProps<"/[team]/settings/tokens/[id]">,
) {
  const { id } = await props.params;
  const [token, canGrantInstanceAdmin, tree, activeTeamId] = await Promise.all([
    getToken(id),
    isInstanceAdmin(),
    listScopeTree(),
    requireActiveTeamId(),
  ]);
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
          docs="tokens.overview"
          title={token.name}
          description={
            <>
              <code className="font-mono">{`${token.prefix}${"•".repeat(8)}`}</code>
              {" · created "}
              {timeAgo(token.createdAt)}
              {" · "}
              {token.lastUsedAt
                ? `last used ${timeAgo(token.lastUsedAt)}`
                : "never used"}
            </>
          }
        />
      </div>
      {token.oauthClientName ? (
        <p className="rounded-lg border border-border bg-surface p-3 text-sm text-muted-foreground">
          Created by connecting {token.oauthClientName}. Changes take effect on
          its next call, without connecting it again.
        </p>
      ) : null}
      <TokenEditor
        mode="edit"
        token={token}
        tree={tree}
        activeTeamId={activeTeamId}

        canGrantInstanceAdmin={canGrantInstanceAdmin}
        publicUrl={await instancePublicBaseUrl()}
      />
    </div>
  );
}
