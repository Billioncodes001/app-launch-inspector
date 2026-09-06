import { HttpError } from "./errors.js";
export class BrowserCapacity {
  private active = 0;
  private reserved = 0;
  private waiting: Array<{
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    abort: () => void;
  }> = [];
  constructor(
    readonly maxActive = 2,
    readonly maxPending = 20,
  ) {}
  snapshot() {
    return {
      active: this.active,
      pending: this.reserved,
      maxActive: this.maxActive,
      maxPending: this.maxPending,
    };
  }
  reserve() {
    if (this.reserved >= this.maxPending)
      throw new HttpError(
        429,
        "Inspection capacity is full. Try again after a run completes.",
      );
    this.reserved++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.reserved--;
      }
    };
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted)
      return Promise.reject(
        Error("Inspection cancelled before browser allocation"),
      );
    return new Promise((resolve, reject) => {
      const item = {
        signal,
        resolve,
        reject,
        abort: () => {
          this.waiting = this.waiting.filter((w) => w !== item);
          reject(Error("Inspection cancelled before browser allocation"));
        },
      };
      signal.addEventListener("abort", item.abort, { once: true });
      this.waiting.push(item);
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.maxActive && this.waiting.length) {
      const item = this.waiting.shift()!;
      item.signal.removeEventListener("abort", item.abort);
      if (item.signal.aborted) {
        item.reject(Error("Inspection cancelled"));
        continue;
      }
      this.active++;
      let released = false;
      item.resolve(() => {
        if (!released) {
          released = true;
          this.active--;
          this.drain();
        }
      });
    }
  }
}
