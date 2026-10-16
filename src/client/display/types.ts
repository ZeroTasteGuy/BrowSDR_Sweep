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
	/** Channel centre frequencies in MHz. */
	channels: number[];
	/** Channel names, when they aren't simply the band id and channel number (as in mixed sets like IMD6C). */
	labels?: string[];
}

export interface SweepAxis {
	startMHz: number;
	binWidthHz: number;
}

export interface SweepPeak {
	freqMHz: number;
	db: number;
}
