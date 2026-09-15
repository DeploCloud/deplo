import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  searchImages,
  listTags,
  checkImageExists,
  imageExposedPort,
} from "@/lib/registry/client";

export async function GET(request: NextRequest) {
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
      const filter = params.get("filter")?.trim() || undefined;
      const tags = await listTags(image, 40, filter);
      return Response.json({ tags });
    }

    if (action === "exists") {
      const image = params.get("image") ?? "";
      if (!image.trim()) return Response.json({ status: "unknown" });
      const result = await checkImageExists(image);
      const port =
        result.status === "exists"
          ? await imageExposedPort(image).catch(() => null)
          : null;
      return Response.json({ ...result, port });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch {
    return Response.json({ error: "Registry lookup failed" }, { status: 502 });
  }
}
