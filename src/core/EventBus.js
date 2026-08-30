/**
 * Minimal synchronous event bus. Listener arrays are copied on emit so that a
 * handler may unsubscribe itself without disturbing the current dispatch.
 */
export class EventBus {
  constructor() {
    this._map = new Map();
  }

  on(name, fn) {
    let list = this._map.get(name);
    if (!list) {
      list = [];
      this._map.set(name, list);
    }
    list.push(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(name, fn) {
    const list = this._map.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(name, payload) {
    const list = this._map.get(name);
    if (!list || list.length === 0) return;
    // Copy: handlers are allowed to unsubscribe during dispatch.
    const snapshot = list.length === 1 ? list : list.slice();
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](payload);
      } catch (err) {
        console.error(`[events] handler for "${name}" threw`, err);
      }
    }
  }

  clear() {
    this._map.clear();
  }
}
