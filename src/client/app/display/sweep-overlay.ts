import type { AppInstance } from '@/app/core/receiver.types';
import { averageSweep, channelLabel, findPeaks, FPV_BANDS } from '@/display/fpv';
import type { ContrastRange } from '@/display/contrast.types';

/** Peaks are recomputed at this rate; the overlay itself redraws every frame. */
const ANALYSIS_INTERVAL_MS = 500;
const PEAK_COUNT = 5;
const CHANNEL_COLOR = 'rgba(255, 170, 60, 0.75)';
const SELECTION_FILL = 'rgba(0, 255, 234, 0.15)';
const SELECTION_EDGE = 'rgba(0, 255, 234, 0.8)';

/** Per-frame sweep bookkeeping: max-hold, the cross-sweep average and, twice a second, the strongest peaks. */
export function trackSweepFrame(app: AppInstance, data: Float32Array) {
	const now = performance.now();
	const fadeDb = app._sweepFrameAt ? ((now - app._sweepFrameAt) / 1000) * app.sweep.peakFadeDbPerSecond : 0;
	app._sweepFrameAt = now;
	app._sweepPeak = app.sweep.peakHold ? maxHold(app._sweepPeak, data, fadeDb) : undefined;
	app._sweepAverage = averageSweep(app._sweepAverage, data);
	if (now - (app._sweepAnalysedAt ?? 0) < ANALYSIS_INTERVAL_MS || !app.sweep.plan) return;
	app._sweepAnalysedAt = now;
	const axis = app.sweep.plan;
	const spanMHz = axis.stopMHz - axis.startMHz;
	app.sweep.peaks = app.sweep.peakMarkers ? findPeaks(app._sweepAverage, axis, PEAK_COUNT, Math.max(spanMHz / 40, 0.05)) : [];
}

/** Forget accumulated traces, e.g. for a new range or when the user clears peak hold. */
export function resetSweepTraces(app: AppInstance) {
	app._sweepPeak = undefined;
	app._sweepAverage = undefined;
	app._sweepAnalysedAt = 0;
	app._sweepFrameAt = 0;
	app.sweep.peaks = [];
}

export function drawSweepOverlays(app: AppInstance, ctx: CanvasRenderingContext2D, w: number, h: number, range: ContrastRange) {
	const x = (freqMHz: number) => ((freqMHz - app.minFreq) / (app.maxFreq - app.minFreq)) * w;
	const y = (db: number) => h - (h * (Math.max(range.minDB, Math.min(range.maxDB, db)) - range.minDB)) / (range.maxDB - range.minDB);
	ctx.save();
	ctx.font = '10px Inter, sans-serif';
	drawChannels(app, ctx, x, w, h);
	if (app._sweepPeak) drawPeakHold(app, ctx, app._sweepPeak, w, y);
	drawPeakMarkers(app, ctx, x, y);
	if (app._sweepSelection) drawSelection(ctx, app._sweepSelection, x, h);
	ctx.restore();
}

/** The range being dragged out, shaded, with the span the display will zoom to on release. */
function drawSelection(
	ctx: CanvasRenderingContext2D,
	selection: { fromMHz: number; toMHz: number },
	x: (freqMHz: number) => number,
	h: number,
) {
	const startMHz = Math.min(selection.fromMHz, selection.toMHz);
	const stopMHz = Math.max(selection.fromMHz, selection.toMHz);
	const left = x(startMHz);
	const right = x(stopMHz);
	ctx.fillStyle = SELECTION_FILL;
	ctx.fillRect(left, 0, right - left, h);
	ctx.strokeStyle = SELECTION_EDGE;
	ctx.lineWidth = 1;
	ctx.strokeRect(left + 0.5, 0.5, Math.max(0, right - left - 1), h - 1);
	ctx.fillStyle = SELECTION_EDGE;
	ctx.textAlign = 'center';
	ctx.fillText(`${Math.floor(startMHz)}\u2013${Math.ceil(stopMHz)} MHz`, (left + right) / 2, 24);
	ctx.textAlign = 'left';
}

/** Channel centres as labelled dashed lines. */
function drawChannels(app: AppInstance, ctx: CanvasRenderingContext2D, x: (freqMHz: number) => number, w: number, h: number) {
	const band = FPV_BANDS.find((candidate) => candidate.id === app.sweep.channelBand);
	if (!band) return;
	ctx.setLineDash([3, 4]);
	band.channels.forEach((freqMHz, index) => {
		const px = x(freqMHz);
		if (px < 0 || px > w) return;
		ctx.strokeStyle = CHANNEL_COLOR;
		ctx.beginPath();
		ctx.moveTo(px, 14);
		ctx.lineTo(px, h);
		ctx.stroke();
		ctx.fillStyle = CHANNEL_COLOR;
		ctx.textAlign = 'center';
		ctx.fillText(channelLabel(band, index), px, 10);
	});
	ctx.setLineDash([]);
	ctx.textAlign = 'left';
}

function drawPeakHold(app: AppInstance, ctx: CanvasRenderingContext2D, peak: Float32Array, w: number, y: (db: number) => number) {
	const pointsToDraw = Math.floor(peak.length / app.view.zoomScale);
	const startIdx = Math.floor(peak.length * app.view.zoomOffset);
	const drawPoints = Math.min(w, pointsToDraw);
	const factor = pointsToDraw / drawPoints;
	ctx.beginPath();
	for (let i = 0; i < drawPoints; i++) {
		const start = startIdx + Math.floor(i * factor);
		const end = startIdx + Math.floor((i + 1) * factor);
		let valDB = -1000;
		for (let j = start; j < end && j < peak.length; j++) if (peak[j] > valDB) valDB = peak[j];
		if (i === 0) ctx.moveTo(0, y(valDB));
		else ctx.lineTo((i / drawPoints) * w, y(valDB));
	}
	ctx.strokeStyle = 'rgba(255, 235, 59, 0.9)';
	ctx.lineWidth = 1;
	ctx.stroke();
}

/** Numbered triangles above the strongest peaks of the averaged sweep. */
function drawPeakMarkers(app: AppInstance, ctx: CanvasRenderingContext2D, x: (freqMHz: number) => number, y: (db: number) => number) {
	ctx.fillStyle = '#00ffea';
	app.sweep.peaks.forEach((peak, index) => {
		const px = x(peak.freqMHz);
		const py = Math.max(28, y(peak.db) - 4);
		ctx.beginPath();
		ctx.moveTo(px, py);
		ctx.lineTo(px - 5, py - 8);
		ctx.lineTo(px + 5, py - 8);
		ctx.closePath();
		ctx.fill();
		ctx.fillText(String(index + 1), px + 6, py - 2);
	});
}

/** Max-hold that first lowers the held trace by `fadeDb`, so a fading hold drops back to the live level. */
export function maxHold(peak: Float32Array | undefined, data: Float32Array, fadeDb = 0): Float32Array {
	if (!peak || peak.length !== data.length) return data.slice();
	for (let i = 0; i < data.length; i++) peak[i] = Math.max(peak[i] - fadeDb, data[i]);
	return peak;
}
