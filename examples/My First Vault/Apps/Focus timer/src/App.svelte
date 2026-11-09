<script>
  // A Svelte app that owns the whole page: its own look, no Noteblock theme, no text editing.
  // Its .noteblock sets "renderer": "view", so it opens rendered rather than in Noteblock's editor.
  const MODES = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
  const LABELS = { focus: "Focus", short: "Short break", long: "Long break" };
  const R = 120;
  const CIRC = 2 * Math.PI * R;

  let mode = $state("focus");
  let left = $state(MODES.focus);
  let running = $state(false);
  let today = $state(0);
  let timer = null;

  const dayKey = () => "sessions:" + new Date().toISOString().slice(0, 10);

  $effect(() => {
    window.quire.ready.then(() => window.quire.kv.get(dayKey())).then((n) => (today = n || 0));
  });

  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  let progress = $derived(1 - left / MODES[mode]);

  function pick(m) {
    stop();
    mode = m;
    left = MODES[m];
  }

  function stop() {
    running = false;
    clearInterval(timer);
  }

  function toggle() {
    if (running) return stop();
    running = true;
    timer = setInterval(async () => {
      left -= 1;
      if (left > 0) return;
      stop();
      if (mode === "focus") {
        today += 1;
        await window.quire.kv.set(dayKey(), today);
        pick(today % 4 === 0 ? "long" : "short");
      } else pick("focus");
    }, 1000);
  }
</script>

<main class:running data-mode={mode}>
  <nav>
    {#each Object.keys(MODES) as m}
      <button class:on={mode === m} onclick={() => pick(m)}>{LABELS[m]}</button>
    {/each}
  </nav>

  <div class="dial">
    <svg viewBox="0 0 280 280" aria-hidden="true">
      <circle cx="140" cy="140" r={R} class="track" />
      <circle cx="140" cy="140" r={R} class="arc" stroke-dasharray={CIRC} stroke-dashoffset={CIRC * (1 - progress)} />
    </svg>
    <div class="time">{mmss(left)}</div>
  </div>

  <div class="controls">
    <button class="go" onclick={toggle}>{running ? "Pause" : "Start"}</button>
    <button class="reset" onclick={() => pick(mode)}>Reset</button>
  </div>

  <p class="count">{today} {today === 1 ? "session" : "sessions"} today</p>
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #0f1420;
  }
  main {
    --tone: #7c9cff;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 28px;
    font-family: "Geist", system-ui, sans-serif;
    color: #e8ecf6;
    transition: background 0.4s;
  }
  main[data-mode="short"],
  main[data-mode="long"] {
    --tone: #5fd4b0;
  }
  nav {
    display: flex;
    gap: 4px;
    padding: 4px;
    border-radius: 999px;
    background: #1a2132;
  }
  nav button {
    padding: 8px 16px;
    border: 0;
    border-radius: 999px;
    font: 500 14px inherit;
    font-family: inherit;
    color: #9aa4bd;
    background: none;
    cursor: pointer;
  }
  nav button.on {
    color: #0f1420;
    background: var(--tone);
  }
  .dial {
    position: relative;
    width: 280px;
    height: 280px;
  }
  svg {
    transform: rotate(-90deg);
  }
  circle {
    fill: none;
    stroke-width: 10;
  }
  .track {
    stroke: #1f2739;
  }
  .arc {
    stroke: var(--tone);
    stroke-linecap: round;
    transition: stroke-dashoffset 1s linear;
  }
  .time {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 64px;
    font-weight: 300;
    font-variant-numeric: tabular-nums;
    letter-spacing: -1px;
  }
  .controls {
    display: flex;
    gap: 12px;
  }
  .controls button {
    height: 44px;
    padding: 0 28px;
    border-radius: 22px;
    font: 600 15px inherit;
    font-family: inherit;
    cursor: pointer;
  }
  .go {
    border: 0;
    color: #0f1420;
    background: var(--tone);
  }
  .reset {
    border: 1px solid #2c3550;
    color: #c9d1e6;
    background: none;
  }
  .count {
    margin: 0;
    font-size: 14px;
    color: #7d879f;
  }
</style>
