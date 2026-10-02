/**
 * End-to-end record-pending-confirmation tests:
 *
 * controller + scheduler + TakeRecorder share one ManualClock timeline
 * and one recording result. A fake MIDI keyboard feeds note-on /
 * note-off at explicit clock times while the existing score plays;
 * tests cover tempo changes, same-pitch retrigger, input disconnect,
 * MIDI permission loss, and the output message ordering exactly at the
 * confirm instant.
 *
 * The scheduler ticks every 25ms, so boundaries only become observable
 * at tick time; `reach(step)` advances in tick-sized steps until the
 * playhead reports the boundary, after which notes with timestamps
 * inside that cell are fed directly to the keyboard.
 */
import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { SequencerController } from '../src/lib/controller';
import { ManualClock } from '../src/lib/sequencer/clock';
import { MidiDeviceManager, type MidiAccessLike } from '../src/lib/sequencer/devices';
import { WebMidiInputAdapter } from '../src/lib/sequencer/midiInput';
import { RecordingOutputAdapter } from '../src/lib/sequencer/output';
import { createPattern } from '../src/lib/sequencer/types';
import { FakeMidiAccess, FakeMidiInput } from './fakeMidi';

/** Input adapter over a FakeMidiInput: the fake already provides the
 *  port.onmidimessage hook WebMidiInputAdapter binds to. */
class FakeInputAdapter extends WebMidiInputAdapter {
  constructor(port: FakeMidiInput) {
    super(port as never);
  }
}

interface Rig {
  clock: ManualClock;
  out: RecordingOutputAdapter;
  access: FakeMidiAccess;
  manager: MidiDeviceManager;
  controller: SequencerController;
  pattern: ReturnType<typeof createPattern>;
  keyPort: FakeMidiInput;
  keyOn: (pitch: number, timeMs: number, velocity?: number) => void;
  keyOff: (pitch: number, timeMs: number) => void;
  keyZero: (pitch: number, timeMs: number) => void;
  /** Advance ticks until the playhead reaches global step `step`. */
  reach: (step: number) => void;
}

function makeRig(): Rig {
  const clock = new ManualClock();
  const out = new RecordingOutputAdapter('out', 'Out');
  const access = new FakeMidiAccess();
  access.plug('out', 'Out');
  const keyPort = access.plugInput('keys', 'Keys');

  const manager = new MidiDeviceManager(
    () => Promise.resolve(access as unknown as MidiAccessLike)
  );
  manager.inputAdapterFor = (id: string) =>
    id === 'keys' ? new FakeInputAdapter(keyPort) : null;
  // Output goes to the clock-agnostic RecordingOutputAdapter (the
  // Web MIDI adapter clamps timestamps to performance.now(), which is
  // meaningless against the ManualClock under jsdom).
  manager.adapterFor = (id: string) => (id === 'out' ? out : null);

  const pattern = createPattern(2, 4);
  for (const t of pattern.tracks) for (const s of t.steps) s.enabled = false;

  const controller = new SequencerController({ clock, deviceManager: manager, pattern });

  const rig: Rig = {
    clock,
    out,
    access,
    manager,
    controller,
    pattern,
    keyPort,
    keyOn: (pitch, timeMs, velocity = 100) =>
      keyPort.receive([0x90, pitch, velocity], timeMs),
    keyOff: (pitch, timeMs) => keyPort.receive([0x80, pitch, 0], timeMs),
    keyZero: (pitch, timeMs) => keyPort.receive([0x90, pitch, 0], timeMs),
    reach: (step: number) => {
      let guard = 0;
      while (get(controller.currentStep) < step && guard++ < 1000) clock.advance(25);
    }
  };
  return rig;
}

async function ready(rig: Rig): Promise<void> {
  await rig.controller.init();
  rig.controller.selectOutput('out');
  rig.controller.selectInput('keys');
}

const noteOns = (out: RecordingOutputAdapter) =>
  out.sent.filter((m) => (m.message[0]! & 0xf0) === 0x90);
