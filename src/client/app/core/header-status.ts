import { computed, defineComponent, inject } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';

/** Small status pills on the right of the header: device, reception, sweep rate and gain. */
export default defineComponent({
	name: 'HeaderStatus',
	template: `<div class="status-pills">
		<span v-for="pill in pills" :key="pill.id" class="pill" :class="pill.tone" :title="pill.title">{{ pill.text }}</span>
	</div>`,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('HeaderStatus requires a receiver');
		const pills = computed(() => {
			const r = receiver;
			const list: Array<{ id: string; text: string; tone: string; title: string }> = [];
			if (r.remoteMode !== 'none')
				list.push({ id: 'remote', text: r.remoteMode === 'host' ? 'sharing' : 'remote', tone: 'warn', title: r.remoteStatus || 'Remote' });
			if (!r.connected) list.push({ id: 'device', text: 'no SDR', tone: 'bad', title: 'Add an SDR from the Source section' });
			else list.push({ id: 'device', text: r.info.boardName || 'SDR', tone: 'good', title: 'Connected device' });
			if (r.connected) {
				list.push(
					r.running
						? { id: 'state', text: 'receiving', tone: 'good', title: 'Reception is running' }
						: { id: 'state', text: 'stopped', tone: '', title: 'Press play to start reception' },
				);
			}
			if (r.sweep.active && r.running)
				list.push({ id: 'sweep', text: r.sweep.rate.toFixed(1) + ' sweeps/s', tone: 'good', title: 'Sweep speed' });
			if (r.autoGain.enabled && r.connected) {
				const overload = r.autoGain.overload;
				list.push({
					id: 'gain',
					text: overload ? 'overload' : 'auto gain',
					tone: overload ? 'bad' : 'good',
					title: r.autoGain.status || 'Auto gain on',
				});
			}
			return list;
		});
		return { pills };
	},
});
