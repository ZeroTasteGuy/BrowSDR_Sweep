import { errorMessage } from '@/platform/errors';
import type { AppInstance } from '@/app/core/receiver.types';

/** Lowest-risk HackRF state: RF amp off first, then LNA and VGA at minimum. */
const SAFE_GAINS = { 'Amp (14dB)': 0, LNA: 0, VGA: 0 };

export const emergencyStopMethods = {
	/** Spacebar: drop every gain to minimum and stop receiving, whatever was running. */
	async emergencyStop(this: AppInstance) {
		if (!this.connected || this.remoteMode === 'client') return;
		if (this.autoGain.active) this.cancelAutoGain();
		let gainError = '';
		if (this.deviceCapabilities?.deviceType === 'hackrf') {
			try {
				await this.backend.setGains(SAFE_GAINS);
				Object.assign(this.gains, SAFE_GAINS);
			} catch (error) {
				gainError = errorMessage(error);
			}
		}
		if (this.running) await this.togglePlay();
		this.showMsg(
			gainError
				? `Emergency stop: reception stopped, but gains could not be lowered (${gainError})`
				: 'Emergency stop: gains at minimum, amp off, reception stopped',
		);
	},
};

/** Space anywhere except while typing in a field. */
export function isEmergencyStopKey(event: KeyboardEvent): boolean {
	if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return false;
	const target = event.target as HTMLElement | null;
	return !(target?.isContentEditable || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));
}
