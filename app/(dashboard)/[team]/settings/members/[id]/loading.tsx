import Link from "@/components/ui/link";
import { ArrowLeft } from "lucide-react";
import { ScopedActivitySkeleton } from "@/components/activity/scoped-activity-skeleton";
import { MemberDetailSkeleton } from "./member-detail-tabs";

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6" aria-busy>
      <Link
        href="/settings/members"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Members
      </Link>
      <MemberDetailSkeleton activity={<ScopedActivitySkeleton pinnedActor />} />
    </div>
  );
}
