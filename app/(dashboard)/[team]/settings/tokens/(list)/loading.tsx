import { PageHeader } from "@/components/shared/page-header";
import { NewTokenMenu } from "@/components/settings/tokens/new-token-menu";
import { TokensListSkeleton } from "@/components/settings/tokens/tokens-list";

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <PageHeader
        docs="tokens.overview"
        title="API tokens"
        description="Your personal tokens that let scripts, CI jobs and AI agents call the API. Each one carries its own permissions."
        actions={<NewTokenMenu />}
      />
      <TokensListSkeleton />
    </div>
  );
}
