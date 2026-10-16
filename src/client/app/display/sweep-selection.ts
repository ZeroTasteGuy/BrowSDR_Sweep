import type { AppInstance } from '@/app/core/receiver.types';
import type { SweepSelection } from './types';

/** Narrower drags count as a click and leave the range alone. */
const MIN_SELECTION_PX = 6;
/** Sideways finger travel before a touch drag becomes a selection rather than a tap. */
const TOUCH_START_PX = 10;

/**
 * Drag across the spectrum in sweep mode to zoom the display in on that part; the sweep range stays as it is. The canvas mouse and touch handlers
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
		showSelection(app);
	};
	const move = (e: MouseEvent | TouchEvent, clientX: number) => {
		if (!app._sweepSelection) return;
		app._sweepSelection.toMHz = Math.max(app.minFreq, Math.min(app.maxFreq, freqAt(e, clientX)));
		showSelection(app);
	};
	const finish = (endX: number | null) => {
		const selection = app._sweepSelection;
		selecting = false;
		app._sweepSelection = undefined;
		showSelection(app);
		if (selection && endX !== null && Math.abs(endX - startX) >= MIN_SELECTION_PX) app.zoomToSweepRange(selection.fromMHz, selection.toMHz);
	};
	return {
		mouseDown(e: MouseEvent) {
			if (e.button !== 0 || app.view.locked || !app.sweep.active) return false;
			begin(e, e.clientX);
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

/** Shade the dragged range across the spectrum and waterfall, labelled with its edges and width. */
function showSelection(app: AppInstance) {
	const overlay = app.$refs.sweepSelection as HTMLElement | undefined;
	if (!overlay) return;
	const selection = app._sweepSelection;
	overlay.hidden = !selection;
	if (!selection) return;
	const startMHz = Math.min(selection.fromMHz, selection.toMHz);
	const stopMHz = Math.max(selection.fromMHz, selection.toMHz);
	const viewMHz = app.maxFreq - app.minFreq;
	overlay.style.left = `${((startMHz - app.minFreq) / viewMHz) * 100}%`;
	overlay.style.width = `${((stopMHz - startMHz) / viewMHz) * 100}%`;
	const spanMHz = stopMHz - startMHz;
	const decimals = spanMHz < 2 ? 2 : spanMHz < 20 ? 1 : 0;
	const label = overlay.firstElementChild as HTMLElement;
	label.textContent = `${startMHz.toFixed(decimals)} \u2013 ${stopMHz.toFixed(decimals)} MHz\n${spanMHz.toFixed(decimals)} MHz wide`;
}
