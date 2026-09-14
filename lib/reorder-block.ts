// reorderBlock - drop activeId on overId carrying the whole multi-selection; null when it is a no-op.
export function reorderBlock(
  order: string[],
  activeId: string,
  overId: string,
  blockIds: readonly string[] = [],
): string[] | null {
  const block =
    blockIds.length > 1 && blockIds.includes(activeId)
      ? order.filter((id) => blockIds.includes(id))
      : [activeId];
  const inBlock = new Set(block);
  if (inBlock.has(overId)) return null;
  const rest = order.filter((id) => !inBlock.has(id));
  let target = rest.indexOf(overId);
  if (target < 0 || order.indexOf(activeId) < 0) return null;
  if (order.indexOf(activeId) < order.indexOf(overId)) target += 1;
  return [...rest.slice(0, target), ...block, ...rest.slice(target)];
}
