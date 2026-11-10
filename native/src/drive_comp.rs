//! DRIVE level compensation (ported from the TypeScript engine's driveComp.ts): each type's output is turned
//! down as DRIVE rises, leaving a small lift (DRIVE_LIFT_DB at full drive). The cut is fixed
//! by the DRIVE value, not the signal.

use crate::kind::SoundKind;

const DRIVE_POINTS: [f64; 12] = [1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 20.0, 40.0, 100.0, 200.0];
const DRIVE_LIFT_DB: f64 = 2.5;

/// How much louder (dB, RMS) each type gets at DRIVE_POINTS without compensation.
pub fn drive_rise(kind: SoundKind) -> &'static [f64; 12] {
    match kind {
        SoundKind::Kick => &[0.0, 1.2, 2.5, 4.4, 5.6, 7.0, 7.8, 8.8, 9.9, 11.0, 12.2, 12.9],
        SoundKind::Snare => &[0.0, 1.3, 2.6, 4.5, 5.9, 7.4, 8.4, 9.5, 10.7, 12.0, 13.3, 14.2],
        SoundKind::Hat => &[0.0, 2.2, 4.0, 7.0, 9.1, 12.0, 13.9, 16.2, 18.7, 21.1, 23.4, 24.6],
        SoundKind::Perc => &[0.0, 1.5, 2.9, 5.0, 6.5, 8.2, 9.2, 10.4, 11.7, 13.1, 14.5, 15.3],
        SoundKind::Bass => &[0.0, 2.5, 3.5, 5.0, 5.8, 6.7, 7.0, 7.4, 7.6, 7.8, 7.9, 7.9],
        SoundKind::Pad => &[0.0, 4.1, 5.9, 8.6, 10.5, 12.7, 13.8, 14.9, 15.7, 16.3, 16.6, 16.6],
        SoundKind::Lead => &[0.0, 3.0, 4.2, 5.9, 6.9, 7.8, 8.3, 8.6, 8.9, 9.1, 9.2, 9.2],
        SoundKind::Pluck => &[0.0, 3.9, 5.5, 7.8, 9.3, 10.9, 11.6, 12.3, 12.7, 13.1, 13.3, 13.4],
    }
}

/// Output gain after DRIVE for a type's rise curve (1 = none).
pub fn drive_comp_gain(rise: &[f64; 12], drive: f64) -> f64 {
    if drive <= 1.0 {
        return 1.0;
    }
    let pts = &DRIVE_POINTS;
    let x = drive.min(pts[pts.len() - 1]).ln();
    let mut i = 0;
    while i < pts.len() - 2 && x > pts[i + 1].ln() {
        i += 1;
    }
    let (x0, x1) = (pts[i].ln(), pts[i + 1].ln());
    let db = rise[i] + (rise[i + 1] - rise[i]) * ((x - x0) / (x1 - x0)).min(1.0);
    let top = rise[rise.len() - 1];
    // The whole rise is cut except a share that reaches DRIVE_LIFT_DB at the top.
    let cut = if top > DRIVE_LIFT_DB { db * (1.0 - DRIVE_LIFT_DB / top) } else { 0.0 };
    10f64.powf(-cut / 20.0)
}
