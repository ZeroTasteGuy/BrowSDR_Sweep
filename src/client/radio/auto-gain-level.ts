import type { RxLevel, AutoGainMode, AutoGainPreference } from './types';

/** The named mode nearest a slider position, for choosing how gain is split between stages. */
export function preferenceMode(preference: AutoGainPreference): AutoGainMode {
	if (typeof preference !== 'number') return preference;
	return preference < 0.25 ? 'sensitivity' : preference > 0.75 ? 'strong' : 'balanced';
}

/**
 * RMS and peak targets in dBFS. The normal slider range runs from -20/-6 (weak
 * signals, 0) to -28/-12 (strong signals, 1); it extends half as far again past
 * each end. The peak target never comes closer than 4 dB to full scale.
 */
export function gainTargets(preference: AutoGainPreference = 'balanced'): { rms: number; peak: number } {
	if (typeof preference !== 'number')
		return preference === 'strong'
			? { rms: -28, peak: -12 }
			: preference === 'sensitivity'
				? { rms: -20, peak: -6 }
				: { rms: -22, peak: -6 };
	const p = Math.max(-0.5, Math.min(1.5, preference));
	return { rms: -20 - 8 * p, peak: Math.min(-4, -6 - 6 * p) };
}

/** Target receiver level while retaining headroom for peaks across the capture. */
export function gainAdjustment(level: RxLevel, mode: AutoGainPreference = 'balanced'): number {
	if (![level.rmsDbfs, level.peakDbfs, level.clippedFraction].every(Number.isFinite) || level.samples < 100)
		throw new Error('Invalid receiver level measurement');
	// Only the DC offset left at low gain: the stream is alive, just raise the gain.
	if ((level.rawRmsDbfs ?? level.rmsDbfs) <= -100) throw new Error('Receiver samples are silent; check the USB stream');
	if (level.rmsDbfs <= -100) return 3;
	if (receiverOverloaded(level)) return -6;
	const target = gainTargets(mode);
	const delta = Math.min(target.rms - level.rmsDbfs, target.peak - level.peakDbfs);
	return delta < -2 ? Math.max(-6, Math.floor(delta)) : delta > 3 ? Math.min(3, Math.floor(delta)) : 0;
}

export function gainAdjustmentReason(change: number, done: boolean, level: RxLevel): string {
	return done
		? change
			? 'Gain limit reached'
			: 'Levels settled'
		: level.clippedFraction > 0.0001 || level.peakDbfs > -3
			? 'Reducing gain: ADC overload'
			: change < 0
				? 'Reducing gain for headroom'
				: 'Increasing gain';
}

export const receiverOverloaded = (level: RxLevel) => level.clippedFraction > 0.0001 || level.peakDbfs > -3;
