export interface RGB {
	r: number;
	g: number;
	b: number;
}

export interface WaterfallLevel {
	offset: number;
	bins: number;
	scale: number;
}

export interface SweepPreset {
	id: string;
	label: string;
	startMHz: number;
	stopMHz: number;
}

export interface FpvBand {
	id: string;
	name: string;
	/** Channel 1–8 centre frequencies in MHz. */
	channels: number[];
}

export interface SweepAxis {
	startMHz: number;
	binWidthHz: number;
}

export interface SweepPeak {
	freqMHz: number;
	db: number;
}
