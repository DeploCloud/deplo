import { providerFor } from "./registry";
import type { GitCredential } from "./types";

export async function hasWebhook(
  c: GitCredential,
  fullName: string,
  hookUrl: string,
): Promise<boolean> {
  const api = providerFor(c.provider).api;
  if (!api) return false;
  return (await api.listWebhooks(c, fullName)).some((h) => h.url === hookUrl);
}

export async function ensureWebhook(
  c: GitCredential,
  fullName: string,
  hookUrl: string,
  secret: string,
): Promise<void> {
  const api = providerFor(c.provider).api;
  if (!api) return;
  const existing = await api.listWebhooks(c, fullName);
  if (existing.some((h) => h.url === hookUrl)) return;
  await api.createWebhook(c, fullName, hookUrl, secret);
}

export async function removeWebhook(
  c: GitCredential,
  fullName: string,
  hookUrl: string,
): Promise<void> {
  const api = providerFor(c.provider).api;
  if (!api) return;
  for (const h of await api.listWebhooks(c, fullName)) {
    if (h.url === hookUrl) await api.deleteWebhook(c, fullName, h.id);
  }
}
