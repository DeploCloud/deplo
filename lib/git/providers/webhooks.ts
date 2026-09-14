import { providerFor } from "./registry";
import type { GitCredential } from "./types";

// hasWebhook - whether our hook URL is already registered on the repository.
export async function hasWebhook(
  c: GitCredential,
  fullName: string,
  hookUrl: string,
): Promise<boolean> {
  const api = providerFor(c.provider).api;
  if (!api) return false;
  return (await api.listWebhooks(c, fullName)).some((h) => h.url === hookUrl);
}

// Idempotent and keyed on the URL, so two Apps deploying from the same
// repository share one hook instead of accumulating duplicates.
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

// removeWebhook - remove our hook from a repository (no-op when it was never registered).
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
