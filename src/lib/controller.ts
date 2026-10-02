/**
 * Application controller: owns the Svelte stores and wires them to the
 * scheduler, the MIDI device manager and the single-track take recorder.
 *
 * The controller is framework-thin on purpose — all timing/queueing
 * policy lives in the Scheduler, all MIDI policy in MidiDeviceManager,
 * all recording arbitration in TakeRecorder — so it can be driven from
 * a Svelte page, a unit test, or jsdom without real MIDI hardware.
 *
 * Recording keeps to its own draft: while a take is armed or in review
 * the playing score and the queued output are never touched. Confirm
 * applies the whole pass in one pattern mutation followed by one
 * scheduler reconciliation; cancel / stop / pause / input disconnect /
 * permission loss discard the draft.
 */

import { derived, get, writable, type Readable } from 'svelte/store';
import { BrowserClock, type Clock } from './sequencer/clock';
import {
  MidiDeviceManager,
  createBrowserDeviceManager,
  type MidiDeviceInfo,
  type MidiStatus
} from './sequencer/devices';
import type { MidiInputAdapter, MidiInputMessage } from './sequencer/midiInput';
import { Scheduler, type TransportState } from './sequencer/scheduler';
import {
  TakeRecorder,
  type TakeDraft
} from './sequencer/recorder';
import {
  MAX_TRACKS,
  MIN_TRACKS,
  clampInt,
  createPattern,
  createTrack,
  resizeTrack,
  type Pattern,
  type Step
} from './sequencer/types';

export const MIN_BPM = 20;
export const MAX_BPM = 300;

export interface StepSelection {
  trackId: string;
  index: number;
}

export interface ControllerOptions {
  clock?: Clock;
  deviceManager?: MidiDeviceManager;
  pattern?: Pattern;
}

export class SequencerController {
  // --- stores (view state) ---
  readonly pattern = writable<Pattern>();
  readonly tempo = writable<number>(120);
  readonly transport = writable<TransportState>('stopped');
  readonly midiStatus = writable<MidiStatus>('unknown');
  readonly outputs = writable<MidiDeviceInfo[]>([]);
  readonly inputs = writable<MidiDeviceInfo[]>([]);
  readonly selectedOutputId = writable<string | null>(null);
  readonly selectedInputId = writable<string | null>(null);
  readonly currentStep = writable<number>(-1);
  readonly notice = writable<string | null>(null);
  readonly selection = writable<StepSelection | null>(null);
  /** Isolated record draft (null when nothing is armed/recording). */
  readonly takeDraft = writable<TakeDraft | null>(null);

  readonly scheduler: Scheduler;
  readonly devices: MidiDeviceManager;
  readonly recorder: TakeRecorder;

  private inputAdapter: MidiInputAdapter | null = null;
  private unsubscribeInput: (() => void) | null = null;

  constructor(options: ControllerOptions = {}) {
    this.pattern.set(options.pattern ?? createPattern(4, 16));

    const clock = options.clock ?? new BrowserClock();
    this.devices = options.deviceManager ?? createBrowserDeviceManager();
    this.devices.setEvents({
      onDevicesChanged: (outputs) => this.onDevicesChanged(outputs),
      onOutputDisconnected: (id) => this.onOutputDisconnected(id),
      onInputsChanged: (inputs) => this.onInputsChanged(inputs),
      onInputDisconnected: (id) => this.onInputDisconnected(id),
      onPermissionLost: () => this.onPermissionLost()
    });

    this.scheduler = new Scheduler({
      clock,
      getPattern: () => get(this.pattern),
      getTempo: () => get(this.tempo),
      onStep: (step) => {
        this.currentStep.set(step);
        this.recorder.onBeat(step);
      },
      onStateChange: (state) => {
        this.transport.set(state);
        if (state === 'stopped') {
          this.currentStep.set(-1);
          this.recorder.abort('stopped');
        } else if (state === 'paused') {
          this.recorder.abort('paused');
        }
      }
    });

    this.recorder = new TakeRecorder({
      clock,
      beatMap: this.scheduler,
      onChange: (draft) => this.takeDraft.set(draft)
    });
  }

