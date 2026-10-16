/** FPV band presets, the standard 5.8 GHz video channel tables, and peak finding on a sweep line. */

import type { FpvBand, SweepAxis, SweepPeak, SweepPreset } from './types';

/** Ranges are whole 20 MHz sweep steps, so they sweep exactly as entered. */
export const SWEEP_PRESETS: SweepPreset[] = [
	{ id: 'fpv-5g8', label: '5.8 GHz FPV (5640–5960)', startMHz: 5640, stopMHz: 5960 },
	{ id: 'wide-5g8', label: '5.8 GHz wide (5300–6000)', startMHz: 5300, stopMHz: 6000 },
	{ id: '2g4', label: '2.4 GHz (2400–2500)', startMHz: 2400, stopMHz: 2500 },
	{ id: 'sub-ghz', label: '868 / 915 MHz control (860–940)', startMHz: 860, stopMHz: 940 },
];

export const FPV_BANDS: FpvBand[] = [
	{ id: 'R', name: 'Raceband', channels: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] },
	{ id: 'F', name: 'Fatshark', channels: [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880] },
	{ id: 'A', name: 'Band A', channels: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725] },
	{ id: 'B', name: 'Band B', channels: [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866] },
	{ id: 'E', name: 'Band E', channels: [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945] },
];

const binMHz = (axis: SweepAxis) => axis.binWidthHz / 1e6;

/** Median level of the line, as an estimate of the noise floor. */
export function noiseFloor(line: Float32Array): number {
	const valid = line.filter((value) => value > -200).sort();
	return valid.length ? valid[Math.floor(valid.length / 2)] : -200;
}

/**
 * The strongest local maxima at least `minSeparationMHz` apart and `minAboveFloorDb` above the noise floor,
 * strongest first. Greedy: take the highest bin, blank its neighbourhood, repeat.
 */
export function findPeaks(line: Float32Array, axis: SweepAxis, count: number, minSeparationMHz: number, minAboveFloorDb = 10): SweepPeak[] {
	const threshold = noiseFloor(line) + minAboveFloorDb;
	const guard = Math.max(1, Math.round(minSeparationMHz / binMHz(axis)));
	const order = Array.from(line.keys()).sort((a, b) => line[b] - line[a]);
	const taken: number[] = [];
	const peaks: SweepPeak[] = [];
	for (const bin of order) {
		if (peaks.length >= count || line[bin] < threshold) break;
		if (taken.some((other) => Math.abs(other - bin) < guard)) continue;
		taken.push(bin);
		peaks.push({ freqMHz: axis.startMHz + bin * binMHz(axis), db: line[bin] });
	}
	return peaks;
}

/** Exponential average across sweeps in linear power, so the analysis isn't thrown by single-sweep noise. */
export function averageSweep(previous: Float32Array | undefined, line: Float32Array, weight = 0.3): Float32Array {
	if (!previous || previous.length !== line.length) return line.slice();
	for (let i = 0; i < line.length; i++) {
		const power = (1 - weight) * 10 ** (previous[i] / 10) + weight * 10 ** (line[i] / 10);
		previous[i] = 10 * Math.log10(power);
	}
	return previous;
}
