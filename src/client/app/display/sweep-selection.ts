import type { AppInstance } from '@/app/core/receiver.types';
import type { SweepSelection } from './types';

/** Narrower drags count as a click and leave the range alone. */
const MIN_SELECTION_PX = 6;
/** Sideways finger travel before a touch drag becomes a selection rather than a tap. */
const TOUCH_START_PX = 10;

/**
 * Drag across the spectrum in sweep mode to zoom into that part. The canvas mouse and touch handlers
 * hand events here first; each method returns true when it consumed the event.
 */
export function createSweepSelection(app: AppInstance): SweepSelection {
	let selecting = false;
	let startX = 0;
	const freqAt = (e: MouseEvent | TouchEvent, clientX: number) => {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		return app.minFreq + ((clientX - rect.left) / rect.width) * (app.maxFreq - app.minFreq);
	};
	const begin = (e: MouseEvent | TouchEvent, clientX: number) => {
		selecting = true;
		startX = clientX;
		const freqMHz = freqAt(e, clientX);
		app._sweepSelection = { fromMHz: freqMHz, toMHz: freqMHz };
	};
	const move = (e: MouseEvent | TouchEvent, clientX: number) => {
		if (!app._sweepSelection) return;
		app._sweepSelection.toMHz = Math.max(app.minFreq, Math.min(app.maxFreq, freqAt(e, clientX)));
		repaintSpectrum(app);
	};
	const finish = (endX: number | null) => {
		const selection = app._sweepSelection;
		selecting = false;
		app._sweepSelection = undefined;
		if (selection && endX !== null && Math.abs(endX - startX) >= MIN_SELECTION_PX)
			app.zoomToSweepSelection(selection.fromMHz, selection.toMHz);
		repaintSpectrum(app);
	};
	return {
		mouseDown(e: MouseEvent) {
			if (e.button !== 0 || app.view.locked || !app.sweep.active) return false;
			begin(e, e.clientX);
			repaintSpectrum(app);
			return true;
		},
		mouseMove(e: MouseEvent) {
			if (!selecting) return false;
			move(e, e.clientX);
			return true;
		},
		mouseUp(e: MouseEvent) {
			if (!selecting) return false;
			finish(e.clientX);
			return true;
		},
		cancel() {
			if (selecting) finish(null);
		},
		/** A sideways one-finger drag on the unzoomed spectrum selects; zoomed in, the finger pans as before. */
		touchMove(e: TouchEvent, touchStartX: number, touchStartY: number) {
			const touch = e.touches[0];
			if (e.touches.length !== 1 || !touch) return false;
			if (!selecting) {
				const dx = Math.abs(touch.clientX - touchStartX);
				const sideways = dx > TOUCH_START_PX && dx > Math.abs(touch.clientY - touchStartY);
				if (!sideways || !app.sweep.active || app.view.locked || app.view.zoomScale > 1.0) return false;
				begin(e, touchStartX);
			}
			e.preventDefault();
			move(e, touch.clientX);
			return true;
		},
		touchEnd(e: TouchEvent) {
			if (!selecting) return false;
			if (e.touches.length === 0) finish(e.changedTouches[0]?.clientX ?? null);
			return true;
		},
	};
}

/** Live frames redraw the selection anyway; while stopped, redraw the last frame so the drag still shows. */
function repaintSpectrum(app: AppInstance) {
	if (app.running || !app._lastSpectrumData || !app._fftCtx) return;
	app._zoomRepaint = true;
	app.drawSpectrum(app._lastSpectrumData);
	app._zoomRepaint = false;
}
