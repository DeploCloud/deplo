import { getNotificationSettings } from "@/lib/data/notifications";
import { PageHeader } from "@/components/shared/page-header";
import { NotificationsPanel } from "@/components/settings/notifications-panel";

export const metadata = { title: "Settings · Notifications" };

export default async function SettingsNotificationsPage() {
  const notifications = await getNotificationSettings();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Alerts and where they’re delivered."
      />
      <NotificationsPanel initial={notifications} />
    </div>
  );
}
