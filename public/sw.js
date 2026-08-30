/* Deplo browser push (beta).
 *
 * Plain JS on purpose: a service worker is served as-is from /sw.js and never
 * goes through the bundler, so there is nothing here to build.
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Deplo";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/logomark.svg",
      badge: "/logomark.svg",
      tag: data.tag || undefined,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Focus the dashboard if it is already open rather than piling up tabs.
        for (const client of clients) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
