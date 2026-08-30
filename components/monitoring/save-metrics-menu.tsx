"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DocsLink } from "@/components/ui/docs-link";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The instance-wide metrics-history switch, out of the toolbar and behind the
 * header's overflow menu: it is a setting on a page of readings, and every knob
 * on a first screen is a knob the reader has to look past.
 */
export function SaveMetricsMenu({
  initialSaveMetrics,
  canManage,
}: {
  initialSaveMetrics: boolean;
  /** Cosmetic gate; setSaveMetrics enforces `manage_monitoring` itself. */
  canManage: boolean;
}) {
  const [saveMetrics, setSaveMetrics] = React.useState(initialSaveMetrics);
  const [saving, setSaving] = React.useState(false);

  async function toggle(next: boolean) {
    setSaveMetrics(next);
    setSaving(true);
    try {
      const res = await gqlAction<
        { setSaveMetrics: { saveMetrics: boolean } },
        boolean
      >(
        `mutation SetSaveMetrics($enabled: Boolean!) {
          setSaveMetrics(enabled: $enabled) {
            saveMetrics
          }
        }`,
        { enabled: next },
        (d) => d.setSaveMetrics.saveMetrics,
      );
      if (!res.ok) {
        setSaveMetrics(!next);
        toast.error(res.error);
      }
    } finally {
      setSaving(false);
    }
  }

  const control = (
    <Switch
      checked={saveMetrics}
      onCheckedChange={toggle}
      disabled={!canManage || saving}
      aria-label="Save metrics on server"
      className="mt-0.5"
    />
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Monitoring options">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Save metrics on server</p>
            <p className="text-xs text-muted-foreground">
              Charts survive a reload. Off, they start empty every time.
              <DocsLink topic="monitoring.saveMetrics" className="ml-1.5" />
            </p>
          </div>
          {canManage ? (
            control
          ) : (
            // span so the tooltip still fires over the disabled switch
            <SimpleTooltip content="Requires the Manage monitoring capability">
              <span className="mt-0.5 inline-flex">{control}</span>
            </SimpleTooltip>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
