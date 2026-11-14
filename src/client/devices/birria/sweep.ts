import type { SweepPlan } from '@/devices/hackrf/types';

/**
 * Stitches the BirriaSDR bridge's sweep steps into one line over the plan's range. Each message is
 * a little-endian uint64 frequency of its first bin in Hz, then float32 dB bins at the plan's bin
 * width; the bridge already did the FFT. onSweep fires each time the steps wrap back to the start
 * (or repeat, for a range the bridge covers with a single tuning).
 */
export class BirriaSweepAssembler {
	readonly line: Float32Array;
	sweepCount = 0;
	private lastHz = Infinity;
	private started = false;
	private readonly startHz: number;

	constructor(
		private readonly plan: SweepPlan,
		private readonly onSweep: (line: Float32Array) => void,
	) {
		this.line = new Float32Array(plan.binCount).fill(-200);
		this.startHz = plan.startMHz * 1e6;
	}

	push(data: ArrayBufferView): void {
		if (data.byteLength < 12) return;
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const firstHz = view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32;
		// A step at or before the previous one starts a new sweep. A range that fits in one tuning
		// repeats the same step, so every message is a whole sweep.
		if (firstHz <= this.lastHz) {
			if (this.started) {
				this.sweepCount++;
				this.onSweep(this.line);
			}
			this.started = true;
		}
		this.lastHz = firstHz;
		const count = (data.byteLength - 8) / 4;
		const bins = new Float32Array(data.buffer.slice(data.byteOffset + 8, data.byteOffset + 8 + count * 4));
		const position = Math.round((firstHz - this.startHz) / this.plan.binWidthHz);
		const skip = Math.max(0, -position);
		const n = Math.min(bins.length, this.line.length - position) - skip;
		if (n > 0) this.line.set(bins.subarray(skip, skip + n), position + skip);
	}
}
