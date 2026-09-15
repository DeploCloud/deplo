import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import {
  getWebPushPublicKey,
  listNotificationChannels,
} from "@/lib/data/notifications";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { NotificationsPanel } from "@/components/settings/notifications-panel";

export const metadata = { title: "Settings · Notifications" };

export default async function SettingsNotificationsPage() {
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
    getWebPushPublicKey(),
  ]);

  return (
    <NotificationsPanel
      initial={channels}
      vapidPublicKey={vapidPublicKey}
      canManage={canManage}
    />
  );
}
