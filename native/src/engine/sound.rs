//! The engine's sound side: automation lanes (song and pattern locks), live offsets, the
//! instruments' parameters, per-pattern patches and their glides, the mixer, the LFO, the
//! buses and the master.

use serde_json::Value;

use super::json::*;
use super::tables::*;
use super::*;
use crate::dsp::silent;
use crate::js;
use crate::params::{to_norm, to_value};

impl Engine {
    // ------------------------------------------------------------------ lanes

    pub(super) fn make_lane(&self, key: &str, points: &[(f64, f64)]) -> Option<Lane> {
        let (kind, index, id) = parse_auto_key(key)?;
        if points.is_empty() {
            return None;
        }
        let spec = match kind {
            AutoKind::M => find_spec(&specs::MIX_PARAMS, id),
            AutoKind::B => match index {
                0 => find_spec(&specs::BUS0_PARAMS, id),
                1 => find_spec(&specs::BUS1_PARAMS, id),
                _ => None,
            },
            AutoKind::L => find_spec(&specs::LFO_PARAMS, id),
            AutoKind::A => find_spec(&specs::ARP_PARAMS, id),
            _ => None,
        };
        Some(Lane {
            key: key.to_string(),
            kind,
            index,
            id: id.to_string(),
            pos: points.iter().map(|p| p.0).collect(),
            val: points.iter().map(|p| p.1).collect(),
            spec,
            active: false,
            last: f64::NAN,
            inst: None,
            slot: -1,
            links: Vec::new(),
        })
    }

    pub(super) fn flush_pat_lanes(&mut self) {
        self.pat_dirty = false;
        for k in 0..PAT_SLOTS {
            if self.pat_lanes_dirty[k] == 0 {
                continue;
            }
            self.pat_lanes_dirty[k] = 0;
            let ch = k / NUM_PATTERNS;
            let mut old = std::mem::take(&mut self.pat_lanes[k]);
            for lane in old.iter_mut() {
                if lane.active {
                    self.release_pat_lane(lane);
                }
            }
            let mut points: Vec<(String, Vec<(f64, f64)>)> = Vec::new();
            for i in 0..MAX_STEPS {
                let Some(src) = &self.step_lock_src[k * MAX_STEPS + i] else { continue };
                for (id, v) in src {
                    let key = if id.contains(':') { id.clone() } else { format!("s:{ch}:{id}") };
                    match points.iter_mut().find(|(k2, _)| *k2 == key) {
                        Some(e) => e.1.push((i as f64, *v)),
                        None => points.push((key, vec![(i as f64, *v)])),
                    }
                }
            }
            let mut lanes = Vec::new();
            for (key, pts) in &points {
                if let Some(l) = self.make_lane(key, pts) {
                    lanes.push(l);
                }
            }
            self.pat_lanes[k] = lanes;
        }
    }

    pub(super) fn run_pat_auto(&mut self) {
        for ch in 0..NC {
            let pat = self.seq_pattern(ch);
            if self.lane_pat[ch] as i32 != pat as i32 {
                self.release_pat_lanes(ch);
                self.lane_pat[ch] = pat as i8;
            }
            let k = ch * NUM_PATTERNS + pat;
            if self.pat_lanes[k].is_empty() {
                continue;
            }
            let mut lanes = std::mem::take(&mut self.pat_lanes[k]);
            let idx = self.current_step[ch];
            if idx < 0 || self.song_off[ch] != 0 || self.current[ch].is_none() {
                for lane in lanes.iter_mut() {
                    if lane.active {
                        self.release_pat_lane(lane);
                    }
                }
                self.pat_lanes[k] = lanes;
                continue;
            }
            let p = idx as f64 + (self.chan_elapsed[ch] / self.chan_len[ch]).min(1.0);
            for lane in lanes.iter_mut() {
                if let Some(&si) = self.song_lane_by_key.get(&lane.key) {
                    if self.lanes[si].active {
                        lane.active = false;
                        continue;
                    }
                }
                let spec = if lane.kind == AutoKind::S { self.lane_spec(lane) } else { lane.spec };
                if lane.kind == AutoKind::S && spec.is_none() {
                    continue;
                }
                let v = value_at(&lane.pos, &lane.val, p, spec);
                if v.is_nan() {
                    if lane.active {
                        self.release_pat_lane(lane);
                    }
                    continue;
                }
                if lane.active && v == lane.last && !(lane.kind == AutoKind::S && self.auto_stale[lane.index] != 0) {
                    continue;
                }
                lane.active = true;
                lane.last = v;
                self.apply_pat_lane(lane, v);
            }
            self.pat_lanes[k] = lanes;
        }
    }

    fn apply_pat_lane(&mut self, lane: &Lane, v: f64) {
        if lane.kind != AutoKind::S {
            self.apply_lane(lane, v);
            return;
        }
        let ch = lane.index;
        let params = params_of(self.current[ch]);
        let slot = lane.slot as usize;
        let x = self.with_offset(ch, slot, v);
        self.apply_param(ch, params[slot].id, x);
        self.lock_applied[ch * LOCK_SLOTS + slot] = 1;
        for &k in &lane.links {
            let x = self.with_offset(ch, k, v);
            self.apply_param(ch, params[k].id, x);
            self.lock_applied[ch * LOCK_SLOTS + k] = 1;
        }
    }

    fn release_pat_lane(&mut self, lane: &mut Lane) {
        if lane.kind != AutoKind::S {
            self.release_lane(lane);
            return;
        }
        lane.active = false;
        lane.last = f64::NAN;
        let ch = lane.index;
        if self.current[ch].is_none() || self.lane_spec(lane).is_none() {
            return;
        }
        self.unlock_slot(ch, lane.slot as usize);
        for &k in &lane.links {
            self.unlock_slot(ch, k);
        }
    }

