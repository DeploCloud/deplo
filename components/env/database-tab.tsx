"use client";

import * as React from "react";
import { Database } from "lucide-react";
import { useRouter } from "@/lib/nav";
import { EmptyState } from "@/components/shared/empty-state";
import { PANEL_BODY_MAX } from "@/components/shared/sliding-panels";
import { DatabaseLogo } from "@/components/storage/database-logo";
import {
  connectedToast,
  DatabaseLinkForm,
  type LinkTarget,
} from "@/components/storage/database-link-form";
import { gql, gqlAction } from "@/lib/graphql-client";
import { DEFAULT_LINK_KEY, type DatabaseReach } from "@/lib/databases/link";
import type { DatabaseType } from "@/lib/types/database";

interface Option {
  id: string;
  name: string;
  type: DatabaseType;
  logo: string | null;
  place: string;
  reach: string;
  connectedKeys: string[];
}

export function DatabaseTab({
  appId,
  appKeys,
  active,
  onDone,
}: {
  appId: string;
  appKeys: string[];
  active: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [options, setOptions] = React.useState<Option[] | null>(null);

  React.useEffect(() => {
    if (!active || options) return;
    let alive = true;
    gql<{ appDatabaseOptions: Option[] }>(
      /* GraphQL */ `
        query ($appId: String!) {
          appDatabaseOptions(appId: $appId) {
            id
            name
            type
            logo
            place
            reach
            connectedKeys
          }
        }
      `,
      { appId },
    )
      .then((d) => alive && setOptions(d.appDatabaseOptions))
      .catch(() => alive && setOptions([]));
    return () => {
      alive = false;
    };
  }, [appId, active, options]);

  const targets = options?.map((o): LinkTarget => ({
    id: o.id,
    name: o.name,
    logo: <DatabaseLogo type={o.type} logo={o.logo} size={28} />,
    place: o.place,
    reach: o.reach.replace(/_/g, "-") as DatabaseReach,
    defaultKey: DEFAULT_LINK_KEY[o.type],
    takenKeys: appKeys,
    connectedKeys: o.connectedKeys,
  }));

  return (
    <DatabaseLinkForm
      targets={targets ?? null}
      noun="database"
      bodyClassName={PANEL_BODY_MAX}
      empty={
        <EmptyState
          icon={Database}
          title="No databases"
          description="Create a database in Storage, then connect it here."
          className="py-10"
        />
      }
      onCancel={onDone}
      onConnect={async (databaseId, key) => {
        const res = await gqlAction(
          /* GraphQL */ `
            mutation ($appId: String!, $databaseId: String!, $key: String!) {
              connectDatabase(appId: $appId, databaseId: $databaseId, key: $key)
            }
          `,
          { appId, databaseId, key },
        );
        if (res.ok) {
          onDone();
          connectedToast(
            `Connected ${options?.find((o) => o.id === databaseId)?.name}`,
            appId,
          );
          router.refresh();
        }
        return res;
      }}
    />
  );
}
