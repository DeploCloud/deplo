"use client";

import { useParams } from "next/navigation";
import { LiveConsoleSkeleton } from "@/components/apps/live-console";

export default function Loading() {
  return <LiveConsoleSkeleton slug={useParams<{ slug: string }>().slug} />;
}