  /** Request MIDI access. Safe to call from onMount; never throws. */
  async init(): Promise<void> {
    const status = await this.devices.request();
    this.midiStatus.set(status);
    if (status === 'ready') {
      this.outputs.set(this.devices.outputs);
      this.inputs.set(this.devices.inputs);
      this.autoSelectOutput();
      this.autoSelectInput();
    } else if (status === 'unsupported') {
      this.notice.set('此浏览器不支持 Web MIDI——可以编辑乐谱，但无法播放与录入。');
    } else if (status === 'denied') {
      this.notice.set('Web MIDI 授权被拒绝——可以编辑乐谱，但无法播放与录入。');
    }
  }

  // --- transport ---

  play(): void {
    if (!this.scheduler.play()) {
      this.notice.set('没有可用的 MIDI 输出设备——可以编辑乐谱，但无法播放。');
    }
  }

  pause(): void {
    // An unconfirmed take cannot survive a pause: discard it first so no
    // hanging note is forgotten, then halt (keeps position).
    this.scheduler.pause();
  }

  stop(): void {
    this.scheduler.stop();
  }

  setTempo(bpm: number): void {
    const clamped = clampInt(bpm, MIN_BPM, MAX_BPM);
    this.tempo.set(clamped);
    this.scheduler.tempoChanged();
  }

  // --- output selection ---

  selectOutput(id: string | null): void {
    if (id === null) {
      // Dropping the output mid-play must not silently "play" nowhere.
      this.scheduler.setOutput(null);
      this.scheduler.stop();
      this.selectedOutputId.set(null);
      return;
    }
    const adapter = this.devices.adapterFor(id);
    if (!adapter) {
      this.notice.set('所选输出设备不可用。');
      return;
    }
    this.scheduler.setOutput(adapter);
    this.selectedOutputId.set(id);
    this.notice.set(null);
  }

  // --- input selection ---

  selectInput(id: string | null): void {
    // Switching (or dropping) the input mid-take invalidates the draft:
    // the device owning the hanging notes is going away.
    this.detachInput();
    if (id === null) {
      this.selectedInputId.set(null);
      return;
    }
    const adapter = this.devices.inputAdapterFor(id);
    if (!adapter) {
      this.notice.set('所选输入设备不可用。');
      this.selectedInputId.set(null);
      return;
    }
    this.inputAdapter = adapter;
    this.unsubscribeInput = adapter.onMessage((msg) => this.handleInputMessage(msg));
    this.selectedInputId.set(id);
  }

  private handleInputMessage(msg: MidiInputMessage): void {
    // The recorder is the single shared interpretation of the input;
    // nothing is echoed to the output while recording.
    this.recorder.handleMessage(msg.message, msg.timeMs);
  }

  // --- single-track record pending confirmation ---

  isTrackRecording(trackId: string): boolean {
    return this.recorder.armedTrackId === trackId;
  }

  /**
   * Arm one track for the next full pass. Requires playback (the take
   * is interpreted against the running beat timeline) and a connected
   * input. Returns false (with a visible notice) otherwise.
   */
  armTrack(trackId: string): boolean {
    const track = get(this.pattern).tracks.find((t) => t.id === trackId);
    if (!track) return false;
    if (this.scheduler.transportState !== 'playing') {
      this.notice.set('请先播放，再为音轨启用录制。');
      return false;
    }
    if (!this.inputAdapter || !this.inputAdapter.connected) {
      this.notice.set('没有可用的 MIDI 输入设备，无法录制。');
      return false;
    }
    if (track.muted) {
      this.notice.set('该音轨已静音，请先取消静音再录制。');
      return false;
    }
    if (this.recorder.state !== 'idle') {
      this.notice.set('上一轮录制待确认，请先确认写入或丢弃。');
      return false;
    }
    const armed = this.recorder.arm(trackId, track.steps.length);
    if (armed) this.notice.set(null);
    return armed;
  }

  /** Discard the unconfirmed draft (armed, recording or completed). */
  cancelTake(): void {
    this.recorder.cancel();
  }

