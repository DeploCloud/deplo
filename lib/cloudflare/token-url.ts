// Prefills the token form with what the panel's tunnel needs; Cloudflare drops a key it does not know.
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  { key: "argotunnel", type: "edit" },
  { key: "dns", type: "edit" },
  { key: "zone", type: "read" },
] as const;

export function cloudflareTokenUrl(name: string): string {
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
    JSON.stringify(CLOUDFLARE_TOKEN_PERMISSIONS),
  )}&accountId=*&zoneId=all&name=${encodeURIComponent(name)}`;
}

export const CLOUDFLARE_TOKEN_URL = cloudflareTokenUrl("Deplo panel");
