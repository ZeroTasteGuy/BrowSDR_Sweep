import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FFT, initSync } from '/wasm/dsp/browsdr_dsp.js';
import { HackRF } from '@/devices/hackrf/usb';
import { HackRFDevice } from '@/devices/hackrf/device';
import {
	SWEEP_BIN_WIDTHS_HZ,
	SWEEP_BLOCK_BYTES,
	SweepAssembler,
	parseSweepBlocks,
	planSweep,
	sweepBlockSamples,
	sweepWindow,
} from '@/devices/hackrf/sweep';
import { HackRFRxLevel } from '@/devices/hackrf/rx-level';
import { normalizedSweepRange } from '@/app/radio/sweep';

beforeAll(() => {
	initSync({ module: readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });
});

/** A 16384-byte sweep block whose trailing samples are a complex tone at toneHz from the LO. */
function block(frequencyHz, fftSize, toneHz = null, amplitude = 100) {
	const bytes = new Uint8Array(SWEEP_BLOCK_BYTES);
	bytes[0] = 0x7f;
	bytes[1] = 0x7f;
	const view = new DataView(bytes.buffer);
	view.setUint32(2, frequencyHz % 2 ** 32, true);
	view.setUint32(6, Math.floor(frequencyHz / 2 ** 32), true);
	const iq = new Int8Array(bytes.buffer, SWEEP_BLOCK_BYTES - fftSize * 2, fftSize * 2);
	for (let n = 0; n < fftSize; n++) {
		// A small deterministic noise floor.
		const noise = (i) => ((n * 7 + i * 13) % 3) - 1;
		const tone = toneHz === null ? [0, 0] : [Math.cos((2 * Math.PI * toneHz * n) / 20e6), Math.sin((2 * Math.PI * toneHz * n) / 20e6)];
		iq[n * 2] = Math.round(amplitude * tone[0]) + noise(0);
		iq[n * 2 + 1] = Math.round(amplitude * tone[1]) + noise(1);
	}
	return bytes;
}

const concat = (...parts) => {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

describe('sweep planning', () => {
	it('rounds the stop up to whole 20 MHz steps and picks a finer power-of-two FFT', () => {
		expect(planSweep({ startMHz: 5300, stopMHz: 6000, binWidthHz: 100e3 })).toEqual({
			startMHz: 5300,
			stopMHz: 6000,
			fftSize: 256,
			binWidthHz: 78125,
			binCount: 35 * 256,
		});
		expect(planSweep({ startMHz: 5300, stopMHz: 6001, binWidthHz: 100e3 })).toMatchObject({ stopMHz: 6020, binCount: 36 * 256 });
		expect(planSweep({ startMHz: 2400.4, stopMHz: 2420, binWidthHz: 20e6 / 4096 }).stopMHz).toBe(2420);
	});
	it('clamps the FFT size and rejects invalid ranges', () => {
		expect(planSweep({ startMHz: 100, stopMHz: 120, binWidthHz: 1 }).fftSize).toBe(4096);
		expect(planSweep({ startMHz: 100, stopMHz: 120, binWidthHz: 1e9 }).fftSize).toBe(16);
		expect(() => planSweep({ startMHz: 6000, stopMHz: 5300, binWidthHz: 1e5 })).toThrow('higher than start');
		expect(() => planSweep({ startMHz: 100, stopMHz: 7300, binWidthHz: 1e5 })).toThrow('7250');
		expect(() => planSweep({ startMHz: NaN, stopMHz: 7300, binWidthHz: 1e5 })).toThrow('numbers');
	});
});

describe('sweep settings', () => {
	it('offers exactly the bin widths the FFT can produce', () => {
		expect(SWEEP_BIN_WIDTHS_HZ[0]).toBe(1_250_000);
		expect(SWEEP_BIN_WIDTHS_HZ.at(-1)).toBeCloseTo(4882.8125);
		for (const hz of SWEEP_BIN_WIDTHS_HZ) expect(planSweep({ startMHz: 5300, stopMHz: 6000, binWidthHz: hz }).binWidthHz).toBe(hz);
	});

	it('normalizes a range to what the firmware sweeps, and rejects invalid ones', () => {
		expect(normalizedSweepRange({ startMHz: 5330.4, stopMHz: 6000, binWidthKHz: 1 })).toEqual({
			startMHz: 5330,
			stopMHz: 6010,
			binWidthKHz: 4.8828125,
		});
		expect(normalizedSweepRange({ startMHz: 5300, stopMHz: 6000, binWidthKHz: 78.125 })).toEqual({
			startMHz: 5300,
			stopMHz: 6000,
			binWidthKHz: 78.125,
		});
		expect(normalizedSweepRange({ startMHz: 6000, stopMHz: 5300, binWidthKHz: 78.125 })).toBeNull();
	});
});

describe('sweep block parsing', () => {
	it('reads the little-endian 64-bit frequency, takes the trailing samples and skips blocks without the marker', () => {
		const good = block(5_805_000_000, 256);
		const bad = block(5_000_000_000, 256);
		bad[0] = 0;
		const blocks = parseSweepBlocks(concat(bad, good), 256);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].frequencyHz).toBe(5_805_000_000);
		expect(blocks[0].iq.byteOffset - 0).toBe(SWEEP_BLOCK_BYTES + SWEEP_BLOCK_BYTES - 512);
		expect(blocks[0].iq).toHaveLength(512);
	});
	it('ignores a trailing partial block and honours the view offset', () => {
		const padded = new Uint8Array(100 + SWEEP_BLOCK_BYTES + 50);
		padded.set(block(1_000_000_000, 16), 100);
		const blocks = parseSweepBlocks(padded.subarray(100), 16);
		expect(blocks.map((b) => b.frequencyHz)).toEqual([1_000_000_000]);
	});
});

