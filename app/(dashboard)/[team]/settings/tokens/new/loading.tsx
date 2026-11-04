import Link from "@/components/ui/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Bone } from "@/components/ui/skeleton";
import { TokenEditorSkeleton } from "@/components/settings/tokens/token-editor";

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="space-y-3">
        <Link
          href="/settings/tokens"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          All tokens
        </Link>
        <PageHeader
          docs="tokens.overview"
          title="New API token"
          description={
            <Bone>
              Pick exactly what this token should be able to do. Nothing is
              granted by default.
            </Bone>
          }
        />
      </div>
      <TokenEditorSkeleton mode="create" />
    </div>
  );
}
