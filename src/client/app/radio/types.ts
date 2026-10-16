export type PairedDevices = Array<{ device: USBDevice; driverName: string; productName: string }>;

export type PairedSdr = { device: USBDevice; driverName: string; productName: string; deviceNumber: number };

export type AutoGainPreset = { id: string; label: string; description: string; target?: number; allowAmp?: boolean };

export type GainStep = { gains: Record<string, number>; done: boolean; reason: string };
