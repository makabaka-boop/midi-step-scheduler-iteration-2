/**
 * Single-track "record pending confirmation" core.
 *
 * While the existing score keeps playing untouched, a TakeRecorder arms
 * one track and listens to an input device. Raw note-on / note-off bytes
 * are interpreted against the scheduler's own beat timeline (`BeatMap`),
 * so recorded notes are quantized to exactly the grid the playhead is
 * following — including tempo changes mid-take — never to a parallel
 * clock.
 *
 * Everything lives in an isolated draft until the user confirms:
 *
 *   idle → armed (waiting for the pass's first boundary)
 *        → recording (one full loop of the selected track)
 *        → completed (draft waiting for confirm/cancel)
 *
 * Confirm returns one `TakeCommit`; the caller writes it into the score
 * in a single mutation and asks the scheduler to reconcile once.
 * Cancel, stop, pause, device disconnect and permission loss all abort,
 * dropping the draft and forgetting any hanging held notes. Recording
 * never sends MIDI and never mutates the playing score or the output
 * queue, so other tracks and the shared output are unaffected.
 *
 * Arbitration is deterministic and visible (every ruling carries a
 * reason):
 *
 * - same-pitch retrigger: the new press restarts the voice (MIDI
 *   semantics); if it lands in the same cell the newer press wins and
 *   the older instance is logged `retriggered`; across cells both notes
 *   are kept, the first clamped to the boundary between them;
 * - same-cell contention between different pitches: earliest onset
 *   wins, ties broken by lower pitch; the loser is `contended`;
 * - a held note reaching a later cell boundary or the pass end is
 *   `tail-clamped` to its own cell;
 * - zero-velocity note-on is a note-off (running-status MIDI).
 */

import type { Clock } from './clock';
import type { MidiMessage } from './midi';

/** A step cell on the scheduler beat timeline. */
export interface BeatCell {
  /** Global step index (unbounded; loops are `step % trackLength`). */
  step: number;
  /** Duration of that cell in ms under the tempo in force there. */
  dur: number;
}

/** The part of the Scheduler the recorder quantizes against. */
export interface BeatMap {
  transportState: 'stopped' | 'playing' | 'paused';
  /** Last global step boundary the playhead reached (-1 before play). */
  readonly currentStep: number;
  /** Nearest cell for a point on the clock timeline (midpoint tie). */
  nearestCell(timeMs: number): BeatCell | null;
  /** Exact boundary time and cell duration for a global step. */
  boundaryAt(globalStep: number): { time: number; dur: number } | null;
}

export type TakePhase = 'idle' | 'armed' | 'recording' | 'completed';

export type AbortReason =
  | 'cancelled'
  | 'stopped'
  | 'paused'
  | 'input-disconnected'
  | 'permission-lost';

/** Why an input event was adjudicated the way it was. */
export type ArbitrationReason =
  | 'retriggered' // same pitch pressed again in the same cell — older lost
  | 'contended' // another pitch earlier in the same cell — later lost
  | 'tail-clamped' // held across a cell boundary / the pass end
  | 'ignored-late' // arrived after the pass had ended
  | 'ignored-early'; // arrived while armed, before the pass began

export interface Arbitration {
  id: number;
  pitch: number;
  cell: number | null;
  reason: ArbitrationReason;
  detail: string;
}

/** A note currently held on the input, already mapped to a cell. */
export interface HeldNote {
  pitch: number;
  cell: number;
  /** Onset time on the clock timeline. */
  onTime: number;
  /** Velocity of the press (1..127). */
  velocity: number;
}

/** One finalized winner for a pass cell. */
export interface DraftCell {
  cell: number;
  pitch: number;
  velocity: number;
  /** Gate as a fraction of the onset cell, in (0, 1]. */
  gate: number;
  /** Physical onset time, for deterministic same-cell rulings. */
  onTime: number;
}

/** The isolated draft: winners, live held notes and visible rulings. */
export interface TakeDraft {
  trackId: string;
  trackLength: number;
  phase: TakePhase;
  /** First and last global step of this pass. */
  startStep: number;
  endStep: number;
  /** Finalized cell winners, ascending by cell. */
  cells: DraftCell[];
  /** Notes still held while recording (visible but not yet finalized). */
  held: HeldNote[];
  arbitrations: Arbitration[];
}

/** A complete, committable pass. */
export interface TakeCommit {
  trackId: string;
  /** One entry per track cell: null = cell left off after the pass. */
  cells: ({ pitch: number; velocity: number; gate: number } | null)[];
}

export interface TakeRecorderOptions {
  clock: Clock;
  beatMap: BeatMap;
  onChange?: (draft: TakeDraft | null) => void;
  onAbort?: (reason: AbortReason) => void;
  onComplete?: (draft: TakeDraft) => void;
  maxArbitrations?: number;
}

export class TakeRecorder {
  private readonly clock: Clock;
  private readonly beatMap: BeatMap;
  private readonly onChange?: (draft: TakeDraft | null) => void;
  private readonly onAbort?: (reason: AbortReason) => void;
  private readonly onComplete?: (draft: TakeDraft) => void;
  private readonly maxArbitrations: number;

