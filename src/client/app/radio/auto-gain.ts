import { errorMessage } from '@/platform/errors';
import type { AppInstance } from '@/app/core/receiver.types';
import { limeGainTotal, nextLimeGain } from '@/radio/lime-auto-gain';
import type { LimeGains, HackRFGains, DeviceCapabilities, RxLevel, AutoGainMode } from '@/radio/types';
import { createHackRFGainAdjustment, hackrfGainTotal } from '@/radio/hackrf-auto-gain';
import { createGainGovernor } from '@/radio/auto-gain-governor';
import { receiverOverloaded } from '@/radio/auto-gain-level';
import type { AutoGainPreset, GainStep } from './types';

const autoGainPresets: AutoGainPreset[] = [
	{ id: 'race', label: 'Race', description: 'Near quads: extra headroom, RF amp off', target: 80, allowAmp: false },
	{ id: 'scan', label: 'Scan', description: 'Far or quiet signals: more gain, RF amp off', target: 20, allowAmp: false },
	{ id: 'manual', label: 'Manual', description: 'Auto gain off; set the gains yourself' },
];

const gainOptions = [
	{
		label: 'Auto set gains',
		items: [
			{ id: 'balanced', label: 'Balanced', icon: 'radio' as const, description: 'Everyday reception with room for peaks' },
			{ id: 'sensitivity', label: 'Weak signals', icon: 'radio' as const, description: 'Favor early amplification for distant signals' },
			{ id: 'strong', label: 'Strong signals', icon: 'radio' as const, description: 'Reduce early gain and leave extra headroom' },
		],
	},
];

