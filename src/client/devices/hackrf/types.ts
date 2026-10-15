export interface PartIdSerialNo {
	partId: [number, number];
	serialNo: [number, number, number, number];
}

export type RxCallback = (data: Uint8Array) => void;

export interface SweepRequest {
	startMHz: number;
	stopMHz: number;
	/** Requested bin width; the FFT size is the next power of two that is at least this fine. */
	binWidthHz: number;
}

export interface SweepPlan {
	/** Whole MHz; stopMHz is rounded up to a whole number of 20 MHz tuning steps from startMHz. */
	startMHz: number;
	stopMHz: number;
	fftSize: number;
	/** Actual bin width, SWEEP_SAMPLE_RATE_HZ / fftSize. */
	binWidthHz: number;
	binCount: number;
}

export interface SweepBlock {
	/** Lower edge of the first usable segment, in Hz (the firmware's block header). */
	frequencyHz: number;
	/** The block's trailing fftSize complex samples as interleaved int8 I/Q. */
	iq: Int8Array;
}

export interface SpectrumFft {
	/** DC-centred power spectrum in dB of fftSize int8 IQ pairs, as the WASM FFT class produces. */
	fft(input: Int8Array, result: Float32Array): void;
}
