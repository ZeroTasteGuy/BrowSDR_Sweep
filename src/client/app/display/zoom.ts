import type { AppInstance } from '@/app/core/receiver.types';

/** Centre a frequency using the same minimum zoom as the active-audio shortcuts. */
export function focusSpectrumFrequency(receiver: AppInstance, frequencyMHz: number): void {
	const position = ((frequencyMHz - receiver.radio.centerFreq) * 1e6) / receiver.radio.sampleRate + 0.5;
	if (!Number.isFinite(position) || position < 0 || position > 1) return;
	const zoom = Math.max(receiver.view.zoomScale, 32);
	receiver.view.zoomScale = zoom;
	receiver.view.zoomOffset = Math.max(0, Math.min(1 - 1 / zoom, position - 0.5 / zoom));
	receiver.applyZoomToEngine();
}

export const zoomMethods = {
	toggleDisplayLock(this: AppInstance) {
		this.view.locked = !this.view.locked;
		this.view.autoLockDisabled = !this.view.locked;
	},
	handleWheelZoom(this: AppInstance, e: WheelEvent, rect: DOMRect) {
		e.preventDefault();

		const zoomSensitivity = 0.1;
		const zoomDir = e.deltaY < 0 ? 1 : -1;
		const newScale = Math.max(1.0, Math.min(100.0, this.view.zoomScale * (1 + zoomDir * zoomSensitivity)));

		// Calculate where the mouse is relative to the current view
		const mouseX = e.clientX - rect.left;
		const p = mouseX / rect.width;

		// Calculate the absolute normalized coordinate of the mouse
		const absNormTarget = this.view.zoomOffset + p / this.view.zoomScale;

		// Calculate new offset to keep the absolute target under the mouse
		let newOffset = absNormTarget - p / newScale;

		// Clamp offset
		const maxOffset = 1.0 - 1.0 / newScale;
		if (newOffset < 0) newOffset = 0;
		if (newOffset > maxOffset) newOffset = maxOffset;

		this.view.zoomScale = newScale;
		this.view.zoomOffset = newOffset;

		this.applyZoomToEngine();
	},
	/** Drag the line between the spectrum and the waterfall. */
	startSplitDrag(this: AppInstance, e: PointerEvent) {
		const handle = e.currentTarget as HTMLElement;
		const area = handle.parentElement;
		if (!area) return;
		e.preventDefault();
		handle.setPointerCapture(e.pointerId);
		const move = (event: PointerEvent) => {
			const rect = area.getBoundingClientRect();
			const percent = ((event.clientY - rect.top) / rect.height) * 100;
			this.display.spectrumSplit = Math.round(Math.max(15, Math.min(85, percent)));
		};
		const end = () => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', end);
			handle.removeEventListener('pointercancel', end);
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	},
	applyZoomToEngine(this: AppInstance) {
		if (this._waterfallEngine) {
			this._waterfallEngine.setZoom(this.view.zoomOffset, this.view.zoomScale);
			// Force an immediate repaint so the new zoom is visible without waiting for the next data frame
			if (this._lastSpectrumData && this._fftCtx) {
				this._zoomRepaint = true;
				this.drawSpectrum(this._lastSpectrumData);
				this._zoomRepaint = false;
			}
		}
	},
};
