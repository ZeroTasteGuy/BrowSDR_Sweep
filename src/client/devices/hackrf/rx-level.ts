import type { RxLevel } from '@/radio/types';

/**
 * Measure signed 8-bit HackRF IQ before any filtering, demodulation or volume.
 *
 * The HackRF's DC offset (LO leakage) is removed from the RMS and peak, because
 * it is not signal: counted in, it fills a quiet band and holds auto gain low.
 * Clipping is still judged on the raw samples, since the ADC sees the DC too.
 */
export class HackRFRxLevel {
	private started = 0;
	private count = 0;
	private clipped = 0;
	private sum = [0, 0];
	private square = [0, 0];
	private min = [Infinity, Infinity];
	private max = [-Infinity, -Infinity];
	private phase = 0;
	private latest: RxLevel | null = null;

	reset(now = Date.now()): void {
		this.started = now;
		this.clear();
		this.phase = 0;
		this.latest = null;
	}
	observe(data: ArrayBufferView, now = Date.now()): void {
		if (!this.started) this.started = now;
		const iq = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
		const pairs = Math.floor(iq.length / 2);
		// At most 1024 IQ pairs per transfer, with rotating positions to avoid
		// synchronizing to a periodic tone. No copy or mutation of USB samples.
		const stride = Math.max(1, Math.ceil(pairs / 1024));
		for (let pair = this.phase++ % stride; pair < pairs; pair += stride) {
			for (let component = 0; component < 2; component++) {
				const signed = iq[pair * 2 + component];
				this.sum[component] += signed;
				this.square[component] += signed * signed;
				if (signed < this.min[component]) this.min[component] = signed;
				if (signed > this.max[component]) this.max[component] = signed;
				if (signed <= -127 || signed >= 126) this.clipped++;
			}
			this.count += 2;
		}
		if (now - this.started >= 250 && this.count) {
			const perComponent = this.count / 2;
			let power = 0;
			let rawPower = 0;
			let peak = 0;
			for (let component = 0; component < 2; component++) {
				const mean = this.sum[component] / perComponent;
				const meanSquare = this.square[component] / perComponent;
				rawPower += meanSquare;
				power += Math.max(0, meanSquare - mean * mean);
				peak = Math.max(peak, this.max[component] - mean, mean - this.min[component]);
			}
			const full = 128 * 128;
			this.latest = {
				timestamp: now,
				started: this.started,
				samples: this.count,
				rmsDbfs: 10 * Math.log10(Math.max(power / 2 / full, 1e-12)),
				peakDbfs: 20 * Math.log10(Math.max(peak / 128, 1e-6)),
				rawRmsDbfs: 10 * Math.log10(Math.max(rawPower / 2 / full, 1e-12)),
				clippedFraction: this.clipped / this.count,
			};
			this.started = now;
			this.clear();
		}
	}
	private clear(): void {
		this.count = this.clipped = 0;
		this.sum = [0, 0];
		this.square = [0, 0];
		this.min = [Infinity, Infinity];
		this.max = [-Infinity, -Infinity];
	}
	get level(): RxLevel | null {
		return this.latest;
	}
}