export const autoGainMethods = {
	autoGainOptions() {
		return gainOptions;
	},
	autoGainPresets() {
		return autoGainPresets;
	},
	applyAutoGainPreset(this: AppInstance, id: string) {
		const preset = autoGainPresets.find((candidate) => candidate.id === id);
		if (!preset) return;
		if (preset.target === undefined) {
			this.autoGain.enabled = false;
			return;
		}
		Object.assign(this.autoGain, { target: preset.target, allowAmp: !!preset.allowAmp, enabled: true });
	},
	autoGainLoopWanted(this: AppInstance) {
		return this.autoGain.enabled && this.running && this.connected && this.remoteMode !== 'client' && this.autoGainSupported();
	},
	/** Write gains without counting it as a manual change, which would switch auto gain off. */
	async setGainsFromCode(this: AppInstance, gains: Record<string, number>) {
		this._gainsFromCode = true;
		try {
			Object.assign(this.gains, gains);
			await this.$nextTick();
		} finally {
			this._gainsFromCode = false;
		}
	},
	/**
	 * Continuous auto gain: measure, step, measure again, for as long as it is switched on.
	 * Levels within the target band (-2 to +3 dB) are held, so the gain does not hunt.
	 */
	async runAutoGainLoop(this: AppInstance) {
		if (this._autoGainLoop) return;
		const token = Date.now() + Math.random();
		this._autoGainLoop = token;
		const wanted = () => this._autoGainLoop === token && this.autoGainLoopWanted();
		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const tuning = () =>
			JSON.stringify([
				// In sweep mode the level covers the whole sweep range.
				this.sweepMode() ? [this.sweep.startMHz, this.sweep.stopMHz] : this.radio.centerFreq,
				this.radio.sampleRate,
				this.radio.frequencyShift,
				this.gains['RX Channel'],
				this.gains.Antenna,
			]);
		let settings = '';
		let tuned = '';
		let adjustHackrf = createHackRFGainAdjustment(0.5, false);
		let after = Date.now() + 150;
		const governor = createGainGovernor();
		/** The last gains that held steady, the first fallback on overload. */
		const memory: { locked: Record<string, number> | null } = { locked: null };
		this.autoGain.status = 'Measuring receiver level…';
		try {
			while (wanted()) {
				await wait(250);
				if (!wanted()) break;
				const isHackrf = this.deviceCapabilities?.deviceType === 'hackrf';
				const preference = this.autoGain.target / 100;
				const key = JSON.stringify([preference, this.autoGain.allowAmp, isHackrf]);
				if (key !== settings) {
					settings = key;
					adjustHackrf = createHackRFGainAdjustment(preference, this.autoGain.allowAmp);
					governor.reset();
					memory.locked = null;
				}
				if (tuning() !== tuned) {
					// Readings taken before a retune describe the old band.
					tuned = tuning();
					after = Date.now() + 150;
					governor.reset();
					memory.locked = null;
				}
				const level = await this.backend.getRxLevel();
				if (!wanted()) break;
				if (!level || level.started < after || Date.now() - level.timestamp > 1000) continue;
				this.autoGain.level = level;
				this.autoGain.overload = receiverOverloaded(level);
				const proposal = planLoopStep(
					this,
					level,
					isHackrf ? (gains) => adjustHackrf(gains as HackRFGains, level) : null,
					governor,
					memory,
				);
				if (!proposal) continue;
				await applyLoopGains.call(this, isHackrf ? HACKRF_NAMES : LIME_NAMES, proposal, wanted);
				after = Date.now() + 150;
			}
		} finally {
			if (this._autoGainLoop === token) this._autoGainLoop = null;
			if (!this.autoGain.enabled) {
				this.autoGain.status = '';
				this.autoGain.overload = false;
			}
		}
	},
	autoGainSupported(this: AppInstance) {
		return this.gains['Receive Mode'] !== 1 && ['limesdr', 'hackrf'].includes(this.deviceCapabilities?.deviceType ?? '');
	},
	autoGainControls(this: AppInstance) {
		return this.deviceCapabilities?.deviceType === 'hackrf' ? 'LNA, VGA and RF amplifier' : 'LNA, TIA and PGA';
	},
	cancelAutoGain(this: AppInstance) {
		this.autoGain.cancelled = true;
		this.autoGain.status = 'Finishing…';
	},
	async autoSetGains(this: AppInstance, mode: AutoGainMode = 'balanced') {
		if (!canAdjustGains(this)) return;
		const isHackrf = this.deviceCapabilities?.deviceType === 'hackrf';
		const names = isHackrf ? ['Amp (14dB)', 'LNA', 'VGA'] : ['LNA', 'TIA', 'PGA'];
		const original: Record<string, number> = Object.fromEntries(names.map((name) => [name, this.gains[name]]));
		let applied = { ...original };
		const capabilities = this.deviceCapabilities;
		const valid = createAutoGainGuard.call(this, capabilities);
		this.autoGain.active = true;
		this.autoGain.mode = mode;
		this.autoGain.cancelled = false;
		this.autoGain.level = null;
		this.autoGain.status = 'Measuring receiver level…';
		const measure = createLevelMeasurement.call(this, valid);
		try {
			// Allow any pending manual gain command to finish before sampling.
			await this.backend.setGains(original);
			if (startWithMinimumGain(capabilities, applied)) {
				await applyGainChanges.call(this, names, { ...applied, LNA: 0, VGA: 0 }, applied, valid);
			}
			let after = Date.now() + 150;
			let stable = 0;
			const adjustHackrf = createHackRFGainAdjustment(mode);
			const maxSteps = isHackrf ? 40 : 14;
			for (let step = 0; step < maxSteps; step++) {
				const level = await measure(after);
				this.autoGain.level = level;
				const next = isHackrf ? adjustHackrf(applied as HackRFGains, level) : nextLimeGain(applied as LimeGains, level, mode);
				const nextGains = next.gains as Record<string, number>;
				this.autoGain.status = next.reason;
				if (next.done) {
					if (++stable >= 2) break;
					after = level.timestamp;
					continue;
				}
				stable = 0;
				await applyGainChanges.call(this, names, nextGains, applied, valid);
				after = Date.now() + 150;
				if (step === maxSteps - 1) {
					this.autoGain.level = await measure(after);
					this.autoGain.status = 'Adjustment limit reached; review levels';
				}
			}
		} catch (error) {
			this.autoGain.status = error instanceof Error ? errorMessage(error) : String(error);
			if (!this.autoGain.cancelled && valid()) {
				// Restore reductions first as well, especially when changing the RF amp.
				const restore = Object.fromEntries(
					[...names.filter((name) => original[name] < applied[name]), ...names.filter((name) => original[name] >= applied[name])].map(
						(name) => [name, original[name]],
					),
				);
				try {
					await this.backend.setGains(restore);
					applied = original;
				} catch {
					this.autoGain.status += ' · Could not restore original gains';
				}
			}
		} finally {
			if (this.deviceCapabilities === capabilities) Object.assign(this.gains, applied);
			// Keep the manual gain watcher suppressed through the reactive update.
			await this.$nextTick();
			this.autoGain.active = false;
			this.saveSetting();
			if (this.remoteMode === 'host' && this._webrtc) this._webrtc.sendCommand({ type: 'sync', gains: this.gains, locks: this.locks });
		}
	},
};

function createLevelMeasurement(this: AppInstance, valid: () => boolean) {
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const measure = async (after: number): Promise<RxLevel> => {
		for (let poll = 0; poll < 25; poll++) {
			if (this.autoGain.cancelled || !valid()) throw new Error('Adjustment cancelled');
			await wait(100);
			const level = await this.backend.getRxLevel();
			if (this.autoGain.cancelled || !valid()) throw new Error('Adjustment cancelled');
			if (level && level.started >= after && Date.now() - level.timestamp < 1000) return level;
		}
		throw new Error('No fresh receiver samples; check the USB stream');
	};
	return measure;
}

function createAutoGainGuard(this: AppInstance, capabilities: DeviceCapabilities | null) {
	const config = () =>
		JSON.stringify([this.radio.centerFreq, this.radio.sampleRate, this.radio.frequencyShift, this.gains['RX Channel'], this.gains.Antenna]);
	const initial = config();
	const valid = () =>
		this.running && this.connected && this.deviceCapabilities === capabilities && this.remoteMode !== 'client' && config() === initial;
	return valid;
}

