import { errorMessage } from '@/platform/errors';
import type { AppInstance } from '@/app/core/receiver.types';
import { nextLimeGain } from '@/radio/lime-auto-gain';
import type { LimeGains, HackRFGains, DeviceCapabilities, RxLevel, AutoGainMode } from '@/radio/types';
import { createHackRFGainAdjustment } from '@/radio/hackrf-auto-gain';
import { receiverOverloaded } from '@/radio/auto-gain-level';
import type { AutoGainPreset } from './types';

const autoGainPresets: AutoGainPreset[] = [
	{ id: 'race', label: 'Race', description: 'Near quads: extra headroom, RF amp off', target: 80, allowAmp: false },
	{ id: 'scan', label: 'Scan', description: 'Far or quiet signals: more gain, RF amp allowed', target: 20, allowAmp: true },
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
		return (
			this.autoGain.enabled &&
			this.running &&
			this.connected &&
			this.remoteMode !== 'client' &&
			this.autoGainSupported() &&
			!this.sweepMode()
		);
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
				this.radio.centerFreq,
				this.radio.sampleRate,
				this.radio.frequencyShift,
				this.gains['RX Channel'],
				this.gains.Antenna,
			]);
		let settings = '';
		let tuned = '';
		let adjustHackrf = createHackRFGainAdjustment(0.5, false);
		let after = Date.now() + 150;
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
				}
				if (tuning() !== tuned) {
					// Readings taken before a retune describe the old band.
					tuned = tuning();
					after = Date.now() + 150;
				}
				const level = await this.backend.getRxLevel();
				if (!wanted()) break;
				if (!level || level.started < after || Date.now() - level.timestamp > 1000) continue;
				this.autoGain.level = level;
				this.autoGain.overload = receiverOverloaded(level);
				let next: { gains: Record<string, number>; done: boolean; reason: string };
				try {
					next = isHackrf
						? adjustHackrf(pickGains(this, HACKRF_NAMES) as HackRFGains, level)
						: nextLimeGain(pickGains(this, LIME_NAMES) as LimeGains, level, preference);
				} catch (error) {
					this.autoGain.status = errorMessage(error);
					continue;
				}
				if (next.done) {
					this.autoGain.status = next.reason === 'Levels settled' ? `Holding · RMS ${level.rmsDbfs.toFixed(0)} dBFS` : next.reason;
					continue;
				}
				this.autoGain.status = next.reason;
				await applyLoopGains.call(this, isHackrf ? HACKRF_NAMES : LIME_NAMES, next.gains, wanted);
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

function pickGains(app: AppInstance, names: string[]) {
	return Object.fromEntries(names.map((name) => [name, app.gains[name]]));
}

/** One loop step: write the changes (reductions first) and show them on the gain sliders. */
async function applyLoopGains(this: AppInstance, names: string[], nextGains: Record<string, number>, wanted: () => boolean) {
	const applied = pickGains(this, names);
	this.autoGain.active = true;
	try {
		await applyGainChanges.call(this, names, nextGains, applied, wanted);
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
