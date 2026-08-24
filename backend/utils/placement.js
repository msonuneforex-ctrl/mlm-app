const db = require('../db');

/**
 * Finds the first open (L or R) slot in the binary tree, starting the
 * search from `rootId` (usually the sponsor), using breadth-first search.
 * preferredSide, if given ('L' or 'R'), tries that side of the sponsor first.
 */
function findOpenSlot(rootId, preferredSide) {
  const getChild = (parentId, side) =>
    db.prepare('SELECT id FROM users WHERE parent_id = ? AND position = ?').get(parentId, side);

  // If sponsor has an open slot directly, and a side was requested, try it first
  if (preferredSide) {
    const direct = getChild(rootId, preferredSide);
    if (!direct) return { parent_id: rootId, position: preferredSide };
  }

  // BFS across the tree under rootId to find first free L then R
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    const left = getChild(current, 'L');
    const right = getChild(current, 'R');

    if (!left) return { parent_id: current, position: 'L' };
    if (!right) return { parent_id: current, position: 'R' };

    queue.push(left.id, right.id);
  }
  // Should never reach here
  return { parent_id: rootId, position: 'L' };
}

module.exports = { findOpenSlot };
