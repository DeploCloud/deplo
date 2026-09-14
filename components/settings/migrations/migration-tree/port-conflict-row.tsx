"use client";

import { TriangleAlert } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import type { Placement, PlanService } from "../types";

// PortConflict is a database's host port already taken on the server it lands on.
export interface PortConflict {
  takenPort: number;
  serverName: string;
  // The port chosen RIGHT NOW is itself taken, so the import cannot start.
  invalid: boolean;
}

// PortConflictRow is the one choice here that is not about WHERE, but about what a database answers on.
export function PortConflictRow({
  service,
  conflict,
  port,
  onPlace,
}: {
  service: PlanService;
  conflict: PortConflict;
  port: number | null;
  onPlace: (patch: Partial<Placement>) => void;
}) {
  const exposed = port != null;
  const portField = `imp-port-${service.sourceId}`;
  const toggleField = `imp-expose-${service.sourceId}`;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-warning-wash-strong py-2 pr-3 text-xs text-warning"
      style={{ paddingLeft: `${0.75 + 3 * 1.25}rem` }}
    >
      <span className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">
          Port {conflict.takenPort} is taken on {conflict.serverName}.
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:ml-auto">
        <span className="flex items-center gap-2">
          <Checkbox
            id={toggleField}
            checked={exposed}
            // Back ON means back to what the source published, which the review
            // finds a free port for again - so there is no stale "last port" here.
            onCheckedChange={(v) =>
              onPlace({
                exposedPort:
                  v === true
                    ? (service.exposedPort ?? conflict.takenPort)
                    : null,
              })
            }
          />
          <label
            htmlFor={toggleField}
            className="cursor-pointer text-foreground"
          >
            Expose publicly
          </label>
        </span>
        {exposed && (
          <span className="flex items-center gap-2">
            {/* `text-xs` on purpose: `Label` is `text-sm`, a size bigger than
                the sentence it sits in. One row, one type size. */}
            <FieldLabel
              htmlFor={portField}
              className="text-xs"
              info="The port on the server clients connect to. Use a free unprivileged port (1024-65535)."
              docs="databases.hostPort"
            >
              Host port
            </FieldLabel>
            <Input
              id={portField}
              type="number"
              inputMode="numeric"
              min={1024}
              max={65535}
              value={port ?? ""}
              aria-invalid={conflict.invalid || undefined}
              onChange={(e) => {
                const n = Number(e.target.value);
                const next = Number.isInteger(n) && n > 0 ? n : null;
                // Emptying the box IS "publish nothing", and the checkbox says so
                // by going off.
                onPlace({ exposedPort: next });
              }}
              className="h-8 w-24"
            />
          </span>
        )}
      </span>
    </div>
  );
}
