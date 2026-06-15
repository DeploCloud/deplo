"use client";

import * as React from "react";
import { RefreshCw, CheckCircle2, ArrowUpRight, TriangleAlert } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { checkForUpdatesAction } from "@/lib/actions/updates";
import type { UpdateInfo } from "@/lib/data/updates";

export function UpdateCard({ current }: { current: string }) {
  const [info, setInfo] = React.useState<UpdateInfo | null>(null);
  const [checking, setChecking] = React.useState(false);

  const check = React.useCallback(async () => {
    setChecking(true);
    try {
      const res = await checkForUpdatesAction();
      if (res.ok && res.data) setInfo(res.data);
    } finally {
      setChecking(false);
    }
  }, []);

  // Initial check on mount. setState only fires inside the async callback (not
  // synchronously in the effect body), so it does not cascade renders.
  React.useEffect(() => {
    let active = true;
    checkForUpdatesAction().then((res) => {
      if (active && res.ok && res.data) setInfo(res.data);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Updates</CardTitle>
          <CardDescription>
            Deplo checks the official repository for new releases.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={check}
          disabled={checking}
        >
          <RefreshCw className={checking ? "size-4 animate-spin" : "size-4"} />
          {checking ? "Checking…" : "Check now"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Current version</span>
          <Badge variant="secondary" className="font-mono">
            v{current}
          </Badge>
        </div>

        {info?.updateAvailable ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 p-3">
            <div className="flex items-center gap-2 text-sm">
              <ArrowUpRight className="size-4 text-[var(--success)]" />
              <span>
                <span className="font-medium">{info.latest}</span> is available
              </span>
            </div>
            {info.url && (
              <Button size="sm" asChild>
                <a href={info.url} target="_blank" rel="noopener noreferrer">
                  View release
                </a>
              </Button>
            )}
          </div>
        ) : info?.error ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TriangleAlert className="size-3.5 text-[var(--warning)]" />
            Couldn&apos;t check for updates: {info.error}
          </p>
        ) : info ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-[var(--success)]" />
            You&apos;re on the latest version.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
