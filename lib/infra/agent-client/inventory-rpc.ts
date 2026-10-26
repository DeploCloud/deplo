import "server-only";

import type {
  InventoryCandidateResponse,
  InventoryImageResponse,
  ListWorkloadImagesResponse,
  PreparePackageUpdateRequest,
  PreparePackageUpdateResponse,
} from "../../agent/gen/agent";
import type { AgentConnection } from "./connection";
import {
  INVENTORY_CANDIDATE_DEADLINE_MS,
  INVENTORY_DEADLINE_MS,
  INVENTORY_LIST_DEADLINE_MS,
  PACKAGE_UPDATE_DEADLINE_MS,
} from "./deadlines";
import { unary, type AgentChannel } from "./mtls-channel";

export function inventoryRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  | "listWorkloadImages"
  | "inventoryImage"
  | "inventoryCandidate"
  | "preparePackageUpdate"
> {
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
    inventoryCandidate(imageRef: string, currentImageId: string) {
      return unary<
        { imageRef: string; currentImageId: string },
        InventoryCandidateResponse
      >(
        (r, md, opts, cb) => client.inventoryCandidate(r, md, opts, cb),
        { imageRef, currentImageId },
        INVENTORY_CANDIDATE_DEADLINE_MS,
      );
    },
    preparePackageUpdate(req: PreparePackageUpdateRequest) {
      return unary<PreparePackageUpdateRequest, PreparePackageUpdateResponse>(
        (r, md, opts, cb) => client.preparePackageUpdate(r, md, opts, cb),
        req,
        PACKAGE_UPDATE_DEADLINE_MS,
      );
    },
  };
}
