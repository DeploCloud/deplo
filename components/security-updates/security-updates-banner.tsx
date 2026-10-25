"use client";

import * as React from "react";
import { ShieldAlert } from "lucide-react";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { RedeployButton } from "@/components/apps/redeploy-button";
import { UpdateDatabaseButton } from "./update-database-button";
import { plural } from "@/lib/utils";
import { SecurityUpdatesDialog } from "./security-updates-dialog";

export interface BannerProps {
  name: string;
  count: number;
  exploited: number;
  // How the top fix is applied from here: a redeploy, a newer version, or nothing.
  action: "update" | "newer_tag" | null;
  newerTag: string | null;
  appId?: string;
  slug?: string;
  databaseId?: string;
  canIgnore?: boolean;
}

export function SecurityUpdatesBanner(p: BannerProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-wash-strong px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5 text-sm">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <p className="font-medium">
            {plural(p.count, "security update", "security updates")} available
          </p>
          <p className="text-muted-foreground">
            {p.exploited
              ? `${p.exploited === 1 ? "1 is" : `${p.exploited} are`} already being used in attacks.`
              : p.count === 1
                ? "Apply it to close a known security flaw."
                : "Apply them to close known security flaws."}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {p.action === "update" && p.appId && p.slug ? (
          <RedeployButton
            appId={p.appId}
            slug={p.slug}
            label="Update"
            pendingLabel="Updating"
            hint="Redeploy to pull the newer build of the image"
          />
        ) : p.action === "update" && p.databaseId ? (
          <UpdateDatabaseButton id={p.databaseId} name={p.name} />
        ) : p.action === "newer_tag" && p.slug && p.newerTag ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/apps/${p.slug}/settings/deployments`}>
              Use {p.newerTag}
            </Link>
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Details
        </Button>
      </div>
      <SecurityUpdatesDialog
        open={open}
        onOpenChange={setOpen}
        appId={p.appId}
        databaseId={p.databaseId}
        name={p.name}
        canIgnore={p.canIgnore}
      />
    </div>
  );
}
