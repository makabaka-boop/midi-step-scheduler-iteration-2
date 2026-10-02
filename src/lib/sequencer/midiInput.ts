/**
 * MIDI input adapter abstraction.
 *
 * Recording talks to a MidiInputAdapter, never to Web MIDI directly:
 * a real Web MIDI input port in the browser, a scripted fake device in
 * tests, or nothing at all when no input exists (editing and playback
 * keep working normally — recording simply cannot be armed).
 *
 * Messages are delivered with a timestamp on the same monotonic clock
 * the scheduler runs on (performance.now() in the browser, the manual
 * clock in tests), so recording quantizes with one shared timeline.
 */

import type { MidiMessage } from './midi';

export interface MidiInputMessage {
  message: MidiMessage;
  /** Time on the scheduler clock when the byte was received. */
  timeMs: number;
}

export interface MidiInputAdapter {
  readonly id: string;
  readonly name: string;
  /** False once the underlying device has gone away. */
  readonly connected: boolean;
  /** Subscribe to incoming messages; returns an unsubscribe function. */
  onMessage(handler: (msg: MidiInputMessage) => void): () => void;
  /** Detach any platform listener. */
  close(): void;
}

/** Structural subset of the Web MIDI MIDIInput we rely on. */
export interface MIDIInputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: 'connected' | 'disconnected';
  onmidimessage: ((event: { data: ArrayLike<number>; receivedTime?: number }) => void) | null;
}

/** Wraps a Web MIDI MIDIInput port. */
export class WebMidiInputAdapter implements MidiInputAdapter {
  private handler: ((msg: MidiInputMessage) => void) | null = null;

  constructor(private readonly port: MIDIInputLike) {
    this.port.onmidimessage = (event) => {
      if (!this.handler) return;
      const bytes: number[] = [];
      for (let i = 0; i < event.data.length; i++) bytes.push(event.data[i]!);
      // Web MIDI timestamps share the performance.now() clock with the
      // BrowserClock; fall back to now when the port omits one.
      const timeMs =
        typeof event.receivedTime === 'number' && event.receivedTime > 0
          ? event.receivedTime
          : performance.now();
      this.handler({ message: bytes, timeMs });
    };
  }

  get id(): string {
    return this.port.id ?? this.port.name ?? 'unknown-input';
  }

  get name(): string {
    return this.port.name ?? this.port.id ?? 'MIDI Input';
  }

  get connected(): boolean {
    return this.port.state === 'connected';
  }

  onMessage(handler: (msg: MidiInputMessage) => void): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  close(): void {
    this.handler = null;
    this.port.onmidimessage = null;
  }
}
