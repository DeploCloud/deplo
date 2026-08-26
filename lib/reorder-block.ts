/**
 * Reorder a card grid by dropping `activeId` on `overId`, carrying the whole
 * multi-selection (`blockIds`) with it. Returns null when the drop is a no-op.
 */
export function reorderBlock(
  order: string[],
  activeId: string,
  overId: string,
  blockIds: readonly string[] = [],
): string[] | null {
  // The lifted card drags its group only when it is actually part of one;
  // otherwise it moves alone, exactly like arrayMove.
  const block =
    blockIds.length > 1 && blockIds.includes(activeId)
      ? order.filter((id) => blockIds.includes(id))
      : [activeId];
  const inBlock = new Set(block);
  if (inBlock.has(overId)) return null; // dropped onto a group member
  const rest = order.filter((id) => !inBlock.has(id));
  let target = rest.indexOf(overId);
  if (target < 0 || order.indexOf(activeId) < 0) return null;
  // Dragging downward (active was before the target) lands AFTER it.
  if (order.indexOf(activeId) < order.indexOf(overId)) target += 1;
  return [...rest.slice(0, target), ...block, ...rest.slice(target)];
}
