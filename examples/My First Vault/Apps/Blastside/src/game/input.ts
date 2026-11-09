// Keyboard + mouse with pointer lock. Never synthesizes anything; just listens.
export class Input {
  keys = new Set<string>();
  lookX = 0;
  lookY = 0;
  fire = false;
  aim = false;
  pressed = new Set<string>(); // edge-triggered since last consume
  wheel = 0;
  locked = false;
  enabled = true;
  private el: HTMLElement;
  onLockChange: (locked: boolean) => void = () => {};
  sensitivity = 1;
  invertY = false;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener("keydown", this.kd);
    window.addEventListener("keyup", this.ku);
    window.addEventListener("blur", this.clear);
    document.addEventListener("visibilitychange", this.clear);
    document.addEventListener("pointerlockchange", this.plc);
    document.addEventListener("pointerlockerror", this.ple);
    el.addEventListener("mousedown", this.md);
    window.addEventListener("mouseup", this.mu);
    window.addEventListener("mousemove", this.mm);
    el.addEventListener("wheel", this.wh, { passive: true });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  dispose() {
    window.removeEventListener("keydown", this.kd);
    window.removeEventListener("keyup", this.ku);
    window.removeEventListener("blur", this.clear);
    document.removeEventListener("visibilitychange", this.clear);
    document.removeEventListener("pointerlockchange", this.plc);
    this.el.removeEventListener("mousedown", this.md);
    window.removeEventListener("mouseup", this.mu);
    window.removeEventListener("mousemove", this.mm);
  }

  /** Pointer lock refused (sandbox, browser policy): play anyway, looking with mouse drags. */
  fallback = false;
  /** Must be called synchronously from a user gesture (click/mousedown handler). */
  lock() {
    try {
      const p = this.el.requestPointerLock?.({ unadjustedMovement: true } as any) as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        try {
          const p2 = this.el.requestPointerLock?.() as unknown as Promise<void> | undefined;
          p2?.catch?.(() => this.enterFallback());
        } catch { this.enterFallback(); }
      });
      if (!this.el.requestPointerLock) this.enterFallback();
    } catch { this.enterFallback(); }
    // some contexts refuse silently: play without the lock rather than staying paused
    setTimeout(() => { if (!this.locked) this.enterFallback(); }, 600);
  }
  private enterFallback() {
    this.fallback = true;
    this.locked = true;
    this.onLockChange(true);
  }
  private ple = () => this.enterFallback();
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  // The game only reads the keyboard while you're playing (mouse captured, or the drag-to-look
  // fallback), so a page around it can be typed into. A key pressed with ⌘ or Ctrl is a shortcut,
  // not a move, and macOS never sends the keyup for a letter released while ⌘ is down, so ⌘ / Ctrl
  // also drops every held key (⌘S used to leave S held: walking backwards forever).
  private kd = (e: KeyboardEvent) => {
    if (e.key === "Meta" || e.key === "Control" || e.metaKey || e.ctrlKey) { this.keys.clear(); return; }
    if (!this.enabled || !this.locked || typing(e)) return;
    if (["Space", "Tab", "KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) e.preventDefault();
    if (e.code === "Escape" && this.fallback) { this.fallback = false; this.locked = false; this.clear(); this.onLockChange(false); return; }
    if (!this.keys.has(e.code)) this.pressed.add(e.code);
    this.keys.add(e.code);
  };
  private ku = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private clear = () => { this.keys.clear(); this.fire = false; this.aim = false; };
  private plc = () => {
    this.locked = document.pointerLockElement === this.el;
    if (this.locked) this.fallback = false;
    if (!this.locked) this.clear();
    this.onLockChange(this.locked);
  };
  private md = (e: MouseEvent) => {
    if (!this.enabled) return;
    if (!this.locked) { this.lock(); return; }
    if (e.button === 0) this.fire = true;
    if (e.button === 2) this.aim = true;
  };
  private mu = (e: MouseEvent) => {
    if (e.button === 0) this.fire = false;
    if (e.button === 2) this.aim = false;
  };
  private mm = (e: MouseEvent) => {
    if (!this.locked || !this.enabled) return;
    if (this.fallback && !(e.buttons & 1) && !(e.buttons & 2)) return; // drag to look without pointer lock
    // guard against the occasional huge jump some browsers emit on lock
    if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
    this.lookX += e.movementX;
    this.lookY += e.movementY;
  };
  private wh = (e: WheelEvent) => { this.wheel += Math.sign(e.deltaY); };

  axis() {
    const k = this.keys;
    const fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const right = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    return { fwd, right };
  }
  consumeLook() {
    const x = this.lookX, y = this.lookY;
    this.lookX = 0; this.lookY = 0;
    return { x, y };
  }
  consumePressed() {
    const p = this.pressed;
    this.pressed = new Set();
    return p;
  }
  consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }
}

/** A key meant for a text field: the game's own name box, or text in the page around the game. */
export function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}
