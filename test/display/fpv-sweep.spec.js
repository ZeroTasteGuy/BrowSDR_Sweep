import { describe, expect, it } from 'vitest';
import { averageSweep, findPeaks, FPV_BANDS, noiseFloor, SWEEP_PRESETS } from '@/display/fpv';
import { planSweep } from '@/devices/hackrf/sweep';
import { drawSweepOverlays, maxHold } from '@/app/display/sweep-overlay';
import { sweepMethods } from '@/app/radio/sweep';

/** A flat -90 dB line over startMHz.. with 100 kHz bins and tones of the given level at the given frequencies. */
function line(startMHz, spanMHz, tones = []) {
	const axis = { startMHz, binWidthHz: 100_000 };
	const data = new Float32Array(spanMHz * 10).fill(-90);
	for (const [freqMHz, db] of tones) data[Math.round((freqMHz - startMHz) * 10)] = db;
	return { axis, data };
}

describe('sweep presets and FPV channels', () => {
	it('uses ranges that sweep exactly as entered', () => {
		for (const preset of SWEEP_PRESETS) {
			const plan = planSweep({ startMHz: preset.startMHz, stopMHz: preset.stopMHz, binWidthHz: 78_125 });
			expect([plan.startMHz, plan.stopMHz]).toEqual([preset.startMHz, preset.stopMHz]);
		}
	});

	it('has eight channels per band, all inside the 5.8 GHz FPV preset', () => {
		const fpv = SWEEP_PRESETS.find((preset) => preset.id === 'fpv-5g8');
		for (const band of FPV_BANDS) {
			expect(band.channels).toHaveLength(8);
			for (const channel of band.channels) expect(channel > fpv.startMHz && channel < fpv.stopMHz).toBe(true);
		}
		expect(FPV_BANDS.find((band) => band.id === 'R').channels[0]).toBe(5658);
		expect(FPV_BANDS.find((band) => band.id === 'F').channels[3]).toBe(5800);
	});
});

describe('sweep peaks', () => {
	it('takes the median as the noise floor', () => {
		expect(noiseFloor(line(5640, 320, [[5800, -20]]).data)).toBe(-90);
	});

	it('finds the strongest separated peaks above the floor, strongest first', () => {
		const { axis, data } = line(5640, 320, [
			[5800, -30],
			[5800.3, -25],
			[5732, -40],
			[5900, -85],
		]);
		const peaks = findPeaks(data, axis, 5, 8);
		expect(peaks.map((peak) => Math.round(peak.freqMHz * 10) / 10)).toEqual([5800.3, 5732]);
		expect(peaks[0].db).toBe(-25);
	});

	it('limits the number of peaks', () => {
		const { axis, data } = line(5640, 320, [
			[5660, -30],
			[5700, -31],
			[5740, -32],
		]);
		expect(findPeaks(data, axis, 2, 8)).toHaveLength(2);
	});

	it('averages sweeps in linear power', () => {
		const first = averageSweep(undefined, new Float32Array([-90, -90]));
		const next = averageSweep(first, new Float32Array([-90, -80]), 0.5);
		expect(next).toBe(first);
		expect(next[0]).toBeCloseTo(-90);
		expect(next[1]).toBeCloseTo(10 * Math.log10((1e-9 + 1e-8) / 2));
	});
});

describe('peak hold', () => {
	it('holds the maximum, and with fade falls back toward the live trace', () => {
		const held = maxHold(undefined, new Float32Array([-40, -90]));
		maxHold(held, new Float32Array([-90, -90]));
		expect([...held]).toEqual([-40, -90]);
		maxHold(held, new Float32Array([-90, -90]), 30);
		expect([...held]).toEqual([-70, -90]);
		maxHold(held, new Float32Array([-90, -90]), 30);
		expect([...held]).toEqual([-90, -90]);
	});
});

describe('sweep panel helpers', () => {
	const app = () => ({ sweep: { startMHz: 5300, stopMHz: 6000, channelBand: 'R' } });

	it('applies a preset and recognises the current range as one', () => {
		const receiver = app();
		expect(sweepMethods.sweepPresetId.call(receiver)).toBe('wide-5g8');
		sweepMethods.applySweepPreset.call(receiver, 'sub-ghz');
		expect(receiver.sweep).toMatchObject({ startMHz: 860, stopMHz: 940 });
		receiver.sweep.stopMHz = 960;
		expect(sweepMethods.sweepPresetId.call(receiver)).toBe('');
	});

	it('names the channel of the selected band a peak sits on', () => {
		const receiver = app();
		expect(sweepMethods.peakChannel.call(receiver, 5805.2)).toBe('R5');
		expect(sweepMethods.peakChannel.call(receiver, 5820)).toBe('');
		receiver.sweep.channelBand = '';
		expect(sweepMethods.peakChannel.call(receiver, 5806)).toBe('');
	});
});

describe('sweep overlay', () => {
	it('draws channel labels, peak hold and numbered peak markers inside the visible span', () => {
		const texts = [];
		const ctx = new Proxy(
			{ fillText: (text) => texts.push(text), canvas: { width: 1000 } },
			{ get: (target, key) => (key in target ? target[key] : () => {}), set: () => true },
		);
		const app = {
			minFreq: 5640,
			maxFreq: 5960,
			view: { zoomScale: 1, zoomOffset: 0 },
			sweep: { channelBand: 'R', peaks: [{ freqMHz: 5806, db: -40 }] },
			_sweepPeak: new Float32Array(3200).fill(-90),
		};
		drawSweepOverlays(app, ctx, 1000, 400, { minDB: -100, maxDB: -20 });
		expect(texts).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', '1']);
	});
});
