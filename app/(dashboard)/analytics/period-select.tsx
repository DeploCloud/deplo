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

const PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

export function PeriodSelect({ days }: { days: number }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function handleChange(value: string) {
    startTransition(() => {
      router.push(`/analytics?days=${value}`);
    });
  }

  return (
    <Select value={String(days)} onValueChange={handleChange} disabled={pending}>
      <SelectTrigger className="w-[160px] cursor-pointer" aria-label="Select period">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERIODS.map((p) => (
          <SelectItem key={p.value} value={p.value}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
