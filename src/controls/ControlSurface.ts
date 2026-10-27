/**
 * Hardware-agnostic control events. The on-screen panel is the first implementation;
 * physical knobs/faders/buttons will emit the same events later.
 */
export type ControlEvent =
  /** Absolute knob/pot position, normalised 0..1 (on-screen knobs: 0-127 steps). */
  | { type: 'knob'; id: string; value: number }
  /**
   * Relative rotary-encoder turn in detents (+ = clockwise). Hardware with endless
   * encoders sends these; one detent = one 0-127 step (finer for TEMPO).
   */
  | { type: 'encoder'; id: string; delta: number }
  | { type: 'fader'; id: string; value: number } // value normalised 0..1
  /** A knob touched (finger / mouse down on it), before or without any turn. */
  | { type: 'touch'; id: string }
  | { type: 'button'; id: string; pressed: boolean }
  | { type: 'joystick'; id: string; x: number; y: number }; // -1..1

export type ControlListener = (e: ControlEvent) => void;

export interface ControlSurface {
  subscribe(listener: ControlListener): () => void;
  /** Move a control to a value without emitting (e.g. after loading a project). */
  setKnob(id: string, value: number): void;
  setButtonLit(id: string, lit: boolean): void;
}

/** Small helper for implementations. */
export class ControlEmitter {
  private listeners: ControlListener[] = [];

  subscribe(listener: ControlListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(e: ControlEvent): void {
    for (const l of this.listeners) l(e);
  }
}
