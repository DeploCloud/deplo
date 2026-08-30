"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { FileText } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { ComposeEditor } from "@/components/apps/compose-editor";
import { ComposeLintSummary } from "@/components/apps/compose-lint-summary";
import {
  hasBlockingErrors,
  type LintDiagnostic,
} from "@/lib/deploy/compose-lint";

/**
 * The compose stack, written full-size. The wizard card keeps its own height by
 * holding only a summary; the actual writing happens here.
 */
export function ComposeDialog({
  open,
  onOpenChange,
  value,
  onSave,
  title = "Docker Compose",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onSave: (compose: string, diagnostics: LintDiagnostic[]) => void;
  title?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        {/* The body mounts with the dialog, so each opening starts from what the
            card holds and a cancelled edit leaves nothing behind. */}
        <ComposeBody
          value={value}
          title={title}
          onCancel={() => onOpenChange(false)}
          onSave={(compose, diagnostics) => {
            onSave(compose, diagnostics);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ComposeBody({
  value,
  title,
  onCancel,
  onSave,
}: {
  value: string;
  title: string;
  onCancel: () => void;
  onSave: (compose: string, diagnostics: LintDiagnostic[]) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  const [diagnostics, setDiagnostics] = React.useState<LintDiagnostic[]>([]);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FileText className="size-4" />
          {title}
        </DialogTitle>
        <DialogDescription>
          Deplo folds in routing, variables and volumes, then brings this up as
          written. <DocsLink topic="compose.overview" />
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <ComposeEditor
          value={draft}
          onChange={setDraft}
          onDiagnostics={setDiagnostics}
          minHeight={420}
        />
        <ComposeLintSummary diagnostics={diagnostics} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={hasBlockingErrors(diagnostics)}
          onClick={() => onSave(draft, diagnostics)}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
