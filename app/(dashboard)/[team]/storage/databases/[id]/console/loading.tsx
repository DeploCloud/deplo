"use client";

import { useParams } from "@/lib/nav";
import { ConsolePaneSkeleton } from "@/components/console/console-pane";

export default function Loading() {
  const { id } = useParams<{ id: string }>();
  return (
    <div aria-busy className="flex min-h-0 flex-1 flex-col">
      <ConsolePaneSkeleton
        title={{
          label: "database-1",
          href: `/storage/databases/${id}`,
          settingsHref: `/storage/databases/${id}/settings/advanced`,
        }}
      />
    </div>
  );
}