/** Boundary time of global step n: playback starts at t=1, 125ms/step. */
const btime = (n: number) => 1 + n * 125;

describe('record pending confirmation — integration', () => {
  it('records a pass against the beat timeline without altering playback', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, out, pattern, keyOn, keyOff } = rig;

    // A note on the OTHER track proves playback continues untouched.
    pattern.tracks[1]!.steps[0]!.enabled = true;
    pattern.tracks[1]!.steps[0]!.pitch = 48;

    controller.play();
    rig.reach(0); // step 0 (t=1) observed by a tick
    const trackId = pattern.tracks[0]!.id;
    expect(controller.armTrack(trackId)).toBe(true);

    rig.reach(1); // pass (steps 1..4) begins
    keyOn(62, btime(1) + 20);
    keyOff(62, btime(1) + 80); // 60/125 -> gate 0.48

    rig.reach(5); // endStep+1 → pass completes
    const draft = get(controller.takeDraft);
    expect(draft?.phase).toBe('completed');
    expect(draft?.cells.map((c) => c.cell)).toEqual([0]);
    expect(draft?.cells[0]!.pitch).toBe(62);
    expect(draft?.cells[0]!.gate).toBeCloseTo(0.48, 2);

    // Recorded track is untouched while pending; the other track plays.
    expect(pattern.tracks[0]!.steps[0]!.enabled).toBe(false);
    expect(noteOns(out).some((m) => m.message[1] === 48)).toBe(true);

    expect(controller.confirmTake()).toBe(true);
    expect(pattern.tracks[0]!.steps[0]!.enabled).toBe(true);
    expect(pattern.tracks[0]!.steps[0]!.pitch).toBe(62);
    expect(pattern.tracks[0]!.steps[1]!.enabled).toBe(false); // unrecorded off
    expect(get(controller.takeDraft)).toBeNull();
    controller.stop();
  });

  it('refuses to arm without an input or while stopped', async () => {
    const rig = makeRig();
    await ready(rig);
    const { clock, controller, pattern } = rig;
    const trackId = pattern.tracks[0]!.id;
    expect(controller.armTrack(trackId)).toBe(false); // stopped
    expect(get(controller.notice)).toMatch(/播放/);

    controller.play();
    rig.reach(0);
    controller.selectInput(null);
    expect(controller.armTrack(trackId)).toBe(false); // no input
    expect(get(controller.notice)).toMatch(/输入/);
    controller.stop();
    void clock;
  });

  it('only one track can have a pending take; arming another is refused', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, pattern } = rig;
    controller.play();
    rig.reach(0);
    expect(controller.armTrack(pattern.tracks[0]!.id)).toBe(true);
    expect(controller.armTrack(pattern.tracks[1]!.id)).toBe(false);
    expect(get(controller.notice)).toMatch(/待确认/);
    // Other tracks remain fully editable and unaffected.
    controller.toggleStep(pattern.tracks[1]!.id, 2);
    expect(pattern.tracks[1]!.steps[2]!.enabled).toBe(true);
    controller.cancelTake();
    expect(controller.armTrack(pattern.tracks[1]!.id)).toBe(true);
    controller.stop();
  });

  it('editing the armed track is blocked while a take is pending', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, pattern } = rig;
    controller.play();
    rig.reach(0);
    controller.armTrack(pattern.tracks[0]!.id);
    const before = pattern.tracks[0]!.steps[2]!.enabled;
    controller.toggleStep(pattern.tracks[0]!.id, 2);
    expect(pattern.tracks[0]!.steps[2]!.enabled).toBe(before);
    expect(get(controller.notice)).toMatch(/录制/);
    controller.stop();
  });

  it('cancel drops the draft, clears held notes and keeps playback going', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, pattern, keyOn } = rig;
    controller.play();
    rig.reach(0);
    const trackId = pattern.tracks[0]!.id;
    controller.armTrack(trackId);
    rig.reach(1);
    keyOn(60, btime(1) + 10); // held, no off
    controller.cancelTake();
    expect(get(controller.takeDraft)).toBeNull();
    expect(pattern.tracks[0]!.steps.every((s) => !s.enabled)).toBe(true);
    expect(get(controller.transport)).toBe('playing');
    controller.stop();
  });

  it('stop and pause both discard an unconfirmed draft', async () => {
    for (const op of ['stop', 'pause'] as const) {
      const rig = makeRig();
      await ready(rig);
      const { controller, pattern } = rig;
      controller.play();
      rig.reach(0);
      controller.armTrack(pattern.tracks[0]!.id);
      rig.reach(1);
      if (op === 'stop') controller.stop();
      else controller.pause();
      expect(get(controller.takeDraft)).toBeNull();
    }
  });

  it('input disconnect mid-take discards the draft and drops the selection', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, access, pattern, keyOn } = rig;
    controller.play();
    rig.reach(0);
    controller.armTrack(pattern.tracks[0]!.id);
    rig.reach(1);
    keyOn(60, btime(1) + 10); // held on the keyboard
    access.unplugInput('keys');
    expect(get(controller.takeDraft)).toBeNull();
    expect(get(controller.selectedInputId)).toBeNull();
    expect(get(controller.notice)).toMatch(/输入设备已断开/);
    // The detached port can no longer feed anything.
    rig.keyPort.receive([0x90, 61, 100], 400);
    expect(get(controller.takeDraft)).toBeNull();
    controller.stop();
  });

  it('MIDI permission loss discards the draft, detaches input and stops', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, access, pattern, keyOn } = rig;
    controller.play();
    rig.reach(0);
    controller.armTrack(pattern.tracks[0]!.id);
    rig.reach(1);
    keyOn(70, btime(1) + 10); // hanging held note
    access.revokePermission();
    expect(get(controller.takeDraft)).toBeNull();
    expect(get(controller.midiStatus)).toBe('denied');
    expect(get(controller.transport)).toBe('stopped');
    expect(get(controller.selectedInputId)).toBeNull();
    expect(get(controller.selectedOutputId)).toBeNull();
    expect(get(controller.notice)).toMatch(/授权/);
    rig.keyPort.receive([0x90, 60, 100], 500);
    expect(get(controller.takeDraft)).toBeNull();
  });

  it('quantizes with the tempo in force after a mid-take tempo change', async () => {
    const rig = makeRig();
    await ready(rig);
    const { clock, controller, pattern, keyOn, keyOff } = rig;
    controller.play();
    rig.reach(0);
    controller.armTrack(pattern.tracks[0]!.id);
    rig.reach(1);

    // Local cell 0 on the 125ms grid: 80ms held -> gate 0.64.
    keyOn(60, btime(1) + 20);
    keyOff(60, btime(1) + 100);

    rig.reach(2); // boundary step 2 (t=251)
    controller.setTempo(240); // cells become 62.5ms
    rig.reach(3); // step 3 now planned at 313.5, observed by a tick
    keyOn(64, 323);
    keyOff(64, 363); // 40/62.5 -> gate 0.64

    rig.reach(5); // pass end
    const draft = get(controller.takeDraft)!;
    const c0 = draft.cells.find((c) => c.cell === 0)!;
    const c2 = draft.cells.find((c) => c.cell === 2)!;
    expect(c0.gate).toBeCloseTo(0.64, 2);
    expect(c2.pitch).toBe(64);
    expect(c2.gate).toBeCloseTo(0.64, 2);
    controller.stop();
    void clock;
  });

  it('zero-velocity note-on closes the held note deterministically', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, pattern, keyOn, keyZero } = rig;
    controller.play();
    rig.reach(0);
    controller.armTrack(pattern.tracks[0]!.id);
    rig.reach(1);
    keyOn(60, btime(1) + 20);
    keyZero(60, btime(1) + 80); // running-status note-off: 60ms -> 0.48
    rig.reach(5);
    const cell = get(controller.takeDraft)!.cells[0]!;
    expect(cell.pitch).toBe(60);
    expect(cell.gate).toBeCloseTo(0.48, 2);
    controller.stop();
  });

  it('same-pitch retrigger in one cell goes to the later press', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, pattern, keyOn, keyOff } = rig;
    controller.play();
    rig.reach(0);
    controller.armTrack(pattern.tracks[0]!.id);
    rig.reach(1);
    keyOn(60, btime(1) + 20);
    keyOn(60, btime(1) + 50); // overlapping retrigger, same cell
    keyOff(60, btime(1) + 90);
    rig.reach(5);
    const draft = get(controller.takeDraft)!;
    expect(draft.cells[0]!.gate).toBeCloseTo(0.32, 2); // newer press: 40/125
    expect(draft.arbitrations.some((a) => a.reason === 'retriggered')).toBe(true);
    controller.stop();
  });

  it('confirm applies the whole pass atomically and never fires notes retroactively', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, out, keyOn, keyOff } = rig;
    const pattern = rig.pattern;
    const t0 = pattern.tracks[0]!;
    t0.steps[0]!.enabled = true;
    t0.steps[0]!.pitch = 60;
    t0.steps[0]!.gate = 0.5;
    // Sibling track shares the channel.
    const t1 = pattern.tracks[1]!;
    t1.channel = 0;
    t1.steps[0]!.enabled = true;
    t1.steps[0]!.pitch = 64;
    t1.steps[0]!.gate = 1;

    controller.play();
    rig.reach(0);
    controller.armTrack(t0.id); // pass = steps 1..4
    rig.reach(1);
    keyOn(72, btime(1) + 10);
    keyOff(72, btime(1) + 100);
    rig.reach(5); // pass completes

    const sentBefore = out.sent.length;
    expect(controller.confirmTake()).toBe(true);
    const burst = out.sent.slice(sentBefore).map((m) => m.message);
    // Nothing is fired retroactively for the just-finished pass…
    expect(burst.some((m) => (m[0]! & 0xf0) === 0x90)).toBe(false);
    // …and the sibling track's voice is never released by the commit.
    expect(burst.some((m) => (m[0]! & 0xf0) === 0x80 && m[1] === 64)).toBe(false);
    // Entire pass written in one shot (recorded cell on, others off).
    expect(t0.steps[0]!.enabled).toBe(true);
    expect(t0.steps[0]!.pitch).toBe(72);
    expect([t0.steps[1]!.enabled, t0.steps[2]!.enabled, t0.steps[3]!.enabled]).toEqual([
      false,
      false,
      false
    ]);

    // Next loop cell 0 plays 72; the sibling 64 keeps going; wire ends clean.
    rig.reach(get(controller.currentStep) + 4);
    expect(noteOns(out).some((m) => m.message[1] === 72)).toBe(true);
    controller.stop();
    const held = new Set<string>();
    for (const m of out.sent) {
      const k = `${m.message[0]! & 0xf}:${m.message[1]}`;
      if ((m.message[0]! & 0xf0) === 0x90) held.add(k);
      else held.delete(k);
    }
    expect([...held]).toEqual([]);
  });

  it('deselecting the input detaches the adapter (no more messages)', async () => {
    const rig = makeRig();
    await ready(rig);
    const { controller, keyPort } = rig;
    // After deselection the port listener is removed; feeding bytes is a
    // harmless no-op and never starts a take.
    controller.selectInput(null);
    expect(get(controller.selectedInputId)).toBeNull();
    keyPort.receive([0x90, 60, 100], 5);
    expect(get(controller.takeDraft)).toBeNull();
  });

  it('with no MIDI input, editing and playback of the original score still work', async () => {    const rig = makeRig();
    await rig.controller.init();
    rig.controller.selectOutput('out');
    rig.controller.selectInput(null);
    const { clock, controller, pattern } = rig;
    controller.toggleStep(pattern.tracks[0]!.id, 0);
    expect(pattern.tracks[0]!.steps[0]!.enabled).toBe(true);
    controller.play();
    clock.advance(200);
    expect(noteOns(rig.out).length).toBeGreaterThan(0);
    controller.stop();
  });
});