  /**
   * Apply one completed pass atomically: overwrite every cell of the
   * track (recorded steps on, unrecorded off), then reconcile once. The
   * score keeps playing throughout; other tracks are untouched.
   */
  confirmTake(): boolean {
    const commit = this.recorder.commit();
    if (!commit) return false;
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === commit.trackId);
      if (track) {
        commit.cells.forEach((cell, i) => {
          const step = track.steps[i];
          if (!step) return;
          if (cell) {
            step.enabled = true;
            step.pitch = clampInt(cell.pitch, 0, 127);
            step.velocity = clampInt(cell.velocity, 1, 127);
            step.gate = Math.max(0.05, Math.min(1, cell.gate));
          } else {
            step.enabled = false;
          }
        });
      }
      return p;
    });
    // One reconciliation for the whole pass: stale queued/sounding
    // voices are released and due recorded cells join the existing
    // timeline immediately — all in the same call, so the output
    // message order at the confirm instant is well defined.
    this.scheduler.commitTake(commit.trackId);
    this.notice.set(null);
    return true;
  }

  // --- score editing (always available, MIDI or not) ---

  toggleStep(trackId: string, index: number): void {
    if (this.lockEdit(trackId)) return;
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      const step = track?.steps[index];
      if (track && step) {
        step.enabled = !step.enabled;
        this.selection.set({ trackId, index });
      }
      return p;
    });
    // A toggle must take effect immediately: cancel a note already queued
    // for a turned-off step, or make a turned-on step fire if it is due
    // inside the current lookahead window.
    this.scheduler.stepEdited(trackId, index);
  }

  updateStep(trackId: string, index: number, patch: Partial<Omit<Step, 'enabled'>>): void {
    if (this.lockEdit(trackId)) return;
    this.pattern.update((p) => {
      const step = p.tracks.find((t) => t.id === trackId)?.steps[index];
      if (step) {
        if (patch.pitch !== undefined) step.pitch = clampInt(patch.pitch, 0, 127);
        if (patch.velocity !== undefined) step.velocity = clampInt(patch.velocity, 1, 127);
        if (patch.gate !== undefined) {
          step.gate = Math.max(0.05, Math.min(1, patch.gate));
        }
      }
      return p;
    });
    // Apply pitch / velocity / gate changes to queued and sounding notes,
    // not only to steps scheduled after the edit.
    this.scheduler.stepEdited(trackId, index);
  }

  selectStep(trackId: string, index: number): void {
    this.selection.set({ trackId, index });
  }

  addTrack(): void {
    let added: string | null = null;
    this.pattern.update((p) => {
      if (p.tracks.length >= MAX_TRACKS) return p;
      const length = p.tracks[0]?.steps.length ?? 16;
      const track = createTrack(length);
      added = track.id;
      p.tracks.push(track);
      return p;
    });
    // Let the new track join the pattern immediately if it owns a due cell.
    if (added) this.scheduler.trackEdited(added);
  }

  removeTrack(trackId: string): void {
    // Removing the very track whose pass is pending discards that pass.
    if (this.recorder.armedTrackId === trackId) this.recorder.abort('cancelled');
    this.pattern.update((p) => {
      if (p.tracks.length <= MIN_TRACKS) return p;
      p.tracks = p.tracks.filter((t) => t.id !== trackId);
      const sel = get(this.selection);
      if (sel && sel.trackId === trackId) this.selection.set(null);
      return p;
    });
    // Cancel everything the removed track had queued or sounding.
    this.scheduler.trackEdited(trackId, true);
  }

  setTrackLength(trackId: string, length: number): void {
    if (this.lockEdit(trackId)) return;
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) resizeTrack(track, length);
      return p;
    });
    // Voices from cells the shortened track no longer owns must be
    // cancelled at once; surviving cells keep their scheduled voices.
    this.scheduler.trackEdited(trackId);
  }

  setTrackChannel(trackId: string, channel: number): void {
    if (this.lockEdit(trackId)) return;
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.channel = clampInt(channel, 0, 15);
      return p;
    });
    // Release notes on the old channel; due steps go out on the new one.
    this.scheduler.trackEdited(trackId);
  }

  toggleMute(trackId: string): void {
    if (this.lockEdit(trackId)) return;
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.muted = !track.muted;
      return p;
    });
    // Muting drops that track's queue and silences its notes; unmuting
    // lets due steps rejoin without restarting or moving the timeline.
    this.scheduler.trackEdited(trackId);
  }

  // --- device events ---

  private onDevicesChanged(outputs: MidiDeviceInfo[]): void {
    this.outputs.set(outputs);
    this.autoSelectOutput();
  }

  private onInputsChanged(inputs: MidiDeviceInfo[]): void {
    this.inputs.set(inputs);
    this.autoSelectInput();
  }

  private onOutputDisconnected(id: string): void {
    if (get(this.selectedOutputId) !== id) return;
    // The device we are playing through vanished: cut every note we
    // started, drop the queue and stop — never leave notes hanging.
    this.scheduler.setOutput(null);
    this.scheduler.stop();
    this.selectedOutputId.set(null);
    this.notice.set('MIDI 输出设备已断开，播放已停止。');
  }

  private onInputDisconnected(id: string): void {
    if (get(this.selectedInputId) !== id) return;
    const wasRecording = this.recorder.armedTrackId !== null;
    this.detachInput();
    this.selectedInputId.set(null);
    if (wasRecording) {
      // The keyboard vanished mid-take: discard the draft and release
      // bookkeeping for any keys that were still held.
      this.recorder.abort('input-disconnected');
    }
    this.autoSelectInput();
    this.notice.set('MIDI 输入设备已断开，未确认的录制已丢弃。');
  }

  private onPermissionLost(): void {
    // Authorization failure after a session started: the draft can never
    // be confirmed against a device, so discard it and stop.
    this.recorder.abort('permission-lost');
    this.detachInput();
    this.selectedInputId.set(null);
    this.scheduler.setOutput(null);
    this.scheduler.stop();
    this.selectedOutputId.set(null);
    this.midiStatus.set('denied');
    this.notice.set('MIDI 授权已失效——未确认的录制已丢弃，播放已停止。');
  }

  /** Editing the track with a pending draft would race the take; refuse. */
  private lockEdit(trackId: string): boolean {
    if (this.recorder.armedTrackId === trackId) {
      this.notice.set('该音轨正在录制待确认，请先确认或取消本轮录制。');
      return true;
    }
    return false;
  }

  private detachInput(): void {
    this.unsubscribeInput?.();
    this.unsubscribeInput = null;
    this.inputAdapter?.close();
    this.inputAdapter = null;
  }

  private autoSelectOutput(): void {
    const current = get(this.selectedOutputId);
    const outputs = get(this.outputs);
    const stillThere = outputs.some((o) => o.id === current && o.connected);
    if (stillThere) return;
    const first = outputs.find((o) => o.connected);
    if (first) {
      const adapter = this.devices.adapterFor(first.id);
      if (adapter) {
        this.scheduler.setOutput(adapter);
        this.selectedOutputId.set(first.id);
      }
    } else if (current !== null) {
      this.scheduler.setOutput(null);
      this.selectedOutputId.set(null);
    }
  }

  private autoSelectInput(): void {
    const current = get(this.selectedInputId);
    const inputs = get(this.inputs);
    const stillThere = inputs.some((i) => i.id === current && i.connected);
    if (stillThere) return;
    const first = inputs.find((i) => i.connected);
    if (first) {
      this.selectInput(first.id);
    } else if (current !== null) {
      this.detachInput();
      this.selectedInputId.set(null);
    }
  }
}

export function selectedStep(
  pattern: Readable<Pattern>,
  selection: Readable<StepSelection | null>
): Readable<{ trackId: string; index: number; step: Step } | null> {
  return derived([pattern, selection], ([p, s]) => {
    if (!s) return null;
    const track = p.tracks.find((t) => t.id === s.trackId);
    const step = track?.steps[s.index];
    return step ? { trackId: s.trackId, index: s.index, step } : null;
  });
}
