import type { SdrDevice, SdrDeviceInfo, GainControl } from '@/radio/types';

/** Where tools/birria-bridge/birria_bridge.py listens. */
export const BIRRIA_BRIDGE_URL = 'ws://127.0.0.1:8075';

/**
 * MT7921AU/MT7961 Wi-Fi stick through the local BirriaSDR bridge. Windows needs libusbK for
 * this stick, which WebUSB can't use, so the bridge opens it natively and streams over a
 * localhost WebSocket. Sweep steps arrive already FFT'd (BirriaSweepAssembler). Live receive gets 16384-sample snapshots, not a gap-free
 * stream: good for spectrum and waterfall, not for demodulation.
 */
export class BirriaBridgeDevice implements SdrDevice {
	readonly deviceType = 'birria';
	readonly sampleRates = [40000000];
	readonly sampleFormat = 'int16' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 3, step: 1, default: 1, type: 'slider' },
		{ name: 'Filter', min: 0, max: 8, step: 1, default: 4, type: 'slider' },
		{ name: 'Digital', min: 0, max: 12, step: 1, default: 0, type: 'slider' },
	];

	private ws: WebSocket | null = null;
	private gains = { lna: 1, lpf: 4, digital: 0 };
	private onData: ((data: ArrayBufferView) => void) | null = null;

	async open(_device?: USBDevice): Promise<void> {
		const ws = new WebSocket(BIRRIA_BRIDGE_URL);
		ws.binaryType = 'arraybuffer';
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error('BirriaSDR bridge not running. Start birria_bridge.py (or BirriaBridge.bat) and try again.'));
		});
		ws.onmessage = (event) => {
			if (typeof event.data === 'string') {
				const msg = JSON.parse(event.data) as { type?: string; message?: string };
				if (msg.type === 'error') console.error('BirriaSDR bridge:', msg.message);
			} else this.onData?.(new Int8Array(event.data));
		};
		ws.onclose = () => {
			this.ws = null;
		};
		this.ws = ws;
	}

	private send(msg: Record<string, unknown>): Promise<void> {
		if (!this.ws) return Promise.reject(new Error('BirriaSDR bridge disconnected'));
		this.ws.send(JSON.stringify(msg));
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.ws?.close();
		this.ws = null;
		return Promise.resolve();
	}

	getInfo(): Promise<SdrDeviceInfo> {
		return Promise.resolve({ name: 'BirriaSDR Wi-Fi stick (bridge)', protocol: BIRRIA_BRIDGE_URL });
	}

	/** Fixed at 40 MS/s. */
	setSampleRate(_rate: number): Promise<void> {
		return Promise.resolve();
	}

	setFrequency(freqHz: number): Promise<void> {
		return this.send({ cmd: 'freq', hz: Math.round(freqHz) });
	}

	setGain(name: string, value: number): Promise<void> {
		if (name === 'LNA') this.gains.lna = value;
		else if (name === 'Filter') this.gains.lpf = value;
		else if (name === 'Digital') this.gains.digital = value;
		else return Promise.resolve();
		return this.send({ cmd: 'gain', ...this.gains });
	}

	/**
	 * Live snapshots arrive as int16 I/Q (14-bit samples), but the receive pipeline reads
	 * int8 I/Q. Scale with a slow AGC so weak signals keep their resolution without
	 * clipping: a fixed shift would round most of the stick's low-level samples to zero.
	 */
	startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		this.liveScale = 0;
		this.onData = (data) => callback(this.toInt8(new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1)));
		return this.send({ cmd: 'rx' });
	}

	private liveScale = 0;

	private toInt8(samples: Int16Array): Int8Array {
		let peak = 1;
		for (const value of samples) peak = Math.max(peak, Math.abs(value));
		const target = 100 / peak;
		// Drop at once when the snapshot would clip, otherwise follow slowly.
		this.liveScale = this.liveScale === 0 || target < this.liveScale ? target : this.liveScale * 0.95 + target * 0.05;
		const out = new Int8Array(samples.length);
		for (let i = 0; i < samples.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(samples[i] * this.liveScale)));
		return out;
	}

	/** The bridge FFTs each step itself at the plan's bin width; see BirriaSweepAssembler. */
	startSweep(range: { startMHz: number; stopMHz: number; fftSize?: number }, callback: (data: ArrayBufferView) => void): Promise<void> {
		this.onData = callback;
		return this.send({ cmd: 'sweep', startMHz: range.startMHz, stopMHz: range.stopMHz, fftSize: range.fftSize ?? 1024 });
	}

	stopRx(): Promise<void> {
		this.onData = null;
		return this.ws ? this.send({ cmd: 'stop' }) : Promise.resolve();
	}
}