  private phase: TakePhase = 'idle';
  private trackId: string | null = null;
  private trackLength = 0;
  private startStep = 0;
  private endStep = 0;

  /** Held presses by pitch; a same-pitch retrigger replaces the entry. */
  private held = new Map<number, HeldNote>();
  /** Finalized winners by cell (one note per cell). */
  private winners = new Map<number, DraftCell>();
  private arbitrations: Arbitration[] = [];
  private arbSeq = 0;

  constructor(options: TakeRecorderOptions) {
    this.clock = options.clock;
    this.beatMap = options.beatMap;
    this.onChange = options.onChange;
    this.onAbort = options.onAbort;
    this.onComplete = options.onComplete;
    this.maxArbitrations = options.maxArbitrations ?? 100;
  }

  get state(): TakePhase {
    return this.phase;
  }

  get armedTrackId(): string | null {
    return this.phase === 'idle' ? null : this.trackId;
  }

  get draft(): TakeDraft | null {
    return this.phase === 'idle' || !this.trackId ? null : this.snapshot(this.phase);
  }

  /**
   * Arm for one pass of `trackLength` cells, beginning at the next
   * boundary after the playhead's current position. Only possible
   * while playing; returns false otherwise.
   */
  arm(trackId: string, trackLength: number): boolean {
    if (this.phase !== 'idle') return false;
    if (this.beatMap.transportState !== 'playing') return false;
    if (trackLength < 1) return false;
    this.phase = 'armed';
    this.trackId = trackId;
    this.trackLength = trackLength;
    this.startStep = this.beatMap.currentStep + 1;
    this.endStep = this.startStep + trackLength - 1;
    this.held.clear();
    this.winners.clear();
    this.arbitrations = [];
    this.emitChange();
    return true;
  }

  /** Playhead callback: drives armed→recording→completed. */
  onBeat(globalStep: number): void {
    if (this.phase === 'armed' && globalStep === this.startStep) {
      this.phase = 'recording';
      this.emitChange();
    } else if (this.phase === 'recording' && globalStep === this.endStep + 1) {
      this.finalizePass();
    }
  }

