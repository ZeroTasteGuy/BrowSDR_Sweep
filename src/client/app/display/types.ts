export interface ViewState {
	autoLockDisabled: boolean;
	zoomScale: number;
	zoomOffset: number;
	locked: boolean;
}

export interface DisplayState {
	spectrumFps: number;
	sharedChannelization: boolean;
	waterfallSmoothing: number;
	smoothingAxes: SmoothingAxes;
	spectrumSplit: number;
	minDB: number;
	maxDB: number;
}

/** Drag-to-select in sweep mode; each handler returns true when it consumed the event. */
export interface SweepSelection {
	mouseDown(e: MouseEvent): boolean;
	mouseMove(e: MouseEvent): boolean;
	mouseUp(e: MouseEvent): boolean;
	cancel(): void;
	touchMove(e: TouchEvent, touchStartX: number, touchStartY: number): boolean;
	touchEnd(e: TouchEvent): boolean;
}

/** Which way waterfall smoothing averages: over time (vertical), across frequency (horizontal), or both. */
export type SmoothingAxes = 'time' | 'both' | 'frequency';
