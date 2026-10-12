import type { ID, ISODateTime, Metadata } from "./common";

/**
 * Emitted when a deterministic engine stage produces an observable event (docs/engine).
 * `refId` links to the entity created/affected (swing, break, pool, FVG, zone, setup).
 * `atBar`/`at` is the *confirmation* bar — the first moment a backtest may know it (spec 18).
 */
export type DetectionEventKind =
  | "swing_confirmed"
  | "swing_invalidated"
  | "structure_break" // BOS or CHOCH — see entity
  | "break_failed"
  | "pool_formed"
  | "sweep_developing"
  | "sweep_confirmed"
  | "break_attempt"
  | "breakout_success"
  | "false_breakout"
  | "fvg_created"
  | "fvg_filled"
  | "zone_created"
  | "zone_retested"
  | "zone_consumed"
  | "zone_invalidated"
  | "displacement" // leg scored ≥ momentum.disp.threshold — see metadata
  | "setup_transition";

export interface DetectionEvent {
  kind: DetectionEventKind;
  /** Entity this event describes (swing/pool/fvg/zone/setup/break id). */
  refId: ID;
  symbol: string;
  /** Bar index at which the event became knowable. */
  atBar: number;
  /** Confirmation time — never earlier than the triggering bar's close. */
  at: ISODateTime;
  /** Event-specific payload (e.g. break direction, sweep side, setup transition target). */
  metadata?: Metadata;
}
