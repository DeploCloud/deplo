// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the toolbar can do to whichever terminal is mounted below it. Each
 * terminal hands these up on mount; `text()` is read at CLICK time because a
 * snapshot passed as a prop would always be one command behind.
 */
export interface ConsoleControls {
  clear: () => void;
  text: () => string;
}
