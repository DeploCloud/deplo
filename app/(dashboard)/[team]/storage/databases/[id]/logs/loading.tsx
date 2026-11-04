"use client";

import { useParams } from "@/lib/nav";
import { ContainerLogsSkeleton } from "@/components/apps/container-logs";

export default function Loading() {
  const { id } = useParams<{ id: string }>();
  return (
    <div aria-busy className="flex min-h-0 flex-1 flex-col">
      <ContainerLogsSkeleton
        title={{ label: "database-1", href: `/storage/databases/${id}` }}
      />
    </div>
  );
}
