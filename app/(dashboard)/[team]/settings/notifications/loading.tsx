import { NotificationsPanel } from "@/components/settings/notifications-panel";

export default function Loading() {
  return (
    <NotificationsPanel initial={[]} vapidPublicKey="" canManage loading />
  );
}
