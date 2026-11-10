//! The sequencer: the block loop, master steps, each track's steps,
//! the song's rows and clip entries, rolls, ties, the ARP, held notes and live recording.

use serde_json::Value;

use super::json::*;
use super::tables::*;
use super::*;
use crate::js;

impl Engine {
    /// Overwrites out_l / out_r with `frames` samples.
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], frames: usize) {
        out_l[..frames].fill(0.0);
        out_r[..frames].fill(0.0);
        if self.click_buf.len() < frames {
            self.click_buf = vec![0.0; frames];
        }
        if self.clicked {
            self.click_buf[..frames].fill(0.0);
        }
        self.clicked = false;
        self.step_patch_glides(frames as f64);
        let mut pos = 0usize;
        while pos < frames {
            if self.playing && self.frames_to_step <= 0.0 {
                if self.count_left > 0.0 {
                    self.count_step();
                } else {
                    self.fire_step();
                }
                continue;
            }
            let mut n = (frames - pos) as f64;
            if n > CHUNK as f64 {
                n = CHUNK as f64;
            }
            for ch in 0..NC {
                if self.arp_held[ch] == 0 {
                    continue;
                }
                if self.arp_at[ch] <= 0.0 {
                    self.arp_step(ch);
                }
                let a = self.arp_at[ch].ceil();
                if a < n {
                    n = a;
                }
            }
            if n < 1.0 {
                n = 1.0;
            }
            if self.playing {
                let until = self.frames_to_step.ceil();
                if until < n {
                    n = until;
                }
                for ch in 0..NC {
                    if self.gate_at[ch] < 0.0 {
                        continue;
                    }
                    if self.gate_at[ch] <= 0.0 {
                        self.release_gate(ch);
                        continue;
                    }
                    let g = self.gate_at[ch].ceil();
                    if g < n {
                        n = g;
                    }
                }
                for k in 0..NC * HOLDS {
                    if self.hold_at[k] < 0.0 {
                        continue;
                    }
                    if self.hold_at[k] <= 0.0 {
                        self.release_hold(k);
                        continue;
                    }
                    let g = self.hold_at[k].ceil();
                    if g < n {
                        n = g;
                    }
                }
                for ch in 0..NC {
                    if self.sub_at[ch] < 0.0 {
                        continue;
                    }
                    if self.sub_at[ch] <= 0.0 {
                        let at = self.sub_pos[ch];
                        let left = self.sub_left[ch] as i32 - 1;
                        self.sub_left[ch] = self.sub_left[ch].wrapping_sub(1);
                        if left > 0 {
                            self.sub_at[ch] = self.sub_len[ch];
                            self.sub_pos[ch] += self.sub_step[ch];
                        } else {
                            self.sub_at[ch] = -1.0;
                        }
                        let len = self.sub_len[ch];
                        self.step_channel(ch, len, at);
                        if self.sub_at[ch] < 0.0 {
                            continue;
                        }
                    }
                    let d = self.sub_at[ch].ceil();
                    if d < n {
                        n = d;
                    }
                }
                for ch in 0..NC {
                    if self.roll_left[ch] == 0 {
                        continue;
                    }
                    if self.roll_at[ch] <= 0.0 {
                        self.roll_hit(ch);
                        if self.roll_left[ch] == 0 {
                            continue;
                        }
                    }
                    let r = self.roll_at[ch].ceil();
                    if r < n {
                        n = r;
                    }
                }
                if n < 1.0 {
                    n = 1.0;
                }
            }
            if self.playing && self.global_step > 0.0 {
                self.run_pat_auto();
                if self.song_on && !self.lanes.is_empty() {
                    self.run_auto();
                } else {
                    self.auto_stale = [0; NC];
                }
            }
            let nu = n as usize;
            self.render_chunk(out_l, out_r, pos, nu);
            if self.playing {
                for ch in 0..NC {
                    self.chan_elapsed[ch] += n;
                }
            }
            if self.click.render(&mut self.click_buf, pos, nu) {
                self.clicked = true;
            }
            pos += nu;
            for ch in 0..NC {
                if self.arp_held[ch] != 0 {
                    self.arp_at[ch] -= n;
                }
            }
            if self.playing {
                self.frames_to_step -= n;
                for ch in 0..NC {
                    if self.roll_left[ch] > 0 {
                        self.roll_at[ch] -= n;
                    }
                }
                for ch in 0..NC {
                    if self.sub_at[ch] > 0.0 {
                        self.sub_at[ch] = (self.sub_at[ch] - n).max(0.0);
                    }
                }
                for ch in 0..NC {
                    if self.gate_at[ch] > 0.0 {
                        self.gate_at[ch] = (self.gate_at[ch] - n).max(0.0);
                    }
                }
                for k in 0..NC * HOLDS {
                    if self.hold_at[k] > 0.0 {
                        self.hold_at[k] = (self.hold_at[k] - n).max(0.0);
                    }
                }
            }
        }
        self.finish_block(out_l, out_r, frames);
    }

    /// Length in frames of the 16th step that starts at global step k (swing in pairs).
    pub fn step_frames(&self, k: f64) -> f64 {
        let base = (60.0 / self.bpm / 4.0) * self.sample_rate;
        if self.bar_pos(k) % 2.0 == 0.0 {
            base * (1.0 + self.swing)
        } else {
            base * (1.0 - self.swing)
        }
    }

    pub(super) fn bar_pos(&self, k: f64) -> f64 {
        let p = (k - self.bar_origin) % self.bar_len as f64;
        if p < 0.0 {
            p + self.bar_len as f64
        } else {
            p
        }
    }

    pub(super) fn set_meter(&mut self, value: f64) {
        let m = js::round(value).min(METERS.len() as f64 - 1.0).max(0.0) as usize;
        if self.playing {
            self.pending_meter = if m == self.meter { -1 } else { m as i32 };
        } else {
            self.apply_meter(m);
        }
    }

    pub(super) fn apply_meter(&mut self, m: usize) {
        self.pending_meter = -1;
        self.meter = m;
        self.bar_len = meter_length(m);
        let mut k = 0usize;
        for cell in 0..16 {
            self.played_before[cell] = k as u8;
            if meter_plays(m, cell) {
                self.cell_of[k] = cell as u8;
                k += 1;
            }
        }
        self.played_before[16] = k as u8;
        self.beat_at = [0; 16];
        let mut at = 0usize;
        for &g in METERS[m].iter() {
            if g == 0 {
                continue;
            }
            self.beat_at[at] = 1;
            at += g;
        }
        self.bar_origin = self.global_step;
        for k in 0..PAT_SLOTS {
            self.refresh_on(k);
        }
        self.lfo_steps = self.lfo_rate_steps();
        self.lfo_cycle = [-1.0; NC];
    }

    pub(super) fn refresh_on(&mut self, k: usize) {
        let r = self.pattern_rate[k];
        let triplet = r > 1.0 && r < 2.0;
        let base = k * MAX_STEPS;
        for i in 0..MAX_STEPS {
            let on = (meter_plays(self.meter, i) && !(triplet && i % 4 == 3)) as u8;
            self.step_on[base + i] = on ^ self.step_flip[base + i];
        }
    }

    pub(super) fn next_on(&self, base: usize, from: i32, len: usize) -> i32 {
        let mut i = from.max(0) as usize;
        while i < len {
            if self.step_on[base + i] != 0 {
                return i as i32;
            }
            i += 1;
        }
        -1
    }

    pub(super) fn on_count(&self, base: usize, from: usize, len: usize) -> usize {
        (from..len).map(|i| self.step_on[base + i] as usize).sum()
    }

    pub(super) fn walk_on(&self, base: usize, from: i32, k: f64, len: usize) -> i32 {
        let dir: i32 = if k < 0.0 { -1 } else { 1 };
        let len = len as i32;
        let mut i = from;
        let mut n = k.abs();
        while n > 0.0 {
            let mut j = i;
            for _ in 0..len {
                j = (j + dir + len) % len;
                if self.step_on[base + j as usize] != 0 {
                    break;
                }
            }
            i = j;
            n -= 1.0;
        }
        i
    }

    fn count_step(&mut self) {
        let pos = ((self.count_total - self.count_left) % self.bar_len as f64) as usize;
        if self.beat_at[pos] != 0 {
            self.click.trigger(pos == 0);
        }
        self.last_step_frames = (60.0 / self.bpm / 4.0) * self.sample_rate;
        self.frames_to_step += self.last_step_frames;
        self.count_left -= 1.0;
        if self.count_left == 0.0 {
            self.lfo_clock = self.lfo_start_clock;
        }
    }

    fn fire_step(&mut self) {
        let g = self.global_step;
        let at_bar = self.bar_pos(g) == 0.0;
        if at_bar && self.pending_meter >= 0 {
            self.apply_meter(self.pending_meter as usize);
        }
        let pos = self.bar_pos(g);
        let step_len = self.step_frames(g);
        if self.click_on && self.beat_at[pos as usize] != 0 {
            self.click.trigger(pos == 0.0);
        }
        if at_bar && self.notes_pending {
            self.apply_pending_notes();
        }
        if at_bar && self.rate_pending {
            self.apply_pending_rates(true);
        }
        if self.song_on && at_bar {
            self.song_bar_line();
        }
        if self.song_on {
            self.run_song_edges(g);
        }
        for ch in 0..NC {
            if self.current[ch].is_none() {
                continue;
            }
            if self.pending_pattern[ch] >= 0 && self.land_at[ch] >= 0.0 {
                if g >= self.land_at[ch] {
                    self.land_at[ch] = -1.0;
                    self.position[ch] = 0;
                    self.loop_start[ch] = 1;
                    self.run_left[ch] = 0;
                    self.roll_left[ch] = 0;
                    self.land_pattern(ch);
                }
            } else if at_bar && self.pending_pattern[ch] >= 0 && (self.loop_start[ch] != 0 || self.off_grid[ch] != 0) {
                if self.loop_start[ch] == 0 {
                    self.position[ch] = 0;
                    self.loop_start[ch] = 1;
                }
                self.run_left[ch] = 0;
                self.roll_left[ch] = 0;
                self.land_pattern(ch);
            }
            if self.fill_at[ch] >= 0.0 && g >= self.fill_at[ch] {
                self.fill_at[ch] = -1.0;
                if self.pending_pattern[ch] >= 0 && self.land_at[ch] > g {
                    let p = self.pending_pattern[ch] as usize;
                    let left = self.land_at[ch] - g;
                    self.start_fill(ch, p, left);
                }
            }
            let rate = self.pattern_rate[ch * NUM_PATTERNS + self.seq_pattern(ch)] as f64;
            if rate < 1.0 {
                self.step_channel(ch, step_len / 2.0, g);
                self.sub_len[ch] = step_len / 2.0;
                self.sub_at[ch] = step_len / 2.0;
                self.sub_left[ch] = 1;
                self.sub_pos[ch] = g + 0.5;
            } else if rate >= 2.0 {
                if pos % 2.0 == 0.0 {
                    let l = step_len + self.step_frames(g + 1.0);
                    self.step_channel(ch, l, g);
                }
            } else if rate > 1.0 {
                if pos % 4.0 == 0.0 {
                    let third = (step_len + self.step_frames(g + 1.0) + self.step_frames(g + 2.0) + self.step_frames(g + 3.0)) / 3.0;
                    self.step_channel(ch, third, g);
                    self.sub_len[ch] = third;
                    self.sub_at[ch] = third;
                    self.sub_left[ch] = 2;
                    self.sub_pos[ch] = g + 4.0 / 3.0;
                    self.sub_step[ch] = 4.0 / 3.0;
                }
            } else {
                self.step_channel(ch, step_len, g);
            }
            if self.hold_roll[ch] != 0 && self.roll_div[ch] > 0.0 && self.song_off[ch] == 0 {
                self.held_roll_step(ch, g);
            }
        }
        self.last_step_frames = self.step_frames(self.global_step);
        self.frames_to_step += self.last_step_frames;
        self.global_step += 1.0;
    }

    /// One step of track ch (stepLen frames long, at master position `at`).
    pub(super) fn step_channel(&mut self, ch: usize, step_len: f64, at: f64) {
        if self.current[ch].is_none() {
            return;
        }
        let pat = ch * NUM_PATTERNS + self.seq_pattern(ch);
        self.chan_rate[ch] = self.pattern_rate[pat] as f64;
        self.chan_at[ch] = at;
        self.chan_count[ch] += 1.0;
        if self.loop_start[ch] != 0 {
            self.off_grid[ch] = if at == at.floor() && self.bar_pos(at) == 0.0 { 0 } else { 1 };
        }
        let len = self.pattern_length[pat] as usize;
        let base = pat * MAX_STEPS;
        let mut idx = self.next_on(base, (self.position[ch] as usize % len) as i32, len);
        if idx < 0 {
            idx = self.next_on(base, 0, len);
        }
        if idx < 0 {
            if self.gate_steps[ch] > 0 {
                self.release_gate(ch);
            }
            self.release_holds(ch);
            self.roll_left[ch] = 0;
            self.run_left[ch] = 0;
            self.tie_left[ch] = 0;
            self.current_step[ch] = -1;
            self.position[ch] = 0;
            self.loop_start[ch] = 1;
            return;
        }
        let iu = idx as usize;
        let s = base + iu;
        let skip = self.skip_step[ch] as i32 == idx;
        let hit = self.step_active[s] == 1 && !skip && self.song_off[ch] == 0 && self.muted[ch] == 0;
        let slide_from: f64 = if hit && self.sliding[ch] != 0 && self.gate_steps[ch] > 0 { self.gate_group[ch] as f64 } else { -1.0 };
        let in_run = self.run_left[ch] > 0;
        if in_run {
            self.run_left[ch] -= 1;
        } else if self.hold_roll[ch] == 0 {
            self.roll_left[ch] = 0;
        }
        let rest = self.step_rest[s] == 1 && !skip && self.song_off[ch] == 0 && self.muted[ch] == 0;
        if rest {
            self.cut_track(ch);
        } else if slide_from >= 0.0 {
            self.gate_steps[ch] = 0;
            self.ringing[ch] = 0;
            self.gate_at[ch] = -1.0;
        } else if self.gate_at[ch] >= 0.0 {
            self.release_gate(ch);
        } else if self.gate_steps[ch] > 0 {
            if self.ringing[ch] != 0 {
                if self.step_active[s] != 0 {
                    self.release_gate(ch);
                }
            } else {
                self.gate_steps[ch] = self.gate_steps[ch].wrapping_sub(1);
                if self.gate_steps[ch] == 0 {
                    if self.gate_length[ch] > 1.0 {
                        self.gate_steps[ch] = 1;
                        self.gate_at[ch] = (self.gate_length[ch] - 1.0) * step_len;
                    } else {
                        self.release_gate(ch);
                    }
                } else if self.gate_steps[ch] == 1 {
                    self.gate_early(ch, step_len);
                }
            }
        }
        self.step_holds(ch, step_len);
        self.chan_elapsed[ch] = 0.0;
        self.chan_len[ch] = step_len;
        if hit && !in_run {
            let ring = self.step_ring[s] == 1 || self.force_ring[ch] == 1;
            let slide_flag = self.step_slide[s] == 1 || self.force_slide[ch] == 1;
            let drum_roll = self.roll_div[ch] > 0.0 && slide_flag;
            let slide = self.roll_div[ch] == 0.0 && slide_flag;
            let vel = if self.force_vel[ch] > 0.0 { self.force_vel[ch] as f64 } else { self.step_vel[s] as f64 };
            let extra = if plays_chords(self.current[ch]) { self.step_extra_n[s] as usize } else { 0 };
            let ex = s * (STEP_NOTES - 1);
            let all = extra > 0 && self.chord[ch] == 0 && self.arp_mode[ch] == 0;
            let mut root = self.step_note[s] as f64;
            if extra > 0 && !all {
                for k in 0..extra {
                    root = root.min(self.step_extra[ex + k] as f64);
                }
            }
            let poly = plays_chords(self.current[ch]) && !ring && !slide && slide_from < 0.0 && self.arp_mode[ch] == 0;
            if poly {
                let g = self.step_gate[s] as f64;
                self.hold_start(ch, root, g, step_len);
                self.note_on(ch, root, vel, false, -1.0, false);
                if all {
                    let v = dyn_velocity(vel, self.dyn_depth[ch] as f64);
                    for k in 0..extra {
                        let note = self.step_extra[ex + k] as f64;
                        let g = self.step_extra_gate[ex + k] as f64;
                        self.hold_start(ch, note, g, step_len);
                        if let Some(i) = self.inst(ch) {
                            i.note_on(note, v, note, false, -1.0, false);
                        }
                    }
                }
                self.sliding[ch] = 0;
            } else {
                self.note_on(ch, root, vel, ring, slide_from, slide);
                if all {
                    let v = dyn_velocity(vel, self.dyn_depth[ch] as f64);
                    for k in 0..extra {
                        let note = self.step_extra[ex + k] as f64;
                        if let Some(i) = self.inst(ch) {
                            i.note_on(note, v, root, ring, -1.0, slide);
                        }
                    }
                }
                if slide_from >= 0.0 && slide_from != root {
                    if let Some(i) = self.inst(ch) {
                        i.note_off(slide_from);
                    }
                }
                self.gate_group[ch] = i16w(root);
                self.gate_steps[ch] = if ring || slide { 1 } else { self.step_gate[s] as i16 };
                self.ringing[ch] = (ring || slide) as u8;
                self.gate_at[ch] = -1.0;
                if !ring && !slide && self.gate_steps[ch] == 1 {
                    self.gate_early(ch, step_len);
                }
                self.sliding[ch] = slide as u8;
            }
            if drum_roll && self.hold_roll[ch] == 0 {
                self.start_roll_run(ch, pat, iu, len, vel);
            }
            self.tie_left[ch] = if self.roll_div[ch] > 0.0 { u16w(self.step_gate[s] as f64 - 1.0) } else { 0 };
            self.tie_note[ch] = i16w(root);
            self.tie_vel[ch] = vel;
            self.tie_ring[ch] = ring as u8;
        } else if self.step_active[s] == 1 || rest {
            self.tie_left[ch] = 0;
        } else if self.tie_left[ch] > 0 {
            self.tie_left[ch] -= 1;
            if !in_run && self.song_off[ch] == 0 && self.muted[ch] == 0 && !skip {
                let ring = self.tie_ring[ch] == 1;
                let note = self.tie_note[ch] as f64;
                let vel = self.tie_vel[ch];
                self.note_on(ch, note, vel, ring, -1.0, false);
                if ring {
                    self.gate_group[ch] = self.tie_note[ch];
                    self.gate_steps[ch] = 1;
                    self.ringing[ch] = 1;
                }
                self.hit_step[ch] = at;
                self.hit_note[ch] = u8w(self.tie_note[ch] as f64);
            }
        }
        if hit {
            self.hit_step[ch] = at;
            self.hit_note[ch] = u8w(self.step_note[s] as f64);
        }
        self.skip_step[ch] = -1;
        self.current_step[ch] = idx as i16;
        let next = self.next_on(base, idx + 1, len);
        self.loop_start[ch] = (next < 0) as u8;
        self.position[ch] = if next < 0 { 0 } else { next as u8 };
    }

    pub(super) fn apply_chain(&mut self, ch: usize) {
        let o = self.chain_order[ch];
        let order = if o >= 0 { o as f64 } else { chain_default(self.current[ch]) };
        if let Some(i) = self.inst(ch) {
            i.set_chain(order);
        }
    }

    fn gate_early(&mut self, ch: usize, step_len: f64) {
        if self.gate_length[ch] < 1.0 {
            self.gate_at[ch] = self.gate_length[ch] * step_len;
        }
    }

    // ------------------------------------------------------------------ PLAY from a bar

    pub(super) fn start_at(&mut self, ch: usize, from: usize) {
        if ch >= NC || self.current[ch].is_none() {
            return;
        }
        let pat = ch * NUM_PATTERNS + self.active_pattern[ch] as usize;
        let len = self.pattern_length[pat] as usize;
        let base = pat * MAX_STEPS;
        if from >= len || self.next_on(base, from as i32, len) < 0 {
            return;
        }
        let mut g = 0.0;
        while g < (4 * MAX_STEPS) as f64 {
            if self.calls_at(ch, self.bar_pos(g)) && self.peek_step(ch) >= from as i32 {
                break;
            }
            self.chase_master_step(g, 0.0);
            g += 1.0;
        }
        self.start_clock_at(g);
    }

    pub(super) fn start_song_at(&mut self, bar: i32) {
        let row = self.song_row as usize;
        self.enter_row(row, false);
        let mut most = 0;
        for ch in 0..NC {
            let mut back = 0i32;
            let mut r = row;
            while r > 0 && self.song_keep[r * NC + ch] != 0 {
                back += self.song_bars[r - 1] as i32;
                r -= 1;
            }
            self.chase_back[ch] = back;
            if back > most {
                most = back;
            }
        }
        let steps = (bar as usize * self.bar_len) as f64;
        let lead = (most as usize * self.bar_len) as f64;
        let mut g = -lead;
        while g < steps {
            self.chase_master_step(g, -g);
            g += 1.0;
        }
        self.song_bar = bar - 1;
        self.start_clock_at(steps);
    }

    fn chase_master_step(&mut self, g: f64, ahead: f64) {
        let pos = self.bar_pos(g);
        for c in 0..NC {
            if self.current[c].is_none() || !self.calls_at(c, pos) {
                continue;
            }
            if ahead > 0.0 && ((self.chase_back[c] as usize * self.bar_len) as f64) < ahead {
                continue;
            }
            let rate = self.pattern_rate[c * NUM_PATTERNS + self.active_pattern[c] as usize] as f64;
            self.chase_step(c, g);
            if rate < 1.0 {
                self.chase_step(c, g + 0.5);
            } else if rate > 1.0 && rate < 2.0 {
                self.chase_step(c, g + 4.0 / 3.0);
                self.chase_step(c, g + 8.0 / 3.0);
            }
        }
    }

    fn start_clock_at(&mut self, g: f64) {
        self.global_step = g;
        self.lfo_clock = g;
        self.lfo_trig = [g; NC];
    }

    fn calls_at(&self, ch: usize, pos: f64) -> bool {
        let rate = self.pattern_rate[ch * NUM_PATTERNS + self.active_pattern[ch] as usize] as f64;
        if rate >= 2.0 {
            return pos % 2.0 == 0.0;
        }
        if rate > 1.0 {
            return pos % 4.0 == 0.0;
        }
        true
    }

    fn peek_step(&self, ch: usize) -> i32 {
        let pat = ch * NUM_PATTERNS + self.active_pattern[ch] as usize;
        let len = self.pattern_length[pat] as usize;
        let base = pat * MAX_STEPS;
        let idx = self.next_on(base, (self.position[ch] as usize % len) as i32, len);
        if idx >= 0 {
            idx
        } else {
            self.next_on(base, 0, len)
        }
    }

    fn chase_step(&mut self, ch: usize, at: f64) {
        let pat = ch * NUM_PATTERNS + self.active_pattern[ch] as usize;
        let len = self.pattern_length[pat] as usize;
        let base = pat * MAX_STEPS;
        self.chan_rate[ch] = self.pattern_rate[pat] as f64;
        self.chan_at[ch] = at;
        self.chan_count[ch] += 1.0;
        if self.loop_start[ch] != 0 {
            self.off_grid[ch] = if at == at.floor() && self.bar_pos(at) == 0.0 { 0 } else { 1 };
        }
        let idx = self.peek_step(ch);
        if idx < 0 {
            self.position[ch] = 0;
            self.loop_start[ch] = 1;
            return;
        }
        let next = self.next_on(base, idx + 1, len);
        self.loop_start[ch] = (next < 0) as u8;
        self.position[ch] = if next < 0 { 0 } else { next as u8 };
    }

    // ------------------------------------------------------------------ song

    fn song_bar_line(&mut self) {
        if self.song_bar < 0 {
            self.enter_row(self.song_row as usize, true);
        } else {
            self.song_bar += 1;
            if self.song_jump_to >= 0 {
                self.enter_row(self.song_jump_to as usize, false);
                self.song_jump_to = -1;
                self.song_cell = f64::NAN;
            } else if self.song_bar >= self.song_bars[self.song_row as usize] as i32 {
                self.enter_row((self.song_row as usize + 1) % self.song_length, true);
            }
        }
    }

    pub(super) fn glide_to_row(&mut self, row: usize, frames: f64) {
        for ch in 0..NC {
            let p = self.song_patterns[row * NC + ch];
            if p < 0 {
                continue;
            }
            if p as u8 != self.active_pattern[ch] {
                self.start_glide(ch, p as usize, frames);
                self.glide_wait[ch] = 1;
            } else if self.glide_pattern[ch] >= 0 && self.glide_pattern[ch] != p {
                self.start_glide(ch, p as usize, frames);
            }
        }
    }

    fn enter_row(&mut self, row: usize, in_order: bool) {
        self.song_row = row as i32;
        self.song_bar = 0;
        for ch in 0..NC {
            let k = row * NC + ch;
            let p = self.song_patterns[k];
            if in_order && self.fill_pat[ch] >= 0 && self.edge_on[k] == 0 {
                continue;
            }
            if in_order && self.song_keep[k] != 0 && self.song_off[ch] == 0 && p as i32 == self.active_pattern[ch] as i32 {
                continue;
            }
            self.fill_pat[ch] = -1;
            self.held_entry[ch] = 0;
            self.pending_pattern[ch] = -1;
            self.glide_wait[ch] = 0;
            self.position[ch] = 0;
            self.loop_start[ch] = 1;
            self.run_left[ch] = 0;
            self.roll_left[ch] = 0;
            if p < 0 {
                if self.song_off[ch] == 0 && self.gate_steps[ch] > 0 {
                    self.release_gate(ch);
                }
                if self.song_off[ch] == 0 {
                    self.release_holds(ch);
                }
                self.song_off[ch] = 1;
            } else {
                self.song_off[ch] = 0;
                if p as u8 != self.active_pattern[ch] {
                    let hold = in_order && self.edge_on[k] == 1 && self.edge_glide_start[k] >= 0 && self.glide_pattern[ch] != p;
                    let snap = !hold && self.glide_pattern[ch] != p;
                    self.enter_pattern(ch, p as usize, snap);
                    if hold {
                        self.held_entry[ch] = 1;
                    }
                }
            }
        }
    }

    pub fn set_song(&mut self, song: &Value) {
        let rows_all = arr(song.get("rows"));
        let rows = &rows_all[..rows_all.len().min(SONG_MAX_ROWS)];
        self.song_length = rows.len();
        for (i, r) in rows.iter().enumerate() {
            self.song_bars[i] = u8w(js::round(num_or(r, "bars", 1.0)).min(255.0).max(1.0));
            let pats = arr(r.get("patterns"));
            let keep = arr(r.get("keep"));
            for ch in 0..NC {
                let p = pats.get(ch).and_then(Value::as_f64);
                self.song_patterns[i * NC + ch] = match p {
                    Some(p) if p >= 0.0 && p < NUM_PATTERNS as f64 => i8w(p),
                    _ => -1,
                };
                let prev = if i > 0 { self.song_patterns[(i - 1) * NC + ch] } else { -1 };
                let kept = keep.get(ch).and_then(Value::as_f64) == Some(1.0);
                self.song_keep[i * NC + ch] = (kept && prev >= 0 && prev == self.song_patterns[i * NC + ch]) as u8;
            }
        }
        if self.song_on && self.song_length == 0 {
            self.song_on = false;
            self.song_row = -1;
            self.song_off = [0; NC];
        }
        if self.song_row >= self.song_length as i32 {
            self.song_row = self.song_length as i32 - 1;
        }
        let mut bar = 0i32;
        for i in 0..self.song_length {
            self.row_start[i] = bar;
            bar += self.song_bars[i] as i32;
        }
        self.row_start[self.song_length] = bar;
        self.set_edges(rows);
        self.release_lanes();
        self.lanes = Vec::new();
        self.song_lane_by_key = HashMap::new();
        if let Some(Value::Object(auto)) = song.get("auto") {
            for (key, points) in auto {
                let lane = match points {
                    Value::Array(_) => self.make_lane(key, &points_of(points)),
                    _ => None,
                };
                if let Some(l) = lane {
                    self.song_lane_by_key.insert(key.clone(), self.lanes.len());
                    self.lanes.push(l);
                }
            }
        }
    }

    fn set_edges(&mut self, rows: &[Value]) {
        let len = self.song_length as i32;
        for r in 0..len {
            for ch in 0..NC {
                let k = r as usize * NC + ch;
                self.edge_on[k] = (self.song_patterns[k] >= 0 && self.song_keep[k] == 0) as u8;
                if self.edge_on[k] == 0 {
                    continue;
                }
                let pat = |e: &Engine, r: i32| e.song_patterns[(((r % len) + len) % len) as usize * NC + ch];
                let mut q = r - 1;
                let mut back = self.song_bars[((q + len) % len) as usize] as i32;
                for _ in 1..(len - 1).max(1) {
                    let qi = ((q + len) % len) as usize;
                    let on = self.song_patterns[qi * NC + ch] >= 0;
                    let goes_on = if on { self.song_keep[qi * NC + ch] == 1 } else { pat(self, q - 1) < 0 };
                    if !goes_on {
                        break;
                    }
                    q -= 1;
                    back += self.song_bars[((q + len) % len) as usize] as i32;
                }
                let most = (back * CELLS_PER_BAR) as f64;
                let e = rows[r as usize].get("entry").and_then(|x| x.get(ch)).filter(|x| x.is_object());
                let gs = e.and_then(|e| num(e, "glideStart")).unwrap_or(CLIP_GLIDE_START);
                let ge = e.and_then(|e| num(e, "glideEnd")).unwrap_or(CLIP_GLIDE_END);
                let start = js::round(gs).min(SONG_GLIDE_MAX).max(-most);
                self.edge_glide_start[k] = i16w(start);
                self.edge_glide_end[k] = i16w(js::round(ge).min(SONG_GLIDE_MAX).max(start));
                let fill = match e.and_then(|e| num(e, "fill")) {
                    Some(f) if f >= 0.0 && f < NUM_PATTERNS as f64 => js::round(f),
                    _ => -1.0,
                };
                let fill_len = match e.and_then(|e| num(e, "fillLen")) {
                    Some(f) => js::round(f),
                    None => CLIP_FILL_LEN,
                };
                self.edge_fill[k] = i8w(fill);
                self.edge_fill_start[k] = i16w(-(fill_len.min(most).max(1.0)));
            }
        }
    }

    fn played_at(&self, c: i32) -> f64 {
        let bar = c.div_euclid(CELLS_PER_BAR);
        (bar as f64) * self.bar_len as f64 + self.played_before[(c - bar * CELLS_PER_BAR) as usize] as f64
    }

    fn run_song_edges(&mut self, g: f64) {
        let total = self.row_start[self.song_length] * CELLS_PER_BAR;
        let cur = ((self.row_start[self.song_row as usize] + self.song_bar.max(0)) * CELLS_PER_BAR) as f64
            + self.cell_of[self.bar_pos(g) as usize] as f64;
        let prev = if !self.song_cell.is_nan() { self.song_cell } else { cur - 0.5 };
        self.song_cell = cur;
        if total <= 0 {
            return;
        }
        for r in 0..self.song_length {
            let at = self.row_start[r] * CELLS_PER_BAR;
            for ch in 0..NC {
                let k = r * NC + ch;
                if self.edge_on[k] == 0 || self.current[ch].is_none() {
                    continue;
                }
                let p = self.song_patterns[k];
                let gs = self.edge_glide_start[k] as i32;
                if crossed_cell(at + gs, prev, cur, total) {
                    let frames = self.frames_ahead(self.played_at(at + self.edge_glide_end[k] as i32) - self.played_at(at + gs));
                    if gs < 0 {
                        if p as i32 != self.active_pattern[ch] as i32 || (self.glide_pattern[ch] >= 0 && self.glide_pattern[ch] != p) {
                            self.start_glide(ch, p as usize, frames);
                            self.glide_wait[ch] = 1;
                        }
                    } else if self.held_entry[ch] != 0 && self.active_pattern[ch] as i32 == p as i32 {
                        self.held_entry[ch] = 0;
                        self.start_glide(ch, p as usize, frames);
                    }
                }
                let fill = self.edge_fill[k];
                if fill >= 0 && crossed_cell(at + self.edge_fill_start[k] as i32, prev, cur, total) {
                    let to = if at as f64 > cur { at } else { at + total };
                    let steps = self.played_at(to) - self.played_at(cur as i32);
                    self.start_fill(ch, fill as usize, steps);
                    self.song_off[ch] = 0;
                }
            }
        }
    }

    // ------------------------------------------------------------------ notes

    /// Play a note (a chord with chord mode on); voices grouped by the root.
    pub(super) fn note_on(&mut self, ch: usize, note: f64, velocity: f64, ring: bool, slide_from: f64, slide: bool) {
        if self.current[ch].is_none() {
            return;
        }
        let velocity = dyn_velocity(velocity, self.dyn_depth[ch] as f64);
        if self.gate_steps[ch] > 0 && slide_from < 0.0 {
            self.release_gate(ch);
        }
        self.tone_target[ch] = hit_tone_cutoff(velocity) as f32;
        if self.arp_mode[ch] > 0 {
            self.stop_arp(ch);
            self.arp_held[ch] = 1;
            self.arp_root[ch] = note as f32;
            self.arp_vel[ch] = velocity as f32;
            self.arp_index[ch] = 0;
            self.arp_step(ch);
        } else {
            let v = *self.chords.voicing(self.chord[ch] as usize, self.notes[ch] as usize, note, self.scale_root[ch] as f64);
            if let Some(inst) = self.inst(ch) {
                for i in 0..v.n {
                    inst.note_on(note + v.iv[i], velocity, note, ring, slide_from, slide);
                }
            }
        }
        if slide_from < 0.0 {
            self.lfo_trig[ch] = self.lfo_clock;
        }
        self.kick_hit(ch);
    }

    #[allow(clippy::too_many_arguments)]
    fn over_tie(&self, ch: usize, base: usize, at: usize, idx: i32, len: usize, i: &mut i32, n: &mut usize, steps: &mut usize, tied: &mut bool) {
        *tied = false;
        let mut k = 1;
        while k < self.step_gate[base + at] as usize && *n < len {
            let mut next = self.next_on(base, *i + 1, len);
            if next < 0 && self.pending_pattern[ch] < 0 {
                next = self.next_on(base, 0, len);
            }
            if next < 0 || next == idx || self.step_active[base + next as usize] == 1 || self.step_rest[base + next as usize] == 1 {
                break;
            }
            *steps += 1;
            *tied = true;
            *i = next;
            k += 1;
            *n += 1;
        }
    }

    fn start_roll_run(&mut self, ch: usize, pat: usize, idx: usize, len: usize, vel: f64) {
        let forced = self.force_slide[ch] == 1;
        let mut steps = 1usize;
        let mut last = vel;
        let base = pat * MAX_STEPS;
        let wraps = forced && self.pending_pattern[ch] < 0;
        let idx_i = idx as i32;
        let mut i = idx_i;
        let mut n = 1usize;
        let mut tied = false;
        self.over_tie(ch, base, idx, idx_i, len, &mut i, &mut n, &mut steps, &mut tied);
        while n < len {
            let mut next = self.next_on(base, i + 1, len);
            if next < 0 && wraps {
                next = self.next_on(base, 0, len);
            }
            if next < 0 || next == idx_i {
                break;
            }
            let s = base + next as usize;
            if self.step_active[s] != 1 || (!forced && self.step_slide[s] != 1) {
                break;
            }
            steps += 1;
            last = if self.force_vel[ch] > 0.0 { self.force_vel[ch] as f64 } else { self.step_vel[s] as f64 };
            i = next;
            self.over_tie(ch, base, next as usize, idx_i, len, &mut i, &mut n, &mut steps, &mut tied);
            n += 1;
        }
        if forced && !tied {
            if steps == 1 {
                return;
            }
            steps -= 1;
        }
        let hits = (steps as f64 * self.chan_rate[ch] * self.roll_div[ch] - 1e-9).ceil();
        self.roll_ramp[ch] = u16w(if forced && !tied { hits } else { hits - 1.0 });
        self.run_left[ch] = u16w(steps as f64 - 1.0);
        self.roll_left[ch] = u8w(hits - 1.0);
        self.roll_index[ch] = 0;
        self.roll_every[ch] = self.roll_spacing() / self.roll_div[ch];
        self.roll_at[ch] = self.roll_every[ch];
        self.roll_note[ch] = self.step_note[pat * MAX_STEPS + idx];
        self.roll_vel[ch] = vel as f32;
        self.roll_vel_end[ch] = last as f32;
    }

    pub(super) fn set_hold_roll(&mut self, ch: usize, on: bool, note: f64) {
        self.hold_roll[ch] = on as u8;
        self.hold_roll_note[ch] = note as f32;
        self.hold_roll_count[ch] = 0;
        if !on {
            self.roll_left[ch] = 0;
            return;
        }
        if !self.playing || self.global_step == 0.0 || self.roll_div[ch] < 1.0 {
            return;
        }
        let every = self.roll_spacing() / self.roll_div[ch];
        let elapsed = self.last_step_frames - self.frames_to_step;
        let k = (elapsed / every).floor() + 1.0;
        if k >= self.roll_div[ch] {
            return;
        }
        self.hold_roll_from(ch, note, k);
        self.roll_at[ch] = k * every - elapsed;
    }

    fn held_roll_step(&mut self, ch: usize, g: f64) {
        let rate = self.roll_div[ch];
        let own = self.hit_step[ch] == g;
        if rate < 1.0 {
            let c = self.hold_roll_count[ch];
            self.hold_roll_count[ch] = c.wrapping_add(1);
            if c as f64 % js::round(1.0 / rate) != 0.0 {
                return;
            }
        }
        if !own {
            let note = self.hold_roll_note[ch] as f64;
            self.note_on(ch, note, NORMAL_VELOCITY, false, -1.0, false);
        }
        if rate > 1.0 {
            let note = if own { self.hit_note[ch] as f64 } else { self.hold_roll_note[ch] as f64 };
            self.hold_roll_from(ch, note, 1.0);
        }
    }

    fn hold_roll_from(&mut self, ch: usize, note: f64, k: f64) {
        self.run_left[ch] = 0;
        self.roll_left[ch] = u8w(self.roll_div[ch] - k);
        self.roll_every[ch] = self.roll_spacing() / self.roll_div[ch];
        self.roll_at[ch] = self.roll_every[ch];
        self.roll_note[ch] = note as f32;
        self.roll_vel[ch] = NORMAL_VELOCITY as f32;
        self.roll_vel_end[ch] = NORMAL_VELOCITY as f32;
        self.roll_ramp[ch] = 0;
        self.roll_index[ch] = 0;
    }

    fn roll_spacing(&self) -> f64 {
        (60.0 / self.bpm / 4.0) * self.sample_rate
    }

    fn roll_hit(&mut self, ch: usize) {
        self.roll_left[ch] = self.roll_left[ch].wrapping_sub(1);
        self.roll_at[ch] += self.roll_every[ch];
        let k = self.roll_index[ch] as f64 + 1.0;
        self.roll_index[ch] = self.roll_index[ch].wrapping_add(1);
        if self.current[ch].is_none() {
            return;
        }
        let note = self.roll_note[ch] as f64;
        let v = *self.chords.voicing(self.chord[ch] as usize, self.notes[ch] as usize, note, self.scale_root[ch] as f64);
        let v0 = self.roll_vel[ch] as f64;
        let ramp = if self.roll_ramp[ch] > 0 { (k / self.roll_ramp[ch] as f64).min(1.0) } else { 0.0 };
        let vel = dyn_velocity(v0 + (self.roll_vel_end[ch] as f64 - v0) * ramp, self.dyn_depth[ch] as f64);
        let ring = self.ringing[ch] == 1;
        if let Some(inst) = self.inst(ch) {
            for i in 0..v.n {
                inst.note_on(note + v.iv[i], vel, note, ring, -1.0, false);
            }
        }
        self.kick_hit(ch);
    }

    fn arp_step(&mut self, ch: usize) {
        if self.current[ch].is_none() {
            return;
        }
        if self.arp_note[ch] >= 0.0 {
            let n = self.arp_note[ch] as f64;
            if let Some(i) = self.inst(ch) {
                i.note_off(n);
            }
        }
        let root = self.arp_root[ch] as f64;
        let v = *self.chords.voicing(self.chord[ch] as usize, self.notes[ch] as usize, root, self.scale_root[ch] as f64);
        let mode = self.arp_mode[ch];
        let count = (v.n * self.arp_oct[ch] as usize) as i32;
        let i = self.arp_index[ch];
        self.arp_index[ch] = i.wrapping_add(1);
        let k: i32 = if mode == 2 {
            count - 1 - (i % count)
        } else if mode == 3 {
            let period = (2 * count - 2).max(1);
            let t = i % period;
            if t < count { t } else { period - t }
        } else if (mode == 4 || mode == 5) && count >= 3 {
            let j = i % (2 * (count - 2));
            let pair = j >> 1;
            let skip = (j & 1) * 2;
            if mode == 4 { pair + skip } else { count - 1 - pair - skip }
        } else if mode == 6 {
            (count - 1).min(((self.arp_noise.next() * 0.5 + 0.5) * count as f64).floor() as i32)
        } else if mode == 5 {
            count - 1 - (i % count)
        } else {
            i % count
        };
        let len = v.n as i32;
        let n = root + v.iv[(k % len) as usize] + 12.0 * (k as f64 / len as f64).floor();
        let vel = self.arp_vel[ch] as f64;
        if let Some(inst) = self.inst(ch) {
            inst.note_on(n, vel, n, false, -1.0, false);
        }
        self.arp_note[ch] = n as f32;
        self.arp_at[ch] += self.arp_steps[ch] as f64 * (60.0 / self.bpm / 4.0) * self.sample_rate;
    }

    pub(super) fn stop_arp(&mut self, ch: usize) {
        if self.arp_note[ch] >= 0.0 {
            let n = self.arp_note[ch] as f64;
            if let Some(i) = self.inst(ch) {
                i.note_off(n);
            }
        }
        self.arp_note[ch] = -1.0;
        self.arp_held[ch] = 0;
        self.arp_at[ch] = 0.0;
    }

    fn hold_start(&mut self, ch: usize, note: f64, steps: f64, step_len: f64) {
        let base = ch * HOLDS;
        let mut free: i32 = -1;
        for k in base..base + HOLDS {
            if self.hold_note[k] as f64 == note {
                self.release_hold(k);
            }
            if free < 0 && self.hold_note[k] < 0 {
                free = k as i32;
            }
        }
        if free < 0 {
            free = base as i32;
            self.release_hold(base);
        }
        let f = free as usize;
        self.hold_note[f] = i16w(note);
        self.hold_steps[f] = i16w(steps.max(1.0));
        self.hold_at[f] = if steps <= 1.0 && self.gate_length[ch] < 1.0 { self.gate_length[ch] * step_len } else { -1.0 };
    }

    fn step_holds(&mut self, ch: usize, step_len: f64) {
        let gl = self.gate_length[ch];
        for k in ch * HOLDS..(ch + 1) * HOLDS {
            if self.hold_note[k] < 0 {
                continue;
            }
            if self.hold_at[k] >= 0.0 {
                self.release_hold(k);
                continue;
            }
            self.hold_steps[k] = self.hold_steps[k].wrapping_sub(1);
            if self.hold_steps[k] == 0 {
                if gl > 1.0 {
                    self.hold_steps[k] = 1;
                    self.hold_at[k] = (gl - 1.0) * step_len;
                } else {
                    self.release_hold(k);
                }
            } else if self.hold_steps[k] == 1 && gl < 1.0 {
                self.hold_at[k] = gl * step_len;
            }
        }
    }

    pub(super) fn release_hold(&mut self, k: usize) {
        let note = self.hold_note[k];
        self.hold_note[k] = -1;
        self.hold_at[k] = -1.0;
        if note >= 0 {
            if let Some(i) = self.inst(k / HOLDS) {
                i.note_off(note as f64);
            }
        }
    }

    pub(super) fn release_holds(&mut self, ch: usize) {
        for k in ch * HOLDS..(ch + 1) * HOLDS {
            if self.hold_note[k] >= 0 {
                self.release_hold(k);
            }
        }
    }

    pub(super) fn clear_holds(&mut self, ch: usize) {
        for k in ch * HOLDS..(ch + 1) * HOLDS {
            self.hold_note[k] = -1;
            self.hold_at[k] = -1.0;
        }
    }

    pub(super) fn release_gate(&mut self, ch: usize) {
        self.sliding[ch] = 0;
        self.gate_at[ch] = -1.0;
        if self.arp_held[ch] != 0 {
            self.stop_arp(ch);
        }
        let g = self.gate_group[ch] as f64;
        if let Some(i) = self.inst(ch) {
            i.note_off(g);
        }
        self.gate_steps[ch] = 0;
        self.ringing[ch] = 0;
    }

    fn cut_track(&mut self, ch: usize) {
        self.sliding[ch] = 0;
        self.gate_at[ch] = -1.0;
        self.gate_steps[ch] = 0;
        self.ringing[ch] = 0;
        if self.arp_held[ch] != 0 {
            self.stop_arp(ch);
        }
        self.clear_holds(ch);
        if let Some(i) = self.inst(ch) {
            i.cut();
        }
    }

    // ------------------------------------------------------------------ live playing / recording

    pub(super) fn release(&mut self, ch: usize, note: f64) {
        if self.arp_held[ch] != 0 && self.arp_root[ch] as f64 == note {
            self.stop_arp(ch);
        }
        if let Some(i) = self.inst(ch) {
            i.note_off(note);
        }
        if self.release_chord_note(ch, note) {
            return;
        }
        if self.rec_note[ch] as f64 != note {
            return;
        }
        self.rec_note[ch] = -1;
        if !self.playing {
            return;
        }
        let pattern = self.rec_pattern[ch] as usize;
        let gate = if self.roll_div[ch] > 0.0 { 1.0 } else { self.held_length(ch, pattern, self.rec_start[ch]) };
        let index = self.rec_index[ch] as usize;
        self.step_gate[(ch * NUM_PATTERNS + pattern) * MAX_STEPS + index] = u8w(gate);
        self.recorded.push(Recorded::Note {
            channel: ch,
            pattern,
            index,
            note,
            velocity: self.rec_vel[ch] as f64,
            accent: self.rec_accent[ch] == 1,
            gate,
            slide: self.rec_slide[ch] == 1,
            start: false,
        });
    }

    fn held_length(&self, ch: usize, pattern: usize, start: f64) -> f64 {
        let end_step = self.chan_count[ch] + js::round(self.heard_step(ch));
        (self.pattern_length[ch * NUM_PATTERNS + pattern] as f64).min(end_step - start).max(1.0)
    }

    fn release_chord_note(&mut self, ch: usize, note: f64) -> bool {
        for k in ch * STEP_NOTES..(ch + 1) * STEP_NOTES {
            if self.chord_note[k] as f64 != note {
                continue;
            }
            self.chord_note[k] = -1;
            if !self.playing {
                return true;
            }
            let slot = self.chord_slot[k] as usize;
            let pattern = (slot / MAX_STEPS) % NUM_PATTERNS;
            let index = slot % MAX_STEPS;
            let gate = self.held_length(ch, pattern, self.chord_start[k]);
            let ex = slot * (STEP_NOTES - 1);
            for j in 0..self.step_extra_n[slot] as usize {
                if self.step_extra[ex + j] as f64 != note {
                    continue;
                }
                self.step_extra_gate[ex + j] = i16w(gate);
                self.recorded.push(Recorded::Chord { channel: ch, pattern, index, note, gate });
            }
            return true;
        }
        false
    }

    fn heard_position(&self) -> f64 {
        let elapsed = self.last_step_frames - self.frames_to_step;
        self.global_step - 1.0 + (elapsed - self.latency() - self.listen_frames) / self.last_step_frames
    }

    /// (index, isNext, global)
    fn nearest_step(&self, ch: usize, round: bool) -> (usize, bool, f64) {
        let cur = self.current_step[ch];
        if cur < 0 {
            return (0, true, 0.0);
        }
        let heard = self.heard_step(ch);
        let k = if round { js::round(heard) } else { heard.floor() };
        let pat = ch * NUM_PATTERNS + self.active_pattern[ch] as usize;
        let index = self.walk_on(pat * MAX_STEPS, cur as i32, k, self.pattern_length[pat] as usize);
        (index as usize, k >= 1.0, self.chan_count[ch] + k)
    }

    fn heard_step(&self, ch: usize) -> f64 {
        (self.heard_position() - self.chan_at[ch]) / self.chan_rate[ch]
    }

    pub(super) fn record_note(&mut self, ch: usize, note: f64, velocity: f64, accent: bool, slide: bool) {
        let prev = if slide && self.rec_note[ch] >= 0 { self.rec_note[ch] as f64 } else { -1.0 };
        self.note_on(ch, note, velocity, false, if slide { prev } else { -1.0 }, false);
        if !self.playing || self.current[ch].is_none() || self.count_left > 0.0 {
            return;
        }
        let (index, is_next, global) = self.nearest_step(ch, true);
        let pattern = self.active_pattern[ch] as usize;
        if prev >= 0.0 {
            let gate = (global - self.rec_start[ch]).min(MAX_STEPS as f64).max(1.0);
            let p = self.rec_pattern[ch] as usize;
            let i = self.rec_index[ch] as usize;
            self.step_gate[(ch * NUM_PATTERNS + p) * MAX_STEPS + i] = u8w(gate);
            self.step_slide[(ch * NUM_PATTERNS + p) * MAX_STEPS + i] = 1;
            self.recorded.push(Recorded::Note {
                channel: ch,
                pattern: p,
                index: i,
                note: prev,
                velocity: self.rec_vel[ch] as f64,
                accent: self.rec_accent[ch] == 1,
                gate,
                slide: true,
                start: false,
            });
        }
        let s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
        self.step_active[s] = 1;
        self.step_note[s] = note as f32;
        self.step_vel[s] = velocity as f32;
        self.step_accent[s] = accent as u8;
        self.step_ring[s] = 0;
        self.step_rest[s] = 0;
        self.step_slide[s] = 0;
        self.step_gate[s] = 1;
        self.step_extra_n[s] = 0;
        for k in ch * STEP_NOTES..(ch + 1) * STEP_NOTES {
            if self.chord_slot[k] as usize == s {
                self.chord_note[k] = -1;
            }
        }
        if is_next {
            self.skip_step[ch] = index as i16;
        }
        self.rec_note[ch] = i16w(note);
        self.rec_frame[ch] = self.frame;
        self.rec_start[ch] = global;
        self.rec_index[ch] = index as i16;
        self.rec_pattern[ch] = pattern as i8;
        self.rec_vel[ch] = velocity as f32;
        self.rec_accent[ch] = accent as u8;
        self.rec_slide[ch] = 0;
        self.recorded.push(Recorded::Note { channel: ch, pattern, index, note, velocity, accent, gate: 1.0, slide: false, start: true });
    }

    pub(super) fn record_chord_note(&mut self, ch: usize, note: f64, velocity: f64) -> bool {
        if !self.playing || self.count_left > 0.0 || self.rec_note[ch] < 0 || !plays_chords(self.current[ch]) {
            return false;
        }
        let (nearest, _, _) = self.nearest_step(ch, true);
        let together = self.frame - self.rec_frame[ch] < CHORD_WINDOW * self.sample_rate;
        if !together && (nearest as i16 != self.rec_index[ch] || self.active_pattern[ch] as i8 != self.rec_pattern[ch]) {
            return false;
        }
        let index = self.rec_index[ch] as usize;
        let pattern = self.rec_pattern[ch] as usize;
        let s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
        let n = self.step_extra_n[s] as usize;
        let ex = s * (STEP_NOTES - 1);
        let mut present = self.step_note[s] as f64 == note;
        for k in 0..n {
            if self.step_extra[ex + k] as f64 == note {
                present = true;
            }
        }
        self.note_on(ch, note, velocity, false, -1.0, false);
        if present || n >= STEP_NOTES - 1 {
            return true;
        }
        self.step_extra[ex + n] = note as f32;
        self.step_extra_gate[ex + n] = 1;
        self.step_extra_n[s] = (n + 1) as u8;
        self.recorded.push(Recorded::Chord { channel: ch, pattern, index, note, gate: 1.0 });
        for k in ch * STEP_NOTES..(ch + 1) * STEP_NOTES {
            if self.chord_note[k] >= 0 {
                continue;
            }
            self.chord_note[k] = i16w(note);
            self.chord_slot[k] = s as i32;
            self.chord_start[k] = self.rec_start[ch];
            break;
        }
        true
    }

    pub(super) fn record_lock(&mut self, ch: usize, id: &str, value: f64) {
        if self.current[ch].is_none() {
            return;
        }
        let slot = slot_of(self.current[ch], id);
        if slot < 0 {
            return;
        }
        let v = self.with_offset(ch, slot as usize, value);
        self.apply_param(ch, id, v);
        if !self.playing || self.current_step[ch] < 0 {
            return;
        }
        let pattern = self.active_pattern[ch] as usize;
        let (index, _, _) = self.nearest_step(ch, false);
        let s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
        let mut locks = self.step_lock_src[s].take().unwrap_or_default();
        match locks.iter_mut().find(|(k, _)| k == id) {
            Some(e) => e.1 = value,
            None => locks.push((id.to_string(), value)),
        }
        self.step_lock_src[s] = Some(locks);
        self.lock_changed(ch, pattern);
        self.recorded.push(Recorded::Lock { channel: ch, pattern, index, id: id.to_string(), value });
    }
}

/// A lane's points from JSON ([[position, value], ...]).
fn points_of(v: &Value) -> Vec<(f64, f64)> {
    arr(Some(v))
        .iter()
        .map(|p| {
            let a = arr(Some(p));
            (a.first().and_then(Value::as_f64).unwrap_or(f64::NAN), a.get(1).and_then(Value::as_f64).unwrap_or(f64::NAN))
        })
        .collect()
}
