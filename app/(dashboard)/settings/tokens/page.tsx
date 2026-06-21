import { listTokens } from "@/lib/data/tokens";
import { PageHeader } from "@/components/shared/page-header";
import { TokensPanel } from "@/components/settings/tokens-panel";

export const metadata = { title: "Settings · API Tokens" };

export default async function SettingsTokensPage() {
  const tokens = await listTokens();

  return (
    <div className="space-y-6">
      <PageHeader
        title="API Tokens"
        description="Personal access tokens for the Deplo API."
      />
      <TokensPanel tokens={tokens} />
    </div>
  );
}
