import type { GainDecision } from './types';

/**
 * Decides when a continuous auto gain loop may act on a proposed gain change,
 * so a strong, bursty signal does not set the gain hunting up and down.
 *
 * - Overload steps down at most once a second, and the gain that first
 *   overloaded becomes a ceiling that is not climbed back past for a while.
 * - Raising gain needs several readings in a row asking for it.
 * - Lowering gain for headroom (without overload) needs two in a row.
 */

const RAISE_READINGS = 4;
const LOWER_READINGS = 2;
/** Each overload at the same ceiling doubles how long it holds, up to 10 minutes. */
const CEILING_HOLD_MS = 60_000;
const CEILING_HOLD_MAX_MS = 600_000;
/** Stay this far below the gain that last overloaded. */
const CEILING_MARGIN_DB = 2;
/** Between overload steps, let the last change show up in the readings. */
const OVERLOAD_COOLDOWN_MS = 1_000;

export function createGainGovernor() {
	let raise = 0;
	let lower = 0;
	let ceiling = Infinity;
	let ceilingUntil = 0;
	let hold = CEILING_HOLD_MS;
	let cooldownUntil = 0;
	return {
		decide(current: number, proposed: number, overloaded: boolean, now = Date.now()): GainDecision {
			if (now >= ceilingUntil) ceiling = Infinity;
			if (overloaded) {
				raise = lower = 0;
				if (now < cooldownUntil) return { act: false, held: 'Waiting to see the last step' };
				// Overloading again after a ceiling expired: the signal is still there, so hold longer.
				if (ceiling === Infinity) {
					if (ceilingUntil) hold = Math.min(CEILING_HOLD_MAX_MS, hold * 2);
					ceiling = current - CEILING_MARGIN_DB;
				}
				ceilingUntil = now + hold;
				cooldownUntil = now + OVERLOAD_COOLDOWN_MS;
				return { act: true };
			}
			if (proposed > current) {
				lower = 0;
				if (proposed > ceiling) return { act: false, held: 'Holding below the last overload' };
				if (++raise < RAISE_READINGS) return { act: false, held: 'Checking before raising gain' };
				raise = 0;
				return { act: true };
			}
			raise = 0;
			if (proposed < current && ++lower < LOWER_READINGS) return { act: false, held: 'Checking before lowering gain' };
			lower = 0;
			return { act: true };
		},
		/** Forget the ceiling after a retune or a new target: the old overload no longer applies. */
		reset() {
			raise = lower = 0;
			ceiling = Infinity;
			ceilingUntil = 0;
			cooldownUntil = 0;
			hold = CEILING_HOLD_MS;
		},
	};
}
