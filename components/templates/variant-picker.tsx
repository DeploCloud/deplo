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

export interface VariantOption {
  slug: string;
  name: string;
  href: string;
}

export function VariantPicker({
  variants,
  selected,
}: {
  variants: VariantOption[];
  selected: string;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const [shown, showOptimistically] = React.useOptimistic(selected);

  return (
    <Select
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
