import { hostnameIsServedHere } from "@/lib/data/domains/hostname-claim";

// The proxy's last-resort route: every address Deplo holds lands here when no app's
// own router is up. https://deplo.build/docs/guides/networking/domains-and-https
export async function GET(request: Request) {
  const served = await hostnameIsServedHere(
    request.headers.get("host") ?? "",
  ).catch(() => true);
  return new Response(page(served), {
    status: served ? 503 : 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      ...(served ? { "retry-after": "30" } : {}),
    },
  });
}

export { GET as POST, GET as PUT, GET as PATCH, GET as DELETE };

function page(served: boolean): string {
  const title = served ? "This site is not running" : "Nothing is served here";
  const body = served
    ? "The app behind this address is not running right now. If it is yours, open Deplo and look at its latest deployment."
    : "No app on this Deplo answers for this address. If it is yours, add it as a domain to your app.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b0b0d; color: #fafafa; }
main { max-width: 32rem; text-align: center; }
h1 { font-size: 1.375rem; font-weight: 600; margin: 0 0 8px; }
p { margin: 0; color: #a1a1aa; }
@media (prefers-color-scheme: light) {
  body { background: #fafafa; color: #18181b; }
  p { color: #52525b; }
}
</style>
</head>
<body><main><h1>${title}</h1><p>${body}</p></main></body>
</html>
`;
}
