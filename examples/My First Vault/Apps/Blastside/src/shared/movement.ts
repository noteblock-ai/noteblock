// Character movement on Rapier's kinematic character controller. Shared by the local player
// (client prediction), bots (server + offline) and, for its limits, the server's validation.
import type RAPIER_NS from "@dimforge/rapier3d-compat";
import { MOVE, JUMP_VELOCITY } from "./constants.js";
import { G_MAP, G_PLAYER, G_PROP, groups, type Rapier, type World } from "./physics.js";
import { PADS, PAD_RADIUS, PAD_GRAVITY_MUL, padVelocity } from "./map.js";

export interface MoveInput {
  /** -1..1 forward/back, right/left in the yaw frame */
  fwd: number;
  right: number;
  yaw: number;
  jump: boolean; // held
  dash: boolean; // held
  aim: boolean;
  crouch?: boolean;
}

export interface MotorState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  grounded: boolean;
  lastGroundT: number;
  jumpPressedT: number;
  jumpHeld: boolean;
  dashHeld: boolean;
  dashUntil: number;
  dashReadyT: number;
  dashDx: number; dashDz: number;
  /** air control is reduced while flying from a pad or a blast */
  launched: boolean;
  /** time we left the ground by a jump (for landing anim) */
  jumpedT: number;
  padT: number;
  /** flying from a jump pad: half gravity until landing */
  padFlight: boolean;
  crouched: boolean;
  events: number; // bit flags of what happened this step (MOTOR_EV_*)
}

export const MOTOR_EV_JUMP = 1;
export const MOTOR_EV_LAND = 2;
export const MOTOR_EV_DASH = 4;
export const MOTOR_EV_PAD = 8;

export function newMotorState(x: number, y: number, z: number): MotorState {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, grounded: false, lastGroundT: -10, jumpPressedT: -10, jumpHeld: false, dashHeld: false,
    dashUntil: 0, dashReadyT: 0, dashDx: 0, dashDz: 0, launched: false, jumpedT: -10, padT: -10, padFlight: false, crouched: false, events: 0,
  };
}

export const CAPSULE_HALF = MOVE.capsuleHeight / 2 - MOVE.capsuleRadius;
export const CAPSULE_CENTER = MOVE.capsuleHeight / 2;

