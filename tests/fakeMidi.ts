/**
 * Fake Web MIDI environment for tests: no real hardware involved.
 * Input and output devices can be plugged, unplugged and revoked at
 * will, with timestamps the test assigns (driven by the same manual
 * clock as the scheduler).
 */

export class FakeMidiOutput {
  readonly sent: number[][] = [];
  readonly type = 'output';
  connection = 'open';

  constructor(
    readonly id: string,
    readonly name: string,
    public state: 'connected' | 'disconnected' = 'connected'
  ) {}

  send(data: number[]): void {
    if (this.state !== 'connected') {
      throw new Error('send on disconnected port');
    }
    this.sent.push([...data]);
  }
}

export interface FakeMidiInputEvent {
  data: number[];
  receivedTime: number;
}

export class FakeMidiInput {
  readonly type = 'input';
  connection = 'open';
  onmidimessage: ((event: FakeMidiInputEvent) => void) | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    public state: 'connected' | 'disconnected' = 'connected'
  ) {}

  /** Deliver bytes as if the keyboard sent them at `timeMs`. */
  receive(data: number[], timeMs: number): void {
    this.onmidimessage?.({ data: [...data], receivedTime: timeMs });
  }
}

export class FakeMidiAccess {
  readonly outputs = new Map<string, FakeMidiOutput>();
  readonly inputs = new Map<string, FakeMidiInput>();
  onstatechange:
    | ((event: { port?: { id: string; state: string; type: string }; permissionLost?: boolean }) => void)
    | null = null;

  plug(id: string, name: string): FakeMidiOutput {
    const existing = this.outputs.get(id);
    if (existing) {
      existing.state = 'connected';
      this.onstatechange?.({ port: { id, state: 'connected', type: 'output' } });
      return existing;
    }
    const port = new FakeMidiOutput(id, name);
    this.outputs.set(id, port);
    this.onstatechange?.({ port: { id, state: 'connected', type: 'output' } });
    return port;
  }

  unplug(id: string): void {
    const port = this.outputs.get(id);
    if (!port) return;
    port.state = 'disconnected';
    this.onstatechange?.({ port: { id, state: 'disconnected', type: 'output' } });
  }

  plugInput(id: string, name: string): FakeMidiInput {
    const existing = this.inputs.get(id);
    if (existing) {
      existing.state = 'connected';
      this.onstatechange?.({ port: { id, state: 'connected', type: 'input' } });
      return existing;
    }
    const port = new FakeMidiInput(id, name);
    this.inputs.set(id, port);
    this.onstatechange?.({ port: { id, state: 'connected', type: 'input' } });
    return port;
  }

  unplugInput(id: string): void {
    const port = this.inputs.get(id);
    if (!port) return;
    port.state = 'disconnected';
    this.onstatechange?.({ port: { id, state: 'disconnected', type: 'input' } });
  }

  /** Simulate the user revoking the MIDI permission mid-session. */
  revokePermission(): void {
    this.onstatechange?.({ permissionLost: true });
  }
}
