import "server-only";

import type {
  CaptureScreenshotRequest,
  CaptureScreenshotResponse,
} from "../../agent/gen/agent";
import type { AgentConnection } from "./connection";
import { CAPTURE_SCREENSHOT_DEADLINE_MS } from "./deadlines";
import { unary, type AgentChannel } from "./mtls-channel";

export function captureRpc(
  channel: AgentChannel,
): Pick<AgentConnection, "captureScreenshot"> {
  const { client } = channel;
  return {
    captureScreenshot(req: CaptureScreenshotRequest) {
      return unary<CaptureScreenshotRequest, CaptureScreenshotResponse>(
        (r, md, opts, cb) => client.captureScreenshot(r, md, opts, cb),
        req,
        CAPTURE_SCREENSHOT_DEADLINE_MS,
      );
    },
  };
}
