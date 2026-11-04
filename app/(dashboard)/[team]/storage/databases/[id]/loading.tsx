"use client";

import { useParams } from "@/lib/nav";
import { DatabaseOverviewSkeleton } from "@/components/storage/database-overview";

export default function Loading() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="space-y-6" aria-busy>
      <DatabaseOverviewSkeleton id={id} />
    </div>
  );
}
