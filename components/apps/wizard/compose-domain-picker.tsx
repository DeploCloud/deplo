"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import type { ComposeRouteCandidate } from "@/lib/deploy/compose-lint";

/**
 * Which services of a hand-written stack get an address. The primary is the one
 * Deplo would pick on its own and is always routed; anything else is a choice,
 * and a database is never pre-selected.
 */
export function ComposeDomainPicker({
  candidates,
  selected,
  onToggle,
}: {
  candidates: ComposeRouteCandidate[];
  selected: string[];
  onToggle: (service: string, on: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-sm font-medium">Domains</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Every service you pick gets its own address.
      </p>
      <div className="mt-3 grid gap-2">
        {candidates.map((c) => (
          <div key={c.name} className="flex items-center gap-2">
            <Checkbox
              id={`route-${c.name}`}
              checked={c.isPrimary || selected.includes(c.name)}
              disabled={c.isPrimary || c.isReserved}
              onCheckedChange={(v) => onToggle(c.name, v === true)}
            />
            <label
              htmlFor={`route-${c.name}`}
              className="min-w-0 flex-1 truncate text-sm"
            >
              {c.name}
              <span className="ml-2 text-xs text-muted-foreground">
                port {c.port}
              </span>
            </label>
            {c.isPrimary && <Badge variant="secondary">Primary</Badge>}
            {c.isReserved ? (
              <Badge variant="outline">Reserved name</Badge>
            ) : (
              c.isDatastore && <Badge variant="outline">Database</Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
