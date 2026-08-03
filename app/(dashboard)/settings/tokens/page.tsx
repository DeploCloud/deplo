import Link from "next/link";
import { KeyRound, BookOpen, ArrowRight } from "lucide-react";
import { hasCapability } from "@/lib/membership";
import { listTokens } from "@/lib/data/tokens";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Settings · API tokens" };

export default async function TokensIndexPage() {
  const [tokens, canManage] = await Promise.all([
    listTokens(),
    hasCapability("manage_tokens"),
  ]);
  const empty = tokens.length === 0;

  return (
    <div className="space-y-4">
      <EmptyState
        icon={KeyRound}
        title={empty ? "No API tokens yet" : "Pick a token to see what it can do"}
        description={
          empty
            ? canManage
              ? "A token lets a script, a CI job or an assistant call this team's API. Start from one of our templates and give it only the permissions it needs."
              : "Only members who can manage API tokens can create one. Ask a team admin if you need API access."
            : canManage
              ? "Every token is on the left. Open one to change its permissions or its project scope — the secret is unchanged, so tightening a live token costs no rotation."
              : "Every token is on the left. Open one to see exactly what a client holding it can do."
        }
      />

      <Link
        href="/api-docs"
        className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-secondary/40"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
          <BookOpen className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">API reference & playground</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Browse every GraphQL query and mutation, and try read-only calls
            live — mutations run as a safe dry run.
          </p>
        </div>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
