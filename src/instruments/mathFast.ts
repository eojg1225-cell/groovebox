/**
 * Fast stand-ins for math.ts (the same functions), from tables with linear interpolation:
 * sin / cos within 3e-7 (-130 dB), tanh within 6e-7 (-124 dB), 2^x / 10^x within 2e-7 of
 * the value (-134 dB). The sound lab's B engine; not used by the app.
 */
const SIN_N = 4096;
const SIN = new Float64Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN[i] = Math.sin((2 * Math.PI * i) / SIN_N);
const INV_TWO_PI = 1 / (2 * Math.PI);

/** sin(2 pi t): a phase in turns. */
export function sinTurn(t: number): number {
  const x = (t - Math.floor(t)) * SIN_N;
  const i = x | 0;
  const a = SIN[i];
  return a + (SIN[i + 1] - a) * (x - i);
}
/** cos(2 pi t). */
export function cosTurn(t: number): number { return sinTurn(t + 0.25); }
/** sin(x), x in radians. */
export function sinRad(x: number): number { return sinTurn(x * INV_TWO_PI); }

// tanh on 0..10 (odd: the sign put back), 1 beyond (tanh(10) = 1 - 4e-9).
const TANH_MAX = 10;
const TANH_N = 4096;
const TANH_SCALE = TANH_N / TANH_MAX;
const TANH = new Float64Array(TANH_N + 1);
for (let i = 0; i <= TANH_N; i++) TANH[i] = Math.tanh(i / TANH_SCALE);

export function tanh(x: number): number {
  const a = x < 0 ? -x : x;
  if (a >= TANH_MAX) return x < 0 ? -1 : 1;
  const p = a * TANH_SCALE;
  const i = p | 0;
  const y = TANH[i] + (TANH[i + 1] - TANH[i]) * (p - i);
  return x < 0 ? -y : y;
}

// 2^x = 2^floor(x) (a table of whole powers) x 2^frac (interpolated).
const EXP_N = 1024;
const EXP = new Float64Array(EXP_N + 1);
for (let i = 0; i <= EXP_N; i++) EXP[i] = Math.pow(2, i / EXP_N);
const WHOLE_MIN = -1022;
const WHOLE = new Float64Array(2046);
for (let n = 0; n < WHOLE.length; n++) WHOLE[n] = Math.pow(2, n + WHOLE_MIN);

/** 2^x. */
export function exp2(x: number): number {
  const n = Math.floor(x);
  if (n < WHOLE_MIN) return 0;
  if (n > 1023) return Infinity;
  const p = (x - n) * EXP_N;
  const i = p | 0;
  return WHOLE[n - WHOLE_MIN] * (EXP[i] + (EXP[i + 1] - EXP[i]) * (p - i));
}
const LOG2_10 = Math.log2(10);
/** 10^x. */
export function pow10(x: number): number { return exp2(x * LOG2_10); }
