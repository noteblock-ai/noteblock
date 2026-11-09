import { create } from "zustand";
import type { MetaMsg, RosterEntry, WeaponId } from "@blastside/shared";

export type Screen = "lobby" | "joining" | "game";

export interface Settings {
  sens: number;
  invertY: boolean;
  fov: number;
  quality: "auto" | "high" | "low";
  volume: number;
}

export interface KillRow { id: number; killer: string; victim: string; weapon: number; fall: boolean; self: boolean; you: boolean; killerSuit: number; victimSuit: number; t: number }

export interface Hud {
  hp: number;
  shield: number;
  ammo: number;
  mag: number;
  weapon: WeaponId;
  arc: number;
  reloading: boolean;
  dashReady: number; // 0..1
  alive: boolean;
  respawnIn: number;
  killedBy: string | null;
  killedByWeapon: number;
  killedBySuit: number;
  killerHp: number;
  protect: boolean;
  lowHp: boolean;
}

interface UI {
  screen: Screen;
  mode: "online" | "offline";
  name: string;
  suit: number;
  joinStatus: string;
  joinError: string | null;
  serverPlaying: number | null;
  serverAwake: boolean | null;
  meta: MetaMsg | null;
  mySlot: number;
  hud: Hud;
  killfeed: KillRow[];
  toast: { text: string; t: number } | null;
  scoreboard: boolean;
  menu: boolean;
  locked: boolean;
  settings: Settings;
  embed: boolean;
  small: boolean;
  fps: number;
  /** emote wheel: null closed, -1 open with nothing selected, else the emote id */
  wheel: number | null;
  muted: boolean;
  volume: number;
  fp: boolean;
  set: (p: Partial<UI>) => void;
}

const loadSettings = (): Settings => {
  const d: Settings = { sens: 1, invertY: false, fov: 70, quality: "auto", volume: 0.7 };
  try { return { ...d, ...JSON.parse(localStorage.getItem("blastside.settings") || "{}") }; } catch { return d; }
};
const loadName = () => { try { return localStorage.getItem("blastside.name") || ""; } catch { return ""; } };
const loadSuit = () => { try { return Number(localStorage.getItem("blastside.suit") ?? 0) || 0; } catch { return 0; } };

export const useUI = create<UI>((set) => ({
  screen: "lobby",
  mode: "online",
  name: loadName(),
  suit: loadSuit(),
  joinStatus: "",
  joinError: null,
  serverPlaying: null,
  serverAwake: null,
  meta: null,
  mySlot: -1,
  hud: { hp: 100, shield: 0, ammo: 30, mag: 30, weapon: 0, arc: 0, reloading: false, dashReady: 1, alive: true, respawnIn: 0, killedBy: null, killedByWeapon: 0, killedBySuit: 0, killerHp: 0, protect: false, lowHp: false },
  killfeed: [],
  toast: null,
  scoreboard: false,
  menu: false,
  locked: false,
  settings: loadSettings(),
  embed: (new URLSearchParams(location.search).has("embed") || location.protocol === "quire:"),
  small: false,
  fps: 0,
  wheel: null,
  muted: (() => { try { return localStorage.getItem("blastside.sound") !== "on"; } catch { return true; } })(),
  volume: loadSettings().volume,
  fp: false,
  set: (p) => set(p),
}));

export function saveSettings(s: Settings) {
  try { localStorage.setItem("blastside.settings", JSON.stringify(s)); } catch {}
}
export function saveProfile(name: string, suit: number) {
  try { localStorage.setItem("blastside.name", name); localStorage.setItem("blastside.suit", String(suit)); } catch {}
}

export function rosterName(meta: MetaMsg | null, slot: number): RosterEntry | undefined {
  return meta?.roster.find((r) => r.id === slot);
}
