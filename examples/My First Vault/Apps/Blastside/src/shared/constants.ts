// Game rules and tuning. One source for the client, the server and the offline sim.

export const TICK_HZ = 30; // sim tick (server + offline)
export const SNAP_HZ = 20; // state down
export const INPUT_HZ = 30; // state up
export const INTERP_DELAY_MS = 100;
export const MAX_EXTRAPOLATE_MS = 150;
export const MAX_REWIND_MS = 200;

export const ROOM_MAX = 16;
export const BOT_FILL = 4;
export const OFFLINE_BOTS = 3;

export const RULES = {
  warmupS: 10,
  matchS: 240,
  overtimeS: 30,
  resultsS: 12,
  scoreToWin: 15,
  fallY: -20,
  fallCreditS: 5,
  respawnS: 3,
  spawnProtectS: 1.5,
  maxHealth: 100,
  maxShield: 50,
  regenDelayS: 6,
  regenPerS: 5,
  regenCap: 50,
  streakGlow: 5,
  idleKickS: 60,
} as const;

export const MOVE = {
  run: 6.0,
  aimWalk: 3.8,
  accelTime: 0.1,
  stopTime: 0.08,
  jumpHeight: 1.3,
  gravity: 24,
  airControl: 0.35,
  coyoteS: 0.1,
  jumpBufferS: 0.12,
  dashDist: 6,
  dashTime: 0.18,
  dashCooldown: 2.5,
  capsuleRadius: 0.35,
  capsuleHeight: 1.8, // total
  crouchHeight: 1.2,
  crouchSpeedMul: 0.5,
  crouchSpreadMul: 0.75,
  stepHeight: 0.35,
  maxSlopeDeg: 50,
  snapToGround: 0.3,
  maxFall: 40,
} as const;

export const JUMP_VELOCITY = Math.sqrt(2 * MOVE.gravity * MOVE.jumpHeight);

/** Hitboxes relative to the feet. */
export const HITBOX = {
  bodyRadius: 0.42,
  bodyBottom: 0.25,
  bodyTop: 1.35,
  headY: 1.62,
  headRadius: 0.26,
} as const;

export const EYE = {
  /** Camera boom per design: behind, right, up. */
  back: 3.2,
  right: 0.6,
  up: 1.6,
  aimBack: 1.6,
  fov: 70,
  aimFov: 55,
} as const;

export type WeaponId = 0 | 1 | 2;
export const WEAPON_RIFLE: WeaponId = 0;
export const WEAPON_SCATTER: WeaponId = 1;
export const WEAPON_ARC: WeaponId = 2;

export interface WeaponStats {
  id: WeaponId;
  name: string;
  short: string;
  color: string;
  damage: number;
  headMult: number;
  rate: number; // shots per second
  auto: boolean;
  mag: number;
  reloadS: number;
  perShellReload?: boolean;
  pellets: number;
  spreadMinDeg: number;
  spreadMaxDeg: number;
  aimSpreadMul: number;
  bloomPerShotDeg: number;
  bloomRecoverDegPerS: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  range: number;
  knockback?: number; // delta-v at 4 m (scatter)
  recoilDeg: number;
}

export const WEAPONS: Record<WeaponId, WeaponStats> = {
  0: {
    id: 0, name: "Pulse Rifle", short: "Rifle", color: "#E07020",
    damage: 12, headMult: 1.5, rate: 10, auto: true, mag: 120, reloadS: 1.5, pellets: 1,
    spreadMinDeg: 0.4, spreadMaxDeg: 2.5, aimSpreadMul: 0.5, bloomPerShotDeg: 0.25, bloomRecoverDegPerS: 8,
    falloffStart: 25, falloffEnd: 45, falloffMin: 0.6, range: 120, recoilDeg: 0.6,
  },
  1: {
    id: 1, name: "Scatter Blaster", short: "Scatter", color: "#1FA6A0",
    damage: 10, headMult: 1.5, rate: 1.2, auto: false, mag: 24, reloadS: 0.3, perShellReload: true, pellets: 8,
    spreadMinDeg: 5, spreadMaxDeg: 5, aimSpreadMul: 0.7, bloomPerShotDeg: 0, bloomRecoverDegPerS: 0,
    falloffStart: 6, falloffEnd: 14, falloffMin: 0.3, range: 40, knockback: 2, recoilDeg: 3,
  },
  2: {
    id: 2, name: "Arc Launcher", short: "Arc", color: "#6D4AE0",
    damage: 90, headMult: 1, rate: 1.1, auto: false, mag: 8, reloadS: 0, pellets: 0,
    spreadMinDeg: 0, spreadMaxDeg: 0, aimSpreadMul: 1, bloomPerShotDeg: 0, bloomRecoverDegPerS: 0,
    falloffStart: 0, falloffEnd: 0, falloffMin: 1, range: 0, recoilDeg: 2.5,
  },
};

export const GRENADE = {
  speed: 26,
  radius: 0.12,
  restitution: 0.45,
  fuseS: 1.2,
  blastRadius: 4.5,
  maxDamage: 90,
  minDamage: 20,
  knockOut: 9,
  knockUp: 4,
  selfMul: 0.5,
  touchRadius: 0.75,
} as const;

