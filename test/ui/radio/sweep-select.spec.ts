import { describe, expect, it, vi } from 'vitest';
import { mountCanvas } from '@/app/display/canvas';
import { sweepMethods } from '@/app/radio/sweep';
import type { AppInstance } from '@/app/core/receiver.types';

function mountSweepCanvas(view = { zoomScale: 1, zoomOffset: 0, locked: false }) {
	const refs = {
		fft: document.createElement('canvas'),
		waterfall: document.createElement('canvas'),
		hoverTick: document.createElement('div'),
		sweepSelection: document.createElement('div'),
	};
	refs.sweepSelection.hidden = true;
	refs.sweepSelection.append(document.createElement('span'));
	vi.spyOn(refs.fft, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 1000 } as DOMRect);
	vi.spyOn(refs.waterfall, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 1000 } as DOMRect);
	const app = {
		$refs: refs,
		workspace: {},
		view,
		minFreq: 5600,
		maxFreq: 6000,
		running: true,
		showVfos: true,
		sweep: {
			active: true,
			startMHz: 5600,
			stopMHz: 6000,
			plan: { startMHz: 5600, stopMHz: 6000 },
			zoomHistory: [] as Array<{ zoomScale: number; zoomOffset: number }>,
		},
		activeVfoIndex: 0,
		vfos: [{ freq: 5800 }],
		updateBackendVfoParams: vi.fn(),
		validateAndApplyVfoFreq: vi.fn(),
		applyZoomToEngine: vi.fn(),
		_sweepSelection: undefined as { fromMHz: number; toMHz: number } | undefined,
		_canvasCleanup: () => {},
		zoomToSweepRange(fromMHz: number, toMHz: number) {
			sweepMethods.zoomToSweepRange.call(this as unknown as AppInstance, fromMHz, toMHz);
		},
	};
	mountCanvas.call(app as unknown as AppInstance);
	return { app, canvas: refs.fft, waterfall: refs.waterfall, overlay: refs.sweepSelection };
}

const touchEvent = (type: string, points: Array<{ clientX: number; clientY: number }>, changed = points) =>
	Object.assign(new Event(type, { cancelable: true }), { touches: points, changedTouches: changed });

describe('sweep drag-to-select', () => {
	it('zooms to the dragged range with the mouse without changing the sweep, and Previous zoom goes back', () => {
		const { app, canvas } = mountSweepCanvas();
		try {
			canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 600 }));
			canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 250 }));
			expect(app._sweepSelection).toEqual({ fromMHz: 5840, toMHz: 5700 });
			canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 250 }));
			expect(app._sweepSelection).toBeUndefined();
			expect(app.sweep).toMatchObject({ startMHz: 5600, stopMHz: 6000 });
			expect(app.view.zoomScale).toBeCloseTo(400 / 140);
			expect(app.view.zoomOffset).toBeCloseTo(0.25);
			expect(app.applyZoomToEngine).toHaveBeenCalled();
			expect(app.vfos[0].freq).toBe(5800);
			expect(app.validateAndApplyVfoFreq).not.toHaveBeenCalled();
			sweepMethods.previousSweepZoom.call(app as unknown as AppInstance);
			expect(app.view).toMatchObject({ zoomScale: 1, zoomOffset: 0 });
			expect(app.sweep.zoomHistory).toEqual([]);
		} finally {
			app._canvasCleanup();
		}
	});

	it('zooms from a drag on the waterfall and shades the range over both views with a readable label', () => {
		const { app, waterfall, overlay } = mountSweepCanvas();
		try {
			waterfall.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 500 }));
			waterfall.dispatchEvent(new MouseEvent('mousemove', { clientX: 510 }));
			expect(overlay.hidden).toBe(false);
			expect(overlay.style.left).toBe('50%');
			expect(overlay.style.width).toBe('1%');
			expect(overlay.textContent).toBe('5800.0 \u2013 5804.0 MHz\n4.0 MHz wide');
			waterfall.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 510 }));
			expect(overlay.hidden).toBe(true);
			expect(app.view.zoomScale).toBeCloseTo(100);
			expect(app.sweep).toMatchObject({ startMHz: 5600, stopMHz: 6000 });
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
			expect(app.sweep).toMatchObject({ startMHz: 5600, stopMHz: 6000, zoomHistory: [] });
		} finally {
			app._canvasCleanup();
		}
	});

	it('selects with a sideways finger drag on the unzoomed spectrum', () => {
		const { app, canvas } = mountSweepCanvas();
		try {
			canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 100, clientY: 50 }]));
			const move = touchEvent('touchmove', [{ clientX: 500, clientY: 55 }]);
			canvas.dispatchEvent(move);
			expect(move.defaultPrevented).toBe(true);
			canvas.dispatchEvent(touchEvent('touchend', [], [{ clientX: 500, clientY: 55 }]));
			expect(app.sweep).toMatchObject({ startMHz: 5600, stopMHz: 6000 });
			expect(app.view.zoomScale).toBeCloseTo(2.5);
			expect(app.view.zoomOffset).toBeCloseTo(0.1);
			expect(app.validateAndApplyVfoFreq).not.toHaveBeenCalled();
		} finally {
			app._canvasCleanup();
		}
	});

	it('caps the zoom like the mouse wheel and keeps it inside the swept range', () => {
		const sweep = { plan: { startMHz: 5600, stopMHz: 6000 }, zoomHistory: [] as Array<{ zoomScale: number; zoomOffset: number }> };
		const view = { zoomScale: 1, zoomOffset: 0 };
		const app = { sweep, view, applyZoomToEngine: vi.fn() } as unknown as AppInstance;
		sweepMethods.zoomToSweepRange.call(app, 5999.9, 6000);
		expect(view.zoomScale).toBe(100);
		expect(view.zoomOffset).toBeCloseTo(0.99);
		sweepMethods.zoomToSweepRange.call(app, 5800, 5900);
		expect(view).toMatchObject({ zoomScale: 4, zoomOffset: 0.5 });
		expect(sweep.zoomHistory).toHaveLength(2);
	});
});
