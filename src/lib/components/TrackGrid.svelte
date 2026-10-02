<script lang="ts">
  import type { SequencerController } from '../controller';
  import { MAX_STEPS, MAX_TRACKS, MIN_STEPS, MIN_TRACKS } from '../sequencer/types';

  let { controller }: { controller: SequencerController } = $props();

  // The controller instance never changes for the app lifetime.
  // svelte-ignore state_referenced_locally
  const { pattern, currentStep, selection, transport, takeDraft } = controller;

  function isPlayhead(trackLength: number, index: number): boolean {
    return (
      $transport !== 'stopped' && $currentStep >= 0 && $currentStep % trackLength === index
    );
  }

  // Cells captured in the pending take for the given track, by local cell.
  const draftCells = $derived.by(() => {
    const map = new Map<number, { pitch: number; velocity: number; gate: number }>();
    if ($takeDraft) {
      for (const c of $takeDraft.cells) map.set(c.cell, c);
    }
    return map;
  });

  // Cells with a key currently held on the keyboard (live, not final).
  const heldCells = $derived.by(() => {
    const set = new Set<number>();
    if ($takeDraft) for (const h of $takeDraft.held) set.add(h.cell);
    return set;
  });
</script>

<div class="panel">
  <div class="row" style="margin-bottom: 10px;">
    <strong>乐谱</strong>
    <button
      data-testid="add-track"
      disabled={$pattern.tracks.length >= MAX_TRACKS}
      onclick={() => controller.addTrack()}
    >
      + 添加音轨
    </button>
  </div>

  {#each $pattern.tracks as track, ti (track.id)}
    {@const isRec = controller.isTrackRecording(track.id)}
    <div class="track" class:recording={isRec} data-testid="track-{ti}">
      <div class="track-head">
        <span class="track-name">{track.name}</span>
        <label>
          通道
          <input
            type="number"
            min="1"
            max="16"
            value={track.channel + 1}
            data-testid="channel-{ti}"
            onchange={(e) => controller.setTrackChannel(track.id, Number(e.currentTarget.value) - 1)}
          />
        </label>
        <label>
          步数
          <input
            type="number"
            min={MIN_STEPS}
            max={MAX_STEPS}
            value={track.steps.length}
            data-testid="length-{ti}"
            onchange={(e) => controller.setTrackLength(track.id, Number(e.currentTarget.value))}
          />
        </label>
        <button
          class:active={track.muted}
          data-testid="mute-{ti}"
          onclick={() => controller.toggleMute(track.id)}
        >
          {track.muted ? '已静音' : '静音'}
        </button>
        <button
          class="rec"
          class:rec-active={isRec}
          data-testid="arm-{ti}"
          title="播放中为该轨录制一轮（待确认）"
          onclick={() => (isRec ? controller.cancelTake() : controller.armTrack(track.id))}
        >
          {isRec
            ? $takeDraft?.phase === 'completed'
              ? '● 待确认（点击放弃）'
              : '● 录制中（点击取消）'
            : '● 录制这一轨'}
        </button>
        <button
          data-testid="remove-track-{ti}"
          disabled={$pattern.tracks.length <= MIN_TRACKS}
          onclick={() => controller.removeTrack(track.id)}
        >
          删除
        </button>
      </div>
      <div class="steps" style="grid-template-columns: repeat({track.steps.length}, minmax(14px, 1fr));">
        {#each track.steps as step, si (si)}
          {@const draft = isRec ? draftCells.get(si) : undefined}
          <button
            class="step"
            class:on={step.enabled}
            class:draft={!!draft}
            class:held={isRec && heldCells.has(si)}
            class:playhead={isPlayhead(track.steps.length, si)}
            class:selected={$selection?.trackId === track.id && $selection?.index === si}
            data-testid="step-{ti}-{si}"
            title={draft ? `草稿：${draft.pitch} / ${draft.velocity} / ${Math.round(draft.gate * 100)}%` : `步 ${si + 1}`}
            onclick={() => controller.toggleStep(track.id, si)}
          ></button>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .track {
    margin-bottom: 10px;
  }
  .track.recording {
    outline: 1px dashed var(--accent-2);
    outline-offset: 3px;
    border-radius: 4px;
  }
  .track-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 4px;
  }
  .track-name {
    min-width: 70px;
    font-weight: 600;
  }
  .track-head input[type='number'] {
    width: 64px;
  }
  .rec {
    font-size: 0.85em;
  }
  .rec-active {
    border-color: var(--accent-2);
    color: var(--accent-2);
  }
  .steps {
    display: grid;
    gap: 3px;
  }
  .step {
    height: 26px;
    padding: 0;
    border-radius: 4px;
    background: var(--panel-2);
    border: 1px solid var(--border);
  }
  .step.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .step.draft {
    box-shadow: inset 0 0 0 2px var(--accent-2);
  }
  .step.held {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }
  .step.playhead {
    box-shadow: 0 0 0 2px var(--accent-2);
  }
  .step.selected {
    outline: 2px solid #fff;
    outline-offset: 1px;
  }
</style>
