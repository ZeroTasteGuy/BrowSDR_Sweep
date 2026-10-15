/*
Block layout, tuning constants and bin selection follow hackrf_sweep:
https://github.com/greatscottgadgets/hackrf/blob/master/host/hackrf-tools/src/hackrf_sweep.c
See also https://github.com/cho45/hackrf-sweep-webusb.
*/

import { DEFAULT_FFT_SIZE } from '@/display/spectrum-range';
import type { SpectrumFft, SweepBlock, SweepPlan, SweepRequest } from './types';

export const SWEEP_SAMPLE_RATE_HZ = 20_000_000;
export const SWEEP_BASEBAND_FILTER_HZ = 15_000_000;
/** Distance between tuning steps and the LO offset passed to the firmware (hackrf_sweep TUNE_STEP / OFFSET). */
export const SWEEP_TUNE_STEP_HZ = 20_000_000;
export const SWEEP_OFFSET_HZ = 7_500_000;
export const SWEEP_BLOCK_BYTES = 16384;
export const SWEEP_MAX_MHZ = 7250;
const MIN_FFT_SIZE = 16;
const MAX_FFT_SIZE = 4096;

export function planSweep({ startMHz, stopMHz, binWidthHz }: SweepRequest): SweepPlan {
	if (![startMHz, stopMHz, binWidthHz].every(Number.isFinite)) throw new Error('Sweep start, stop and bin width must be numbers.');
	const start = Math.floor(startMHz);
	const requestedStop = Math.ceil(stopMHz);
	if (start < 0) throw new Error('Sweep start must be 0 MHz or higher.');
	if (requestedStop <= start) throw new Error('Sweep stop must be higher than start.');
	if (requestedStop > SWEEP_MAX_MHZ) throw new Error(`Sweep stop must be ${SWEEP_MAX_MHZ} MHz or lower.`);
	if (binWidthHz <= 0) throw new Error('Sweep bin width must be greater than zero.');
	const stepMHz = SWEEP_TUNE_STEP_HZ / 1e6;
	const steps = Math.ceil((requestedStop - start) / stepMHz);
	const fftSize = Math.min(MAX_FFT_SIZE, Math.max(MIN_FFT_SIZE, 2 ** Math.ceil(Math.log2(SWEEP_SAMPLE_RATE_HZ / binWidthHz))));
	return {
		startMHz: start,
		stopMHz: start + steps * stepMHz,
		fftSize,
		binWidthHz: SWEEP_SAMPLE_RATE_HZ / fftSize,
		binCount: steps * fftSize,
	};
}

/**
 * Split a USB transfer into sweep blocks. Each 16384-byte block starts with 0x7F 0x7F and a
 * little-endian uint64 frequency in Hz, followed by IQ; hackrf_sweep FFTs the last fftSize samples.
 * Blocks without the marker are skipped.
 */
export function parseSweepBlocks(data: ArrayBufferView, fftSize: number): SweepBlock[] {
	const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const blocks: SweepBlock[] = [];
	for (let offset = 0; offset + SWEEP_BLOCK_BYTES <= bytes.length; offset += SWEEP_BLOCK_BYTES) {
		if (bytes[offset] !== 0x7f || bytes[offset + 1] !== 0x7f) continue;
		const frequencyHz = view.getUint32(offset + 2, true) + view.getUint32(offset + 6, true) * 2 ** 32;
		const iq = new Int8Array(data.buffer, data.byteOffset + offset + SWEEP_BLOCK_BYTES - fftSize * 2, fftSize * 2);
		blocks.push({ frequencyHz, iq });
	}
	return blocks;
}

/** Hann window, as hackrf_sweep uses. */
export function sweepWindow(fftSize: number): Float32Array {
	return Float32Array.from({ length: fftSize }, (_, i) => 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1))));
}

/**
 * FFT each block, keep the two usable quarters (2.5–7.5 MHz either side of the LO, where the
 * baseband filter is flat and the other half of the 20 MHz is covered by the interleaved step),
 * and stitch them into one line spanning the whole range. The line keeps the last value of every
 * bin, so partial sweeps never show holes. onSweep fires each time the sweep returns to the start.
 */
export class SweepAssembler {
	readonly line: Float32Array;
	sweepCount = 0;
	private started = false;
	private readonly spectrum: Float32Array;
	private readonly startHz: number;
	private readonly stopHz: number;
	/** Keeps levels comparable with the receiver's default display range, which assumes a 65536-point FFT. */
	private readonly levelOffsetDb: number;

	constructor(
		private readonly plan: SweepPlan,
		private readonly fft: SpectrumFft,
		private readonly onSweep: (line: Float32Array) => void,
	) {
		this.line = new Float32Array(plan.binCount).fill(-200);
		this.spectrum = new Float32Array(plan.fftSize);
		this.startHz = plan.startMHz * 1e6;
		this.stopHz = plan.stopMHz * 1e6;
		this.levelOffsetDb = 10 * Math.log10(plan.fftSize / DEFAULT_FFT_SIZE);
	}

	push(data: ArrayBufferView): void {
		for (const block of parseSweepBlocks(data, this.plan.fftSize)) this.addBlock(block);
	}

	addBlock({ frequencyHz, iq }: SweepBlock): void {
		if (frequencyHz === this.startHz) {
			if (this.started) {
				this.sweepCount++;
				this.onSweep(this.line);
			}
			this.started = true;
		}
		if (!this.started || frequencyHz < this.startHz || frequencyHz >= this.stopHz) return;

		const { fftSize } = this.plan;
		this.fft.fft(iq, this.spectrum);
		const spectrum = this.spectrum;
		for (let i = 0; i < fftSize; i++) spectrum[i] += this.levelOffsetDb;
		const position = Math.round((frequencyHz - this.startHz) / this.plan.binWidthHz);
		const quarter = fftSize / 4;
		const eighth = fftSize / 8;
		this.place(position, spectrum.subarray(eighth, eighth + quarter));
		this.place(position + fftSize / 2, spectrum.subarray(5 * eighth, 5 * eighth + quarter));
	}

	private place(position: number, bins: Float32Array): void {
		const skip = Math.max(0, -position);
		const count = Math.min(bins.length, this.line.length - position) - skip;
		if (count > 0) this.line.set(bins.subarray(skip, skip + count), position + skip);
	}
}
