"use client";

import * as React from "react";

import { gqlAction } from "@/lib/graphql-client";
import type { ServerSummary } from "../server-detail-tabs";
import { HOST_INFO_FIELDS, type HostInfo, type Reading } from "./host-info";
import { HostDetails } from "./host-details";
import { ServerClock } from "./server-clock";
import { InstallCommand } from "./install-command";
import { DangerZone } from "./danger-zone";
import { ServerRolePanel } from "./server-role-panel";

export function ServerAdvancedTab({ server }: { server: ServerSummary }) {
  const [reading, setReading] = React.useState<Reading | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const info = reading?.info ?? null;

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await gqlAction<{ checkServerHostInfo: HostInfo }>(
      `mutation CheckServerHostInfo($id: String!) {
        checkServerHostInfo(id: $id) { ${HOST_INFO_FIELDS} }
      }`,
      { id: server.id },
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      setReading(null);
      return;
    }
    if (res.data)
      setReading({ info: res.data.checkServerHostInfo, readAt: Date.now() });
  }, [server.id]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <>
      <ServerRolePanel server={server} />
      <HostDetails info={info} loading={loading} error={error} onRetry={load} />
      <ServerClock
        server={server}
        reading={reading}
        error={error}
        onChanged={setReading}
      />
      <InstallCommand server={server} />
      <DangerZone server={server} />
    </>
  );
}
