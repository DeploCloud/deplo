"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
 * Which variant of a template family the page shows; only rendered when there is
 * more than one. The choice rides `?variant=` and `replace`s rather than
 * `push`es, because picking a variant refines the page you are on. */
export function VariantPicker({
  variants,
  selected,
}: {
  variants: VariantOption[];
  selected: string;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  // The trigger says what was clicked while the RSC navigation is in flight; React
  // drops the optimistic value once the transition lands and `selected` is the
  // server's answer.
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
