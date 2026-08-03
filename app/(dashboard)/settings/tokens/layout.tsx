import { hasCapability } from "@/lib/membership";
import { listTokens } from "@/lib/data/tokens";
import { PageHeader } from "@/components/shared/page-header";
import { TokensRail } from "@/components/settings/tokens/tokens-rail";

/**
 * API tokens is a master-detail section, exactly like Roles — and for the same
 * reason: a token now carries its own forty-permission set, which is a page to
 * edit, not a dialog. The rail lives here so navigating between tokens never
 * re-renders it.
 */
export default async function TokensLayout({
  children,
}: LayoutProps<"/settings/tokens">) {
  const [tokens, canManage] = await Promise.all([
    listTokens(),
    hasCapability("manage_tokens"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="API tokens"
        description="Tokens that let scripts, CI jobs and other clients drive this team over the API. Each one carries its own permissions."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(220px,280px)_1fr]">
        <TokensRail tokens={tokens} canManage={canManage} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