describe('sweep level measurement', () => {
	it('measures only block IQ, so headers never read as overload', () => {
		const transfer = new Uint8Array(SWEEP_BLOCK_BYTES * 2);
		transfer.set(block(5_300_000_000, 256), 0);
		transfer.set(block(5_320_000_000, 256), SWEEP_BLOCK_BYTES);
		const samples = sweepBlockSamples(transfer);
		expect(samples.map((iq) => iq.length)).toEqual([SWEEP_BLOCK_BYTES - 16, SWEEP_BLOCK_BYTES - 16]);
		const level = new HackRFRxLevel();
		level.reset(1);
		for (let pass = 0; pass < 8; pass++) for (const iq of samples) level.observe(iq, 1);
		level.observe(samples[0], 300);
		expect(level.level.clippedFraction).toBe(0);
		expect(level.level.peakDbfs).toBeLessThan(-1);
	});
});

describe('sweep stitching', () => {
	const plan = planSweep({ startMHz: 100, stopMHz: 140, binWidthHz: 20e6 / 256 });
	const run = (blocks) => {
		const sweeps = [];
		const assembler = new SweepAssembler(plan, new FFT(plan.fftSize, sweepWindow(plan.fftSize)), (line) => sweeps.push(line.slice()));
		assembler.push(concat(...blocks));
		return { sweeps, assembler };
	};
	const peakFrequencyMHz = (line) => plan.startMHz + (line.indexOf(Math.max(...line)) * plan.binWidthHz) / 1e6;
	// One 40 MHz sweep: two 20 MHz steps, each visited at f and f + 5 MHz (interleaved), then the wrap to the start.
	const sweepOf = (toneAt) => {
		const out = [];
		for (const start of [100, 120]) {
			for (const f of [start, start + 5]) {
				const centerHz = f * 1e6 + 7.5e6;
				out.push(block(f * 1e6, plan.fftSize, toneAt !== null && Math.abs(toneAt - centerHz) < 7.5e6 ? toneAt - centerHz : null));
			}
		}
		return out;
	};

	it('places a tone at its true frequency and emits one line per completed sweep', () => {
		const { sweeps, assembler } = run([...sweepOf(null), ...sweepOf(106.25e6), block(100e6, plan.fftSize)]);
		expect(sweeps).toHaveLength(2);
		expect(assembler.sweepCount).toBe(2);
		expect(sweeps[1]).toHaveLength(plan.binCount);
		expect(peakFrequencyMHz(sweeps[1])).toBeCloseTo(106.25, 1);
	});
	it('covers the whole range without gaps across the interleaved 5 MHz segments', () => {
		const { sweeps } = run([...sweepOf(null), block(100e6, plan.fftSize)]);
		// -200 is the fill for bins no block has written yet.
		expect(sweeps[0].includes(-200)).toBe(false);
	});
	it('places tones in the upper and lower usable quarters of a step', () => {
		for (const toneMHz of [101, 104, 111, 114, 121, 139]) {
			const { sweeps } = run([...sweepOf(toneMHz * 1e6), block(100e6, plan.fftSize)]);
			expect(peakFrequencyMHz(sweeps[0])).toBeCloseTo(toneMHz, 1);
		}
	});
	it('ignores data before the first sweep start and out-of-range headers', () => {
		const { sweeps } = run([
			block(120e6, plan.fftSize),
			block(5_000e6, plan.fftSize),
			...sweepOf(null),
			block(140e6, plan.fftSize),
			block(100e6, plan.fftSize),
		]);
		expect(sweeps).toHaveLength(1);
	});
});

