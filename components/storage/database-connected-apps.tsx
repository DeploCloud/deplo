"use client";

import * as React from "react";
import { Plus, Unlink } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "@/lib/nav";
import Link from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { AppLogo } from "@/components/shared/project-logo";
import { EmptyState } from "@/components/shared/empty-state";
import {
  connectedToast,
  DatabaseLinkForm,
} from "@/components/storage/database-link-form";
import { gqlAction } from "@/lib/graphql-client";
import { DEFAULT_LINK_KEY, reachable } from "@/lib/databases/link";
import type { AppLinkOption, DatabaseAppLink } from "@/lib/data/database-links";
import type { DatabaseType } from "@/lib/types/database";

export function DatabaseConnectedApps({
  databaseId,
  databaseName,
  databaseType,
  links,
  apps,
}: {
  databaseId: string;
  databaseName: string;
  databaseType: DatabaseType;
  links: DatabaseAppLink[];
  apps: AppLinkOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [unlinking, startUnlink] = React.useTransition();

  // Unlink keeps each variable's current value, so it needs no confirmation.
  function unlink(link: DatabaseAppLink) {
    startUnlink(async () => {
      const res = await gqlAction(
        /* GraphQL */ `
          mutation ($appId: String!, $databaseId: String!) {
            disconnectDatabase(appId: $appId, databaseId: $databaseId)
          }
        `,
        { appId: link.appId, databaseId },
      );
      if (!res.ok) return void toast.error(res.error);
      toast.success(`${link.appName} no longer follows ${databaseName}`, {
        description: "Its variables keep their current value.",
      });
      router.refresh();
    });
  }

  const byApp = new Map<string, DatabaseAppLink[]>();
  for (const l of links) byApp.set(l.appId, [...(byApp.get(l.appId) ?? []), l]);
  const connectedKeys = (appId: string) =>
    (byApp.get(appId) ?? []).map((l) => l.key);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Connected apps</CardTitle>
        {apps.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            Connect app
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {byApp.size === 0 ? (
          <p className="text-sm text-muted-foreground">
            No app gets this database&apos;s connection string from Deplo yet.
          </p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {[...byApp.values()].map((group) => {
              const first = group[0];
              return (
                <div
                  key={first.appId}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <AppLogo logo={first.appLogo} size={28} />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/apps/${first.appSlug}/environment`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {first.appName}
                    </Link>
                    {first.canManage && (
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {group.map((l) => l.key).join(", ")}
                      </p>
                    )}
                  </div>
                  {!reachable(first.reach) && (
                    <SimpleTooltip
                      content={`${first.appName} cannot reach this database, so its next deploy fails until one of them moves.`}
                    >
                      <Badge
                        variant="outline"
                        className="text-[10px] font-normal whitespace-nowrap text-destructive"
                      >
                        Unreachable
                      </Badge>
                    </SimpleTooltip>
                  )}
                  {first.canManage && (
                    <SimpleTooltip content="Unlink">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Unlink ${first.appName}`}
                        disabled={unlinking}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => unlink(first)}
                      >
                        <Unlink className="size-4" />
                      </Button>
                    </SimpleTooltip>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          selfManaged
          className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        >
          <DialogHeader className="px-6 pt-6 pb-4">
            <DialogTitle>Connect app</DialogTitle>
            <DialogDescription>
              The app gets <strong>{databaseName}</strong>&apos;s connection
              string as a variable.
            </DialogDescription>
          </DialogHeader>
          <DatabaseLinkForm
            noun="app"
            bodyClassName="max-h-[calc(85vh-12rem)] border-t border-border"
            targets={apps.map((a) => ({
              id: a.id,
              name: a.name,
              logo: <AppLogo logo={a.logo} size={28} />,
              place: a.place,
              reach: a.reach,
              defaultKey: DEFAULT_LINK_KEY[databaseType],
              takenKeys: a.keys,
              connectedKeys: connectedKeys(a.id),
            }))}
            empty={
              <EmptyState
                title="No apps"
                description="You can't edit the variables of any app in this team."
                className="py-10"
              />
            }
            onCancel={() => setOpen(false)}
            onConnect={async (appId, key) => {
              const res = await gqlAction(
                /* GraphQL */ `
                  mutation (
                    $appId: String!
                    $databaseId: String!
                    $key: String!
                  ) {
                    connectDatabase(
                      appId: $appId
                      databaseId: $databaseId
                      key: $key
                    )
                  }
                `,
                { appId, databaseId, key },
              );
              if (res.ok) {
                setOpen(false);
                connectedToast(
                  `Connected to ${apps.find((a) => a.id === appId)?.name}`,
                  appId,
                );
                router.refresh();
              }
              return res;
            }}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
