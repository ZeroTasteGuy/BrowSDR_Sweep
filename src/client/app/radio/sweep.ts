import * as Comlink from 'comlink';
import type { AppInstance } from '@/app/core/receiver.types';
import { planSweep } from '@/devices/hackrf/sweep';
import { errorMessage } from '@/platform/errors';

export const sweepMethods = {
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
		const request = { startMHz: this.sweep.startMHz, stopMHz: this.sweep.stopMHz, binWidthHz: this.sweep.binWidthKHz * 1e3 };
		try {
			this.sweep.plan = planSweep(request);
		} catch (error) {
			this.showMsg(errorMessage(error));
			return;
		}
		this.sweep.active = true;
		this.sweep.rate = 0;
		this._sweepPeak = undefined;
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
