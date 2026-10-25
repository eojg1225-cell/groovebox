/**
 * The engine's per-sample maths (sines, tanh, powers) in one place, so a faster version
 * (mathFast.ts) can stand in at build time: the sound lab's B engine uses it. These are the
 * exact ones (Math.*); the app uses them. Keep each a plain one-liner so V8 inlines it.
 */
const TWO_PI = 2 * Math.PI;

/** sin(2 pi t): a phase in turns. */
export function sinTurn(t: number): number { return Math.sin(TWO_PI * t); }
/** cos(2 pi t). */
export function cosTurn(t: number): number { return Math.cos(TWO_PI * t); }
/** sin(x), x in radians. */
export function sinRad(x: number): number { return Math.sin(x); }
export function tanh(x: number): number { return Math.tanh(x); }
/** 2^x. */
export function exp2(x: number): number { return Math.pow(2, x); }
/** 10^x. */
export function pow10(x: number): number { return Math.pow(10, x); }
