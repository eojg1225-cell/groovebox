/**
 * The exact versions of math.ts (Math.*): the same functions, for the sound lab's B engine
 * (its `exactMath` Vite plugin swaps them in) and the accuracy test. Not used by the app.
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
