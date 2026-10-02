<script lang="ts">
  import type { SequencerController } from '../controller';
  import { noteName } from '../noteNames';

  let { controller }: { controller: SequencerController } = $props();

  // svelte-ignore state_referenced_locally
  const { takeDraft, pattern } = controller;

  const trackName = $derived(
    $takeDraft
      ? ($pattern.tracks.find((t) => t.id === $takeDraft?.trackId)?.name ?? '音轨')
      : ''
  );

  const phaseText: Record<string, string> = {
    armed: '已预备：等待本轮起点…',
    recording: '录制中：在 MIDI 键盘上演奏一轮',
    completed: '本轮录制完成，待确认'
  };

  const reasonText: Record<string, string> = {
    retriggered: '同音高重触发',
    contended: '同格竞争',
    'tail-clamped': '跨边界/循环尾部',
    'ignored-late': '轮后忽略',
    'ignored-early': '轮前忽略'
  };
</script>

{#if $takeDraft}
  <div class="panel record-panel" data-testid="record-panel">
    <div class="row">
      <strong data-testid="record-title">{trackName} · {phaseText[$takeDraft.phase]}</strong>
      <span data-testid="record-progress">
        步格 {$takeDraft.cells.length}/{$takeDraft.trackLength}
        {#if $takeDraft.held.length > 0}· 按住 {$takeDraft.held.length}{/if}
      </span>
      <button
        class="primary"
        data-testid="confirm-take"
        disabled={$takeDraft.phase !== 'completed'}
        onclick={() => controller.confirmTake()}
      >
        确认写入
      </button>
      <button data-testid="cancel-take" onclick={() => controller.cancelTake()}>
        {$takeDraft.phase === 'completed' ? '丢弃本轮' : '取消录制'}
      </button>
    </div>

    {#if $takeDraft.cells.length > 0}
      <div class="captured" data-testid="record-cells">
        {#each $takeDraft.cells as c (c.cell)}
          <span class="chip">
            {c.cell + 1}:{noteName(c.pitch)} v{c.velocity} {Math.round(c.gate * 100)}%
          </span>
        {/each}
      </div>
    {/if}

    {#if $takeDraft.arbitrations.length > 0}
      <div class="arbitrations" data-testid="record-arbitrations">
        <strong>裁决：</strong>
        <ul>
          {#each $takeDraft.arbitrations as a (a.id)}
            <li data-testid="arb-{a.id}" class="arb-{a.reason}">
              <span class="tag">{reasonText[a.reason] ?? a.reason}</span>
              {a.detail}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}

<style>
  .record-panel {
    border-color: var(--accent-2);
  }
  .captured {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .chip {
    font-size: 0.8em;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .arbitrations {
    margin-top: 6px;
    font-size: 0.85em;
  }
  .arbitrations ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
  .tag {
    display: inline-block;
    margin-right: 4px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--panel-2);
  }
</style>
