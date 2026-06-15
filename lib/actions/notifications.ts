"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import {
  updateNotificationSettings,
  sendTestNotification,
} from "@/lib/data/notifications";
import type { NotificationSettings } from "@/lib/types";

const settingsSchema = z.object({
  channels: z.object({
    push: z.object({ enabled: z.boolean() }),
    email: z.object({ enabled: z.boolean(), address: z.string().max(254) }),
    discord: z.object({
      enabled: z.boolean(),
      webhookUrl: z.string().max(500),
    }),
    webhook: z.object({ enabled: z.boolean(), url: z.string().max(500) }),
  }),
  events: z.object({
    deployment_failed: z.boolean(),
    deployment_succeeded: z.boolean(),
    server_offline: z.boolean(),
    high_resource_usage: z.boolean(),
    update_available: z.boolean(),
  }),
});

export async function saveNotificationSettingsAction(
  input: NotificationSettings,
): Promise<ActionResult<NotificationSettings>> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid settings",
    };
  const res = await run(() => updateNotificationSettings(parsed.data));
  if (res.ok) revalidatePath("/settings");
  return res;
}

export async function testNotificationAction(
  channel: string,
): Promise<ActionResult> {
  const parsed = z.enum(["email", "discord", "webhook"]).safeParse(channel);
  if (!parsed.success) return { ok: false, error: "Invalid channel" };
  return run(async () => {
    await sendTestNotification(parsed.data);
    return undefined;
  });
}
