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

  next(): number {
    this.current += (this.target - this.current) * this.coeff;
    // Snap when close, which also keeps denormals out of the state.
    if (Math.abs(this.target - this.current) < 1e-9) this.current = this.target;
    return this.current;
  }
}
