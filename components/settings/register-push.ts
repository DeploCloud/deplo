"use client";

import { toast } from "sonner";
import { gqlAction } from "@/lib/graphql-client";

// Asks for permission, subscribes this browser and registers it in the active team. Null when it could not.
export async function registerPush(
  vapidPublicKey: string,
): Promise<string | null> {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !window.isSecureContext
  ) {
    toast.error("Browser push needs this panel to be served over https");
    return null;
  }
  if ((await Notification.requestPermission()) !== "granted") {
    toast.error("Your browser blocked notifications for this site");
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidPublicKey,
    });
    const json = sub.toJSON();
    const res = await gqlAction(
      `mutation($endpoint: String!, $p256dh: String!, $auth: String!) {
         subscribeWebPush(endpoint: $endpoint, p256dh: $p256dh, auth: $auth)
       }`,
      {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
      },
    );
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    return sub.endpoint;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}
