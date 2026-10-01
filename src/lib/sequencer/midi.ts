/**
 * MIDI message builders. All messages are plain byte arrays so the
 * scheduler stays independent of any particular output implementation.
 */

export type MidiMessage = number[];

const clampByte = (v: number) => Math.max(0, Math.min(127, Math.round(v)));

export function noteOn(channel: number, pitch: number, velocity: number): MidiMessage {
  return [0x90 | (channel & 0x0f), clampByte(pitch), clampByte(velocity)];
}

export function noteOff(channel: number, pitch: number): MidiMessage {
  return [0x80 | (channel & 0x0f), clampByte(pitch), 0];
}

/** CC 123 — All Notes Off for one channel. */
export function allNotesOff(channel: number): MidiMessage {
  return [0xb0 | (channel & 0x0f), 123, 0];
}

/** CC 120 — All Sound Off for one channel (immediate, ignores release). */
export function allSoundOff(channel: number): MidiMessage {
  return [0xb0 | (channel & 0x0f), 120, 0];
}
