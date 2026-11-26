/** Lightweight binary min-heap for O(log N) A* priority queues. */
export class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const arr = this.items;
    arr.push(item);
    let idx = arr.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (arr[parent].cost <= arr[idx].cost) break;
      const tmp = arr[parent];
      arr[parent] = arr[idx];
      arr[idx] = tmp;
      idx = parent;
    }
  }

  pop() {
    const arr = this.items;
    const len = arr.length;
    if (!len) return undefined;
    const top = arr[0];
    const last = arr.pop();
    if (len > 1) {
      arr[0] = last;
      let idx = 0;
      const half = (len - 1) >> 1;
      while (idx < half) {
        let left = (idx << 1) + 1;
        let smallest = left;
        const right = left + 1;
        if (right < arr.length && arr[right].cost < arr[left].cost) {
          smallest = right;
        }
        if (arr[idx].cost <= arr[smallest].cost) break;
        const tmp = arr[idx];
        arr[idx] = arr[smallest];
        arr[smallest] = tmp;
        idx = smallest;
      }
    }
    return top;
  }
}
