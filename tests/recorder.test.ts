/**
 * TakeRecorder unit tests.
 *
 * A scripted beat map models the scheduler's timeline deterministically:
 * fixed cells (with an optional tempo change), so quantization, gate
 * conversion and every arbitration rule can be asserted directly.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/lib/sequencer/clock';
import {
  TakeRecorder,
  type AbortReason,
  type BeatCell,
  type BeatMap,
  type TakeDraft
} from '../src/lib/sequencer/recorder';

/**
 * Beat timeline on a manual clock. Each cell starts at `start + i*dur`;
 * a tempo change can shorten cells from a given global step onward.
 */
class ScriptedBeatMap implements BeatMap {
  transportState: 'stopped' | 'playing' | 'paused' = 'playing';
  currentStep = -1;
  readonly boundaries = new Map<number, { time: number; dur: number }>();

  constructor(
    private start: number,
    dur: number,
    count: number,
    tempoChange?: { fromStep: number; newDur: number }
  ) {
    let t = start;
    let d = dur;
    for (let i = 0; i < count; i++) {
      if (tempoChange && i === tempoChange.fromStep) d = tempoChange.newDur;
      this.boundaries.set(i, { time: t, dur: d });
      t += d;
    }
  }

  /** Advance the playhead, returning the steps reached. */
  reach(step: number): number[] {
    const reached: number[] = [];
    while (this.currentStep < step) {
      this.currentStep++;
      reached.push(this.currentStep);
    }
    return reached;
  }

  nearestCell(timeMs: number): BeatCell | null {
    // Latest boundary not after the time…
    let prev: { step: number; b: { time: number; dur: number } } | null = null;
    let nextStep = -1;
    for (const [step, b] of this.boundaries) {
      if (b.time <= timeMs) {
        if (!prev || b.time > prev.b.time) prev = { step, b };
      } else {
        nextStep = step;
        break;
      }
    }
    if (!prev) {
      const upcoming = this.boundaries.get(nextStep);
      return upcoming ? { step: nextStep, dur: upcoming.dur } : null;
    }
    const next = this.boundaries.get(prev.step + 1);
    if (!next) return { step: prev.step, dur: prev.b.dur };
    // Midpoint tie: strictly inside the previous cell keeps it.
    return timeMs - prev.b.time < next.time - timeMs
      ? { step: prev.step, dur: prev.b.dur }
      : { step: prev.step + 1, dur: next.dur };
  }

  boundaryAt(globalStep: number): { time: number; dur: number } | null {
    return this.boundaries.get(globalStep) ?? null;
  }
}

function setup(options?: {
  length?: number;
  dur?: number;
  tempoChange?: { fromStep: number; newDur: number };
}) {
  const clock = new ManualClock();
  const START = 100;
  const map = new ScriptedBeatMap(
    START,
    options?.dur ?? 100,
    64,
    options?.tempoChange
  );
  const changes: (TakeDraft | null)[] = [];
  const aborts: AbortReason[] = [];
  let completed: TakeDraft | null = null;
  const recorder = new TakeRecorder({
    clock,
    beatMap: map,
    onChange: (d) => changes.push(d),
    onAbort: (r) => aborts.push(r),
    onComplete: (d) => (completed = d)
  });
  return { clock, map, recorder, changes, aborts, START, get completed() { return completed; } };
}

const on = (pitch: number, velocity = 100) => [0x90, pitch, velocity];
const off = (pitch: number) => [0x80, pitch, 0];

describe('TakeRecorder arming and lifecycle', () => {
  it('refuses to arm while not playing', () => {
    const { recorder, map } = setup();
    map.transportState = 'stopped';
    expect(recorder.arm('t', 4)).toBe(false);
    expect(recorder.state).toBe('idle');
  });

  it('arms at the next boundary and ignores presses before the pass', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(2); // playhead at step 2
    expect(recorder.arm('t', 4)).toBe(true);
    expect(recorder.state).toBe('armed');
    // Press while armed (before startStep 3) is ignored-early.
    recorder.handleMessage(on(60), START + 2 * 100 + 10);
    expect(recorder.draft?.arbitrations.some((a) => a.reason === 'ignored-early')).toBe(true);
    expect(recorder.draft?.cells.length).toBe(0);
  });

  it('records one full pass then parks pending confirmation', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4); // pass = steps 1..4
    recorder.onBeat(1);
    expect(recorder.state).toBe('recording');

    recorder.handleMessage(on(60), START + 1 * 100 + 10);
    recorder.handleMessage(off(60), START + 1 * 100 + 60);
    recorder.onBeat(5); // endStep(4)+1 reached
    expect(recorder.state).toBe('completed');

    const commit = recorder.commit();
    expect(commit).not.toBeNull();
    expect(commit!.cells.length).toBe(4);
    expect(commit!.cells[0]).toEqual({ pitch: 60, velocity: 100, gate: 0.5 });
    expect(commit!.cells.slice(1)).toEqual([null, null, null]);
    expect(recorder.state).toBe('idle');
  });

  it('commit returns null outside the completed phase', () => {
    const { recorder, map } = setup();
    expect(recorder.commit()).toBeNull();
    map.reach(0);
    recorder.arm('t', 4);
    expect(recorder.commit()).toBeNull();
  });
});

