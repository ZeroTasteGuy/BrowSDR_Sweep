import { computed, defineComponent, inject, onUnmounted, ref, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RxLevel } from '@/radio/types';

/** Own the telemetry render effect so live levels do not rerender receiver controls. */
export default defineComponent({
	name: 'RxLevel',
	template: `<div v-if="supported" class="rx-level" aria-label="RX level">
		<template v-if="level">
			<div class="rx-level-bar" role="meter" aria-label="ADC peak level" :aria-valuenow="level.peakDbfs.toFixed(1)" aria-valuemin="-50" aria-valuemax="0">
				<div class="rx-level-fill" :class="zone" :style="{ width: barWidth + '%' }"></div>
				<div class="rx-level-limit" title="Overload line, -3 dBFS"></div>
			</div>
			<div :class="{ 'rx-level-warning': overloaded }">{{ overloaded ? 'Overload: reduce gain' : 'Peak ' + level.peakDbfs.toFixed(0) + ' dBFS · RMS ' + level.rmsDbfs.toFixed(0) + ' dBFS' }}</div>
		</template>
		<div v-else>{{ receiver.running ? 'RX level: waiting for samples' : 'RX level: reception stopped' }}</div>
	</div>`,
	setup() {
		const injected = inject<AppInstance>('receiver');
		if (!injected) throw new Error('RxLevel requires a receiver');
		const receiver: AppInstance = injected;
		const level = ref<RxLevel | null>(null);
		const supported = ref(false);
		let timer: ReturnType<typeof setInterval> | undefined;
		let generation = 0;
		let busy = false;
		async function poll() {
			if (busy) return;
			const current = generation;
			const backend = receiver.backend;
			busy = true;
			try {
				const value = await backend?.getRxLevel();
				if (current === generation) level.value = value && Date.now() - value.timestamp < 1000 ? value : null;
			} catch {
				if (current === generation) level.value = null;
			} finally {
				busy = false;
			}
		}
		watch(
			() => [receiver.running, receiver.radio.sampleRate, receiver.remoteMode, receiver.deviceCapabilities, receiver.gains['Receive Mode']],
			() => {
				generation++;
				level.value = null;
				clearInterval(timer);
				supported.value = receiver.remoteMode !== 'client' && ['hackrf', 'limesdr'].includes(receiver.deviceCapabilities?.deviceType ?? '');
				if (supported.value && receiver.running && receiver.gains['Receive Mode'] !== 1) timer = setInterval(() => void poll(), 250);
			},
			{ immediate: true },
		);
		onUnmounted(() => {
			generation++;
			clearInterval(timer);
		});
		const overloaded = computed(() => !!level.value && (level.value.clippedFraction > 0.0001 || level.value.peakDbfs > -3));
		// -50 dBFS is empty, 0 dBFS is full.
		const barWidth = computed(() => (level.value ? Math.max(0, Math.min(100, ((level.value.peakDbfs + 50) / 50) * 100)) : 0));
		const zone = computed(() => (overloaded.value ? 'red' : level.value && level.value.peakDbfs > -12 ? 'amber' : 'green'));
		return { receiver, level, supported, overloaded, barWidth, zone };
	},
});
