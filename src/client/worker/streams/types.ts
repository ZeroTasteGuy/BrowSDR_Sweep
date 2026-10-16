import type { VfoParams } from '@/worker/runtime/types';
import type { SweepRequest } from '@/devices/hackrf/types';
import type { DcOffsetRemover } from '@/radio/offset-tuning';

export interface SharedBand {
	centerBin: number;
	centerFreq: number;
	vfos: number[];
}

export interface ChannelPlan {
	ratio: number;
	sampleRate: number;
	bands: SharedBand[];
	direct: number[];
}

export interface ChannelState {
	worker?: Worker;
	plan?: ChannelPlan;
	targets: Array<{ worker: Worker; params: VfoParams; shared: boolean }>;
	pending: number;
	key: string;
	perf: { calls: number; sum: number; max: number };
}

export interface SweepStreamOpts extends SweepRequest {
	gains?: Record<string, number>;
}

/** Offset tuning applied to spectrum frames: bins to shift back, DC removal and spike patching. */
export interface SpectrumOffset {
	bins: number;
	dc: DcOffsetRemover | null;
	/** Most bins either side of the DC bin to patch over. */
	spikeHalfWidth: number;
}
