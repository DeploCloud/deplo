/**
 * Turn a `User-Agent` string into something a person recognises as their own
 * device ("Chrome on macOS", "Safari on iPhone") for the signed-in-devices table
 * in Settings → Security.
 */

export type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export interface UserAgentInfo {
  /** Browser or client name, or null when nothing matched. */
  browser: string | null;
  /** Operating system, or null when nothing matched. */
  os: string | null;
  device: DeviceKind;
  /** The display string: "Chrome on macOS", "curl", "Unknown device". */
  label: string;
}

/** Most specific first. Every entry after the first match is unreachable. */
const BROWSERS: [RegExp, string][] = [
  // Edge announces itself as Chrome and Safari as well, so it must precede both.
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  // Opera is Chrome + "OPR/"; older desktop builds used "Opera/".
  [/\bOPR\/|\bOpera[\s/]/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bVivaldi\//, "Vivaldi"],
  [/\bBrave\//, "Brave"],
  // Firefox on iOS is "FxiOS" and carries no "Firefox/" token at all.
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  // Chrome on iOS is "CriOS"; it is still Chrome to the person reading the row.
  [/\bCriOS\//, "Chrome"],
  // Puppeteer/Playwright.
  [/\bHeadlessChrome\//, "Headless Chrome"],
  [/\bChrome\/|\bChromium\//, "Chrome"],
  // Last of the browsers: everything above also ships "Safari/" in its UA.
  [/\bSafari\//, "Safari"],
  // Non-browser clients. Someone hitting the API from a script deserves to see
  // it named rather than filed under "Unknown".
  [/^deplo/i, "deplo CLI"],
  [/\bcurl\//i, "curl"],
  [/\bWget\//i, "Wget"],
  [/\bPostmanRuntime\//i, "Postman"],
  [/\binsomnia\//i, "Insomnia"],
  [/\bGo-http-client\//i, "Go client"],
  [/\bpython-requests\//i, "Python requests"],
  [/\bnode(?:-fetch)?\//i, "Node"],
];

/** Also most specific first: "Android" strings contain "Linux". */
const OSES: [RegExp, string][] = [
  [/\biPhone\b|\biPod\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  // iPadOS 13+ pretends to be a Mac; the touch hint is what gives it away.
  [/\bMacintosh\b(?=.*\bMobile\b)/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows NT\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

function deviceOf(ua: string, os: string | null): DeviceKind {
  if (os === "iPad") return "tablet";
  if (os === "iPhone") return "mobile";
  if (/\bAndroid\b/.test(ua))
    return /\bMobile\b/.test(ua) ? "mobile" : "tablet";
  if (/\bMobi\b/.test(ua)) return "mobile";
  if (os === "Windows" || os === "macOS" || os === "Linux" || os === "ChromeOS")
    return "desktop";
  return "unknown";
}

export function describeUserAgent(
  ua: string | null | undefined,
): UserAgentInfo {
  const raw = (ua ?? "").trim();
  if (!raw)
    return {
      browser: null,
      os: null,
      device: "unknown",
      label: "Unknown device",
    };

  const browser = BROWSERS.find(([re]) => re.test(raw))?.[1] ?? null;
  const os = OSES.find(([re]) => re.test(raw))?.[1] ?? null;
  const device = deviceOf(raw, os);

  // "Safari on iPhone" reads better than "Safari on iOS", so the OS list already
  // names the device for Apple's mobile hardware.
  const label = browser
    ? os
      ? `${browser} on ${os}`
      : browser
    : os
      ? os
      : "Unknown device";

  return { browser, os, device, label };
}
