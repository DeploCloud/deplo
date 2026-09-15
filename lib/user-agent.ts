export type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export interface UserAgentInfo {
  browser: string | null;
  os: string | null;
  device: DeviceKind;
  label: string;
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera[\s/]/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bVivaldi\//, "Vivaldi"],
  [/\bBrave\//, "Brave"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bHeadlessChrome\//, "Headless Chrome"],
  [/\bChrome\/|\bChromium\//, "Chrome"],
  [/\bSafari\//, "Safari"],
  [/^deplo/i, "Deplo CLI"],
  [/\bcurl\//i, "curl"],
  [/\bWget\//i, "Wget"],
  [/\bPostmanRuntime\//i, "Postman"],
  [/\binsomnia\//i, "Insomnia"],
  [/\bGo-http-client\//i, "Go client"],
  [/\bpython-requests\//i, "Python requests"],
  [/\bnode(?:-fetch)?\//i, "Node"],
];

const OSES: [RegExp, string][] = [
  [/\biPhone\b|\biPod\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
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

  const label = browser
    ? os
      ? `${browser} on ${os}`
      : browser
    : os
      ? os
      : "Unknown device";

  return { browser, os, device, label };
}
