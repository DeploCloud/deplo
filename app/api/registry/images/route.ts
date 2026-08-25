import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  searchImages,
  listTags,
  checkImageExists,
} from "@/lib/registry/client";

/**
 * Image-hinting proxy for the Compose / Docker-image inputs.
 */
export async function GET(request: NextRequest) {
  // Any logged-in user may query - the image inputs this feeds are visible to every
  // member with `view`, so a capability gate here would break the UI.
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
      // `filter` is the tag fragment being typed; forwarded to the registry's
      // server-side name filter so old/specific versions surface.
      const filter = params.get("filter")?.trim() || undefined;
      const tags = await listTags(image, 40, filter);
      return Response.json({ tags });
    }

    if (action === "exists") {
      const image = params.get("image") ?? "";
      if (!image.trim()) return Response.json({ status: "unknown" });
      const result = await checkImageExists(image);
      return Response.json(result);
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch {
    // Registry outages / timeouts must not surface as input errors - degrade
    // gracefully to "no hints" rather than a 500.
    return Response.json({ error: "Registry lookup failed" }, { status: 502 });
  }
}
