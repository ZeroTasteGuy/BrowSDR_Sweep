import * as Comlink from 'comlink';
import { FFT } from '@/worker/runtime/wasm-init';
import type { Backend } from '@/worker/runtime/backend';
import type { SamplesCallback } from '@/worker/runtime/callbacks.types';
import { planSweep, SweepAssembler, sweepWindow } from '@/devices/hackrf/sweep';
import type { SweepPlan } from '@/devices/hackrf/types';
import type { SweepStreamOpts } from './types';
import { configureReceiveGains } from './usb-diagnostic';

/**
 * Firmware sweep: the HackRF retunes itself; each USB block is FFT'd with the existing WASM FFT
 * and stitched into one line covering the whole range, emitted once per completed sweep.
 */
export async function startSweepStream(
	backend: Backend,
	opts: SweepStreamOpts,
	spectrumCallback: SamplesCallback,
	rateCallback: (sweepsPerSecond: number) => void,
): Promise<SweepPlan> {
	const { device } = backend;
	if (!device) throw new Error('No device connected');
	if (!device.startSweep) throw new Error('This device does not support sweep mode');
	const plan = planSweep(opts);
	const generation = ++backend._streamGeneration;

	backend._disposeSpectrum?.();
	const fft = new FFT(plan.fftSize, sweepWindow(plan.fftSize));
	backend._disposeSpectrum = () => fft.free();

	let lastEmit = 0;
	let rateStart = performance.now();
	let rateSweeps = 0;
	const assembler = new SweepAssembler(plan, fft, (line) => {
		const now = performance.now();
		rateSweeps++;
		if (now - rateStart >= 1000) {
			rateCallback((rateSweeps * 1000) / (now - rateStart));
			rateStart = now;
			rateSweeps = 0;
		}
		if (now - lastEmit < 1000 / backend._spectrumFps) return;
		lastEmit = now;
		const copy = line.slice();
		spectrumCallback(Comlink.transfer(copy, [copy.buffer]));
	});

	await configureReceiveGains(device, opts.gains);
	await device.startSweep(plan, (data) => {
		if (backend._streamGeneration === generation) assembler.push(data);
	});
	return plan;
}
