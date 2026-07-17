export type Release = () => void;

export class ConcurrencyGate {
  readonly #limit: number;
  #active = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  tryAcquire(): Release | undefined {
    if (this.#active >= this.#limit) {
      return undefined;
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active -= 1;
    };
  }
}