    fn unlock_slot(&mut self, ch: usize, k: usize) {
        self.lock_applied[ch * LOCK_SLOTS + k] = 0;
        let params = params_of(self.current[ch]);
        let x = self.with_offset(ch, k, self.base_value[ch * LOCK_SLOTS + k] as f64);
        self.apply_param(ch, params[k].id, x);
    }

    pub(super) fn release_pat_lanes(&mut self, ch: usize) {
        let pat = self.lane_pat[ch];
        if pat < 0 {
            return;
        }
        let k = ch * NUM_PATTERNS + pat as usize;
        let mut lanes = std::mem::take(&mut self.pat_lanes[k]);
        for lane in lanes.iter_mut() {
            if lane.active {
                self.release_pat_lane(lane);
            }
        }
        self.pat_lanes[k] = lanes;
        self.lane_pat[ch] = -1;
    }

    /// A sound parameter to the instrument; MID FREQ goes to the track's MID CUT.
    pub(super) fn apply_param(&mut self, ch: usize, id: &str, value: f64) {
        if id == "midfreq" {
            self.cuts[ch].set_freq(value);
        } else if let Some(i) = self.inst(ch) {
            i.set_param(id, value);
        }
    }

    fn move_tone(&mut self, ch: usize, n: f64) {
        let to = self.tone_target[ch] as f64;
        let now = self.tone_now[ch] as f64;
        let k = 1.0 - (-n / (TONE_SMOOTH * self.sample_rate)).exp();
        let mut fc = now * (to / now).powf(k);
        if (fc - to).abs() < to * 0.002 {
            fc = to;
        }
        self.tone_now[ch] = fc as f32;
        let sr = self.sample_rate;
        self.tone_l[ch].setup(fc, 0.0, sr);
        self.tone_r[ch].setup(fc, 0.0, sr);
    }

    pub(super) fn run_auto(&mut self) {
        let g = self.global_step - 1.0;
        let step = (1.0 - self.frames_to_step / self.last_step_frames).max(0.0).min(1.0);
        let bar = self.row_start[self.song_row as usize] + self.song_bar.max(0);
        let p = (bar * CELLS_PER_BAR) as f64 + self.cell_of[self.bar_pos(g) as usize] as f64 + step;
        let mut lanes = std::mem::take(&mut self.lanes);
        for lane in lanes.iter_mut() {
            let spec = if lane.kind == AutoKind::S { self.lane_spec(lane) } else { lane.spec };
            if lane.kind == AutoKind::S && spec.is_none() {
                continue;
            }
            let v = value_at(&lane.pos, &lane.val, p, spec);
            if v.is_nan() {
                if lane.active {
                    self.release_lane(lane);
                }
                continue;
            }
            if lane.active && v == lane.last && !(lane.kind == AutoKind::S && self.auto_stale[lane.index] != 0) {
                continue;
            }
            lane.active = true;
            lane.last = v;
            self.apply_lane(lane, v);
        }
        self.lanes = lanes;
        self.auto_stale = [0; NC];
        self.auto_snap = false;
    }

