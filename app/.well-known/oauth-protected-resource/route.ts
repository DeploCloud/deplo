// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import {
  oauthPreflight,
  protectedResourceResponse,
} from "@/lib/auth/oauth-well-known";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 9728, bare form. Public: a client discovers deplo before it has a token. */
export function GET() {
  return protectedResourceResponse();
}

export function OPTIONS() {
  return oauthPreflight();
}
