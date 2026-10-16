import { describe, expect, it, vi } from 'vitest';
import { mountCanvas, smoothingAmounts, smoothWaterfallRow } from '@/app/display/canvas';
import type { AppInstance } from '@/app/core/receiver.types';

describe('canvas mouse panning', () => {
	it.each(['fft', 'waterfall'] as const)('pans %s with the middle or right button without tuning', (surface) => {
		const refs = {
			fft: document.createElement('canvas'),
			waterfall: document.createElement('canvas'),
			hoverTick: document.createElement('div'),
		};
		const canvas = refs[surface];
		vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 1000 } as DOMRect);
		const app = {
			$refs: refs,
			workspace: {},
			view: { zoomScale: 2, zoomOffset: 0.25, locked: false },
			minFreq: 100,
			maxFreq: 110,
			activeVfoIndex: 0,
			vfos: [{ freq: 105 }],
			updateBackendVfoParams: vi.fn(),
			validateAndApplyVfoFreq: vi.fn(),
			applyZoomToEngine: vi.fn(),
			_canvasCleanup: () => {},
		};
		mountCanvas.call(app as unknown as AppInstance);
		try {
			for (const button of [1, 2]) {
				app.view.zoomOffset = 0.25;
				const down = new MouseEvent('mousedown', { button, clientX: 500, cancelable: true });
				canvas.dispatchEvent(down);
				expect(down.defaultPrevented).toBe(true);
				canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
				expect(app.view.zoomOffset).toBeCloseTo(0.2);
				canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: -1000 }));
				expect(app.view.zoomOffset).toBe(0.5);
				canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000 }));
				expect(app.view.zoomOffset).toBe(0);
				canvas.dispatchEvent(new MouseEvent('mouseup', { button }));
				canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }));
				expect(app.view.zoomOffset).toBe(0);
			}
			expect(app.vfos[0].freq).toBe(105);
			expect(app.updateBackendVfoParams).not.toHaveBeenCalled();
			expect(app.validateAndApplyVfoFreq).not.toHaveBeenCalled();
			expect(app.applyZoomToEngine).toHaveBeenCalledTimes(7);
		} finally {
			app._canvasCleanup();
		}
	});
});

describe('waterfall smoothing', () => {
	it('passes rows through when off and averages them over time when on', () => {
		const app = { display: { waterfallSmoothing: 0, smoothingAxes: 'time' } } as unknown as AppInstance;
		const row = new Float32Array([-100, -50]);
		expect(smoothWaterfallRow(app, row)).toBe(row);
		app.display.waterfallSmoothing = 0.5;
		expect(Array.from(smoothWaterfallRow(app, new Float32Array([-100, -100])))).toEqual([-100, -100]);
		expect(Array.from(smoothWaterfallRow(app, new Float32Array([-60, -100])))).toEqual([-80, -100]);
		// A new bin count, as after a sample-rate change, starts over.
		expect(Array.from(smoothWaterfallRow(app, new Float32Array([-70])))).toEqual([-70]);
		app.display.waterfallSmoothing = 0;
		smoothWaterfallRow(app, row);
		expect(app._waterfallSmoothed).toBeUndefined();
	});
});

describe('waterfall smoothing direction', () => {
	it('splits the Smooth amount into time and frequency by the chosen direction', () => {
		const app = { display: { waterfallSmoothing: 0.6, smoothingAxes: 'time' } } as unknown as AppInstance;
		expect(smoothingAmounts(app)).toEqual({ time: 0.6, frequency: 0 });
		app.display.smoothingAxes = 'both';
		expect(smoothingAmounts(app)).toEqual({ time: 0.6, frequency: 0.6 });
		app.display.smoothingAxes = 'frequency';
		expect(smoothingAmounts(app)).toEqual({ time: 0, frequency: 0.6 });
	});

	it('averages neighbouring bins in frequency mode without keeping history', () => {
		const app = { display: { waterfallSmoothing: 0.5, smoothingAxes: 'frequency' } } as unknown as AppInstance;
		const out = smoothWaterfallRow(app, new Float32Array([-100, -100, -40, -100, -100]));
		expect(out[2]).toBeGreaterThan(-100);
		expect(out[2]).toBeLessThan(-40);
		expect(out[1]).toBeGreaterThan(-100);
		expect(out[1]).toBeLessThan(out[2]);
		expect(app._waterfallSmoothed).toBeUndefined();
	});
});
