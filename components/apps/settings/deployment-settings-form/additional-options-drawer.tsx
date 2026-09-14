"use client";

import { Server as ServerIcon, AlertTriangle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RootDirectoryFields } from "@/components/apps/settings/root-directory-fields";
import { SettingRow } from "@/components/shared/setting-row";
import { SettingsDrawer } from "@/components/shared/settings-drawer";
import type { SettingsServer } from "@/components/apps/settings/settings-shared";
import { cn, serverLabel } from "@/lib/utils";
import { ServerRoleHint } from "@/components/shared/server-role-hint";
import { Collapse } from "@/components/shared/collapse";
import type { DeploymentSettings } from "./use-deployment-settings";

// AdditionalOptionsDrawer: the Deploy Source card's root directory + server rows.
export function AdditionalOptionsDrawer({
  settings,
  servers,
  neighbours,
}: {
  settings: DeploymentSettings;
  servers: SettingsServer[];
  neighbours: string[];
}) {
  const {
    closedSummary,
    rootCardVisible,
    build,
    setBuild,
    pending,
    serverId,
    setServerId,
    serverMoveWarned,
    currentServerName,
  } = settings;

  return (
    <SettingsDrawer title="Additional options" summary={closedSummary}>
      {rootCardVisible && (
        <SettingRow
          label="Root directory"
          htmlFor="root-directory"
          info='Sub-folder to build from, e.g. "apps/web" in a monorepo. Leave as ./ to build from the repository root'
          docs="build.fields"
        >
          <RootDirectoryFields
            build={build}
            onBuildChange={setBuild}
            disabled={pending}
            bare
          />
        </SettingRow>
      )}
      <SettingRow
        label="Server"
        info="The server (host machine) that builds and runs this app."
        docs="servers.overview"
        align={serverMoveWarned ? "start" : "center"}
      >
        {/* Squared off and flush under the Select, so the warning reads as that control's own. */}
        <div className="w-full">
          <Select value={serverId} onValueChange={setServerId}>
            <SelectTrigger
              className={cn("w-full", serverMoveWarned && "rounded-b-none")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {servers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <span className="flex items-center gap-2">
                    <ServerIcon className="size-4 text-muted-foreground" />
                    {serverLabel(s)}
                    <ServerRoleHint isDeploHost={s.isDeploHost} />
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Collapse open={serverMoveWarned}>
            <div className="flex items-start gap-2 rounded-md rounded-t-none border border-t-0 border-warning/40 bg-warning-wash-strong px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Saving redeploys this app on the new server and copies its data
                (volumes and files) across. It&apos;s offline during the copy;
                if the copy fails, it stays on {currentServerName}.
                {neighbours.length > 0 && (
                  <>
                    {" "}
                    {neighbours.join(", ")}{" "}
                    {neighbours.length === 1 ? "stays" : "stay"} on{" "}
                    {currentServerName}, and this app will no longer reach{" "}
                    {neighbours.length === 1 ? "it" : "them"} by name.
                  </>
                )}
              </span>
            </div>
          </Collapse>
        </div>
      </SettingRow>
    </SettingsDrawer>
  );
}
