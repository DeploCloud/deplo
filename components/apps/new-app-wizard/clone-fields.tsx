"use client";

import * as React from "react";
import { GitBranch, Lock, LockOpen, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import Link from "@/components/ui/link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { GitProviderIcon } from "@/components/shared/brand-icons";
import { repoNameProblem } from "@/lib/git/clone-source";
import { gqlAction } from "@/lib/graphql-client";

import { WizardAlerts } from "./wizard-alerts";
import type { WizardClone, WizardCloneDestination } from "./types";

export interface CloneTarget {
  destinationKey: string;
  repoName: string;
  private: boolean;
}

export function cloneTargetReady(
  clone: WizardClone,
  target: CloneTarget,
): boolean {
  const dest = clone.destinations.find((d) => d.key === target.destinationKey);
  return Boolean(dest && !dest.needs && !repoNameProblem(target.repoName));
}

export function CloneSourceCard({ clone }: { clone: WizardClone }) {
  return (
    <div className="rounded-lg bg-surface p-4">
      <p className="text-sm text-muted-foreground">
        Cloning from {clone.hostLabel}
      </p>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <GitProviderIcon provider={clone.host} className="size-4 shrink-0" />
          <span className="truncate">{clone.fullName}</span>
        </span>
        <span className="flex items-center gap-1.5 font-mono text-sm text-muted-foreground">
          <GitBranch className="size-4" />
          {clone.ref ?? "default branch"}
        </span>
      </div>
      {clone.composeFile && (
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {clone.composeFile}
        </p>
      )}
    </div>
  );
}

function DestinationLabel({ dest }: { dest: WizardCloneDestination }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar className="size-5">
        {dest.avatarUrl && <AvatarImage src={dest.avatarUrl} alt="" />}
        <AvatarFallback>
          <GitProviderIcon provider={dest.provider} className="size-3" />
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{dest.login}</span>
      <span className="text-xs text-muted-foreground">
        {dest.providerLabel}
      </span>
    </span>
  );
}

async function startGithubSignIn(installationId: string) {
  const res = await gqlAction(
    /* GraphQL */ `
      query ($installationId: String!, $returnTo: String) {
        githubSignInUrl(installationId: $installationId, returnTo: $returnTo)
      }
    `,
    {
      installationId,
      returnTo: `${window.location.pathname}${window.location.search}`,
    },
    (d: { githubSignInUrl: string }) => d.githubSignInUrl,
  );
  if (!res.ok || !res.data) {
    if (!res.ok) toast.error(res.error);
    return;
  }
  window.location.assign(res.data);
}

export function CloneFields({
  clone,
  target,
  onChange,
  locked,
}: {
  clone: WizardClone;
  target: CloneTarget;
  onChange: (next: CloneTarget) => void;
  locked: boolean;
}) {
  const [signingIn, startSignIn] = React.useTransition();
  const dest = clone.destinations.find((d) => d.key === target.destinationKey);
  const nameProblem = target.repoName ? repoNameProblem(target.repoName) : null;

  React.useEffect(() => {
    if (clone.signIn === "denied") toast.error("GitHub sign-in was cancelled");
    if (clone.signIn === "error")
      toast.error("GitHub sign-in didn't work. Try again.");
  }, [clone.signIn]);

  if (clone.destinations.length === 0)
    return (
      <>
        <CloneSourceCard clone={clone} />
        <WizardAlerts
          alerts={[
            {
              type: "info",
              content: (
                <>
                  Connect GitHub, GitLab, Bitbucket or Gitea so Deplo can create
                  the repository.{" "}
                  <Link href="/settings/git" className="underline">
                    Connect a Git account
                  </Link>
                </>
              ),
            },
          ]}
        />
      </>
    );

  return (
    <>
      <CloneSourceCard clone={clone} />
      <p className="text-sm text-muted-foreground">
        Deplo creates a repository for you, so every push to it deploys again.{" "}
        <DocsLink topic="deploy.button" />
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <FieldLabel
            htmlFor="clone-scope"
            info="The account or group the new repository belongs to."
          >
            Git account
          </FieldLabel>
          <Select
            value={target.destinationKey}
            onValueChange={(key) =>
              onChange({ ...target, destinationKey: key })
            }
            disabled={locked}
          >
            <SelectTrigger id="clone-scope">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {clone.destinations.map((d) => (
                <SelectItem key={d.key} value={d.key}>
                  <DestinationLabel dest={d} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <FieldLabel
            htmlFor="clone-name"
            info="Letters, digits, dots, dashes and underscores."
          >
            {target.private ? "Private repository name" : "Repository name"}
          </FieldLabel>
          <div className="relative">
            <Input
              id="clone-name"
              value={target.repoName}
              onChange={(e) =>
                onChange({ ...target, repoName: e.target.value })
              }
              placeholder="my-repository"
              className="pr-16"
              disabled={locked}
              aria-invalid={Boolean(nameProblem)}
            />
            <div className="absolute inset-y-0 right-2 flex items-center gap-1">
              {target.private ? (
                <Lock className="size-3.5 text-muted-foreground" />
              ) : (
                <LockOpen className="size-3.5 text-muted-foreground" />
              )}
              <Switch
                checked={target.private}
                onCheckedChange={(on) => onChange({ ...target, private: on })}
                aria-label="Private repository"
                disabled={locked}
              />
            </div>
          </div>
          {nameProblem && (
            <p className="text-xs text-destructive">{nameProblem}</p>
          )}
        </div>
      </div>

      {dest?.needs === "github-sign-in" && dest.installationId && (
        <WizardAlerts
          alerts={[
            {
              type: "info",
              content: (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Sign in to GitHub as {dest.login} once, so Deplo can create
                    the repository in that account.
                  </span>
                  <Button
                    size="sm"
                    disabled={signingIn}
                    onClick={() =>
                      startSignIn(() => startGithubSignIn(dest.installationId!))
                    }
                  >
                    Sign in with GitHub
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
      {dest?.needs === "github-permissions" && (
        <WizardAlerts
          alerts={[
            {
              type: "warning",
              icon: ShieldAlert,
              content: (
                <>
                  Deplo&apos;s GitHub App can&apos;t create repositories yet.
                  Allow Administration and Contents (read and write)
                  {dest.settingsUrl ? (
                    <>
                      {" "}
                      in{" "}
                      <a
                        href={dest.settingsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        its settings
                      </a>
                    </>
                  ) : null}
                  , then accept the change on GitHub.
                </>
              ),
            },
          ]}
        />
      )}
      {clone.unreachable.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not listed, didn&apos;t answer: {clone.unreachable.join(", ")}
        </p>
      )}
    </>
  );
}
