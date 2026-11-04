"use client";

import { useParams } from "next/navigation";
import { DetailFrame } from "@/components/layout/detail-frame";
import { AppHeaderSkeleton } from "@/components/apps/app-header";
import { useFlatPathname } from "@/lib/nav";
import { AppTabSkeleton } from "@/components/apps/app-tab-skeletons";

// Entering an App: its frame and the tab being opened, before the layout has the App.
export function AppFrameSkeleton() {
  const { slug } = useParams<{ slug: string }>();
  const root = `/apps/${slug}`;
  const tab = useFlatPathname().slice(root.length);
  return (
    <DetailFrame
      busy
      header={<AppHeaderSkeleton />}
      mobile={{ root, name: slug, parent: { href: "/", label: "Overview" } }}
    >
      <AppTabSkeleton tab={tab} />
    </DetailFrame>
  );
}
