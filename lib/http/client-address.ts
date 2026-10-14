import { isCloudflareIp } from "../deploy/cloudflare";
import { clientKeyAddress, isIpLiteral } from "../host-address";

// Traefik appends the peer it saw as the LAST x-forwarded-for entry, the one a caller cannot write.
// cf-connecting-ip counts only when that peer is Cloudflare itself.
export function clientAddress(h: Headers): string | null {
  const peer = h.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (!peer) return null;
  const cf = h.get("cf-connecting-ip")?.trim();
  return cf && isIpLiteral(cf) && isCloudflareIp(peer) ? cf : peer;
}

// The per-address rate-limit key.
export function clientAddressKey(h: Headers): string {
  return clientKeyAddress(clientAddress(h) ?? "unknown");
}