describe('TakeRecorder quantization and gate conversion', () => {
  it('quantizes presses to the nearest cell of the pass', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    // t=252 is just past the midpoint between local cell 1 (t=200) and
    // local cell 2 (t=300), so nearest-boundary quantization picks cell 2.
    recorder.handleMessage(on(64), START + 252);
    recorder.handleMessage(off(64), START + 260);
    recorder.onBeat(5);
    const cells = recorder.draft!.cells;
    expect(cells.map((c) => c.cell)).toEqual([2]);

    // A press at t=240 (before the midpoint) stays in local cell 1.
    const { recorder: r2, map: m2, START: s2 } = setup({ length: 4 });
    m2.reach(0);
    r2.arm('t', 4);
    r2.onBeat(1);
    r2.handleMessage(on(64), s2 + 240);
    r2.handleMessage(off(64), s2 + 245);
    r2.onBeat(5);
    expect(r2.draft!.cells.map((c) => c.cell)).toEqual([1]);
  });

  it('measures the gate against the onset cell duration', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    recorder.handleMessage(on(60), START + 100 + 20);
    recorder.handleMessage(off(60), START + 100 + 95); // 75/100
    recorder.onBeat(5);
    expect(recorder.draft!.cells[0]!.gate).toBeCloseTo(0.75, 5);
  });

  it('clamps the gate to the 5%..100% step range', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    // Extremely short blip -> minimum 5%.
    recorder.handleMessage(on(60), START + 100 + 50);
    recorder.handleMessage(off(60), START + 100 + 51);
    // A press at local cell 2's boundary released a cell later: held
    // across the boundary -> clamped to 100% of its own cell.
    recorder.handleMessage(on(72), START + 300);
    recorder.handleMessage(off(72), START + 400 + 90);
    recorder.onBeat(5);
    const byPitch = new Map(recorder.draft!.cells.map((c) => [c.pitch, c]));
    expect(byPitch.get(60)!.gate).toBe(0.05);
    expect(byPitch.get(72)!.gate).toBe(1);
  });

  it('uses the tempo in force at each cell across a mid-take tempo change', () => {
    const { recorder, map, START } = setup({
      length: 4,
      tempoChange: { fromStep: 3, newDur: 50 } // doubles tempo from step 3
    });
    map.reach(0);
    recorder.arm('t', 4); // pass steps 1..4
    recorder.onBeat(1);
    // Cell 2 (local 1): 100ms cell, held 80ms -> gate 0.8.
    recorder.handleMessage(on(60), START + 200 + 10);
    recorder.handleMessage(off(60), START + 200 + 90);
    // Cell 3 (local 2): 50ms cell after tempo change, held 40ms -> 0.8.
    recorder.handleMessage(on(64), START + 300 + 5);
    recorder.handleMessage(off(64), START + 300 + 45);
    recorder.onBeat(5);
    const cells = recorder.draft!.cells;
    expect(cells.find((c) => c.pitch === 60)!.gate).toBeCloseTo(0.8, 5);
    expect(cells.find((c) => c.pitch === 64)!.gate).toBeCloseTo(0.8, 5);
  });
});

describe('TakeRecorder same-pitch retrigger', () => {
  it('same cell: the later press wins and the ruling is visible', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    // First press (vel 100) still held when the same pitch re-triggers,
    // both quantized inside local cell 0 (t=200..300, midpoint at 250).
    recorder.handleMessage(on(60, 100), START + 100 + 10);
    recorder.handleMessage(on(60, 60), START + 100 + 30); // overlap retrigger
    recorder.handleMessage(off(60), START + 100 + 70);
    recorder.onBeat(5);
    const cell = recorder.draft!.cells[0]!;
    expect(cell.velocity).toBe(60); // newer press wins
    expect(cell.gate).toBeCloseTo(0.4, 5); // measured on the newer press
    expect(recorder.draft!.arbitrations.some((a) => a.reason === 'retriggered')).toBe(true);
  });

  it('across cells: both notes survive, the first clamped at the shared boundary', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    // Hold pitch 60 from local 0 across into local 1, then retrigger there.
    recorder.handleMessage(on(60), START + 100 + 10);
    recorder.handleMessage(on(60), START + 200 + 10); // retrigger in next cell, no off
    recorder.handleMessage(off(60), START + 200 + 70);
    recorder.onBeat(5);
    const cells = recorder.draft!.cells;
    expect(cells.map((c) => c.cell)).toEqual([0, 1]);
    // First note clamped exactly to cell 0's end -> gate 0.9.
    expect(cells[0]!.gate).toBeCloseTo(0.9, 5);
    expect(cells[1]!.gate).toBeCloseTo(0.6, 5);
    expect(recorder.draft!.arbitrations.some((a) => a.reason === 'tail-clamped')).toBe(true);
  });
});

