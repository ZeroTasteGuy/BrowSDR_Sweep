import { describe, expect, it, vi } from 'vitest';
import { mountCanvas } from '@/app/display/canvas';
import { sweepMethods } from '@/app/radio/sweep';
import type { AppInstance } from '@/app/core/receiver.types';

const PLAN = { startMHz: 5600, stopMHz: 6000, fftSize: 256, binWidthHz: 78125, binCount: 5120 };

function mountSweepCanvas() {
	const refs = {
		fft: document.createElement('canvas'),
		waterfall: document.createElement('canvas'),
		hoverTick: document.createElement('div'),
	};
	vi.spyOn(refs.fft, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 1000 } as DOMRect);
	const app = {
		$refs: refs,
		workspace: {},
		view: { zoomScale: 1, zoomOffset: 0, locked: false },
		minFreq: 5600,
		maxFreq: 6000,
		running: true,
		showVfos: true,
		sweep: { active: true, startMHz: 5600, stopMHz: 6000, plan: PLAN },
		activeVfoIndex: 0,
		vfos: [{ freq: 5800 }],
		updateBackendVfoParams: vi.fn(),
		validateAndApplyVfoFreq: vi.fn(),
		applyZoomToEngine: vi.fn(),
		_sweepSelection: undefined as { fromMHz: number; toMHz: number } | undefined,
		_canvasCleanup: () => {},
		zoomToSweepSelection(fromMHz: number, toMHz: number) {
			sweepMethods.zoomToSweepSelection.call(this as unknown as AppInstance, fromMHz, toMHz);
		},
	};
	mountCanvas.call(app as unknown as AppInstance);
	return { app, canvas: refs.fft };
}

const touchEvent = (type: string, points: Array<{ clientX: number; clientY: number }>, changed = points) =>
	Object.assign(new Event(type, { cancelable: true }), { touches: points, changedTouches: changed });

describe('sweep drag-to-zoom', () => {
	it('zooms into the dragged part with the mouse without changing the swept range, and Zoom out shows it all again', () => {
		const { app, canvas } = mountSweepCanvas();
		try {
			canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 600 }));
			canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 250 }));
			expect(app._sweepSelection).toEqual({ fromMHz: 5840, toMHz: 5700 });
			canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 250 }));
			expect(app._sweepSelection).toBeUndefined();
			expect(app.view.zoomScale).toBeCloseTo(400 / 140);
			expect(app.view.zoomOffset).toBeCloseTo(0.25);
			expect(app.applyZoomToEngine).toHaveBeenCalled();
			expect(app.sweep).toMatchObject({ startMHz: 5600, stopMHz: 6000 });
			expect(app.validateAndApplyVfoFreq).not.toHaveBeenCalled();
			sweepMethods.resetSweepZoom.call(app as unknown as AppInstance);
			expect(app.view).toMatchObject({ zoomScale: 1, zoomOffset: 0 });
		} finally {
			app._canvasCleanup();
		}
	});

	it('ignores a click, a cancelled drag and a locked display', () => {
		const { app, canvas } = mountSweepCanvas();
		try {
			canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 600 }));
			canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 603 }));
			canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100 }));
			canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
			canvas.dispatchEvent(new MouseEvent('mouseleave'));
			canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 400 }));
			app.view.locked = true;
			canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100 }));
			canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 400 }));
			expect(app._sweepSelection).toBeUndefined();
			expect(app.view).toMatchObject({ zoomScale: 1, zoomOffset: 0 });
		} finally {
			app._canvasCleanup();
		}
	});

	it('zooms with a sideways finger drag on the unzoomed spectrum', () => {
		const { app, canvas } = mountSweepCanvas();
		try {
			canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 100, clientY: 50 }]));
			const move = touchEvent('touchmove', [{ clientX: 500, clientY: 55 }]);
			canvas.dispatchEvent(move);
			expect(move.defaultPrevented).toBe(true);
			canvas.dispatchEvent(touchEvent('touchend', [], [{ clientX: 500, clientY: 55 }]));
			expect(app.view.zoomScale).toBeCloseTo(2.5);
			expect(app.view.zoomOffset).toBeCloseTo(0.1);
			expect(app.sweep).toMatchObject({ startMHz: 5600, stopMHz: 6000 });
		} finally {
			app._canvasCleanup();
		}
	});

	it('keeps the zoom inside the swept range and within the usual zoom limit', () => {
		const view = { zoomScale: 1, zoomOffset: 0 };
		const app = { view, sweep: { plan: PLAN }, applyZoomToEngine: vi.fn() } as unknown as AppInstance;
		sweepMethods.zoomToSweepSelection.call(app, 5900, 6200);
		expect(view.zoomScale).toBeCloseTo(4);
		expect(view.zoomOffset).toBeCloseTo(0.75);
		sweepMethods.zoomToSweepSelection.call(app, 5800, 5800.5);
		expect(view.zoomScale).toBe(100);
		expect(view.zoomOffset).toBeCloseTo(0.5);
	});
});
