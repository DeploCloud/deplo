// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The result shape the UI was built around.
 */
export type ActionResult<T = undefined> =
  { ok: true; data?: T } | { ok: false; error: string };
