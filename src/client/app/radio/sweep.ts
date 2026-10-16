import * as Comlink from 'comlink';
import type { AppInstance } from '@/app/core/receiver.types';
import { planSweep, SWEEP_BIN_WIDTHS_HZ } from '@/devices/hackrf/sweep';
import { errorMessage } from '@/platform/errors';
import { resetSweepTraces } from '@/app/display/sweep-overlay';
import { channelLabel, FPV_BANDS, PEAK_FADE_OPTIONS, SWEEP_PRESETS } from '@/display/fpv';

export const sweepMethods = {
	peakFadeOptions() {
		return PEAK_FADE_OPTIONS;
	},
	sweepPresets() {
		return SWEEP_PRESETS;
	},
	fpvBands() {
		return FPV_BANDS;
	},
	/** The preset matching the current range, or '' when the range was entered by hand. */
	sweepPresetId(this: AppInstance) {
		return SWEEP_PRESETS.find((preset) => preset.startMHz === this.sweep.startMHz && preset.stopMHz === this.sweep.stopMHz)?.id ?? '';
	},
	applySweepPreset(this: AppInstance, id: string) {
		const preset = SWEEP_PRESETS.find((candidate) => candidate.id === id);
		if (preset) Object.assign(this.sweep, { startMHz: preset.startMHz, stopMHz: preset.stopMHz });
	},
	/** Start peak hold and the averaged peaks over, e.g. after moving a transmitter. */
	clearSweepPeaks(this: AppInstance) {
		resetSweepTraces(this);
	},
	/** "R5" when a peak sits within 3 MHz of a channel of the selected band. */
	peakChannel(this: AppInstance, freqMHz: number) {
		const band = FPV_BANDS.find((candidate) => candidate.id === this.sweep.channelBand);
		const index = band?.channels.findIndex((channel) => Math.abs(channel - freqMHz) <= 3) ?? -1;
		return band && index >= 0 ? channelLabel(band, index) : '';
	},
	/** Bin width choices for the dropdown, in kHz. */
	sweepBinWidthOptions() {
		return SWEEP_BIN_WIDTHS_HZ.map((hz) => ({ value: hz / 1e3, label: `${formatKHz(hz / 1e3)} kHz` }));
	},
	/** Why the entered range can't be swept, or an empty string. Shown under the fields as you type. */
	sweepError(this: AppInstance) {
		try {
			planSweep(sweepRequest(this));
			return '';
		} catch (error) {
			return errorMessage(error);
		}
	},
	/** Sweep runs the HackRF's own firmware sweep, so it is offered for HackRF only. */
	sweepAvailable(this: AppInstance) {
		return this.connected && this.deviceCapabilities?.deviceType === 'hackrf' && this.remoteMode !== 'client';
	},
	async startSweep(this: AppInstance) {
		if (this.running) return;
		if (this.remoteMode !== 'none') {
			this.showMsg('Sweep is unavailable while sharing or viewing a remote receiver.');
			return;
		}
		const request = sweepRequest(this);
		try {
			this.sweep.plan = planSweep(request);
		} catch (error) {
			this.showMsg(errorMessage(error));
			return;
		}
		this.sweep.active = true;
		this.sweep.rate = 0;
		resetSweepTraces(this);
		this.view.zoomScale = 1.0;
		this.view.zoomOffset = 0.0;
		this.initCanvas();
		this.running = true;
		try {
			await this.backend.startSweepStream(
				{ ...request, gains: { ...this.gains } },
				Comlink.proxy((spectrumData: Float32Array) => this.drawSpectrum(spectrumData)),
				Comlink.proxy((sweepsPerSecond: number) => {
					this.sweep.rate = sweepsPerSecond;
				}),
			);
		} catch (error) {
			console.error('Error starting sweep:', error);
			try {
				await this.backend.stopRx();
			} catch {
				/* Best-effort cleanup; the original error is the one worth showing. */
			}
			this.showMsg('Error starting sweep: ' + errorMessage(error));
			this.running = false;
		}
	},
};

function sweepRequest(app: AppInstance) {
	return { startMHz: app.sweep.startMHz, stopMHz: app.sweep.stopMHz, binWidthHz: app.sweep.binWidthKHz * 1e3 };
}

function formatKHz(kHz: number) {
	return kHz >= 100 ? String(Math.round(kHz * 100) / 100) : kHz.toFixed(kHz >= 10 ? 1 : 2);
}

/**
 * Move a restored or typed range onto what the firmware will sweep: whole MHz, and a stop rounded up to
 * whole 20 MHz steps. Returns null when the range is invalid, so the inline error can explain it.
 */
export function normalizedSweepRange(sweep: { startMHz: number; stopMHz: number; binWidthKHz: number }) {
	try {
		const plan = planSweep({ startMHz: sweep.startMHz, stopMHz: sweep.stopMHz, binWidthHz: sweep.binWidthKHz * 1e3 });
		return { startMHz: plan.startMHz, stopMHz: plan.stopMHz, binWidthKHz: plan.binWidthHz / 1e3 };
	} catch {
		return null;
	}
}
