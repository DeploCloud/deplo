import { reachesWholeTeam } from "@/lib/membership";
import {
  getNotificationSettings,
  getWebPushPublicKey,
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
        description="Alerts and where they’re delivered."
        what="The team's notification channels"
      />
    );
  const notifications = await getNotificationSettings();
  // Minted here, on first render of this page, so an instance that never uses
  // browser push never holds a VAPID keypair.
  const vapidPublicKey = await getWebPushPublicKey();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Alerts and where they’re delivered."
      />
      <NotificationsPanel
        initial={notifications}
        vapidPublicKey={vapidPublicKey}
      />
    </div>
  );
}
