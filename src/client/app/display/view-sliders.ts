import { computed, defineComponent, inject } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';

const MAX_ZOOM = 100;

/** Slim vertical sliders beside the plot: zoom, the display's top and floor levels, and waterfall smoothing. */
export default defineComponent({
	name: 'ViewSliders',
	template: `<div class="view-sliders" aria-label="View">
		<label title="Zoom into the centre of the view. Wheel or pinch on the plot also zooms.">Zoom
			<input class="vertical" type="range" min="0" max="1000" :value="zoom" @input="setZoom" aria-label="Zoom">
			<output>{{ zoomText }}</output>
		</label>
		<label title="Strongest level shown: the top of the spectrum and the brightest waterfall colour.">Top
			<input class="vertical" type="range" min="-150" max="0" :value="receiver.display.maxDB" @input="setTop" aria-label="Top level, dB">
			<output>{{ receiver.display.maxDB.toFixed(0) }}</output>
		</label>
		<label title="Weakest level shown: the bottom of the spectrum and the darkest waterfall colour.">Floor
			<input class="vertical" type="range" min="-200" max="-20" :value="receiver.display.minDB" @input="setFloor" aria-label="Floor level, dB">
			<output>{{ receiver.display.minDB.toFixed(0) }}</output>
		</label>
		<label title="Waterfall smoothing: averages each new waterfall line with the ones before it. Calms noise; short bursts fade in more slowly.">Smooth
			<input class="vertical" type="range" min="0" max="95" step="5" :value="smooth" @input="setSmooth" aria-label="Waterfall smoothing">
			<output>{{ smooth }}%</output>
		</label>
	</div>`,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('ViewSliders requires a receiver');
		// Logarithmic, so each step of the slider feels the same at any zoom.
		const zoom = computed(() => Math.round((Math.log(receiver.view.zoomScale) / Math.log(MAX_ZOOM)) * 1000));
		const zoomText = computed(
			() => (receiver.view.zoomScale < 10 ? receiver.view.zoomScale.toFixed(1) : receiver.view.zoomScale.toFixed(0)) + '×',
		);
		const smooth = computed(() => Math.round(receiver.display.waterfallSmoothing * 100));
		const value = (event: Event) => Number((event.target as HTMLInputElement).value);
		return {
			receiver,
			zoom,
			zoomText,
			smooth,
			setZoom(event: Event) {
				const { view } = receiver;
				const scale = Math.max(1, Math.min(MAX_ZOOM, Math.pow(MAX_ZOOM, value(event) / 1000)));
				// Keep the middle of the view where it is.
				const centre = view.zoomOffset + 0.5 / view.zoomScale;
				view.zoomScale = scale;
				view.zoomOffset = Math.max(0, Math.min(1 - 1 / scale, centre - 0.5 / scale));
				receiver.applyZoomToEngine();
			},
			setTop(event: Event) {
				receiver.display.maxDB = Math.max(value(event), receiver.display.minDB + 5);
			},
			setFloor(event: Event) {
				receiver.display.minDB = Math.min(value(event), receiver.display.maxDB - 5);
			},
			setSmooth(event: Event) {
				receiver.display.waterfallSmoothing = Math.max(0, Math.min(0.95, value(event) / 100));
			},
		};
	},
});