async function applyGainChanges(
	this: AppInstance,
	names: string[],
	nextGains: Record<string, number>,
	applied: Record<string, number>,
	valid: () => boolean,
) {
	// Apply reductions before increases to avoid transient overload.
	for (const name of [
		...names.filter((name) => nextGains[name] < applied[name]),
		...names.filter((name) => nextGains[name] > applied[name]),
	]) {
		if (this.autoGain.cancelled || !valid()) throw new Error('Adjustment cancelled');
		await this.backend.setGain(name, nextGains[name]);
		applied[name] = nextGains[name];
	}
}

function canAdjustGains(app: AppInstance): boolean {
	return !app.autoGain.active && app.running && app.connected && app.remoteMode !== 'client' && app.autoGainSupported();
}

function startWithMinimumGain(capabilities: DeviceCapabilities | null, gains: Record<string, number>) {
	return capabilities?.deviceType === 'hackrf' && !!gains['Amp (14dB)'];
}

const HACKRF_NAMES = ['Amp (14dB)', 'LNA', 'VGA'];
const LIME_NAMES = ['LNA', 'TIA', 'PGA'];

/** Turn one level reading into gains to apply now, or null to hold. Sets the status line either way. */
function planLoopStep(
	app: AppInstance,
	level: RxLevel,
	adjustHackrf: ((gains: Record<string, number>) => GainStep) | null,
	governor: ReturnType<typeof createGainGovernor>,
	memory: { locked: Record<string, number> | null },
): Record<string, number> | null {
	const isHackrf = !!adjustHackrf;
	const current = pickGains(app, isHackrf ? HACKRF_NAMES : LIME_NAMES);
	const total = (gains: Record<string, number>) => (isHackrf ? hackrfGainTotal(gains as HackRFGains) : limeGainTotal(gains as LimeGains));
	let next: GainStep;
	try {
		next = adjustHackrf ? adjustHackrf(current) : nextLimeGain(current as LimeGains, level, app.autoGain.target / 100);
	} catch (error) {
		app.autoGain.status = errorMessage(error);
		return null;
	}
	const locked = `Locked · RMS ${level.rmsDbfs.toFixed(0)} dBFS`;
	const proposal = app.autoGain.overload
		? overloadFallback(current, next.gains, memory.locked, total)
		: isHackrf
			? vgaFirst(current, next.gains)
			: next.gains;
	const ampChange = isHackrf && proposal['Amp (14dB)'] !== current['Amp (14dB)'];
	// A change that only moves gain between stages is not worth a glitch in the waterfall.
	if (next.done || (!ampChange && total(proposal) === total(current))) {
		app.autoGain.status = next.done && next.reason !== 'Levels settled' ? next.reason : locked;
		if (!app.autoGain.overload) memory.locked = current;
		return null;
	}
	const decision = governor.decide(total(current), total(proposal), app.autoGain.overload);
	app.autoGain.status = decision.act ? next.reason : `${locked} · ${decision.held}`;
	return decision.act ? proposal : null;
}

/**
 * On overload, fall back to the last gains that held steady, or when already
 * at or below those, step down by 2 dB on the VGA (the amp goes off first).
 */
function overloadFallback(
	current: Record<string, number>,
	proposed: Record<string, number>,
	locked: Record<string, number> | null,
	total: (gains: Record<string, number>) => number,
) {
	if (locked && total(locked) < total(current)) return locked;
	if (current['Amp (14dB)'] || current.VGA === undefined) return proposed;
	return current.VGA >= 2 ? { ...current, VGA: current.VGA - 2 } : proposed;
}

/**
 * Make small corrections on the VGA (2 dB steps) and leave the LNA (8 dB steps)
 * where it is, so a correction does not overshoot. The LNA only moves when the
 * VGA runs out of range or the amp switches.
 */
function vgaFirst(current: Record<string, number>, proposed: Record<string, number>) {
	if (proposed['Amp (14dB)'] !== current['Amp (14dB)']) return proposed;
	const vga = current.VGA + (proposed.LNA + proposed.VGA - current.LNA - current.VGA);
	return vga >= 0 && vga <= 62 ? { ...current, VGA: vga } : proposed;
}

function pickGains(app: AppInstance, names: string[]) {
	return Object.fromEntries(names.map((name) => [name, app.gains[name]]));
}

/** One loop step: write the changes (reductions first) and show them on the gain sliders. */
async function applyLoopGains(this: AppInstance, names: string[], nextGains: Record<string, number>, wanted: () => boolean) {
	const applied = pickGains(this, names);
	this.autoGain.active = true;
	try {
		await applyGainChanges.call(this, names, nextGains, applied, wanted);
		this._gainMarkerPending = true;
	} catch (error) {
		if (wanted()) this.autoGain.status = errorMessage(error);
	} finally {
		Object.assign(this.gains, applied);
		// Keep the manual gain watcher suppressed through the reactive update.
		await this.$nextTick();
		this.autoGain.active = false;
		this.saveSetting();
		if (this.remoteMode === 'host' && this._webrtc) this._webrtc.sendCommand({ type: 'sync', gains: this.gains, locks: this.locks });
	}
}