    /// A sound lane's slot on the track's instrument now (None = it has none).
    fn lane_spec(&self, lane: &mut Lane) -> Option<&'static Spec> {
        let kind = self.current.get(lane.index).copied().flatten()?;
        if lane.inst != Some(kind) {
            lane.inst = Some(kind);
            lane.slot = slot_of(Some(kind), &lane.id);
            lane.links = specs::linked_params(kind, &lane.id)
                .iter()
                .map(|id| slot_of(Some(kind), id))
                .filter(|&s| s >= 0)
                .map(|s| s as usize)
                .collect();
        }
        if lane.slot >= 0 {
            Some(&specs::kind_params(kind)[lane.slot as usize])
        } else {
            None
        }
    }

    fn apply_lane(&mut self, lane: &Lane, v: f64) {
        self.auto_applying = true;
        let i = lane.index;
        match lane.kind {
            AutoKind::S => {
                let params = params_of(self.current[i]);
                self.set_sound(i, &lane.id, v, lane.slot);
                for &s in &lane.links {
                    self.set_sound(i, params[s].id, v, s as i32);
                }
            }
            AutoKind::M => {
                if i < NC {
                    self.set_mix(i, &lane.id, v);
                    if self.auto_snap {
                        match lane.id.as_str() {
                            "volume" => self.volume[i].set_immediate(v),
                            "pan" => self.pan[i].set_immediate(v),
                            "send" => self.send_level[i].set_immediate(v),
                            _ => {}
                        }
                    }
                }
            }
            AutoKind::O => {
                if i < NC {
                    self.set_offset(i, &lane.id, v)
                }
            }
            AutoKind::B => self.set_bus_param(i, &lane.id, v),
            AutoKind::L => self.set_lfo(&lane.id, v),
            AutoKind::A => {
                if i < NC {
                    self.set_arp(i, &lane.id, v)
                }
            }
        }
        self.auto_applying = false;
    }

    fn release_lane(&mut self, lane: &mut Lane) {
        lane.active = false;
        lane.last = f64::NAN;
        if lane.kind == AutoKind::S {
            if self.current.get(lane.index).copied().flatten().is_none() || self.lane_spec(lane).is_none() {
                return;
            }
            let i = lane.index;
            let params = params_of(self.current[i]);
            let at = (i * NUM_PATTERNS + self.active_pattern[i] as usize) * LOCK_SLOTS;
            self.auto_applying = true;
            let v = self.patch_value[at + lane.slot as usize] as f64;
            self.set_sound(i, &lane.id, v, lane.slot);
            for &s in &lane.links {
                let v = self.patch_value[at + s] as f64;
                self.set_sound(i, params[s].id, v, s as i32);
            }
            self.auto_applying = false;
            return;
        }
        let base = self.auto_base.get(&lane.key).copied();
        let v = base.unwrap_or(if lane.kind == AutoKind::O { 0.0 } else { lane.spec.map_or(0.0, |s| s.default) });
        self.apply_lane(lane, v);
    }

    pub(super) fn release_lanes(&mut self) {
        let mut lanes = std::mem::take(&mut self.lanes);
        for lane in lanes.iter_mut() {
            if lane.active {
                self.release_lane(lane);
            }
        }
        self.lanes = lanes;
    }

    pub(super) fn set_bus_param(&mut self, k: usize, id: &str, value: f64) {
        if !self.auto_applying {
            self.auto_base.insert(format!("b:{k}:{id}"), value);
        }
        if let Some(b) = self.buses.get_mut(k) {
            b.set_param(id, value);
        }
    }

    // ------------------------------------------------------------------ live offsets

    /// A slot's value with the relative LIVE knobs' push added (clamped to its range).
    pub(super) fn with_offset(&self, ch: usize, slot: usize, value: f64) -> f64 {
        let off = self.offset_norm[ch * LOCK_SLOTS + slot];
        if off == 0.0 {
            return value;
        }
        let spec = &params_of(self.current[ch])[slot];
        let n = to_norm(spec, value) + off as f64;
        to_value(spec, if n < 0.0 { 0.0 } else if n > 1.0 { 1.0 } else { n })
    }

    pub(super) fn set_offset(&mut self, ch: usize, id: &str, value: f64) {
        if !self.auto_applying {
            self.auto_base.insert(format!("o:{ch}:{id}"), value);
        }
        {
            let offsets = &mut self.live_offsets[ch];
            if value == 0.0 {
                offsets.retain(|(k, _)| k != id);
            } else {
                let v = value.min(1.0).max(-1.0);
                match offsets.iter_mut().find(|(k, _)| k == id) {
                    Some(e) => e.1 = v,
                    None => offsets.push((id.to_string(), v)),
                }
            }
        }
        let Some(kind) = self.current[ch] else { return };
        let params = specs::kind_params(kind);
        let base = ch * LOCK_SLOTS;
        let n = params.len().min(LOCK_SLOTS);
        for k in 0..n {
            self.prev_offset[k] = self.offset_norm[base + k];
        }
        self.offset_norm[base..base + LOCK_SLOTS].fill(0.0);
        for oi in 0..self.live_offsets[ch].len() {
            let v = self.live_offsets[ch][oi].1;
            let key = &self.live_offsets[ch][oi].0;
            if !key.starts_with("macro:") {
                continue;
            }
            let Some(targets) = specs::live_macros(kind).iter().find(|m| m.0 == key).map(|m| m.1) else { continue };
            // macroAnchor: where its targets sit as set.
            let mut sum = 0.0;
            let mut cnt = 0;
            for &(tid, amount, top) in targets {
                if top {
                    continue;
                }
                let slot = slot_of(Some(kind), tid);
                if slot < 0 {
                    continue;
                }
                let nv = to_norm(&params[slot as usize], self.base_value[base + slot as usize] as f64);
                sum += if amount < 0.0 { 1.0 - nv } else { nv };
                cnt += 1;
            }
            let anchor = if cnt > 0 { sum / cnt as f64 } else { 0.5 };
            for &(tid, amount, top) in targets {
                let slot = slot_of(Some(kind), tid);
                if slot < 0 {
                    continue;
                }
                let c = if top {
                    let half = (1.0 - anchor) / 2.0;
                    if half > 0.0 && v > half { ((v - half) / half) * amount } else { 0.0 }
                } else {
                    v * amount
                };
                js::add_f32(&mut self.offset_norm[base + slot as usize], c);
            }
        }
        for k in 0..n {
            if self.offset_norm[base + k] == self.prev_offset[k] || self.lock_applied[base + k] != 0 {
                continue;
            }
            let x = self.with_offset(ch, k, self.base_value[base + k] as f64);
            self.apply_param(ch, params[k].id, x);
        }
    }

    pub(super) fn set_instrument(&mut self, ch: usize, kind: Option<SoundKind>, sound: &[(String, f64)]) {
        self.release_pat_lanes(ch);
        if self.arp_held[ch] != 0 {
            self.stop_arp(ch);
        }
        self.roll_div[ch] = 0.0;
        if let Some(i) = self.inst(ch) {
            i.note_off(-1.0);
        }
        self.clear_holds(ch);
        self.gate_steps[ch] = 0;
        self.gate_at[ch] = -1.0;
        self.current[ch] = kind;
        self.apply_chain(ch);
        self.type_gain[ch] = kind.map_or(1.0, specs::type_gain) as f32;
        self.live_offsets[ch].clear();
        self.offset_norm[ch * LOCK_SLOTS..(ch + 1) * LOCK_SLOTS].fill(0.0);
        self.lock_applied[ch * LOCK_SLOTS..(ch + 1) * LOCK_SLOTS].fill(0);
        self.glide_pattern[ch] = -1;
        if kind.is_some() {
            let params = params_of(kind);
            for (slot, spec) in params.iter().enumerate() {
                let v = lookup(sound, spec.id).unwrap_or(spec.default);
                self.set_sound(ch, spec.id, v, slot as i32);
            }
            for pat in 0..NUM_PATTERNS {
                self.store_patch(ch, pat, sound);
            }
        }
    }

    // ------------------------------------------------------------------ audio

    pub(super) fn render_chunk(&mut self, out_l: &mut [f32], out_r: &mut [f32], off: usize, n: usize) {
        for k in 0..NUM_SENDS {
            self.bus_l[k][..n].fill(0.0);
            self.bus_r[k][..n].fill(0.0);
        }
        let lfo_active = self.lfo_vol > 0.0 || self.lfo_pitch > 0.0 || self.lfo_filter > 0.0 || self.lfo_pan > 0.0 || self.lfo_send > 0.0 || self.lfo_fm > 0.0;
        for ch in 0..NC {
            let Some(kind) = self.current[ch] else { continue };
            if self.tone_now[ch] != self.tone_target[ch] {
                self.move_tone(ch, n as f64);
            }
            self.scratch_l[..n].fill(0.0);
            self.scratch_r[..n].fill(0.0);
            let lfo = lfo_active && self.lfo_on[ch] == 1;
            let lb = ch * CHUNK;
            if lfo {
                self.fill_lfo(ch, n);
            }
            let ki = kind_index(kind);
            let lb0 = self.lfo_buf[lb] as f64;
            {
                let inst = &mut self.insts[ch][ki];
                if lfo && self.lfo_pitch > 0.0 {
                    inst.set_pitch_mod(self.lfo_pitch * lb0);
                    self.pitch_mod_on[ch] = 1;
                } else if self.pitch_mod_on[ch] != 0 {
                    inst.set_pitch_mod(0.0);
                    self.pitch_mod_on[ch] = 0;
                }
                if lfo && self.lfo_filter > 0.0 {
                    inst.set_filter_mod(self.lfo_filter * lb0);
                    self.filter_mod_on[ch] = 1;
                } else if self.filter_mod_on[ch] != 0 {
                    inst.set_filter_mod(0.0);
                    self.filter_mod_on[ch] = 0;
                }
                if lfo && self.lfo_fm > 0.0 {
                    inst.set_fm_mod(self.lfo_fm * lb0);
                    self.fm_mod_on[ch] = 1;
                } else if self.fm_mod_on[ch] != 0 {
                    inst.set_fm_mod(0.0);
                    self.fm_mod_on[ch] = 0;
                }
                inst.render(&mut self.scratch_l, &mut self.scratch_r, n);
                let sl = &mut self.scratch_l[..n];
                let sr = &mut self.scratch_r[..n];
                let tl = &mut self.tone_l[ch];
                let tr = &mut self.tone_r[ch];
                if !(tl.quiet() && tr.quiet() && silent(sl, sr)) {
                    for i in 0..n {
                        tl.process(sl[i] as f64);
                        tr.process(sr[i] as f64);
                        sl[i] = tl.low as f32;
                        sr[i] = tr.low as f32;
                    }
                }
                inst.post(sl, sr);
                self.cuts[ch].process(sl, sr);
            }
            let vol_depth = if lfo { self.lfo_vol } else { 0.0 };
            let pan_depth = if lfo { self.lfo_pan } else { 0.0 };
            let send_depth = if lfo { self.lfo_send } else { 0.0 };
            let tg = self.type_gain[ch] as f64;
            let bus = self.route[ch];
            let drum = self.in_drum_bus[ch] != 0;
            let sl = &self.scratch_l;
            let sr = &self.scratch_r;
            let vol = &mut self.volume[ch];
            let pan = &mut self.pan[ch];
            let level = &mut self.send_level[ch];
            if silent(&sl[..n], &sr[..n]) {
                vol.advance(n as u32);
                pan.advance(n as u32);
                level.advance(n as u32);
                continue;
            }
            let (b01_l, b1_l) = self.bus_l.split_at_mut(1);
            let (b01_r, b1_r) = self.bus_r.split_at_mut(1);
            let d0l = &mut b01_l[0];
            let d0r = &mut b01_r[0];
            let send_l: Option<&mut [f32; CHUNK]> = if bus == 1 { Some(&mut b1_l[0]) } else { None };
            let send_r: Option<&mut [f32; CHUNK]> = if bus == 1 { Some(&mut b1_r[0]) } else { None };
            // A send onto bus 0 (never routed: FX 1 is the drum bus) is left out, as busIndex never gives it.
            let (mut send_l, mut send_r) = (send_l, send_r);
            if vol_depth == 0.0 && pan_depth == 0.0 && send_depth == 0.0 && vol.settled() && pan.settled() && level.settled() {
                let v = vol.value() * tg;
                let a = (pan.value() + 1.0) * 0.25 * std::f64::consts::PI;
                let cl = a.cos();
                let cr = a.sin();
                let g = level.value();
                for i in 0..n {
                    let l = sl[i] as f64 * v * cl;
                    let r = sr[i] as f64 * v * cr;
                    if drum {
                        js::add_f32(&mut d0l[i], l);
                        js::add_f32(&mut d0r[i], r);
                    } else {
                        js::add_f32(&mut out_l[off + i], l);
                        js::add_f32(&mut out_r[off + i], r);
                    }
                    if let (Some(bl), Some(br)) = (send_l.as_deref_mut(), send_r.as_deref_mut()) {
                        js::add_f32(&mut bl[i], l * g);
                        js::add_f32(&mut br[i], r * g);
                    }
                }
                continue;
            }
            let lfo_buf = &self.lfo_buf;
            for i in 0..n {
                let mut v = vol.next() * tg;
                if vol_depth > 0.0 {
                    v *= 1.0 - vol_depth * (0.5 - 0.5 * lfo_buf[lb + i] as f64);
                }
                let mut pp = pan.next();
                if pan_depth > 0.0 {
                    pp += pan_depth * lfo_buf[lb + i] as f64;
                    pp = if pp > 1.0 { 1.0 } else if pp < -1.0 { -1.0 } else { pp };
                }
                let a = (pp + 1.0) * 0.25 * std::f64::consts::PI;
                let l = sl[i] as f64 * v * a.cos();
                let r = sr[i] as f64 * v * a.sin();
                if drum {
                    js::add_f32(&mut d0l[i], l);
                    js::add_f32(&mut d0r[i], r);
                } else {
                    js::add_f32(&mut out_l[off + i], l);
                    js::add_f32(&mut out_r[off + i], r);
                }
                let mut g = level.next();
                if send_depth > 0.0 {
                    g += send_depth * lfo_buf[lb + i] as f64;
                    g = if g > 1.0 { 1.0 } else if g < 0.0 { 0.0 } else { g };
                }
                if let (Some(bl), Some(br)) = (send_l.as_deref_mut(), send_r.as_deref_mut()) {
                    js::add_f32(&mut bl[i], l * g);
                    js::add_f32(&mut br[i], r * g);
                }
            }
        }
        for k in 0..NUM_BUSES {
            self.buses[k].process(&mut self.bus_l[k][..n], &mut self.bus_r[k][..n], &mut out_l[off..off + n], &mut out_r[off..off + n]);
        }
        self.lfo_clock += n as f64 * self.lfo_step_inc();
    }

    fn lfo_step_inc(&self) -> f64 {
        (self.bpm * 4.0) / (60.0 * self.sample_rate)
    }

    fn fill_lfo(&mut self, ch: usize, n: usize) {
        let inc = self.lfo_step_inc();
        let steps = self.lfo_steps;
        let t0 = if self.lfo_retrig { self.lfo_clock - self.lfo_trig[ch] } else { self.lfo_clock };
        let offset = self.lfo_phase + (self.lfo_spread * ch as f64) / NC as f64;
        let k = if self.lfo_smooth > 0.0 { 1.0 - (-inc / (self.lfo_smooth * steps * 0.25)).exp() } else { 1.0 };
        let base = ch * CHUNK;
        let mut y = self.lfo_y[ch] as f64;
        for i in 0..n {
            let t = t0 + i as f64 * inc;
            let pos = t / steps + offset;
            let cycle = pos.floor();
            if cycle != self.lfo_cycle[ch] {
                self.lfo_cycle[ch] = cycle;
                self.lfo_held[ch] = self.lfo_noise.next() as f32;
            }
            y += (lfo_value(self.lfo_shape, pos - cycle, self.lfo_held[ch] as f64, self.lfo_morph) - y) * k;
            let fade = if self.lfo_fade > 0.0 { (t.max(0.0) / self.lfo_fade).min(1.0) } else { 1.0 };
            self.lfo_buf[base + i] = (y * fade) as f32;
        }
        self.lfo_y[ch] = y as f32;
    }

    pub(super) fn lfo_rate_steps(&self) -> f64 {
        if self.lfo_rate < 0 || self.lfo_rate as usize >= LFO_STEPS.len() {
            return 4.0;
        }
        let r = self.lfo_rate as usize;
        if r < LFO_BAR_RATES {
            (LFO_STEPS[r] * self.bar_len as f64) / 16.0
        } else {
            LFO_STEPS[r]
        }
    }

    pub(super) fn set_lfo(&mut self, id: &str, value: f64) {
        if !self.auto_applying {
            self.auto_base.insert(format!("l:{id}"), value);
        }
        match id {
            "rate" => {
                self.lfo_rate = js::round(value) as i32;
                self.lfo_steps = self.lfo_rate_steps();
                self.lfo_cycle = [-1.0; NC];
            }
            "shape" => self.lfo_shape = js::round(value) as i32,
            "morph" => self.lfo_morph = value,
            "fm" => self.lfo_fm = value,
            "vol" => self.lfo_vol = value,
            "pitch" => self.lfo_pitch = value,
            "filter" => self.lfo_filter = value,
            "pan" => self.lfo_pan = value,
            "phase" => self.lfo_phase = value,
            "smooth" => self.lfo_smooth = value,
            "fade" => self.lfo_fade = value * 16.0,
            "retrig" => self.lfo_retrig = js::round(value) == 1.0,
            "send" => self.lfo_send = value,
            "spread" => self.lfo_spread = value,
            _ => {}
        }
    }

    pub(super) fn finish_block(&mut self, out_l: &mut [f32], out_r: &mut [f32], frames: usize) {
        for i in 0..frames {
            let g = self.master.next() * std::f64::consts::SQRT_2;
            out_l[i] = (out_l[i] as f64 * g) as f32;
            out_r[i] = (out_r[i] as f64 * g) as f32;
        }
        if self.clicked && self.click_level > 0.0 {
            let k = 0.5 * self.click_level;
            for i in 0..frames {
                let c = self.click_buf[i] as f64 * k;
                js::add_f32(&mut out_l[i], c);
                js::add_f32(&mut out_r[i], c);
            }
        }
        self.limiter.process(&mut out_l[..frames], &mut out_r[..frames]);
        let mut pl = self.peak_l;
        let mut pr = self.peak_r;
        for i in 0..frames {
            let al = (out_l[i] as f64).abs();
            let ar = (out_r[i] as f64).abs();
            if al > pl {
                pl = al;
            }
            if ar > pr {
                pr = ar;
            }
        }
        self.peak_l = pl;
        self.peak_r = pr;
        self.frame += frames as f64;
    }

    // ------------------------------------------------------------------ patches

    pub(super) fn edited_pattern(&self, ch: usize) -> usize {
        if self.pending_pattern[ch] >= 0 {
            self.pending_pattern[ch] as usize
        } else {
            self.active_pattern[ch] as usize
        }
    }

    pub(super) fn frames_ahead(&self, steps: f64) -> f64 {
        let mut f = self.frames_to_step.max(0.0);
        let mut k = 0.0;
        while k < steps {
            f += self.step_frames(self.global_step + k);
            k += 1.0;
        }
        f
    }

    fn frames_to_bar(&self) -> f64 {
        let bl = self.bar_len as f64;
        let steps = (bl - self.bar_pos(self.global_step)) % bl;
        let f = self.frames_ahead(steps);
        if f < self.step_frames(self.global_step) {
            self.frames_ahead(steps + bl)
        } else {
            f
        }
    }

    pub(super) fn store_patch(&mut self, ch: usize, pat: usize, sound: &[(String, f64)]) {
        let Some(kind) = self.current[ch] else { return };
        let params = specs::kind_params(kind);
        let base = (ch * NUM_PATTERNS + pat) * LOCK_SLOTS;
        for (k, p) in params.iter().take(LOCK_SLOTS).enumerate() {
            self.patch_value[base + k] = lookup(sound, p.id).unwrap_or(p.default) as f32;
        }
    }

    pub(super) fn set_patch_sound(&mut self, ch: usize, pat: usize, id: &str, value: f64) {
        let Some(kind) = self.current[ch] else { return };
        let slot = slot_of(Some(kind), id);
        if slot < 0 {
            if pat == self.active_pattern[ch] as usize {
                self.set_sound(ch, id, value, -1);
            }
            return;
        }
        let su = slot as usize;
        self.patch_value[(ch * NUM_PATTERNS + pat) * LOCK_SLOTS + su] = value as f32;
        let gliding = self.glide_pattern[ch];
        if gliding < 0 {
            if pat == self.active_pattern[ch] as usize {
                self.set_sound(ch, id, value, slot);
            }
        } else if pat == gliding as usize {
            let spec = &specs::kind_params(kind)[su];
            if spec.coarse || spec.options > 0 {
                if pat == self.active_pattern[ch] as usize {
                    self.set_sound(ch, id, value, slot);
                }
            } else {
                self.glide_to[ch * LOCK_SLOTS + su] = to_norm(spec, value) as f32;
            }
        }
    }

    pub(super) fn set_patch(&mut self, ch: usize, pat: usize, sound: &[(String, f64)], glide: bool) {
        if self.current[ch].is_none() {
            return;
        }
        self.store_patch(ch, pat, sound);
        let target = if self.glide_pattern[ch] >= 0 { self.glide_pattern[ch] as usize } else { self.active_pattern[ch] as usize };
        if pat != target {
            return;
        }
        if glide && self.playing {
            let left = if self.glide_pattern[ch] >= 0 { self.glide_total[ch] - self.glide_done[ch] } else { 0.0 };
            let f = left.max(self.frames_to_bar());
            self.start_glide(ch, pat, f);
        } else {
            self.glide_pattern[ch] = -1;
            self.enter_pattern(ch, pat, true);
        }
    }

    pub(super) fn select_pattern(&mut self, ch: usize, pat: usize, immediate: bool) {
        if !self.playing {
            self.pending_pattern[ch] = -1;
            self.glide_pattern[ch] = -1;
            self.enter_pattern(ch, pat, true);
            return;
        }
        let active = self.active_pattern[ch] as usize;
        if self.fill_pat[ch] >= 0 && self.pending_pattern[ch] >= 0 && self.land_at[ch] > self.global_step && !immediate {
            let left = self.land_at[ch] - self.global_step;
            self.pending_pattern[ch] = pat as i8;
            if pat != active {
                self.start_fill(ch, pat, left);
            }
            let f = if pat == active { CANCEL_PATCH_GLIDE * self.sample_rate } else { self.frames_ahead(left) };
            self.start_glide(ch, pat, f);
            return;
        }
        if pat == active {
            self.fill_at[ch] = -1.0;
            if self.pending_pattern[ch] >= 0 || self.glide_pattern[ch] >= 0 {
                self.pending_pattern[ch] = -1;
                self.start_glide(ch, pat, CANCEL_PATCH_GLIDE * self.sample_rate);
            }
            return;
        }
        if immediate {
            self.fill_pat[ch] = -1;
            self.fill_at[ch] = -1.0;
            self.pending_pattern[ch] = -1;
            self.start_glide(ch, pat, 0.0);
            self.enter_pattern(ch, pat, false);
            return;
        }
        self.pending_pattern[ch] = pat as i8;
        self.land_at[ch] = -1.0;
        let ahead = self.loop_ahead(ch);
        let f = self.frames_ahead(ahead);
        self.start_glide(ch, pat, f);
        self.plan_fill(ch, ahead);
    }

    pub(super) fn seq_pattern(&self, ch: usize) -> usize {
        if self.fill_pat[ch] >= 0 {
            self.fill_pat[ch] as usize
        } else {
            self.active_pattern[ch] as usize
        }
    }

    fn plan_fill(&mut self, ch: usize, ahead: f64) {
        self.fill_at[ch] = -1.0;
        if self.song_on || self.auto_fill_on[ch] == 0 || self.auto_fill_steps <= 0.0 || ahead <= 0.0 {
            return;
        }
        self.land_at[ch] = self.global_step + ahead;
        self.fill_at[ch] = self.global_step + ahead - ahead.min(self.auto_fill_steps);
    }

    pub(super) fn start_fill(&mut self, ch: usize, fp: usize, steps: f64) {
        if steps <= 0.0 || self.current[ch].is_none() {
            return;
        }
        let k = ch * NUM_PATTERNS + fp;
        let len = self.pattern_length[k] as usize;
        let base = k * MAX_STEPS;
        self.fill_pat[ch] = fp as i8;
        self.run_left[ch] = 0;
        self.roll_left[ch] = 0;
        self.loop_start[ch] = 0;
        let first = self.next_on(base, 0, len);
        self.position[ch] = if first < 0 {
            0
        } else {
            let back = -(js::round(steps / self.pattern_rate[k] as f64).max(1.0));
            u8w(self.walk_on(base, first, back, len) as f64)
        };
    }

    fn loop_ahead(&self, ch: usize) -> f64 {
        if self.fill_pat[ch] >= 0 && self.land_at[ch] > self.global_step {
            return self.land_at[ch] - self.global_step;
        }
        let cur = ch * NUM_PATTERNS + self.active_pattern[ch] as usize;
        let left = if self.loop_start[ch] != 0 {
            0
        } else {
            self.on_count(cur * MAX_STEPS, self.position[ch] as usize, self.pattern_length[cur] as usize)
        };
        let mut ahead = (left as f64 * self.pattern_rate[cur] as f64 - 1e-6).ceil();
        let p = self.bar_pos(self.global_step + ahead);
        if p != 0.0 {
            ahead += self.bar_len as f64 - p;
        }
        ahead
    }

    pub(super) fn switch_patterns(&mut self, channels: &[usize], pat: usize, quick: bool) {
        let channels: Vec<usize> = channels.iter().copied().filter(|&c| c < NC).collect();
        let moving: Vec<usize> = if self.playing {
            channels.iter().copied().filter(|&c| self.current[c].is_some() && pat != self.active_pattern[c] as usize).collect()
        } else {
            Vec::new()
        };
        for &ch in &channels {
            if !moving.contains(&ch) {
                self.select_pattern(ch, pat, false);
            }
        }
        if moving.is_empty() {
            return;
        }
        let mut ahead = 0.0f64;
        if quick {
            let p = self.bar_pos(self.global_step);
            ahead = if p == 0.0 { 0.0 } else { self.bar_len as f64 - p };
        } else {
            for &ch in &moving {
                ahead = ahead.max(self.loop_ahead(ch));
            }
        }
        for &ch in &moving {
            let filling = self.fill_pat[ch] >= 0;
            self.pending_pattern[ch] = pat as i8;
            self.land_at[ch] = self.global_step + ahead;
            let f = self.frames_ahead(ahead);
            self.start_glide(ch, pat, f);
            if filling {
                self.start_fill(ch, pat, ahead);
            } else {
                self.plan_fill(ch, ahead);
            }
        }
    }

    pub(super) fn land_pattern(&mut self, ch: usize) {
        let pat = self.pending_pattern[ch];
        self.pending_pattern[ch] = -1;
        self.fill_pat[ch] = -1;
        self.fill_at[ch] = -1.0;
        let snap = self.glide_pattern[ch] != pat;
        self.enter_pattern(ch, pat as usize, snap);
    }

    pub(super) fn enter_pattern(&mut self, ch: usize, pat: usize, snap: bool) {
        self.active_pattern[ch] = pat as u8;
        let Some(kind) = self.current[ch] else { return };
        let params = specs::kind_params(kind);
        let base = (ch * NUM_PATTERNS + pat) * LOCK_SLOTS;
        let n = params.len().min(LOCK_SLOTS);
        for k in 0..n {
            let spec = &params[k];
            if snap || spec.coarse || spec.options > 0 {
                let v = self.patch_value[base + k] as f64;
                self.set_sound(ch, spec.id, v, k as i32);
            }
        }
        if snap && self.glide_pattern[ch] as i32 == pat as i32 {
            self.glide_pattern[ch] = -1;
        }
    }

    pub(super) fn start_glide(&mut self, ch: usize, pat: usize, frames: f64) {
        let Some(kind) = self.current[ch] else { return };
        let params = specs::kind_params(kind);
        let base = ch * LOCK_SLOTS;
        let from = (ch * NUM_PATTERNS + pat) * LOCK_SLOTS;
        let n = params.len().min(LOCK_SLOTS);
        for k in 0..n {
            let spec = &params[k];
            self.glide_from[base + k] = to_norm(spec, self.base_value[base + k] as f64) as f32;
            self.glide_to[base + k] = to_norm(spec, self.patch_value[from + k] as f64) as f32;
        }
        self.glide_pattern[ch] = pat as i8;
        self.glide_wait[ch] = 0;
        self.glide_done[ch] = 0.0;
        self.glide_total[ch] = frames.max(MIN_PATCH_GLIDE * self.sample_rate);
    }

    pub(super) fn step_patch_glides(&mut self, frames: f64) {
        for ch in 0..NC {
            let pat = self.glide_pattern[ch];
            if pat < 0 {
                continue;
            }
            let Some(kind) = self.current[ch] else {
                self.glide_pattern[ch] = -1;
                continue;
            };
            if self.glide_done[ch] >= self.glide_total[ch] {
                if self.active_pattern[ch] as i32 == pat as i32 && self.pending_pattern[ch] < 0 {
                    self.finish_glide(ch);
                } else if self.pending_pattern[ch] != pat && self.glide_wait[ch] == 0 {
                    let a = self.active_pattern[ch] as usize;
                    self.start_glide(ch, a, CANCEL_PATCH_GLIDE * self.sample_rate);
                }
                continue;
            }
            self.glide_done[ch] += frames;
            let t = self.glide_shape((self.glide_done[ch] / self.glide_total[ch]).min(1.0));
            let params = specs::kind_params(kind);
            let base = ch * LOCK_SLOTS;
            let n = params.len().min(LOCK_SLOTS);
            for k in 0..n {
                let spec = &params[k];
                if spec.coarse || spec.options > 0 {
                    continue;
                }
                let a = self.glide_from[base + k] as f64;
                let b = self.glide_to[base + k] as f64;
                if a == b {
                    continue;
                }
                let v = to_value(spec, a + (b - a) * t);
                self.base_value[base + k] = v as f32;
                if self.lock_applied[base + k] == 0 {
                    let x = self.with_offset(ch, k, v);
                    self.apply_param(ch, spec.id, x);
                }
            }
        }
    }

    fn glide_shape(&self, t: f64) -> f64 {
        match self.glide_curve {
            1 => t * t,
            2 => 1.0 - (1.0 - t) * (1.0 - t),
            3 => t * t * (3.0 - 2.0 * t),
            _ => t,
        }
    }

    pub(super) fn finish_glide(&mut self, ch: usize) {
        self.glide_pattern[ch] = -1;
        self.glide_wait[ch] = 0;
        let a = self.active_pattern[ch] as usize;
        self.enter_pattern(ch, a, true);
    }

    pub(super) fn apply_pending_rates(&mut self, moving: bool) {
        if !self.rate_pending {
            return;
        }
        self.rate_pending = false;
        for k in 0..PAT_SLOTS {
            let rate = self.pending_rate[k];
            if rate == 0.0 {
                continue;
            }
            self.pending_rate[k] = 0.0;
            let ch = k / NUM_PATTERNS;
            let old = self.pattern_rate[k] as f64;
            self.pattern_rate[k] = rate as f32;
            self.refresh_on(k);
            if !moving || old == rate || k != ch * NUM_PATTERNS + self.seq_pattern(ch) {
                continue;
            }
            let len = self.pattern_length[k] as usize;
            let pos = js::round((self.position[ch] as f64 * slots_per_bar(rate)) / slots_per_bar(old)) % len as f64;
            let at = self.next_on(k * MAX_STEPS, pos as i32, len);
            self.position[ch] = if at < 0 { 0 } else { at as u8 };
            self.loop_start[ch] = (self.position[ch] == 0) as u8;
        }
    }

    pub(super) fn apply_pending_notes(&mut self) {
        if !self.notes_pending {
            return;
        }
        self.notes_pending = false;
        for k in 0..PAT_SLOTS {
            let Some(next) = self.pending_notes[k].take() else { continue };
            let ch = k / NUM_PATTERNS;
            let pat = k % NUM_PATTERNS;
            self.pattern_length[k] = u8w(next.length.min(MAX_STEPS as f64).max(1.0));
            self.pattern_rate[k] = speed_steps(next.speed.as_deref()) as f32;
            for i in 0..MAX_STEPS.min(next.steps.len()) {
                self.write_step(ch, pat, i, &next.steps[i]);
            }
            self.refresh_on(k);
        }
    }

    pub(super) fn set_sound(&mut self, ch: usize, id: &str, value: f64, known_slot: i32) {
        if self.current[ch].is_none() {
            return;
        }
        if !self.auto_applying {
            self.auto_stale[ch] = 1;
        }
        let slot = if known_slot >= 0 { known_slot } else { slot_of(self.current[ch], id) };
        if slot >= 0 {
            self.base_value[ch * LOCK_SLOTS + slot as usize] = value as f32;
        }
        let x = if slot >= 0 { self.with_offset(ch, slot as usize, value) } else { value };
        self.apply_param(ch, id, x);
        if id == "rolldiv" {
            let r = js::round(value);
            self.roll_div[ch] = if r >= 0.0 && (r as usize) < ROLL_HITS.len() { ROLL_HITS[r as usize] } else { 1.0 };
        }
    }

    pub(super) fn set_arp(&mut self, ch: usize, id: &str, value: f64) {
        if !self.auto_applying {
            self.auto_base.insert(format!("a:{ch}:{id}"), value);
        }
        let v = js::round(value).max(0.0);
        match id {
            "on" => self.arp_on[ch] = (v > 0.0) as u8,
            "mode" => self.arp_set[ch] = u8w(v),
            "rate" => self.arp_steps[ch] = (if (v as usize) < ARP_STEPS.len() { ARP_STEPS[v as usize] } else { 1.0 }) as f32,
            _ => self.arp_oct[ch] = u8w((v + 1.0).min(3.0)),
        }
        self.arp_mode[ch] = if self.arp_on[ch] != 0 { self.arp_set[ch] } else { 0 };
        if self.arp_mode[ch] == 0 && self.arp_held[ch] != 0 {
            self.stop_arp(ch);
        }
    }

    pub(super) fn write_step(&mut self, ch: usize, pattern: usize, index: usize, step: &Value) {
        if index >= MAX_STEPS || pattern >= NUM_PATTERNS {
            return;
        }
        let s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
        let active = truthy(step, "active");
        self.step_active[s] = active as u8;
        self.step_note[s] = num_or(step, "note", f64::NAN) as f32;
        self.step_vel[s] = num_or(step, "velocity", f64::NAN) as f32;
        self.step_accent[s] = truthy(step, "accent") as u8;
        self.step_ring[s] = truthy(step, "ring") as u8;
        self.step_rest[s] = (truthy(step, "rest") && !active) as u8;
        self.step_slide[s] = (truthy(step, "slide") && active) as u8;
        let gate_raw = num(step, "gate");
        let gate = match gate_raw {
            Some(g) if g != 0.0 && !g.is_nan() => g,
            _ => 1.0,
        };
        self.step_gate[s] = u8w(js::round(gate).min(MAX_STEPS as f64).max(1.0));
        self.step_flip[s] = truthy(step, "flip") as u8;
        let rate = self.pattern_rate[ch * NUM_PATTERNS + pattern];
        let on = (meter_plays(self.meter, index) && !(rate > 1.0 && rate < 2.0 && index % 4 == 3)) as u8;
        self.step_on[s] = on ^ self.step_flip[s];
        let extras = arr(step.get("extra"));
        let has_extra = active && truthy(step, "extra");
        let extra = if has_extra { extras.len().min(STEP_NOTES - 1) } else { 0 };
        self.step_extra_n[s] = extra as u8;
        let gates = arr(step.get("extraGate"));
        for k in 0..extra {
            self.step_extra[s * (STEP_NOTES - 1) + k] = extras[k].as_f64().unwrap_or(f64::NAN) as f32;
            let g = gates.get(k).and_then(Value::as_f64).unwrap_or(gate_raw.unwrap_or(f64::NAN));
            self.step_extra_gate[s * (STEP_NOTES - 1) + k] = i16w(jmax(1.0, js::round(g)));
        }
        let had = self.step_lock_src[s].is_some();
        let locks = record(step.get("locks"));
        let locks = if locks.is_empty() { None } else { Some(locks) };
        let has = locks.is_some();
        self.step_lock_src[s] = locks;
        if had || has {
            self.lock_changed(ch, pattern);
        }
    }

    pub(super) fn lock_changed(&mut self, ch: usize, pattern: usize) {
        self.pat_lanes_dirty[ch * NUM_PATTERNS + pattern] = 1;
        self.pat_dirty = true;
    }

    pub(super) fn set_mix(&mut self, ch: usize, id: &str, value: f64) {
        if !self.auto_applying {
            self.auto_base.insert(format!("m:{ch}:{id}"), value);
        }
        match id {
            "send" => {
                self.send_level[ch].set_target(value);
                return;
            }
            "dyn" => {
                self.dyn_depth[ch] = (value / 100.0) as f32;
                return;
            }
            "gate" => {
                self.gate_length[ch] = value;
                return;
            }
            "ring" => {
                for i in self.insts[ch].iter_mut() {
                    i.set_ring_length(value);
                }
                return;
            }
            "cut" => {
                self.cuts[ch].set_amount(value);
                return;
            }
            "volume" => self.volume_value[ch] = value as f32,
            "pan" => self.pan[ch].set_target(value),
            _ => self.muted[ch] = (value > 0.0) as u8,
        }
        let v = self.volume_value[ch] as f64;
        self.volume[ch].set_target(v);
    }
}
