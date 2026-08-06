import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";

import { listScopeTree } from "@/lib/data/tokens";
import { tokenPreset } from "@/lib/token-presets";
import { PageHeader } from "@/components/shared/page-header";
import { TokenEditor } from "@/components/settings/tokens/token-editor";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings";

export const metadata = { title: "Settings · New API token" };

export default async function NewTokenPage(
  props: PageProps<"/settings/tokens/new">,
) {
  const sp = await props.searchParams;
  const wanted = Array.isArray(sp.preset) ? sp.preset[0] : sp.preset;
  const [canManage, canGrantInstanceAdmin, tree] = await Promise.all([
    hasCapability("manage_tokens"),
    isInstanceAdmin(),
    listScopeTree(),
  ]);
  // Reachable only from the "New token" menu, which is itself gated — but a
  // typed URL must not open an editor whose save can only fail.
  if (!canManage) redirect("/settings/tokens");
  // `?preset=` is the template chosen in that menu. An unknown or stale id
  // degrades to a blank token rather than erroring: the choice is a starting
  // point, not a link.
  const preset = wanted ? tokenPreset(wanted) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/settings/tokens"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          All tokens
        </Link>
        <PageHeader
          title="New API token"
          description={
            preset
              ? `Starting from ${preset.name}. Change anything you like before creating it.`
              : "Pick exactly what this token should be able to do. Nothing is granted by default."
          }
        />
      </div>
      <TokenEditor
        mode="create"
        preset={preset}
        tree={tree}
        canManage
        canGrantInstanceAdmin={canGrantInstanceAdmin}
        publicUrl={await instancePublicBaseUrl()}
      />
    </div>
  );
}
