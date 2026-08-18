"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One deployable variant of the family, plus the URL that selects it. */
export interface VariantOption {
  slug: string;
  name: string;
  href: string;
}

/**
 * Which variant of a template family the page is showing. Only rendered when
 * the family has more than one; a template with a single variant looks exactly
 * as it always did.
 *
 * The choice rides the URL (`?variant=`), like the project drill-in's
 * environment: the link is shareable and the page stays a server component. It
 * `replace`s rather than `push`es, because picking a variant refines the page
 * you are on: Back has to leave the template rather than walk back through the
 * variants you looked at. (`TemplateSearchLink` pushes for the opposite reason:
 * typing there takes you off this page.)
 *
 * The server owns the hrefs, so this component knows nothing about the drill-in
 * scope it has to preserve.
 */
export function VariantPicker({
  variants,
  selected,
}: {
  variants: VariantOption[];
  selected: string;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  // The trigger says what was clicked while the RSC navigation is in flight;
  // React drops the optimistic value once the transition lands and `selected`
  // is the server's answer. Without it the picker keeps showing the old variant
  // for the length of a round trip, which reads as a control that ignored you.
  const [shown, showOptimistically] = React.useOptimistic(selected);

  return (
    <Select
      value={shown}
      onValueChange={(slug) => {
        const next = variants.find((v) => v.slug === slug);
        if (!next) return;
        startTransition(() => {
          showOptimistically(slug);
          router.replace(next.href, { scroll: false });
        });
      }}
    >
      <SelectTrigger aria-label="Variant" className="w-full sm:w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {variants.map((v) => (
          <SelectItem key={v.slug} value={v.slug}>
            {v.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
