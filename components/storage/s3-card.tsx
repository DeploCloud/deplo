"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, PlugZap, Trash2, Cloud } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusBadge } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { S3DestinationDTO } from "@/lib/data/s3";

const PROVIDER_LABEL: Record<string, string> = {
  aws: "Amazon S3",
  "cloudflare-r2": "Cloudflare R2",
  "backblaze-b2": "Backblaze B2",
  digitalocean: "DigitalOcean Spaces",
  wasabi: "Wasabi",
  minio: "MinIO",
  other: "S3-compatible",
};

/** Menu-primitive set so the actions render once for both the ⋯ dropdown and the
 *  right-click context menu (see the note in service-card.tsx). */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
};

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};
const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};

export function S3Card({ dest }: { dest: S3DestinationDTO }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  function test() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($id: String!) { testS3(id: $id) { id } }`,
        { id: dest.id },
      );
      if (res.ok) {
        toast.success("Connection verified");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // The destination's actions, rendered once for whichever menu primitive is
  // passed — the ⋯ dropdown and the right-click context menu share these items
  // and handlers. Each item carries a native `title` like the project card.
  const menu = (K: MenuKit) => (
    <>
      <SimpleTooltip
        content="Verify this destination's credentials and reachability"
        side="left"
      >
        <K.Item onClick={test} disabled={pending}>
          <PlugZap className="size-4" />
          Test connection
        </K.Item>
      </SimpleTooltip>
      <K.Separator />
      <SimpleTooltip
        content="Remove this destination — bucket contents are not affected"
        side="left"
      >
        <K.Item
          variant="destructive"
          onSelect={(e: Event) => {
            e.preventDefault();
            setConfirmOpen(true);
          }}
        >
          <Trash2 className="size-4" />
          Remove
        </K.Item>
      </SimpleTooltip>
    </>
  );

  const cardInner = (
    <Card onContextMenu={(e) => e.stopPropagation()}>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-secondary">
              <Cloud className="size-5" />
            </div>
            <div>
              <p className="font-medium">{dest.name}</p>
              <p className="text-xs text-muted-foreground">
                {PROVIDER_LABEL[dest.provider] ?? dest.provider}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={dest.status} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Destination menu">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {menu(DROPDOWN_KIT)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Bucket</dt>
            <dd className="font-mono">{dest.bucket}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Region</dt>
            <dd className="font-mono">{dest.region}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Endpoint</dt>
            <dd className="truncate font-mono">{dest.endpoint}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Access key</dt>
            <dd className="font-mono">{dest.accessKeyMasked}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Added</dt>
            <dd>{timeAgo(dest.createdAt)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{cardInner}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">{menu(CONTEXT_KIT)}</ContextMenuContent>

      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Remove ${dest.name}?`}
        description="Backups configured to use this destination will stop running. Your bucket contents are not affected."
        confirmLabel="Remove destination"
        successMessage="Destination removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation ($id: String!) { deleteS3(id: $id) }`,
            { id: dest.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </ContextMenu>
  );
}
