/**
 * Offset tuning: the hardware tunes above the requested centre so its DC
 * spike falls away from the frequency being watched, and the spectrum is
 * shifted back so the display still centres on the requested frequency.
 * The DC offset itself is also removed from the spectrum frames.
 */

/** The tuning offset rounded to whole FFT bins, so the spectrum shift is exact. */
export function offsetTuningBins(offsetHz: number, sampleRate: number, fftSize: number): number {
	if (!offsetHz || !sampleRate || !fftSize) return 0;
	return Math.round((offsetHz * fftSize) / sampleRate);
}

export function offsetTuningHz(bins: number, sampleRate: number, fftSize: number): number {
	return fftSize ? (bins * sampleRate) / fftSize : 0;
}

/**
 * Shift a DC-centred spectrum captured `bins` above the display centre back
 * onto the display grid. Bins with no captured data get the frame's floor.
 */
export function shiftSpectrum(captured: Float32Array, out: Float32Array, bins: number): void {
	const n = captured.length;
	if (!bins) {
		out.set(captured);
		return;
	}
	let floor = Infinity;
	for (let i = 0; i < n; i++) if (captured[i] < floor) floor = captured[i];
	for (let i = 0; i < n; i++) {
		const source = i - bins;
		out[i] = source >= 0 && source < n ? captured[source] : floor;
	}
}

/**
 * Remove the DC offset (LO leakage) from a spectrum frame of signed 8-bit IQ, in place.
 *
 * The offset is the frame mean, smoothed across frames. Samples stay 8-bit:
 * the fractional part is carried from sample to sample (error feedback), so
 * the average is exact without adding rounding noise near the centre.
 */
export class DcOffsetRemover {
	private dcI = 0;
	private dcQ = 0;
	private errI = 0;
	private errQ = 0;
	private primed = false;

	constructor(private readonly smoothing = 0.1) {}

	get offset(): { i: number; q: number } {
		return { i: this.dcI, q: this.dcQ };
	}

	process(iq: Int8Array): void {
		const pairs = iq.length >> 1;
		if (!pairs) return;
		let sumI = 0;
		let sumQ = 0;
		for (let n = 0; n < pairs * 2; n += 2) {
			sumI += iq[n];
			sumQ += iq[n + 1];
		}
		const alpha = this.primed ? this.smoothing : 1;
		this.dcI += alpha * (sumI / pairs - this.dcI);
		this.dcQ += alpha * (sumQ / pairs - this.dcQ);
		this.primed = true;

		const { dcI, dcQ } = this;
		let { errI, errQ } = this;
		for (let n = 0; n < pairs * 2; n += 2) {
			const i = iq[n] - dcI + errI;
			const q = iq[n + 1] - dcQ + errQ;
			const ri = Math.min(127, Math.max(-128, Math.round(i)));
			const rq = Math.min(127, Math.max(-128, Math.round(q)));
			// A clamped sample leaves a large error; don't carry it into the next one.
			errI = ri === 127 || ri === -128 ? 0 : i - ri;
			errQ = rq === 127 || rq === -128 ? 0 : q - rq;
			iq[n] = ri;
			iq[n + 1] = rq;
		}
		this.errI = errI;
		this.errQ = errQ;
	}
}
