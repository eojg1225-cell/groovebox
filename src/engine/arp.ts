/**
 * ARP: a track setting (any track type, not part of its sound). While a note is held, its
 * chord tones (CHORD / NOTES) are played in turn over OCTAVES, at RATE. The ARP key turns it
 * on / off for a track; MODE OFF (the default) keeps it silent even when on.
 */
import { choice, type ParamSpec } from './params';

/**
 * How the held chord (over ARP OCT octaves) is stepped through. CASCADE goes up (or down) in
 * overlapping skips: 1 5 3 7 5 9 ... (or from the top: 11 7 9 5 7 3 ...).
 */
export const ARP_MODES = ['OFF', 'UP', 'DOWN', 'UP/DN', 'CASC UP', 'CASC DN', 'RANDOM'] as const;
/** ARP speeds in 16th steps. */
export const ARP_RATES = [
  { name: '1/4', steps: 4 }, { name: '1/8', steps: 2 }, { name: '1/8T', steps: 4 / 3 },
  { name: '1/16', steps: 1 }, { name: '1/16T', steps: 2 / 3 }, { name: '1/32', steps: 0.5 },
] as const;

export type ArpId = 'mode' | 'rate' | 'oct';

/** The ARP view's knobs (FUNC + ARP). Values are option indices. */
export const ARP_PARAMS: readonly ParamSpec[] = [
  choice('mode', 'ARP MODE', ARP_MODES),
  choice('rate', 'ARP RATE', ARP_RATES.map((r) => r.name), 3),
  choice('oct', 'ARP OCT', ['1 OCT', '2 OCT', '3 OCT']),
];

export interface ArpState {
  on: boolean;
  mode: number;
  rate: number;
  oct: number;
}

export function defaultArp(): ArpState {
  return { on: false, mode: 0, rate: 3, oct: 0 };
}
