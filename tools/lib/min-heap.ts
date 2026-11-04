// A binary min-heap, as Python's heapq: the order of equal items is the caller's, so a tie-break goes in `before`.
export class MinHeap<T> {
  private readonly items: T[] = [];
  private readonly before: (a: T, b: T) => boolean;

  constructor(before: (a: T, b: T) => boolean, items: Iterable<T> = []) {
    this.before = before;
    for (const item of items) this.push(item);
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const { items, before } = this;
    let i = items.length;
    items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(item, items[parent]!)) break;
      items[i] = items[parent]!;
      i = parent;
    }
    items[i] = item;
  }

  pop(): T | undefined {
    const { items, before } = this;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return top;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= items.length) break;
      if (child + 1 < items.length && before(items[child + 1]!, items[child]!)) child += 1;
      if (!before(items[child]!, last)) break;
      items[i] = items[child]!;
      i = child;
    }
    items[i] = last;
    return top;
  }
}