export const PICKUPS = {
  healthAmount: 50,
  healthRespawnS: 20,
  shieldAmount: 50,
  shieldRespawnS: 30,
  arcRespawnS: 30,
  radius: 1.1,
} as const;

/** Suit colours: Ember, Tide, Warden, Zest (+ extras for big rooms). */
export const SUITS = [
  { name: "Ember", color: "#FF7A2F" },
  { name: "Tide", color: "#1FB5AC" },
  { name: "Warden", color: "#7B56E8" },
  { name: "Zest", color: "#9BD32A" },
  { name: "Rose", color: "#F0508A" },
  { name: "Sky", color: "#3D8BF2" },
  { name: "Gold", color: "#F2C230" },
  { name: "Slate", color: "#8C97A8" },
] as const;

export type Difficulty = "easy" | "normal" | "hard";
/**
 * Bot skill, one knob. `easy` is the default everywhere (Rhett: "a little too good"); aim error shrinks from
 * aimStartDeg to aimTrackDeg over trackS seconds of continuous sight, grows with range and target speed,
 * and bots sometimes whiff a burst or wander off to a pickup.
 */
export interface BotSkill { damageMul: number; noticeMissPct: number; holdSightMs: number; leadS: number; lookAroundPct: number; reactMs: number; reactJitter: number; aimStartDeg: number; aimTrackDeg: number; trackS: number; rangeDegPer10m: number; strafeDegPerMs: number; headPct: number; burstMin: number; burstMax: number; pauseMin: number; pauseMax: number; whiffPct: number; wanderPct: number; loseSightMs: number }
export const BOT_DIFFICULTY: Record<Difficulty, BotSkill> = {
  // easy is deliberately dumb: slow to notice, slow to shoot, wide aim that never gets tight, short bursts.
  easy: { damageMul: 0.55, noticeMissPct: 0.3, holdSightMs: 800, leadS: 0, lookAroundPct: 0.25, reactMs: 1150, reactJitter: 250, aimStartDeg: 14, aimTrackDeg: 6, trackS: 3, rangeDegPer10m: 4, strafeDegPerMs: 0.6, headPct: 0, burstMin: 2, burstMax: 4, pauseMin: 700, pauseMax: 1300, whiffPct: 0.25, wanderPct: 0.4, loseSightMs: 600 },
  normal: { damageMul: 0.8, noticeMissPct: 0.15, holdSightMs: 400, leadS: 0.04, lookAroundPct: 0.15, reactMs: 360, reactJitter: 90, aimStartDeg: 6, aimTrackDeg: 2.0, trackS: 1.6, rangeDegPer10m: 0.6, strafeDegPerMs: 0.3, headPct: 0.08, burstMin: 4, burstMax: 8, pauseMin: 300, pauseMax: 600, whiffPct: 0.1, wanderPct: 0.25, loseSightMs: 1200 },
  hard: { damageMul: 1, noticeMissPct: 0.05, holdSightMs: 150, leadS: 0.08, lookAroundPct: 0.05, reactMs: 200, reactJitter: 50, aimStartDeg: 3, aimTrackDeg: 0.8, trackS: 1.0, rangeDegPer10m: 0.3, strafeDegPerMs: 0.15, headPct: 0.22, burstMin: 6, burstMax: 10, pauseMin: 200, pauseMax: 250, whiffPct: 0.03, wanderPct: 0.15, loseSightMs: 1500 },
};
export const DEFAULT_BOT_DIFFICULTY: Difficulty = "easy";

export const LIMITS = {
  msgPerSecDrop: 40,
  msgPerSecKick: 120,
  maxMsgBytes: 512,
  nameMin: 2,
  nameMax: 16,
} as const;

/** Emote wheel, clockwise from the top. clip = animation name on the character (Toon Shooter or retargeted UAL). */
export const EMOTES = [
  { id: 0, name: "Dance", clip: "Dance", loop: true },
  { id: 1, name: "Wave", clip: "Wave", loop: false },
  { id: 2, name: "Yes", clip: "Yes", loop: false },
  { id: 3, name: "Taunt", clip: "Punch", loop: false },
  { id: 4, name: "Sit", clip: "Sit", loop: true },
  { id: 5, name: "No", clip: "No", loop: false },
  { id: 6, name: "Arms", clip: "FoldArms", loop: true },
] as const;
export const EMOTE_COOLDOWN_MS = 2000;

/**
 * Bots are target practice against humans (Rhett: "pretty much impossible to die to the bots").
 * One place to tune: per-hit damage a bot deals to a human, extra aim error when shooting at a human,
 * and fast regen for humans after bot damage. Bots fight each other normally; humans vs humans unchanged.
 */
export const BOTS_VS_HUMANS = {
  damagePerHit: 2.5,
  grenadeDamage: 8,
  extraAimErrorDeg: 7,
  regenDelayS: 3,
  regenPerS: 25,
} as const;
