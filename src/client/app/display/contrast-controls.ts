import { defineComponent, inject } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { autoContrastRange } from '@/display/contrast';
import { DEFAULT_SPECTRUM_RANGE } from '@/display/spectrum-range';
import { UiFormRow, UiButton } from '@/ui';

export default defineComponent({
	name: 'ContrastControls',
	components: { UiFormRow, UiButton },
	template: `<div class="contrast-controls">
		<UiFormRow class="contrast-buttons">
			<UiButton variant="secondary" @click="setAutoContrast" :disabled="!receiver.running"
				title="Set Top and Floor from the current spectrum once, then hold them. Does not change reception gains.">Auto levels</UiButton>
			<UiButton variant="secondary" @click="resetContrast"
				title="Restore the original Top and Floor levels. Does not change reception gains.">Reset levels</UiButton>
		</UiFormRow>
		<p class="rx-level-hint">Top, Floor and waterfall smoothing are the sliders right of the waterfall. They change the picture only, not the gains.</p>
	</div>`,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('ContrastControls requires a receiver');
		return {
			receiver,
			resetContrast() {
				Object.assign(receiver.display, DEFAULT_SPECTRUM_RANGE);
			},
			setAutoContrast() {
				if (!receiver.running || !receiver._lastSpectrumData) return;
				const range = autoContrastRange(receiver._lastSpectrumData);
				if (range) Object.assign(receiver.display, range);
			},
		};
	},
});