export class Motor {
  readonly kcc: RAPIER_NS.KinematicCharacterController;
  readonly collider: RAPIER_NS.Collider;
  constructor(private R: Rapier, private world: World, x: number, y: number, z: number) {
    this.kcc = world.createCharacterController(0.02);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle((MOVE.maxSlopeDeg * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.enableAutostep(MOVE.stepHeight, 0.2, false);
    this.kcc.enableSnapToGround(MOVE.snapToGround);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(80);
    // Parentless collider: its position updates immediately, so the controller always starts from it.
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(CAPSULE_HALF, MOVE.capsuleRadius).setTranslation(x, y + CAPSULE_CENTER, z).setCollisionGroups(groups(G_PLAYER, G_MAP | G_PROP)),
    );
  }

  teleport(s: MotorState, x: number, y: number, z: number) {
    s.x = x; s.y = y; s.z = z; s.vx = s.vy = s.vz = 0; s.launched = false; s.padFlight = false;
    if (s.crouched) this.setCrouch(s, false);
    this.collider.setTranslation({ x, y: y + CAPSULE_CENTER, z });
  }

  /** Advance one step. `now` in seconds (any monotonic clock). */
  step(s: MotorState, inp: MoveInput, dt: number, now: number, frozen = false) {
    s.events = 0;
    const R = this.R;
    // Wish direction in world space (yaw: 0 looks down -Z).
    let f = frozen ? 0 : inp.fwd, r = frozen ? 0 : inp.right;
    const len = Math.hypot(f, r);
    if (len > 1) { f /= len; r /= len; }
    const sy = Math.sin(inp.yaw), cy = Math.cos(inp.yaw);
    // forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw)
    const wx = -sy * f + cy * r;
    const wz = -cy * f - sy * r;
    // crouch: shorter capsule, half speed; standing up needs headroom
    if (inp.crouch && !s.crouched) this.setCrouch(s, true);
    else if (!inp.crouch && s.crouched && this.headroom(s)) this.setCrouch(s, false);
    const maxSpeed = (inp.aim ? MOVE.aimWalk : MOVE.run) * (s.crouched ? MOVE.crouchSpeedMul : 1);
    const tx = wx * maxSpeed, tz = wz * maxSpeed;

    const dashing = now < s.dashUntil;
    if (!dashing) {
      const control = s.grounded ? 1 : s.launched ? 0.12 : MOVE.airControl;
      const accel = (MOVE.run / MOVE.accelTime) * control;
      const decel = (MOVE.run / MOVE.stopTime) * control;
      const dvx = tx - s.vx, dvz = tz - s.vz;
      const dl = Math.hypot(dvx, dvz);
      const speeding = Math.hypot(s.vx, s.vz) > maxSpeed + 0.01;
      const rate = (len > 0.01 && !speeding ? accel : decel) * dt;
      if (s.launched && !s.grounded && len < 0.01) {
        // keep momentum when flying
      } else if (dl <= rate) { s.vx = tx; s.vz = tz; } else { s.vx += (dvx / dl) * rate; s.vz += (dvz / dl) * rate; }
    }

    // Jump (buffer + coyote)
    if (inp.jump && !s.jumpHeld && !frozen) s.jumpPressedT = now;
    s.jumpHeld = inp.jump;
    const canCoyote = s.grounded || now - s.lastGroundT <= MOVE.coyoteS;
    if (now - s.jumpPressedT <= MOVE.jumpBufferS && canCoyote && s.vy <= 0.5) {
      s.vy = JUMP_VELOCITY;
      s.jumpPressedT = -10;
      s.lastGroundT = -10;
      s.grounded = false;
      s.jumpedT = now;
      s.events |= MOTOR_EV_JUMP;
    }

    // Dash
    if (inp.dash && !s.dashHeld && !frozen && now >= s.dashReadyT) {
      let dx = wx, dz = wz;
      if (Math.hypot(dx, dz) < 0.1) { dx = -sy; dz = -cy; }
      const dl = Math.hypot(dx, dz);
      s.dashDx = dx / dl; s.dashDz = dz / dl;
      s.dashUntil = now + MOVE.dashTime;
      s.dashReadyT = now + MOVE.dashCooldown;
      s.events |= MOTOR_EV_DASH;
    }
    s.dashHeld = inp.dash;
    if (now < s.dashUntil) {
      const dashSpeed = MOVE.dashDist / MOVE.dashTime;
      s.vx = s.dashDx * dashSpeed; s.vz = s.dashDz * dashSpeed;
      if (s.vy < 0) s.vy = 0;
    } else if (dashing) {
      // end of dash: bleed down to run speed
      s.vx = s.dashDx * MOVE.run; s.vz = s.dashDz * MOVE.run;
    }

    // Gravity
    if (!(now < s.dashUntil)) s.vy -= MOVE.gravity * (s.padFlight ? PAD_GRAVITY_MUL : 1) * dt;
    if (s.vy < -MOVE.maxFall) s.vy = -MOVE.maxFall;

    // Jump pads
    for (const pad of PADS) {
      const ddx = s.x - pad.p[0], ddz = s.z - pad.p[2];
      if (ddx * ddx + ddz * ddz < PAD_RADIUS * PAD_RADIUS && Math.abs(s.y - pad.p[1]) < 0.4 && now - s.padT > 0.8) {
        const v = padVelocity(pad, MOVE.gravity);
        s.vx = v[0]; s.vy = v[1]; s.vz = v[2];
        s.launched = true; s.padFlight = true; s.grounded = false; s.padT = now; s.lastGroundT = -10;
        s.events |= MOTOR_EV_PAD;
      }
    }

    const desired = { x: s.vx * dt, y: s.vy * dt, z: s.vz * dt };
    this.kcc.computeColliderMovement(this.collider, desired, R.QueryFilterFlags.EXCLUDE_SENSORS, groups(G_PLAYER, G_MAP | G_PROP));
    const m = this.kcc.computedMovement();
    const wasGrounded = s.grounded;
    const grounded = this.kcc.computedGrounded();
    const nx = s.x + m.x, ny = s.y + m.y, nz = s.z + m.z;
    // Velocity from actual motion (so walls stop you), vertical handled separately
    if (dt > 0) {
      if (Math.abs(m.x - desired.x) > 1e-4) s.vx = m.x / dt;
      if (Math.abs(m.z - desired.z) > 1e-4) s.vz = m.z / dt;
    }
    if (grounded && s.vy <= 0) {
      s.vy = 0;
      if (!wasGrounded) { s.events |= MOTOR_EV_LAND; s.launched = false; s.padFlight = false; }
      s.lastGroundT = now;
    } else if (s.vy > 0 && m.y < desired.y - 1e-4) {
      s.vy = 0; // bumped head
    }
    s.grounded = grounded && s.vy <= 0;
    s.x = nx; s.y = ny; s.z = nz;
    this.collider.setTranslation({ x: nx, y: ny + (s.crouched ? MOVE.crouchHeight / 2 : CAPSULE_CENTER), z: nz });
  }

  setCrouch(s: MotorState, on: boolean) {
    s.crouched = on;
    const h = (on ? MOVE.crouchHeight : MOVE.capsuleHeight) / 2 - MOVE.capsuleRadius;
    this.collider.setHalfHeight(h);
    this.collider.setTranslation({ x: s.x, y: s.y + h + MOVE.capsuleRadius, z: s.z });
  }
  /** Is there room to stand up here? */
  headroom(s: MotorState): boolean {
    const R = this.R;
    const shape = new R.Capsule(CAPSULE_HALF, MOVE.capsuleRadius - 0.02);
    let blocked = false;
    this.world.intersectionsWithShape({ x: s.x, y: s.y + CAPSULE_CENTER + 0.02, z: s.z }, { x: 0, y: 0, z: 0, w: 1 }, shape, () => { blocked = true; return false; }, undefined, groups(0xffff, G_MAP | G_PROP), this.collider);
    return !blocked;
  }

  addImpulse(s: MotorState, dvx: number, dvy: number, dvz: number) {
    s.vx += dvx; s.vy += dvy; s.vz += dvz;
    if (dvy > 0.5) { s.grounded = false; s.lastGroundT = -10; }
    if (Math.hypot(dvx, dvz) > 3) s.launched = true;
  }

  dispose() {
    this.world.removeCharacterController(this.kcc);
    this.world.removeCollider(this.collider, false);
  }
}
