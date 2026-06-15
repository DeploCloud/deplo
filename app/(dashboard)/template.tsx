"use client";

import { usePathname } from "next/navigation";

/**
 * A `template.tsx` re-mounts on every navigation (unlike `layout.tsx`), so it is
 * the natural place to animate page entrances. Routes are already prefetched by
 * <Link>, so this keeps navigation instant while giving the dashboard a smooth,
 * single-page-app feel. Keyed by pathname so the animation replays per route.
 */
export default function DashboardTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="animate-page-in">
      {children}
    </div>
  );
}
