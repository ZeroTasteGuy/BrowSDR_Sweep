import { afterEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, nextTick } from 'vue';
import RxLevel from '@/app/radio/rx-level';
import ContrastControls from '@/app/display/contrast-controls';
import ViewSliders from '@/app/display/view-sliders';
import { DEFAULT_SPECTRUM_RANGE } from '@/display/spectrum-range';

afterEach(() => vi.useRealTimers());

it('keeps Top and Floor apart, sets centre-anchored zoom and waterfall smoothing from the side sliders', async () => {
	const applyZoomToEngine = vi.fn();
	const receiver = reactive({
		display: { minDB: -110, maxDB: -50, waterfallSmoothing: 0 },
		view: { zoomScale: 1, zoomOffset: 0 },
		applyZoomToEngine,
	});
	const wrapper = mount(ViewSliders, { global: { provide: { receiver } } });
	const [zoom, top, floor, smooth] = wrapper.findAll('input[type=range]');
	await floor.setValue(-80);
	expect(receiver.display).toMatchObject({ minDB: -80, maxDB: -50 });
	await top.setValue(-40);
	expect(receiver.display).toMatchObject({ minDB: -80, maxDB: -40 });
	await floor.setValue(-20);
	expect(receiver.display).toMatchObject({ minDB: -45, maxDB: -40 });
	await top.setValue(-90);
	expect(receiver.display).toMatchObject({ minDB: -45, maxDB: -40 });
	await smooth.setValue(60);
	expect(receiver.display.waterfallSmoothing).toBeCloseTo(0.6);
	await zoom.setValue(500);
	expect(receiver.view.zoomScale).toBeCloseTo(10);
	expect(receiver.view.zoomOffset + 0.5 / receiver.view.zoomScale).toBeCloseTo(0.5);
	expect(applyZoomToEngine).toHaveBeenCalled();
	wrapper.unmount();
});

it('polls raw levels, clears stale readings and stops polling on unmount', async () => {
	vi.useFakeTimers();
	const getRxLevel = vi
		.fn()
		.mockImplementation(() => Promise.resolve({ timestamp: Date.now(), peakDbfs: -6, rmsDbfs: -22, clippedFraction: 0.001 }));
	const receiver = reactive({
		running: true,
		radio: { sampleRate: 5e6 },
		remoteMode: 'none',
		deviceCapabilities: { deviceType: 'hackrf' },
		gains: {},
		backend: { getRxLevel },
	});
	const wrapper = mount(RxLevel, { global: { provide: { receiver } } });
	await vi.advanceTimersByTimeAsync(250);
	expect(wrapper.text()).toContain('Overload: reduce gain');
	expect(wrapper.get('.rx-level-fill').attributes('style')).toContain('width: 88%');
	getRxLevel.mockResolvedValue({ timestamp: Date.now() - 2000, peakDbfs: -6 });
	await vi.advanceTimersByTimeAsync(250);
	expect(wrapper.text()).toContain('waiting for samples');
	receiver.running = false;
	await nextTick();
	expect(wrapper.text()).toContain('reception stopped');
	wrapper.unmount();
	const count = getRxLevel.mock.calls.length;
	await vi.advanceTimersByTimeAsync(1000);
	expect(getRxLevel).toHaveBeenCalledTimes(count);
});

it('sets contrast only when requested and holds it across signal and gain changes', async () => {
	const receiver = reactive({
		display: { minDB: -110, maxDB: -50 },
		gains: { LNA: 32, VGA: 22 },
		running: true,
		_lastSpectrumData: new Float32Array(1024).fill(-85),
	});
	const wrapper = mount(ContrastControls, { global: { provide: { receiver } } });
	await wrapper.findAll('button')[0].trigger('click');
	expect(receiver.display).toEqual({ minDB: -91, maxDB: -40 });
	expect(wrapper.findAll('input[type=range]').every((input) => input.attributes('disabled') === undefined)).toBe(true);
	expect(receiver.gains).toEqual({ LNA: 32, VGA: 22 });
	receiver._lastSpectrumData.fill(-65);
	receiver.gains.VGA = 30;
	await nextTick();
	expect(receiver.display).toEqual({ minDB: -91, maxDB: -40 });
	await wrapper.findAll('button')[0].trigger('click');
	expect(receiver.display).toEqual({ minDB: -71, maxDB: -20 });
	receiver.running = false;
	await nextTick();
	expect(wrapper.findAll('button')[0].attributes('disabled')).toBeDefined();
	await wrapper.findAll('button')[1].trigger('click');
	expect(receiver.display).toEqual(DEFAULT_SPECTRUM_RANGE);
	expect(receiver.gains).toEqual({ LNA: 32, VGA: 30 });
	wrapper.unmount();
});
