"use client";

import * as React from "react";
import { useTheme } from "@/components/theme-provider";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * App-wide toast host. sonner's `richColors` palette is rebranded to Deplo's
 * tokens by overriding its custom properties INLINE on the toaster element: an
 * inline declaration beats its stylesheet rule regardless of injection order.
 */
const TOAST_VARS = {
  // Plain / loading toasts: match the popover surface (sonner's "normal" type).
  "--normal-bg": "var(--popover)",
  "--normal-border": "var(--border)",
  "--normal-text": "var(--popover-foreground)",

  "--success-bg": "color-mix(in srgb, var(--success) 14%, var(--popover))",
  "--success-border": "color-mix(in srgb, var(--success) 40%, transparent)",
  "--success-text": "var(--success)",

  "--error-bg": "color-mix(in srgb, var(--destructive) 14%, var(--popover))",
  "--error-border": "color-mix(in srgb, var(--destructive) 42%, transparent)",
  "--error-text": "var(--destructive)",

  "--warning-bg": "color-mix(in srgb, var(--warning) 15%, var(--popover))",
  "--warning-border": "color-mix(in srgb, var(--warning) 42%, transparent)",
  "--warning-text": "var(--warning)",

  "--info-bg": "color-mix(in srgb, var(--info) 14%, var(--popover))",
  "--info-border": "color-mix(in srgb, var(--info) 42%, transparent)",
  "--info-text": "var(--info)",
} as React.CSSProperties;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "dark" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      richColors
      closeButton
      className="toaster group"
      style={TOAST_VARS}
      toastOptions={{
        // Shape only - the per-type colours come from richColors + TOAST_VARS,
        // so this must NOT pin a background/text colour or it would flatten them.
        classNames: {
          toast:
            "group toast group-[.toaster]:items-start group-[.toaster]:gap-2.5 group-[.toaster]:rounded-xl group-[.toaster]:border group-[.toaster]:p-4 group-[.toaster]:text-[13px] group-[.toaster]:shadow-lg",
          title: "group-[.toast]:font-medium group-[.toast]:leading-snug",
          icon: "group-[.toast]:mt-0.5",
          actionButton:
            "group-[.toast]:rounded-md group-[.toast]:bg-primary group-[.toast]:font-medium group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:rounded-md group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
