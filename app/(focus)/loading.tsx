"use client";

import { useSearchParams } from "@/lib/nav";
import { TemplateStepSkeleton } from "@/components/apps/new-app-wizard/details-step";
import {
  FocusBackdrop,
  FocusFrame,
} from "@/components/apps/new-app-wizard/focus-frame";
import {
  PlacementMeta,
  SourceStep,
} from "@/components/apps/new-app-wizard/new-app-wizard";
import { Bone } from "@/components/ui/skeleton";
import {
  placementFromSearchParams,
  placementHref,
  templatesHref,
} from "@/lib/overview-links";

const UNCOMMON = ["detected", "source", "repo", "compose"];

// Above the focus layout, which checks the team before it renders: the frame is drawn here.
// A rarer entry keeps the frame alone rather than a card its page would swap out.
export default function Loading() {
  const params = useSearchParams();
  const get = (key: string) => params.get(key) ?? undefined;
  const placement = placementFromSearchParams({
    folder: get("folder"),
    project: get("project"),
    env: get("env"),
  });
  const meta =
    placement.folderId || placement.projectId ? (
      <PlacementMeta label={<Bone>Folder name</Bone>} />
    ) : null;
  const template = get("variant") ? get("template") : undefined;
  const plain = !template && UNCOMMON.every((key) => !params.has(key));

  return (
    <FocusBackdrop>
      <div aria-busy>
        <FocusFrame
          exitHref={
            template ? templatesHref(placement) : placementHref(placement)
          }
          narrow={Boolean(template) || params.has("compose")}
        >
          <div inert>
            {template ? (
              <TemplateStepSkeleton slug={template} meta={meta} />
            ) : plain ? (
              <SourceStep
                meta={meta}
                value={null}
                onSelect={() => {}}
                templatesHref={templatesHref(placement)}
              />
            ) : null}
          </div>
        </FocusFrame>
      </div>
    </FocusBackdrop>
  );
}