  /** Feed one raw input message (the input channel is ignored — the
   *  armed track defines the destination). */
  handleMessage(message: MidiMessage, timeMs?: number): void {
    if (this.phase !== 'armed' && this.phase !== 'recording') return;
    const status = message[0] ?? 0;
    const command = status & 0xf0;
    const pitch = message[1] ?? 0;
    const velocity = message[2] ?? 0;
    if (command === 0x90 && velocity > 0) {
      this.noteOn(pitch, velocity, timeMs ?? this.clock.now());
    } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      // Zero-velocity note-on is the running-status form of note-off.
      this.noteOff(pitch, timeMs ?? this.clock.now());
    }
  }

  /** Take the completed draft; null unless a pass is awaiting decision. */
  commit(): TakeCommit | null {
    if (this.phase !== 'completed' || !this.trackId) return null;
    const cells: TakeCommit['cells'] = [];
    for (let i = 0; i < this.trackLength; i++) {
      const winner = this.winners.get(i);
      cells.push(
        winner ? { pitch: winner.pitch, velocity: winner.velocity, gate: winner.gate } : null
      );
    }
    const trackId = this.trackId;
    this.reset();
    this.onChange?.(null);
    return { trackId, cells };
  }

  /** User discard of an armed / recording / completed draft. */
  cancel(): void {
    this.abort('cancelled');
  }

  /**
   * Discard the unconfirmed draft and forget every hanging held note.
   * Used for cancel, stop, pause, input disconnect and permission loss.
   */
  abort(reason: AbortReason): void {
    if (this.phase === 'idle') return;
    this.reset();
    this.onChange?.(null);
    this.onAbort?.(reason);
  }

  // -------------------------------------------------------------------

  private noteOn(pitch: number, velocity: number, time: number): void {
    const cell = this.quantizeCell(time);
    if (cell === null) {
      this.log(pitch, null, 'ignored-early', '本轮开始前到达，已忽略');
      return;
    }
    if (cell >= this.trackLength) {
      this.log(pitch, null, 'ignored-late', '本轮结束后到达，已忽略');
      return;
    }

    const previous = this.held.get(pitch);
    if (previous) {
      // Same-pitch retrigger: close the old voice at the new onset.
      this.resolve(previous, time, { retriggerCell: cell });
    }

    this.held.set(pitch, { pitch, cell, onTime: time, velocity });
    this.emitChange();
  }

  private noteOff(pitch: number, time: number): void {
    const held = this.held.get(pitch);
    if (!held) return; // orphan off / zero-velocity press: no voice to close
    this.held.delete(pitch);
    this.resolve(held, time, null);
    this.emitChange();
  }

  /**
   * Finalize one held voice at `time`. Gate is the physical held time
   * against the onset cell's own duration and is capped at the onset
   * cell's end (a step gate never exceeds one step). Same-pitch
   * retrigger and same-cell contention are adjudicated by fixed rules.
   */
  private resolve(
    held: HeldNote,
    time: number,
    retrigger: { retriggerCell: number } | null
  ): void {
    const onsetBoundary = this.beatMap.boundaryAt(this.startStep + held.cell);
    if (!onsetBoundary) return; // timeline gone (stop) — nothing to draft

    // The gate is a fraction of *one* step: a note ringing into the
    // next cell (held key, cross-loop tail, or later retrigger) is
    // clamped to the onset cell's own end.
    const cellEnd = onsetBoundary.time + onsetBoundary.dur;
    let clamped = false;
    let endTime = time;
    if (retrigger && retrigger.retriggerCell !== held.cell) {
      endTime = cellEnd; // predecessor stops at its cell boundary
      clamped = true;
    } else if (time > cellEnd) {
      endTime = cellEnd;
      clamped = true;
    }

    const gate = clampGate((endTime - held.onTime) / onsetBoundary.dur);
    const candidate: DraftCell = {
      cell: held.cell,
      pitch: held.pitch,
      velocity: held.velocity,
      gate,
      onTime: held.onTime
    };

    const incumbent = this.winners.get(held.cell);
    let winner = candidate;
    if (incumbent) {
      const samePitch = incumbent.pitch === held.pitch;
      if (samePitch) {
        // MIDI retrigger semantics on the same cell: the newer press
        // restarts the voice and wins the cell.
        this.log(
          incumbent.pitch,
          held.cell,
          'retriggered',
          `步 ${held.cell + 1} 同音高重触发：后一次演奏覆盖前一次`
        );
        winner = candidate;
      } else {
        // Contention: earliest onset wins; exact tie -> lower pitch.
        const candidateWins =
          held.onTime < incumbent.onTime ||
          (held.onTime === incumbent.onTime && held.pitch < incumbent.pitch);
        if (candidateWins) {
          this.log(
            incumbent.pitch,
            held.cell,
            'contended',
            `步 ${held.cell + 1} 竞争：音高 ${held.pitch} 更早，丢弃音高 ${incumbent.pitch}`
          );
        } else {
          this.log(
            held.pitch,
            held.cell,
            'contended',
            `步 ${held.cell + 1} 竞争：音高 ${incumbent.pitch} 更早，丢弃音高 ${held.pitch}`
          );
          winner = incumbent;
        }
      }
    }
    this.winners.set(held.cell, winner);
    if (clamped) {
      this.log(
        held.pitch,
        held.cell,
        'tail-clamped',
        `步 ${held.cell + 1} 音符跨过边界/循环尾部：门长钳制到步末`
      );
    }
  }

  /** Close every still-held voice at the pass end, then park for review. */
  private finalizePass(): void {
    // The endStep+1 boundary has just been reached, so every cell edge
    // (including the last) is resolvable from the beat timeline.
    const afterLast = this.beatMap.boundaryAt(this.endStep + 1);
    const endTime = afterLast?.time ?? this.clock.now();
    for (const held of [...this.held.values()]) {
      this.resolve(held, endTime, null);
    }
    this.held.clear();
    this.phase = 'completed';
    const draft = this.snapshot('completed');
    this.emit('completed', draft);
  }

  /** Map a clock time to a local pass cell index. */
  private quantizeCell(time: number): number | null {
    if (this.phase === 'armed') return null;
    const beat = this.beatMap.nearestCell(time);
    if (!beat) return null;
    const local = beat.step - this.startStep;
    return local < 0 ? null : local; // >= trackLength = past the pass
  }

  private log(pitch: number, cell: number | null, reason: ArbitrationReason, detail: string): void {
    this.arbitrations.push({ id: ++this.arbSeq, pitch, cell, reason, detail });
    if (this.arbitrations.length > this.maxArbitrations) {
      this.arbitrations.splice(0, this.arbitrations.length - this.maxArbitrations);
    }
  }

  private snapshot(phase: TakePhase): TakeDraft {
    return {
      trackId: this.trackId!,
      trackLength: this.trackLength,
      phase,
      startStep: this.startStep,
      endStep: this.endStep,
      cells: [...this.winners.values()].sort((a, b) => a.cell - b.cell),
      held: [...this.held.values()].sort((a, b) => a.cell - b.cell || a.pitch - b.pitch),
      arbitrations: [...this.arbitrations]
    };
  }

  private emitChange(): void {
    if (this.phase !== 'idle') this.onChange?.(this.snapshot(this.phase));
  }

  private emit(phase: 'completed', draft: TakeDraft): void {
    void phase;
    this.onChange?.(draft);
    this.onComplete?.(draft);
  }

  private reset(): void {
    this.phase = 'idle';
    this.trackId = null;
    this.trackLength = 0;
    this.startStep = 0;
    this.endStep = 0;
    this.held.clear();
    this.winners.clear();
    this.arbitrations = [];
  }
}

function clampGate(gate: number): number {
  return Math.max(0.05, Math.min(1, gate));
}
