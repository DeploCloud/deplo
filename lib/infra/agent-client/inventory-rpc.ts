import "server-only";

import type {
  InventoryImageResponse,
  ListWorkloadImagesResponse,
} from "../../agent/gen/agent";
import type { AgentConnection } from "./connection";
import { INVENTORY_DEADLINE_MS, INVENTORY_LIST_DEADLINE_MS } from "./deadlines";
import { unary, type AgentChannel } from "./mtls-channel";

export function inventoryRpc(
  channel: AgentChannel,
): Pick<AgentConnection, "listWorkloadImages" | "inventoryImage"> {
  const { client } = channel;
  return {
    listWorkloadImages() {
      return unary<object, ListWorkloadImagesResponse>(
        (r, md, opts, cb) => client.listWorkloadImages(r, md, opts, cb),
        {},
        INVENTORY_LIST_DEADLINE_MS,
      );
    },
    inventoryImage(imageId: string) {
      return unary<{ imageId: string }, InventoryImageResponse>(
        (r, md, opts, cb) => client.inventoryImage(r, md, opts, cb),
        { imageId },
        INVENTORY_DEADLINE_MS,
      );
    },
  };
}
