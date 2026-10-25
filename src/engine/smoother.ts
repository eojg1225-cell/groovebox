/**
 * One-pole parameter smoother to avoid zipper noise. Allocation-free after construction.
 */
export class Smoother {
  private current: number;
  private target: number;
  private coeff = 0;

  constructor(value: number, timeSeconds: number, sampleRate: number) {
    this.current = value;
    this.target = value;
    this.setTime(timeSeconds, sampleRate);
  }

  setTime(timeSeconds: number, sampleRate: number): void {
    this.coeff = timeSeconds <= 0 ? 1 : 1 - Math.exp(-1 / (timeSeconds * sampleRate));
  }

  setTarget(value: number): void {
    this.target = value;
  }

  setImmediate(value: number): void {
    this.current = value;
    this.target = value;
  }

  get value(): number {
    return this.current;
  }

  /** At its target (next() returns the same value until a new one is set). */
  get settled(): boolean {
    return this.current === this.target;
  }

  /** n steps of next() at once (a block that was skipped). */
  advance(n: number): void {
    if (this.current === this.target) return;
    this.current = this.target + (this.current - this.target) * Math.pow(1 - this.coeff, n);
    if (Math.abs(this.target - this.current) < 1e-9) this.current = this.target;
  }

  next(): number {
    this.current += (this.target - this.current) * this.coeff;
    // Snap when close, which also keeps denormals out of the state.
    if (Math.abs(this.target - this.current) < 1e-9) this.current = this.target;
    return this.current;
  }
}
