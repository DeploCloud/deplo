"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, CheckCircle2, ExternalLink } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { GithubConnectButton } from "@/components/apps/github-connect-button";
import { gqlAction } from "@/lib/graphql-client";
import type { GithubAppDTO } from "@/lib/data/github";

const GIT_FEEDBACK: Record<string, { ok: boolean; msg: string }> = {
  connected: { ok: true, msg: "GitHub App connected" },
  error: { ok: false, msg: "GitHub connection failed. Please try again." },
  state_error: {
    ok: false,
    msg: "GitHub connection expired or was tampered with. Try again.",
  },
};

export function GithubPanel({
  apps,
  gitStatus,
}: {
  apps: GithubAppDTO[];
  gitStatus?: string;
}) {
  const router = useRouter();
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  // One-shot feedback from the OAuth-style redirect (?git=connected|error).
  React.useEffect(() => {
    if (!gitStatus) return;
    const fb = GIT_FEEDBACK[gitStatus];
    if (fb) (fb.ok ? toast.success : toast.error)(fb.msg);
    router.replace("/settings/git", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <GitHubIcon className="size-4" />
            GitHub
            <InfoTip content="Connect a GitHub App to deploy from your repositories. Deplo creates the App for you with only the permissions it needs, then you choose which repositories to grant access to." />
          </CardTitle>
        </div>
        <GithubConnectButton
          size="sm"
          label={apps.length ? "Connect another" : "Connect GitHub"}
        />
      </CardHeader>
      <CardContent>
        {apps.length === 0 ? (
          <EmptyState
            icon={GitHubIcon}
            title="No GitHub App connected"
            description="Connect a GitHub App to import and auto-deploy your repositories."
          />
        ) : (
          <div className="space-y-3">
            {apps.map((app) => (
              <div
                key={app.id}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {app.name}
                      <a
                        href={app.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label="Open on GitHub"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {app.installations.length} installation
                      {app.installations.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteId(app.id)}
                    aria-label="Remove GitHub App"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                {app.installations.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {app.installations.map((inst) => (
                      <Badge
                        key={inst.id}
                        variant="secondary"
                        className="gap-1.5"
                      >
                        <CheckCircle2 className="size-3 text-[var(--success)]" />
                        {inst.accountLogin}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Remove GitHub App?"
        description="Apps importing from this App will stop auto-deploying and private clones will fail until you reconnect."
        confirmLabel="Remove"
        successMessage="GitHub App removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation ($id: String!) { removeGithubApp(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </Card>
  );
}
