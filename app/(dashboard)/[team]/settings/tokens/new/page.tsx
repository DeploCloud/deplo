import Link from "@/components/ui/link";
import { ArrowLeft } from "lucide-react";
import { isInstanceAdmin, requireActiveTeamId } from "@/lib/membership";

import { listScopeTree } from "@/lib/data/tokens/scope-tree";
import { tokenPreset } from "@/lib/token-presets";
import { PageHeader } from "@/components/shared/page-header";
import { TokenEditor } from "@/components/settings/tokens/token-editor";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings/settings-store";

export const metadata = { title: "Settings · New API token" };

export default async function NewTokenPage(
  props: PageProps<"/[team]/settings/tokens/new">,
) {
  const sp = await props.searchParams;
  const wanted = Array.isArray(sp.preset) ? sp.preset[0] : sp.preset;
  const [canGrantInstanceAdmin, tree, activeTeamId] = await Promise.all([
    isInstanceAdmin(),
    listScopeTree(),
    requireActiveTeamId(),
  ]);
  // An unknown or stale `?preset=` degrades to a blank token rather than erroring.
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
          docs="tokens.overview"
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
        activeTeamId={activeTeamId}

        canGrantInstanceAdmin={canGrantInstanceAdmin}
        publicUrl={await instancePublicBaseUrl()}
      />
    </div>
  );
}
