import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import {
  getWebPushPublicKey,
  listNotificationChannels,
} from "@/lib/data/notifications";
import { PageHeader } from "@/components/shared/page-header";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { NotificationsPanel } from "@/components/settings/notifications-panel";

export const metadata = { title: "Settings · Notifications" };

export default async function SettingsNotificationsPage() {
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="Notifications"
        description="Pick a channel, then pick what it should tell you about."
        what="The team's notification channels"
      />
    );
  const [channels, vapidPublicKey, canManage] = await Promise.all([
    listNotificationChannels(),
    // Minted here, on first render of this page, so an instance that never uses
    // browser push never holds a VAPID keypair.
    getWebPushPublicKey(),
    // Cosmetic only: every switch and every Test is gated server-side too.
    hasCapability("manage_notifications"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Pick a channel, then pick what it should tell you about."
      />
      <NotificationsPanel
        initial={channels}
        vapidPublicKey={vapidPublicKey}
        canManage={canManage}
      />
    </div>
  );
}
