import { CloudflareIcon } from "@/components/shared/brand-icons";
import { cloudflareTokenUrl } from "@/lib/cloudflare/token-url";
import { cn } from "@/lib/utils";

export const DNS_PROVIDER_META = {
  cloudflare: {
    label: "Cloudflare",
    blurb:
      "Creates DNS records, and can serve apps through a Cloudflare Tunnel.",
    icon: CloudflareIcon,
    brand: { bg: "#f38020", fg: "#ffffff" },
    tokenHint: "Needs DNS: Edit, and Cloudflare Tunnel: Edit for tunnels.",
    tokenUrl: () => cloudflareTokenUrl("Deplo DNS"),
  },
} as const;

export type DnsProviderId = keyof typeof DNS_PROVIDER_META;

export function ProviderMark({
  provider,
  size = "sm",
}: {
  provider: DnsProviderId;
  size?: "xs" | "sm" | "lg";
}) {
  const meta = DNS_PROVIDER_META[provider];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md ring-1 ring-border",
        { xs: "size-5", sm: "size-8", lg: "size-10" }[size],
      )}
      style={{ backgroundColor: meta.brand.bg, color: meta.brand.fg }}
    >
      <Icon className={{ xs: "size-3", sm: "size-4", lg: "size-5" }[size]} />
    </span>
  );
}
