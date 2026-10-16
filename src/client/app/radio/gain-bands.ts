import type { AppInstance } from '@/app/core/receiver.types';

/** FPV and control-link bands share one gain setting each; elsewhere, every 100 MHz does. */
const NAMED_BANDS = [
	{ id: '900M', startMHz: 800, stopMHz: 1000 },
	{ id: '1.2G', startMHz: 1000, stopMHz: 1400 },
	{ id: '2.4G', startMHz: 2300, stopMHz: 2550 },
	{ id: '5.8G', startMHz: 5000, stopMHz: 6100 },
];

export function gainBand(freqMHz: number): string {
	if (!Number.isFinite(freqMHz)) return '';
	return NAMED_BANDS.find((band) => freqMHz >= band.startMHz && freqMHz < band.stopMHz)?.id ?? `${Math.floor(freqMHz / 100) * 100}M`;
}

/** The band the receiver is on now: the middle of the sweep range, or the centre frequency. */
export function currentGainBandKey(app: AppInstance): string {
	const type = app.deviceCapabilities?.deviceType;
	if (!type) return '';
	const freqMHz = app.sweepMode() ? (app.sweep.startMHz + app.sweep.stopMHz) / 2 : app.radio.centerFreq;
	const band = gainBand(freqMHz);
	return band && `${type}:${band}`;
}

/** Gain controls only; antenna, channel and transport selections are not per band. */
export function bandGains(app: AppInstance): Record<string, number> {
	const names = (app.deviceCapabilities?.gainControls ?? []).filter(
		(gc) => !['Antenna', 'RX Channel', 'USB Format', 'Receive Mode'].includes(gc.name),
	);
	return Object.fromEntries(names.filter((gc) => Number.isFinite(app.gains[gc.name])).map((gc) => [gc.name, app.gains[gc.name]]));
}

/** Remember the gains in use for this band, and bring back a band's gains when it is selected again. */
export function watchGainBands(this: AppInstance) {
	let previous = currentGainBandKey(this);
	this.$watch(
		() => currentGainBandKey(this),
		(key: string) => {
			if (previous && this.remoteMode !== 'client') this.gainsByBand[previous] = bandGains(this);
			previous = key;
			const saved = key && this.gainsByBand[key];
			if (saved && this.remoteMode !== 'client') void this.setGainsFromCode(saved);
		},
	);
	this.$watch(
		() => [this.gains, this.autoGain.active],
		() => {
			const key = currentGainBandKey(this);
			if (key && key === previous && !this.autoGain.active && this.remoteMode !== 'client') this.gainsByBand[key] = bandGains(this);
		},
		{ deep: true },
	);
}
