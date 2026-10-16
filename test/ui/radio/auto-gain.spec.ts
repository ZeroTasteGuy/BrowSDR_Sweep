import { expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { HackRFDevice } from '@/devices/hackrf/device';

it('switches auto gain with the toggle and presets, and sets the target and amp rule', async () => {
	const wrapper = mount(ReceiverView);
	await wrapper.setData({
		deviceCapabilities: new HackRFDevice(),
		gains: { LNA: 16, VGA: 16, 'Amp (14dB)': 0 },
		connected: true,
		running: false,
	});
	const panel = wrapper.get('.auto-gain');
	expect(panel.text()).toContain('Auto gain off');
	await panel.get('.auto-gain-toggle input').setValue(true);
	expect(wrapper.vm.autoGain.enabled).toBe(true);
	expect(panel.text()).toContain('starts with reception');
	const preset = (label) => panel.findAll('.auto-gain-presets button').find((button) => button.text() === label);
	await preset('Race').trigger('click');
	expect(wrapper.vm.autoGain).toMatchObject({ enabled: true, target: 80, allowAmp: false });
	await preset('Scan').trigger('click');
	expect(wrapper.vm.autoGain).toMatchObject({ enabled: true, target: 20, allowAmp: false });
	expect(preset('Scan').classes()).toContain('active');
	await preset('Manual').trigger('click');
	expect(wrapper.vm.autoGain.enabled).toBe(false);
	wrapper.unmount();
});
