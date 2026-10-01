/**
 * Web MIDI device management: access request, output listing and
 * hot-plug / disconnect tracking.
 *
 * The manager talks to a `MidiAccessLike` structural interface rather
 * than the global `navigator`, so tests can inject a fake MIDI access
 * object and simulate devices coming and going.
 */

import { WebMidiOutputAdapter, type MidiOutputAdapter } from './output';

export type MidiStatus =
  | 'unknown'
  | 'unsupported' // no Web MIDI in this browser
  | 'requesting'
  | 'denied' // user/agent refused access
  | 'ready'
  | 'error';

export interface MidiDeviceInfo {
  id: string;
  name: string;
  connected: boolean;
}

/** Structural subset of the Web MIDI MIDIAccess we rely on. */
export interface MidiAccessLike {
  outputs: ReadonlyMap<string, MIDIOutput>;
  onstatechange: ((event: { port?: { id?: string; state?: string } }) => void) | null;
}

export interface MidiDeviceManagerEvents {
  /** Fired whenever the output list or connection states change. */
  onDevicesChanged?: (outputs: MidiDeviceInfo[]) => void;
  /** Fired when a previously connected output disappears. */
  onOutputDisconnected?: (id: string) => void;
}

export class MidiDeviceManager {
  private access: MidiAccessLike | null = null;
  private knownConnected = new Set<string>();
  private events: MidiDeviceManagerEvents;
  status: MidiStatus = 'unknown';
  outputs: MidiDeviceInfo[] = [];

  constructor(
    private readonly requestAccess: (() => Promise<MidiAccessLike>) | null,
    events: MidiDeviceManagerEvents = {}
  ) {
    this.events = events;
  }

  /** Rebind event callbacks (used when the manager is injected pre-built). */
  setEvents(events: MidiDeviceManagerEvents): void {
    this.events = events;
  }

  /** Ask for MIDI access once; safe to call again after a failure. */
  async request(): Promise<MidiStatus> {
    if (!this.requestAccess) {
      this.status = 'unsupported';
      return this.status;
    }
    this.status = 'requesting';
    try {
      this.access = await this.requestAccess();
      this.access.onstatechange = () => this.refresh();
      this.status = 'ready';
      this.refresh();
    } catch {
      this.status = 'denied';
    }
    return this.status;
  }

  /** Re-read the output list from the access object (hot-plug entry point). */
  refresh(): void {
    if (!this.access) return;
    const next: MidiDeviceInfo[] = [];
    const nowConnected = new Set<string>();
    for (const port of this.access.outputs.values()) {
      const connected = port.state === 'connected';
      next.push({
        id: port.id,
        name: port.name ?? port.id,
        connected
      });
      if (connected) nowConnected.add(port.id);
    }
    // Diff against what we knew to report disconnections.
    for (const id of this.knownConnected) {
      if (!nowConnected.has(id)) {
        this.events.onOutputDisconnected?.(id);
      }
    }
    this.knownConnected = nowConnected;
    this.outputs = next;
    this.events.onDevicesChanged?.(next);
  }

  /** Build an adapter for a currently connected output, or null. */
  adapterFor(id: string): MidiOutputAdapter | null {
    if (!this.access) return null;
    const port = this.access.outputs.get(id);
    if (!port || port.state !== 'connected') return null;
    return new WebMidiOutputAdapter(port);
  }
}

/** Production factory: reads `navigator.requestMIDIAccess` if present. */
export function createBrowserDeviceManager(
  events: MidiDeviceManagerEvents = {}
): MidiDeviceManager {
  const request =
    typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
      ? () => navigator.requestMIDIAccess({ sysex: false }) as Promise<MidiAccessLike>
      : null;
  return new MidiDeviceManager(request, events);
}
