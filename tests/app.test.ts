/**
 * Page tests: the whole app runs in jsdom without any MIDI hardware.
 * Web MIDI is absent here, so the app must allow editing but refuse
 * to pretend it can play.
 */
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import App from '../src/App.svelte';

describe('App without Web MIDI', () => {
  it('shows MIDI as unavailable and keeps playback disabled', async () => {
    render(App);
    // jsdom has no navigator.requestMIDIAccess -> unsupported.
    await screen.findByText(/Web MIDI 不可用/);
    const play = screen.getByTestId('play') as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(screen.getByText(/仅可编辑/)).toBeTruthy();
  });

  it('allows editing the score: toggle steps and edit pitch/velocity/gate', async () => {
    render(App);
    await screen.findByText(/Web MIDI 不可用/);

    // Toggle a step on.
    const step = screen.getByTestId('step-0-0');
    await fireEvent.click(step);
    expect(step.className).toContain('on');

    // The step editor appears for the selected step.
    const editor = await screen.findByTestId('step-editor');
    expect(editor).toBeTruthy();

    // Change pitch -> note name updates.
    const pitch = screen.getByTestId('pitch') as HTMLInputElement;
    await fireEvent.change(pitch, { target: { value: '64' } });
    expect(screen.getByTestId('pitch-name').textContent).toBe('E4');

    // Velocity and gate sliders are bound.
    const velocity = screen.getByTestId('velocity') as HTMLInputElement;
    await fireEvent.input(velocity, { target: { value: '90' } });
    expect(screen.getByTestId('velocity-value').textContent).toBe('90');
    const gate = screen.getByTestId('gate') as HTMLInputElement;
    await fireEvent.input(gate, { target: { value: '50' } });
    expect(screen.getByTestId('gate-value').textContent).toBe('50%');
  });

  it('supports adding and removing tracks within 1..8', async () => {
    render(App);
    await screen.findByText(/Web MIDI 不可用/);

    // Starts with 4 tracks.
    expect(screen.getByTestId('track-3')).toBeTruthy();

    // Add up to the maximum of 8.
    const add = screen.getByTestId('add-track') as HTMLButtonElement;
    for (let i = 0; i < 4; i++) await fireEvent.click(add);
    expect(screen.getByTestId('track-7')).toBeTruthy();
    expect(add.disabled).toBe(true);

    // Remove one track again.
    await fireEvent.click(screen.getByTestId('remove-track-0'));
    expect(screen.queryByTestId('track-7')).toBeNull();
    expect(screen.getByTestId('track-6')).toBeTruthy();
  });

  it('keeps per-track step counts editable within 1..64', async () => {
    render(App);
    await screen.findByText(/Web MIDI 不可用/);

    const length = screen.getByTestId('length-0') as HTMLInputElement;
    await fireEvent.change(length, { target: { value: '64' } });
    expect(screen.getByTestId('step-0-63')).toBeTruthy();

    await fireEvent.change(length, { target: { value: '4' } });
    expect(screen.getByTestId('step-0-3')).toBeTruthy();
    expect(screen.queryByTestId('step-0-4')).toBeNull();
  });

  it('never pretends to play: transport stays stopped without an output', async () => {
    render(App);
    await screen.findByText(/Web MIDI 不可用/);
    expect(screen.getByText(/已停止/)).toBeTruthy();
    // The play button is disabled, so there is nothing to click; the
    // transport must read "stopped" and stay that way.
    expect((screen.getByTestId('play') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/已停止/)).toBeTruthy();
  });

  it('shows recording controls but keeps them harmless without MIDI', async () => {
    render(App);
    await screen.findByText(/Web MIDI 不可用/);

    // Every track exposes a record-arm button, but without playback it
    // cannot enter a recording state or open a draft panel.
    const arm = screen.getByTestId('arm-0') as HTMLButtonElement;
    await fireEvent.click(arm);
    expect(screen.queryByTestId('record-panel')).toBeNull();

    // Input selector exists (disabled, no devices).
    const input = screen.getByTestId('input-select') as HTMLSelectElement;
    expect(input).toBeTruthy();
    expect(input.disabled).toBe(true);

    // Editing the score still works — recording added no modal lock.
    const step = screen.getByTestId('step-0-1');
    await fireEvent.click(step);
    expect(step.className).toContain('on');
  });
});
