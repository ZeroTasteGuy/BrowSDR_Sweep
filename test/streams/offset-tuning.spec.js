import { afterEach, describe, expect, it, vi } from 'vitest';

const fftInputMeans = vi.hoisted(() => []);
vi.mock('@/worker/runtime/wasm-init', () => ({
	FFT: class {
		set_smoothing_speed() {}
		free() {}
		// Record the frame's mean and output the bin index, so the shift is visible.
		fft(input, output) {
			let sum = 0;
			for (let n = 0; n < input.length; n += 2) sum += input[n];
			fftInputMeans.push(sum / (input.length / 2));
			output.forEach((_, index) => (output[index] = index));
		}
	},
}));

import { HackRFDevice } from '@/devices/hackrf/device';
import { DcOffsetRemover, offsetTuningBins, offsetTuningHz, patchDcSpike, shiftSpectrum, spikeHalfWidthBins } from '@/radio/offset-tuning';
import { startRxStream } from '@/worker/streams/rx-stream';
import { Backend } from '@/worker/runtime/backend';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function toneWithOffset(pairs, dcI, dcQ, phase = 0) {
	const iq = new Int8Array(pairs * 2);
	for (let n = 0; n < pairs; n++) {
		const angle = phase + (2 * Math.PI * n) / 37;
		iq[n * 2] = Math.round(40 * Math.cos(angle) + dcI);
		iq[n * 2 + 1] = Math.round(40 * Math.sin(angle) + dcQ);
	}
	return iq;
}

const mean = (iq, component) => {
	let sum = 0;
	for (let n = component; n < iq.length; n += 2) sum += iq[n];
	return sum / (iq.length / 2);
};

describe('DC offset removal', () => {
	it('removes a fractional DC offset and keeps the signal', () => {
		const remover = new DcOffsetRemover();
		const before = toneWithOffset(37 * 400, 3.4, -2.6);
		expect(mean(before, 0)).toBeCloseTo(3.4, 0);
		const block = before.slice();
		remover.process(block);
		expect(Math.abs(mean(block, 0))).toBeLessThan(0.01);
		expect(Math.abs(mean(block, 1))).toBeLessThan(0.01);
		expect(remover.offset.i).toBeCloseTo(mean(before, 0), 6);
		// The tone itself only moves by the removed offset, give or take one step.
		for (let n = 0; n < 200; n++) expect(Math.abs(block[n * 2] - (before[n * 2] - 3.4))).toBeLessThanOrEqual(1);
	});
	it('follows a drifting offset smoothly across frames', () => {
		const remover = new DcOffsetRemover();
		remover.process(toneWithOffset(37 * 100, 2, 2));
		remover.process(toneWithOffset(37 * 100, 4, 2));
		expect(remover.offset.i).toBeGreaterThan(2.5);
		expect(remover.offset.i).toBeLessThan(3.5);
	});
	it('clamps at full scale without carrying the clipping error onward', () => {
		const remover = new DcOffsetRemover();
		const block = new Int8Array(200).fill(-3);
		block[0] = block[1] = 127;
		remover.process(block);
		// The offset is -1.7, so 127 clips; the next -3 becomes -1.3, not -3 + 1.7 + 1.7.
		expect(remover.offset.i).toBeCloseTo(-1.7, 6);
		expect(block[0]).toBe(127);
		expect(block[2]).toBe(-1);
	});
});

describe('offset tuning', () => {
	it('tunes the HackRF an eighth of the sample rate high, in whole FFT bins', () => {
		const offset = new HackRFDevice().tuningOffsetHz(20e6);
		expect(offset).toBe(2.5e6);
		const bins = offsetTuningBins(offset, 20e6, 2048);
		expect(bins).toBe(256);
		expect(offsetTuningHz(bins, 20e6, 2048)).toBe(2.5e6);
		expect(offsetTuningBins(0, 20e6, 2048)).toBe(0);
	});
	it('shifts the captured spectrum back onto the display centre', () => {
		const captured = new Float32Array([-50, -40, -30, -20, -10, 0, -60, -70]);
		const out = new Float32Array(8);
		shiftSpectrum(captured, out, 2);
		expect([...out]).toEqual([-40, -50, -50, -40, -30, -20, -10, 0]);
		shiftSpectrum(captured, out, -2);
		expect([...out]).toEqual([-30, -20, -10, 0, -60, -70, -70, -60]);
		shiftSpectrum(captured, out, 0);
		expect([...out]).toEqual([...captured]);
	});
	it('tunes the hardware and DSP to the offset centre, also when retuning', async () => {
		vi.stubGlobal(
			'Worker',
			class {
				postMessage() {}
			},
		);
		let deliver;
		const device = {
			setSampleRate: vi.fn(),
			setFrequency: vi.fn(),
			startRx: vi.fn(async (onData) => (deliver = onData)),
			tuningOffsetHz: (rate) => rate / 8,
		};
		const backend = {
			device,
			setSpectrumFps: vi.fn(),
			setWhisperEnabled: Backend.prototype.setWhisperEnabled,
			_reinitRemoteClientWorkers: vi.fn(),
			_spectrumFps: 20,
		};
		const spectrum = vi.fn();
		await startRxStream(backend, { centerFreq: 5800, sampleRate: 20e6, fftSize: 2048 }, spectrum, vi.fn(), null, null);
		expect(device.setFrequency).toHaveBeenLastCalledWith(5802.5e6);
		expect(backend._centerFreq).toBe(5802.5);
		expect(backend._tuningOffsetHz).toBe(2.5e6);
		deliver(toneWithOffset(2048, 6.3, -4));
		expect(Math.abs(fftInputMeans.at(-1))).toBeLessThan(0.01);
		const line = spectrum.mock.calls[0][0];
		expect([line[0], line[255], line[256], line[2047]]).toEqual([255, 0, 0, 1791]);
		await Backend.prototype.setFrequency.call(backend, 5740);
		expect(device.setFrequency).toHaveBeenLastCalledWith(5742.5e6);
		expect(backend._centerFreq).toBe(5742.5);
	});
});

describe('DC spike patch', () => {
	function noisy(n, seed = 1) {
		let x = seed;
		return Float32Array.from({ length: n }, () => {
			x = (x * 16807) % 2147483647;
			return -100 + (x / 2147483647) * 4;
		});
	}
	it('sizes the patch from 150 kHz, within limits', () => {
		expect(spikeHalfWidthBins(20e6, 65536)).toBe(492);
		expect(spikeHalfWidthBins(20e6, 2048)).toBe(15);
		expect(spikeHalfWidthBins(2e6, 256)).toBe(8);
		expect(spikeHalfWidthBins(20e6, 64)).toBe(2);
	});
	it('replaces the spike and its skirt with nearby noise', () => {
		const spectrum = noisy(4096);
		const c = 2048;
		spectrum[c] = -40;
		for (let k = 1; k <= 10; k++) spectrum[c - k] = spectrum[c + k] = -40 - 5 * k;
		patchDcSpike(spectrum, 40);
		for (let k = -12; k <= 12; k++) expect(spectrum[c + k]).toBeLessThan(-95);
	});
	it('leaves a wide signal across the centre alone apart from the centre bin', () => {
		const spectrum = noisy(4096);
		const c = 2048;
		for (let k = -300; k <= 300; k++) spectrum[c + k] = -60 + (k % 3);
		const before = spectrum.slice();
		patchDcSpike(spectrum, 40);
		for (let k = 2; k <= 300; k++) expect(spectrum[c + k]).toBe(before[c + k]);
		expect(spectrum[c]).toBeGreaterThan(-62);
	});
});
