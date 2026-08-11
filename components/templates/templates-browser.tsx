"use client";

import { useTemplates } from "@/templates/hooks";

export function TemplatesBrowser() {
  const { data, isLoading } = useTemplates();

  return (
    <div className="space-y-5">
      {isLoading ? "Loading..." : data?.data.map((t) => t.name).join(", ")}
    </div>
  );
}
