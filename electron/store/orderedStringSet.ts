interface Node {
  key: string
  priority: number
  left?: Node
  right?: Node
  size: number
}

function nodeSize(node: Node | undefined): number {
  return node?.size ?? 0
}

function update(node: Node): Node {
  node.size = nodeSize(node.left) + nodeSize(node.right) + 1
  return node
}

/** Stable non-cryptographic priority keeps replayed indexes structurally equal. */
function priorityFor(key: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b)
  return (hash ^ (hash >>> 16)) >>> 0
}

function outranks(left: Node, right: Node): boolean {
  return left.priority > right.priority
    || (left.priority === right.priority && left.key > right.key)
}

function rotateRight(root: Node): Node {
  const next = root.left!
  root.left = next.right
  next.right = update(root)
  return update(next)
}

function rotateLeft(root: Node): Node {
  const next = root.right!
  root.right = next.left
  next.left = update(root)
  return update(next)
}

function insertNode(root: Node | undefined, key: string): { root: Node; added: boolean } {
  if (!root) return { root: { key, priority: priorityFor(key), size: 1 }, added: true }
  if (key === root.key) return { root, added: false }
  if (key < root.key) {
    const inserted = insertNode(root.left, key)
    root.left = inserted.root
    root = update(root)
    if (outranks(inserted.root, root)) root = rotateRight(root)
    return { root, added: inserted.added }
  }
  const inserted = insertNode(root.right, key)
  root.right = inserted.root
  root = update(root)
  if (outranks(inserted.root, root)) root = rotateLeft(root)
  return { root, added: inserted.added }
}

function mergeNodes(left: Node | undefined, right: Node | undefined): Node | undefined {
  if (!left) return right
  if (!right) return left
  if (outranks(left, right)) {
    left.right = mergeNodes(left.right, right)
    return update(left)
  }
  right.left = mergeNodes(left, right.left)
  return update(right)
}

function deleteNode(root: Node | undefined, key: string): { root?: Node; deleted: boolean } {
  if (!root) return { deleted: false }
  if (key === root.key) return { root: mergeNodes(root.left, root.right), deleted: true }
  if (key < root.key) {
    const removed = deleteNode(root.left, key)
    root.left = removed.root
    return { root: update(root), deleted: removed.deleted }
  }
  const removed = deleteNode(root.right, key)
  root.right = removed.root
  return { root: update(root), deleted: removed.deleted }
}

/** Ordered membership index with logarithmic expected mutation and successor reads. */
export class OrderedStringSet {
  private root?: Node

  get size(): number {
    return nodeSize(this.root)
  }

  add(key: string): boolean {
    const inserted = insertNode(this.root, key)
    this.root = inserted.root
    return inserted.added
  }

  delete(key: string): boolean {
    const removed = deleteNode(this.root, key)
    this.root = removed.root
    return removed.deleted
  }

  valuesAfter(afterKey: string | undefined, limit: number): string[] {
    const result: string[] = []
    const visit = (node: Node | undefined): void => {
      if (!node || result.length >= limit) return
      if (afterKey === undefined || node.key > afterKey) {
        visit(node.left)
        if (result.length < limit) result.push(node.key)
        visit(node.right)
      } else {
        visit(node.right)
      }
    }
    visit(this.root)
    return result
  }
}
