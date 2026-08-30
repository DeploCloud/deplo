// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import {
  getWebPushPublicKey,
  listNotificationChannels,
} from "@/lib/data/notifications";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { NotificationsPanel } from "@/components/settings/notifications-panel";

export const metadata = { title: "Settings · Notifications" };

export default async function SettingsNotificationsPage() {
  // A channel row carries the webhook URL, which IS the credential for a chat
  // room, so the PAGE takes the same gate as the read behind it: reaching the
  // whole team is not enough, it takes `manage_notifications`.
  const canManage = await hasCapability("manage_notifications");
  if (!(await reachesWholeTeam()) || !canManage)
    return (
      <OutsideYourAccess
        title="Notifications"
        description="Pick a channel, then pick what it should tell you about."
        what="The team's notification channels"
      />
    );
  const [channels, vapidPublicKey] = await Promise.all([
    listNotificationChannels(),
    // Minted here, on first render of this page, so an instance that never uses
    // browser push never holds a VAPID keypair.
    getWebPushPublicKey(),
  ]);

  // The page header lives inside the panel: "Add channel" belongs in it, and
  // only the panel can open the dialog it opens.
  return (
    <NotificationsPanel
      initial={channels}
      vapidPublicKey={vapidPublicKey}
      canManage={canManage}
    />
  );
}
