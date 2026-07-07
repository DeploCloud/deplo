"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FrameworkIcon } from "@/components/shared/framework-icon";
import type { FrameworkId } from "@/lib/types";

/**
 * A service's display avatar: its custom logo when one is set (defaulted from a
 * template on deploy, editable in settings), otherwise the framework icon. The
 * logo container mirrors FrameworkIcon's box so the two are interchangeable in
 * lists. A logo that fails to load falls back to the framework icon at runtime
 * rather than showing a broken image.
 */
export function ServiceLogo({
  logo,
  framework,
  size = 36,
  className,
}: {
  logo: string | null;
  framework: FrameworkId;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = React.useState(false);

  if (!logo || broken) {
    return (
      <FrameworkIcon framework={framework} size={size} className={className} />
    );
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-white",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logo}
        alt=""
        className="size-full object-contain p-1"
        loading="lazy"
        onError={() => setBroken(true)}
      />
    </span>
  );
}