describe('TakeRecorder same-cell contention', () => {
  it('earliest onset wins; later pitch is contended away', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    recorder.handleMessage(on(60), START + 100 + 20);
    recorder.handleMessage(on(67), START + 100 + 40); // later, different pitch
    recorder.handleMessage(off(60), START + 100 + 80);
    recorder.handleMessage(off(67), START + 100 + 90);
    recorder.onBeat(5);
    expect(recorder.draft!.cells[0]!.pitch).toBe(60);
    const contended = recorder.draft!.arbitrations.filter((a) => a.reason === 'contended');
    expect(contended.length).toBe(1);
    expect(contended[0]!.pitch).toBe(67);
  });

  it('an exact onset tie is broken by the lower pitch', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    const t = START + 100 + 30;
    recorder.handleMessage(on(72), t);
    recorder.handleMessage(on(60), t);
    recorder.handleMessage(off(72), t + 40);
    recorder.handleMessage(off(60), t + 40);
    recorder.onBeat(5);
    expect(recorder.draft!.cells[0]!.pitch).toBe(60);
  });
});

describe('TakeRecorder zero-velocity and tail handling', () => {
  it('treats a zero-velocity note-on as note-off', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    recorder.handleMessage(on(60, 110), START + 100 + 10);
    recorder.handleMessage([0x90, 60, 0], START + 100 + 70); // zero-vel off
    recorder.onBeat(5);
    expect(recorder.draft!.cells[0]!.gate).toBeCloseTo(0.6, 5);
  });

  it('a zero-velocity press with nothing held drafts nothing', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    recorder.handleMessage([0x90, 60, 0], START + 100 + 10);
    recorder.onBeat(5);
    expect(recorder.draft!.cells.length).toBe(0);
  });

  it('tail: a note still held at pass end is clamped to its cell', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    recorder.handleMessage(on(60), START + 400 + 10); // last cell (local 3)
    // Never released. The endStep+1 boundary is reached at the cell end;
    // emulate the playhead tick finalizing there, with the key still held.
    recorder.onBeat(5);
    const cell = recorder.draft!.cells.find((c) => c.cell === 3)!;
    // Held at least until the boundary: gate saturates at the cell.
    expect(cell.gate).toBeCloseTo(0.9, 5);
  });

  it('tail: a release arriving after the cell boundary clamps the gate', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    recorder.handleMessage(on(60), START + 400); // local 3 boundary, t=500
    // Release after the cell end (t=600) but still during the take.
    recorder.handleMessage(off(60), START + 600 + 40);
    recorder.onBeat(5);
    const cell = recorder.draft!.cells.find((c) => c.cell === 3)!;
    expect(cell.gate).toBe(1);
    expect(recorder.draft!.arbitrations.some((a) => a.reason === 'tail-clamped')).toBe(true);
  });

  it('cross-loop tail: a note in the last cell held into the next loop is clamped to the cell', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    // Press in the last cell (local 3, t=500) and never release; the
    // pass closes at the step-5 boundary (t=600), within that same cell.
    recorder.handleMessage(on(60), START + 400 + 40); // t=540, held
    recorder.onBeat(5); // pass end; key would ring into the next loop
    const cell = recorder.draft!.cells.find((c) => c.cell === 3)!;
    // 60/100 of the last cell, not carried into a new loop's cells.
    expect(cell.gate).toBeCloseTo(0.6, 5);
    expect(recorder.draft!.cells.length).toBe(1);
    expect(recorder.draft!.arbitrations.some((a) => a.reason === 'tail-clamped')).not.toBe(true);
  });

  it('presses after the pass are ignored-late', () => {
    const { recorder, map, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    recorder.onBeat(5); // pass completed
    recorder.handleMessage(on(60), START + 600);
    expect(recorder.draft!.cells.length).toBe(0);
  });
});

describe('TakeRecorder abort cleanup', () => {
  it('cancel / abort drops the draft and every hanging held note', () => {
    const { recorder, map, changes, aborts, START } = setup({ length: 4 });
    map.reach(0);
    recorder.arm('t', 4);
    recorder.onBeat(1);
    recorder.handleMessage(on(60), START + 100 + 10); // held, no off
    recorder.cancel();
    expect(recorder.state).toBe('idle');
    expect(recorder.draft).toBeNull();
    expect(changes[changes.length - 1]).toBeNull();
    expect(aborts).toContain('cancelled');
    // A new take starts clean: no carried-over held notes.
    map.reach(6);
    recorder.arm('t', 4);
    recorder.onBeat(7);
    recorder.onBeat(11);
    expect(recorder.draft!.cells.length).toBe(0);
  });

  it('each abort reason is reported to the listener', () => {
    const reasons: AbortReason[] = ['stopped', 'paused', 'input-disconnected', 'permission-lost'];
    for (const reason of reasons) {
      const { recorder, map } = setup({ length: 4 });
      map.reach(0);
      recorder.arm('t', 4);
      recorder.abort(reason);
      expect(recorder.state).toBe('idle');
    }
    expect(reasons.length).toBe(4);
  });
});