describe('HackRF sweep start-up', () => {
	it('programs the firmware sweep and enters RX_SWEEP, never transmit', async () => {
		const device = new HackRFDevice();
		const calls = [];
		const record = (name) =>
			vi.fn(async (...args) => {
				calls.push([name, ...args]);
			});
		device.hackrf.usbApiRequired = record('usbApiRequired');
		device.hackrf.setSampleRateManual = record('setSampleRateManual');
		device.hackrf.setBasebandFilterBandwidth = record('setBasebandFilterBandwidth');
		device.hackrf.initSweep = record('initSweep');
		device.hackrf.setTransceiverMode = record('setTransceiverMode');
		device.hackrf.startRxSweep = vi.fn(async (callback) => {
			calls.push(['startRxSweep']);
			callback(new Uint8Array(SWEEP_BLOCK_BYTES));
		});
		device.hackrf.stopRx = record('stopRx');
		await device.startSweep({ startMHz: 5300, stopMHz: 6020 }, () => {});
		expect(calls).toEqual([
			['usbApiRequired', 0x0104],
			['setSampleRateManual', 20_000_000, 1],
			['setBasebandFilterBandwidth', 15_000_000],
			['initSweep', [5300, 6020], 16384, 20_000_000, 7_500_000, HackRF.SWEEP_STYLE_INTERLEAVED],
			['startRxSweep'],
		]);
		expect(device.hackrf.setTransceiverMode).not.toHaveBeenCalled();
	});
	it('encodes init_sweep like libhackrf and requests RX_SWEEP mode 5', async () => {
		const hackrf = new HackRF();
		const transfers = [];
		hackrf.device = {
			controlTransferOut: vi.fn(async (setup, data) => {
				transfers.push({ setup, data: data && [...new Uint8Array(data)] });
				return { status: 'ok' };
			}),
		};
		await hackrf.initSweep([5300, 6020], 16384, 20_000_000, 7_500_000, HackRF.SWEEP_STYLE_INTERLEAVED);
		await hackrf.setTransceiverMode(HackRF.TRANSCEIVER_MODE_RX_SWEEP);
		expect(transfers[0].setup).toMatchObject({ requestType: 'vendor', request: 26, value: 16384, index: 0 });
		expect(transfers[0].data).toEqual([0x00, 0x2d, 0x31, 0x01, 0xe0, 0x70, 0x72, 0x00, 1, 0xb4, 0x14, 0x84, 0x17]);
		expect(transfers[1].setup).toMatchObject({ request: 1, value: 5 });
	});
	it('explains the firmware requirement when sweep is unsupported', async () => {
		const device = new HackRFDevice();
		device.hackrf.usbApiRequired = vi.fn().mockRejectedValue(new Error('USB API version 104 required, but 102 found'));
		await expect(device.startSweep({ startMHz: 100, stopMHz: 120 }, () => {})).rejects.toThrow('USB API 1.04');
	});
});
