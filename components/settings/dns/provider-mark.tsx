import { CloudflareIcon } from "@/components/shared/brand-icons";
import { cn } from "@/lib/utils";

export const DNS_PROVIDER_META = {
  cloudflare: {
    label: "Cloudflare",
    blurb:
      "Creates DNS records, and can serve apps through a Cloudflare Tunnel.",
    icon: CloudflareIcon,
    brand: { bg: "#f38020", fg: "#ffffff" },
  },
} as const;

export type DnsProviderId = keyof typeof DNS_PROVIDER_META;

export function ProviderMark({
  provider,
  size = "sm",
}: {
  provider: DnsProviderId;
  size?: "sm" | "lg";
}) {
  const meta = DNS_PROVIDER_META[provider];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md ring-1 ring-border",
        size === "lg" ? "size-10" : "size-8",
      )}
      style={{ backgroundColor: meta.brand.bg, color: meta.brand.fg }}
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}
