import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  searchImages,
  listTags,
  checkImageExists,
  imageExposedPort,
} from "@/lib/registry/client";

export async function GET(request: NextRequest) {
  // Any logged-in user may query: the inputs this feeds are visible at the `view` floor, so a capability gate would break the UI.
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const action = params.get("action");

  try {
    if (action === "search") {
      const q = params.get("q") ?? "";
      const results = await searchImages(q);
      return Response.json({ results });
    }

    if (action === "tags") {
      const image = params.get("image") ?? "";
      if (!image.trim()) return Response.json({ tags: [] });
      // Forwarded to the registry's server-side name filter so old/specific versions surface.
      const filter = params.get("filter")?.trim() || undefined;
      const tags = await listTags(image, 40, filter);
      return Response.json({ tags });
    }

    if (action === "exists") {
      const image = params.get("image") ?? "";
      if (!image.trim()) return Response.json({ status: "unknown" });
      const result = await checkImageExists(image);
      // The port the image declares rides along, so a Docker-image app is not routed to a guessed 3000.
      const port =
        result.status === "exists"
          ? await imageExposedPort(image).catch(() => null)
          : null;
      return Response.json({ ...result, port });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch {
    // Registry outages / timeouts must not surface as input errors - degrade to "no hints", never a 500.
    return Response.json({ error: "Registry lookup failed" }, { status: 502 });
  }
}
