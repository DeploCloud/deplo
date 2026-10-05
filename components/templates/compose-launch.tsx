"use client";

import * as React from "react";
import { ChevronDown, FileCode2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { useRouter } from "@/lib/nav";
import { cn } from "@/lib/utils";

const SUBMIT_URL = "https://github.com/DeploCloud/templates";

/** Any compose file by its link: /new loads it the way it loads a template. */
export function ComposeLaunch({
  canDeploy,
  className,
}: {
  canDeploy: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [bad, setBad] = React.useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const link = url.trim();
    if (!/^https:\/\/\S+$/i.test(link)) return setBad(true);
    router.push(`/new?compose=${encodeURIComponent(link)}`);
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {canDeploy && (
          <Button
            variant="outline"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <FileCode2 className="size-4" />
            Deploy a compose file
            <ChevronDown
              className={cn(
                "size-4 transition-transform",
                open && "rotate-180",
              )}
            />
          </Button>
        )}
        <Button variant="ghost" asChild>
          <a href={SUBMIT_URL} target="_blank" rel="noreferrer noopener">
            <GitHubIcon className="size-4" />
            Submit a template
          </a>
        </Button>
      </div>
      {open && (
        <form noValidate onSubmit={onSubmit} className="flex max-w-md gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <Input
              autoFocus
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setBad(false);
              }}
              placeholder="https://acme.com/docker-compose.yml"
              aria-label="Compose file link"
              aria-invalid={bad}
            />
            {bad && (
              <p role="alert" className="text-xs text-destructive">
                That is not an https link to a compose file.
              </p>
            )}
          </div>
          <Button type="submit" disabled={!url.trim()}>
            Deploy
          </Button>
        </form>
      )}
    </div>
  );
}
