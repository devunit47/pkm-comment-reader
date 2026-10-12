export function fakeClock() {
  let time = 1000000, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    get size() { return timers.size; },
    async tick(ms) {
      const end = time + ms;
      for (;;) {
        const entry = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        time = entry[1].at; timers.delete(entry[0]); await entry[1].fn();
      }
      time = end;
    },
  };
}
