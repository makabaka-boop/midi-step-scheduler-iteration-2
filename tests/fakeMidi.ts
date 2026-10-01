/**
 * Fake Web MIDI environment for tests: no real hardware involved.
 * Devices can be plugged and unplugged at will.
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

export class FakeMidiAccess {
  readonly outputs = new Map<string, FakeMidiOutput>();
  onstatechange: ((event: { port: FakeMidiOutput }) => void) | null = null;

  plug(id: string, name: string): FakeMidiOutput {
    const existing = this.outputs.get(id);
    if (existing) {
      existing.state = 'connected';
      this.onstatechange?.({ port: existing });
      return existing;
    }
    const port = new FakeMidiOutput(id, name);
    this.outputs.set(id, port);
    this.onstatechange?.({ port });
    return port;
  }

  unplug(id: string): void {
    const port = this.outputs.get(id);
    if (!port) return;
    port.state = 'disconnected';
    this.onstatechange?.({ port });
  }
}
