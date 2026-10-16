import { describe, expect, it, vi } from 'vitest';
import { mountCanvas } from '@/app/display/canvas';
import { sweepMethods } from '@/app/radio/sweep';
import type { AppInstance } from '@/app/core/receiver.types';

function mountSweepCanvas(view = { zoomScale: 1, zoomOffset: 0, locked: false }) {
	const refs = {
		fft: document.createElement('canvas'),
		waterfall: document.createElement('canvas'),
		hoverTick: document.createElement('div'),
	};
	vi.spyOn(refs.fft, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 1000 } as DOMRect);
	const app = {
		$refs: refs,
		workspace: {},
		view,
		minFreq: 5600,
		maxFreq: 6000,
		running: true,
		showVfos: true,
		sweep: { active: true, startMHz: 5600, stopMHz: 6000, rangeHistory: [] as Array<{ startMHz: number; stopMHz: number }> },
		activeVfoIndex: 0,
		vfos: [{ freq: 5800 }],
		updateBackendVfoParams: vi.fn(),
		validateAndApplyVfoFreq: vi.fn(),
		applyZoomToEngine: vi.fn(),
		_sweepSelection: undefined as { fromMHz: number; toMHz: number } | undefined,
		_canvasCleanup: () => {},
		selectSweepRange(fromMHz: number, toMHz: number) {
			sweepMethods.selectSweepRange.call(this as unknown as AppInstance, fromMHz, toMHz);
		},
	};
	mountCanvas.call(app as unknown as AppInstance);
	return { app, canvas: refs.fft };
}

const touchEvent = (type: string, points: Array<{ clientX: number; clientY: number }>, changed = points) =>
	Object.assign(new Event(type, { cancelable: true }), { touches: points, changedTouches: changed });

describe('sweep drag-to-select', () => {
	it('sweeps the dragged range with the mouse, and Previous range goes back', () => {
		const { app, canvas } = mountSweepCanvas();
		try {
			canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 600 }));
			canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 250 }));
			expect(app._sweepSelection).toEqual({ fromMHz: 5840, toMHz: 5700 });
			canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 250 }));
			expect(app._sweepSelection).toBeUndefined();
			expect(app.sweep).toMatchObject({ startMHz: 5700, stopMHz: 5840 });
			expect(app.vfos[0].freq).toBe(5800);
			expect(app.validateAndApplyVfoFreq).not.toHaveBeenCalled();
			sweepMethods.previousSweepRange.call(app as unknown as AppInstance);
			expect(app.sweep).toMatchObject({ startMHz: 5600, stopMHz: 6000, rangeHistory: [] });
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
			expect(app.sweep).toMatchObject({ startMHz: 5600, stopMHz: 6000, rangeHistory: [] });
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
			expect(app.sweep).toMatchObject({ startMHz: 5640, stopMHz: 5800 });
			expect(app.validateAndApplyVfoFreq).not.toHaveBeenCalled();
		} finally {
			app._canvasCleanup();
		}
	});

	it('rounds to whole MHz and keeps the range within what the HackRF can sweep', () => {
		const sweep = { startMHz: 5600, stopMHz: 6000, rangeHistory: [] as Array<{ startMHz: number; stopMHz: number }> };
		const app = { sweep } as unknown as AppInstance;
		sweepMethods.selectSweepRange.call(app, 5712.6, 5650.2);
		expect(sweep).toMatchObject({ startMHz: 5650, stopMHz: 5713 });
		sweepMethods.selectSweepRange.call(app, 7200, 7400);
		expect(sweep).toMatchObject({ startMHz: 7200, stopMHz: 7250 });
		expect(sweep.rangeHistory).toHaveLength(2);
	});
});
