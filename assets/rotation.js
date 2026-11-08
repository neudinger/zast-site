// One timer, with explicit user control and temporary visibility/hover holds.
export class Rotation {
  constructor({ next, changed, delay = 12000, schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer) }) {
    Object.assign(this, { next, changed, delay, schedule, cancel });
    this.enabled = false;
    this.holds = new Set();
    this.timer = null;
  }
  start() { this.enabled = true; this.refresh(); }
  stop() { this.enabled = false; this.refresh(); }
  hold(reason, active) {
    if (active) this.holds.add(reason);
    else this.holds.delete(reason);
    this.refresh();
  }
  refresh() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    const running = this.enabled && this.holds.size === 0;
    this.changed({ enabled: this.enabled, running, delay: this.delay });
    if (running) this.timer = this.schedule(() => {
      this.next();
      this.refresh();
    }, this.delay);
  }
}
