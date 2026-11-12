# BirriaSDR bridge

Lets BrowSDR use an MT7921AU/MT7961 Wi-Fi stick ([BirriaSDR](https://github.com/ot0tot/BirriaSDR)) for
sweep and spectrum. Browsers can't open this stick over WebUSB on Windows: it needs the libusbK driver,
and WebUSB only works on WinUSB. So this small program opens the stick with BirriaSDR's native library
and serves it to BrowSDR over `ws://127.0.0.1:8075`.

## Use

1. Once per PC: install libusbK on the stick's **WiFi_If (Interface 3)** with Zadig (see the BirriaSDR
   README). Use a USB 3 port.
2. Put `birria_bridge.py` and `BirriaBridge.bat` next to a BirriaSDR Windows build, i.e. the folder that
   has `birriasdr.dll`, `birria_display.dll` and `libusb-1.0.dll` (or anywhere above it; the script
   searches its own folder and the one above). Or pass `--lib FOLDER`.
3. Double-click `BirriaBridge.bat` (needs Python with numpy). Keep the window open.
4. In BrowSDR, open **Add SDR** and choose **Wi-Fi stick (BirriaSDR bridge)**. Sweep mode and its FPV
   presets work as with a HackRF.

Linux: same, with `libbirriasdr.so` and `libbirria_display.so`, `python3 birria_bridge.py`.
Without a stick, `--fake` serves synthetic tones at 5695, 5806 and 5917 MHz.

## How it works

- One continuous 40 MS/s stream; each sweep step is a live retune (no restart), a 2 ms settle, and
  16384 samples.
- Each 20 MHz step is cut digitally into the two interleaved 20 MS/s tunings that `hackrf_sweep` uses,
  and sent as its 16384-byte blocks (0x7F 0x7F header). BrowSDR's sweep assembler stitches them
  unchanged.
- Live receive sends 65536-sample snapshots, not a gap-free stream: good for spectrum and waterfall,
  not for demodulation.
- Gain is the raw LNA (0-3), filter (0-8) and digital (0-12) codes. Default 1, 4, 0.
- A known DMA glitch (some 32-sample blocks shifted by 2 samples) only adds a little to the noise floor.
