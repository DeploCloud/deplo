"use client";

import * as React from "react";
import { ExternalLink, GitPullRequest, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { gqlAction } from "@/lib/graphql-client";

export type PullRequest = { number: number; url: string };

// The fix as a pull request on the app's repository, or the link to it once opened.
export function PullRequestButton({
  appId,
  packageName,
  pullRequest,
  onOpened,
}: {
  appId: string;
  packageName: string;
  pullRequest: PullRequest | null;
  onOpened: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [accessUrl, setAccessUrl] = React.useState<string | null>(null);

  if (pullRequest)
    return (
      <Button size="sm" variant="ghost" asChild>
        <a href={pullRequest.url} target="_blank" rel="noopener noreferrer">
          <GitPullRequest />
          Pull request #{pullRequest.number}
        </a>
      </Button>
    );

  function open() {
    startTransition(async () => {
      const res = await gqlAction<{
        openSecurityPullRequest: {
          number: number | null;
          accessUrl: string | null;
        };
      }>(
        `mutation($appId: ID!, $packageName: String!) {
           openSecurityPullRequest(appId: $appId, packageName: $packageName) { number url accessUrl }
         }`,
        { appId, packageName },
      );
      if (!res.ok) return void toast.error(res.error);
      const opened = res.data?.openSecurityPullRequest;
      if (opened?.accessUrl) return setAccessUrl(opened.accessUrl);
      toast.success(`Opened pull request #${opened?.number}`);
      onOpened();
    });
  }

  return (
    <>
      <Button size="sm" variant="ghost" disabled={pending} onClick={open}>
        {pending ? <Loader2 className="animate-spin" /> : <GitPullRequest />}
        {pending ? "Opening pull request" : "Open pull request"}
      </Button>
      <Dialog open={!!accessUrl} onOpenChange={(o) => !o && setAccessUrl(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Let Deplo open pull requests</DialogTitle>
            <DialogDescription>
              Deplo&apos;s GitHub App needs write access to this repository.
              Allow it on GitHub, then try again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAccessUrl(null)}>
              Cancel
            </Button>
            <Button asChild>
              <a
                href={accessUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                Allow on GitHub
                <ExternalLink />
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
