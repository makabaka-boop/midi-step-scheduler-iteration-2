/**
 * Application controller: owns the Svelte stores and wires them to the
 * scheduler and the MIDI device manager.
 *
 * The controller is framework-thin on purpose — all timing/queueing
 * policy lives in the Scheduler, all MIDI policy in MidiDeviceManager —
 * so it can be driven from a Svelte page, a unit test, or jsdom without
 * real MIDI hardware.
 */

import { derived, get, writable, type Readable } from 'svelte/store';
import { BrowserClock, type Clock } from './sequencer/clock';
import {
  MidiDeviceManager,
  createBrowserDeviceManager,
  type MidiDeviceInfo,
  type MidiStatus
} from './sequencer/devices';
import { Scheduler, type TransportState } from './sequencer/scheduler';
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
  readonly selectedOutputId = writable<string | null>(null);
  readonly currentStep = writable<number>(-1);
  readonly notice = writable<string | null>(null);
  readonly selection = writable<StepSelection | null>(null);

  readonly scheduler: Scheduler;
  readonly devices: MidiDeviceManager;

  constructor(options: ControllerOptions = {}) {
    this.pattern.set(options.pattern ?? createPattern(4, 16));

    this.devices = options.deviceManager ?? createBrowserDeviceManager();
    this.devices.setEvents({
      onDevicesChanged: (outputs) => this.onDevicesChanged(outputs),
      onOutputDisconnected: (id) => this.onOutputDisconnected(id)
    });

    this.scheduler = new Scheduler({
      clock: options.clock ?? new BrowserClock(),
      getPattern: () => get(this.pattern),
      getTempo: () => get(this.tempo),
      onStep: (step) => this.currentStep.set(step),
      onStateChange: (state) => {
        this.transport.set(state);
        if (state === 'stopped') this.currentStep.set(-1);
      }
    });
  }

  /** Request MIDI access. Safe to call from onMount; never throws. */
  async init(): Promise<void> {
    const status = await this.devices.request();
    this.midiStatus.set(status);
    if (status === 'ready') {
      this.outputs.set(this.devices.outputs);
      this.autoSelectOutput();
    } else if (status === 'unsupported') {
      this.notice.set('此浏览器不支持 Web MIDI——可以编辑乐谱，但无法播放。');
    } else if (status === 'denied') {
      this.notice.set('Web MIDI 授权被拒绝——可以编辑乐谱，但无法播放。');
    }
  }

  // --- transport ---

  play(): void {
    if (!this.scheduler.play()) {
      this.notice.set('没有可用的 MIDI 输出设备——可以编辑乐谱，但无法播放。');
    }
  }

  pause(): void {
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

  // --- score editing (always available, MIDI or not) ---

  toggleStep(trackId: string, index: number): void {
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
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.channel = clampInt(channel, 0, 15);
      return p;
    });
    // Release notes on the old channel; due steps go out on the new one.
    this.scheduler.trackEdited(trackId);
  }

  toggleMute(trackId: string): void {
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

  private onOutputDisconnected(id: string): void {
    if (get(this.selectedOutputId) !== id) return;
    // The device we are playing through vanished: cut every note we
    // started, drop the queue and stop — never leave notes hanging.
    this.scheduler.setOutput(null);
    this.scheduler.stop();
    this.selectedOutputId.set(null);
    this.notice.set('MIDI 输出设备已断开，播放已停止。');
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
