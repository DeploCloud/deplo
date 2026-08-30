"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import {
  isValidExposePort,
  MIN_USER_PORT,
  MAX_PORT,
} from "@/lib/databases/ports";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * Publishing a database's port lives on the Overview AND in Settings, so the
 * rules live here and only the arrangement differs.
 * https://deplo.build/docs/guides/data/databases
 */
export function useDatabaseExposure(db: DatabaseDTO) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [exposed, setExposed] = React.useState(db.exposedPublicly);
  const [port, setPort] = React.useState(
    db.exposedPort ? String(db.exposedPort) : "",
  );
  const [generating, setGenerating] = React.useState(false);

  const parsedPort = Number.parseInt(port, 10);
  const portValid = isValidExposePort(parsedPort);
  const dirty =
    exposed !== db.exposedPublicly ||
    (exposed && parsedPort !== db.exposedPort);
  const ready = !exposed || portValid;

  function generate(serverId?: string) {
    setGenerating(true);
    startTransition(async () => {
      const res = await gqlAction<{ generateAvailableDbPort: number }, number>(
        `mutation($serverId: ID) { generateAvailableDbPort(serverId: $serverId) }`,
        { serverId: serverId ?? db.serverId },
        (d) => d.generateAvailableDbPort,
      );
      setGenerating(false);
      if (res.ok) setPort(String(res.data));
      else toast.error(res.error);
    });
  }

  function save(opts?: { serverId?: string | null; success?: string }) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateDatabaseInput!) {
          updateDatabase(id: $id, input: $input) { id }
        }`,
        {
          id: db.id,
          input: {
            exposedPublicly: exposed,
            exposedPort: exposed ? parsedPort : null,
            serverId: opts?.serverId ?? null,
          },
        },
      );
      if (res.ok) {
        toast.success(opts?.success ?? "Database updated");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return {
    exposed,
    setExposed,
    port,
    setPort,
    parsedPort,
    portValid,
    dirty,
    ready,
    pending,
    generating,
    generate,
    save,
  };
}

export type DatabaseExposure = ReturnType<typeof useDatabaseExposure>;

/** The two gates in one control: the Capability, then the instance grant. */
export function ExposureSwitch({
  checked,
  onCheckedChange,
  canExposePorts,
  canConfigure,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  canExposePorts: boolean;
  canConfigure: boolean;
}) {
  const refusal = !canConfigure
    ? "You don't have permission to change this database"
    : !canExposePorts
      ? "You don't have permission to publish ports"
      : null;

  if (!refusal)
    return <Switch checked={checked} onCheckedChange={onCheckedChange} />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled control fires no pointer events, so the tooltip hangs off
            a focusable wrapper instead. */}
        <span tabIndex={0}>
          <Switch checked={checked} disabled />
        </span>
      </TooltipTrigger>
      <TooltipContent>{refusal}</TooltipContent>
    </Tooltip>
  );
}

export function ExposurePortRow({
  exposure,
  canExposePorts,
  canConfigure,
  serverId,
  extraInfo,
}: {
  exposure: DatabaseExposure;
  canExposePorts: boolean;
  canConfigure: boolean;
  /** Settings passes the (possibly changed) move target so Generate asks it. */
  serverId?: string;
  extraInfo?: React.ReactNode;
}) {
  const locked = !canConfigure || !canExposePorts;
  return (
    <div className="space-y-1.5">
      <FieldLabel
        htmlFor="db-port"
        info={
          <>
            Port clients connect to. Use a free unprivileged port (
            {MIN_USER_PORT}-{MAX_PORT}), or click Generate.
            {extraInfo}
          </>
        }
        docs="databases.hostPort"
      >
        Host port
      </FieldLabel>
      <div className="flex gap-2">
        <Input
          id="db-port"
          inputMode="numeric"
          value={exposure.port}
          onChange={(e) =>
            exposure.setPort(e.target.value.replace(/[^0-9]/g, ""))
          }
          placeholder="e.g. 25432"
          aria-invalid={exposure.port !== "" && !exposure.portValid}
          disabled={locked}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => exposure.generate(serverId)}
          disabled={exposure.generating || exposure.pending || locked}
        >
          {exposure.generating ? "Finding" : "Generate"}
        </Button>
      </div>
    </div>
  );
}
