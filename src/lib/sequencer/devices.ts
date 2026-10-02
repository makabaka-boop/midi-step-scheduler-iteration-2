/**
 * Web MIDI device management: access request, input/output listing and
 * hot-plug / disconnect tracking.
 *
 * The manager talks to a `MidiAccessLike` structural interface rather
 * than the global `navigator`, so tests can inject a fake MIDI access
 * object and simulate devices coming and going (or MIDI permission
 * being revoked mid-session).
 */

import { WebMidiInputAdapter, type MIDIInputLike, type MidiInputAdapter } from './midiInput';
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
  inputs: ReadonlyMap<string, MIDIInputLike>;
  outputs: ReadonlyMap<string, MIDIOutput>;
  /**
   * State-change hook. An event explicitly flagged `permissionLost`
   * (or carrying a `permission`/`permissionDenied` marker, as browsers
   * report a revoked grant) means the whole session is gone; an
   * ordinary port event is a hot-plug.
   */
  onstatechange:
    | ((event: {
        port?: { id?: string; state?: string; type?: string };
        permissionLost?: boolean;
      }) => void)
    | null;
}

export interface MidiDeviceManagerEvents {
  /** Fired whenever the output list or connection states change. */
  onDevicesChanged?: (outputs: MidiDeviceInfo[]) => void;
  /** Fired when a previously connected output disappears. */
  onOutputDisconnected?: (id: string) => void;
  /** Fired whenever the input list or connection states change. */
  onInputsChanged?: (inputs: MidiDeviceInfo[]) => void;
  /** Fired when a previously connected input disappears. */
  onInputDisconnected?: (id: string) => void;
  /** Fired when the MIDI grant is revoked after a successful request. */
  onPermissionLost?: () => void;
}

export class MidiDeviceManager {
  private access: MidiAccessLike | null = null;
  private knownConnectedOutputs = new Set<string>();
  private knownConnectedInputs = new Set<string>();
  private events: MidiDeviceManagerEvents;
  status: MidiStatus = 'unknown';
  outputs: MidiDeviceInfo[] = [];
  inputs: MidiDeviceInfo[] = [];

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
      this.access.onstatechange = (event) => {
        if (event.permissionLost) {
          this.handlePermissionLost();
          return;
        }
        this.refresh();
      };
      this.status = 'ready';
      this.refresh();
    } catch {
      this.status = 'denied';
    }
    return this.status;
  }

  /** Re-read the port lists from the access object (hot-plug entry point). */
  refresh(): void {
    if (!this.access) return;
    this.refreshOutputs();
    this.refreshInputs();
  }

  /** Mark the MIDI grant as revoked: drop every known connected port. */
  permissionLost(): void {
    this.handlePermissionLost();
  }

  private handlePermissionLost(): void {
    if (this.status !== 'ready') return;
    this.status = 'denied';
    this.knownConnectedOutputs.clear();
    this.knownConnectedInputs.clear();
    this.outputs = [];
    this.inputs = [];
    this.events.onDevicesChanged?.([]);
    this.events.onInputsChanged?.([]);
    this.events.onPermissionLost?.();
  }

  private refreshOutputs(): void {
    const next: MidiDeviceInfo[] = [];
    const nowConnected = new Set<string>();
    for (const port of this.access!.outputs.values()) {
      const connected = port.state === 'connected';
      next.push({ id: port.id, name: port.name ?? port.id, connected });
      if (connected) nowConnected.add(port.id);
    }
    for (const id of this.knownConnectedOutputs) {
      if (!nowConnected.has(id)) this.events.onOutputDisconnected?.(id);
    }
    this.knownConnectedOutputs = nowConnected;
    this.outputs = next;
    this.events.onDevicesChanged?.(next);
  }

  private refreshInputs(): void {
    const next: MidiDeviceInfo[] = [];
    const nowConnected = new Set<string>();
    for (const port of this.access!.inputs.values()) {
      const connected = port.state === 'connected';
      next.push({ id: port.id, name: port.name ?? port.id, connected });
      if (connected) nowConnected.add(port.id);
    }
    for (const id of this.knownConnectedInputs) {
      if (!nowConnected.has(id)) this.events.onInputDisconnected?.(id);
    }
    this.knownConnectedInputs = nowConnected;
    this.inputs = next;
    this.events.onInputsChanged?.(next);
  }

  /** Build an adapter for a currently connected output, or null. */
  adapterFor(id: string): MidiOutputAdapter | null {
    if (!this.access) return null;
    const port = this.access.outputs.get(id);
    if (!port || port.state !== 'connected') return null;
    return new WebMidiOutputAdapter(port);
  }

  /** Build an adapter for a currently connected input, or null. */
  inputAdapterFor(id: string): MidiInputAdapter | null {
    if (!this.access) return null;
    const port = this.access.inputs.get(id);
    if (!port || port.state !== 'connected') return null;
    return new WebMidiInputAdapter(port);
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
