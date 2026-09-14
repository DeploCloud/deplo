"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// VariantOption - one deployable variant of the family, plus the URL that selects it.
export interface VariantOption {
  slug: string;
  name: string;
  href: string;
}

// VariantPicker - rendered only when the family has more than one variant; it `replace`s rather than `push`es, since picking refines the page you are on.
export function VariantPicker({
  variants,
  selected,
}: {
  variants: VariantOption[];
  // The variant the page is showing - the family default until one is picked.
  selected: string;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  // React drops the optimistic value once the transition lands and `selected` is the server's answer.
  const [shown, showOptimistically] = React.useOptimistic(selected);

  return (
    <Select
      // Radix reserves the empty string, so "nothing chosen" is `undefined`.
      value={shown || undefined}
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
        <SelectValue placeholder="Choose a variant" />
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
