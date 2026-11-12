"""Localhost bridge between a BirriaSDR MT7921AU/MT7961 stick and BrowSDR.

Browsers can't open this stick over WebUSB on Windows (it needs libusbK), so this
program opens it with the BirriaSDR native library and serves it to the BrowSDR
"Wi-Fi stick (BirriaSDR bridge)" device over ws://127.0.0.1:8075.

Sweep mode retunes one continuous 40 MS/s stream live (no restart) in 35 MHz
steps, FFTs each step here and sends the dB bins ready to place.

Run:  python birria_bridge.py [--lib DIR] [--port 8075] [--fake]
Needs numpy, and birriasdr.dll, birria_display.dll and libusb-1.0.dll from a
BirriaSDR Windows build (or the .so files on Linux).
"""
import argparse, base64, ctypes as C, hashlib, json, os, socket, struct, sys, threading, time
from pathlib import Path
import numpy as np

RATE = 40_000_000
CAPTURE = 16384           # 40 MS/s samples per step (0.41 ms) and per native callback
SPAN_HZ = 35_000_000      # used per step: the flat middle of the filter (70 MHz at 80 MS/s)
FULL_SCALE = 8192.0       # 14-bit samples
DEFAULT_FFT_SIZE = 65536  # BrowSDR's level reference
LIVE_SAMPLES = CAPTURE
BATCH = CAPTURE           # samples per native callback (--batch)
SETTLE_US = 500           # discarded after each retune (--settle-us)
FLAGS = 1 | 2             # OPEN_EXPERIMENTAL_MT7961 | OPEN_EXPERIMENTAL_TUNING (| 4 for 80 MS/s)


class Gain(C.Structure):
    _fields_ = [('lna', C.c_uint8), ('lpf', C.c_uint8), ('digital', C.c_uint8)]


def find_lib_dir(start):
    name = 'birriasdr.dll' if os.name == 'nt' else 'libbirriasdr.so'
    for base in (start, start.parent):
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'node_modules']
            if name in files and ('birria_display.dll' in files or 'libbirria_display.so' in files):
                return Path(root)
    return None


class Stick:
    """The real receiver: one continuous native stream, retuned live."""
    def __init__(self, directory):
        if os.name == 'nt':
            self._dll_dir = os.add_dll_directory(str(directory.resolve()))
            C.CDLL(str(directory / 'libusb-1.0.dll'))
            self.lib = C.CDLL(str(directory / 'birriasdr.dll'))
            disp = C.CDLL(str(directory / 'birria_display.dll'))
        else:
            self.lib = C.CDLL(str(directory / 'libbirriasdr.so'))
            disp = C.CDLL(str(directory / 'libbirria_display.so'))
        L, P = self.lib, C.c_void_p
        for name, args, res in [('open_ex', [C.POINTER(P), C.c_uint32, C.c_uint32], C.c_int),
                                ('close', [P], C.c_int), ('set_center_freq', [P, C.c_uint64], C.c_int),
                                ('set_sample_rate', [P, C.c_uint32], C.c_int),
                                ('set_tuner_bandwidth', [P, C.c_uint32], C.c_int),
                                ('set_tuner_gain_mode', [P, C.c_int], C.c_int),
                                ('set_gain_codes', [P, C.POINTER(Gain)], C.c_int),
                                ('cancel_async', [P], C.c_int), ('strerror', [C.c_int], C.c_char_p)]:
            fn = getattr(L, 'birriasdr_' + name); fn.argtypes, fn.restype = args, res
        for name, args, res in [('create', [], P), ('configure', [P, C.c_uint32, C.c_uint64, C.c_int], C.c_int),
                                ('take', [P, C.POINTER(C.c_int16), C.c_uint32, C.POINTER(C.c_uint32),
                                          C.POINTER(C.c_uint64), C.POINTER(C.c_uint64)], C.c_int),
                                ('counters', [P, C.POINTER(C.c_uint64)], None)]:
            fn = getattr(disp, 'bs_display_' + name); fn.argtypes, fn.restype = args, res
        self.disp = disp
        L.birriasdr_read_async.argtypes = [P, P, P, C.c_uint32, C.c_uint32]
        L.birriasdr_read_async.restype = C.c_int
        self.box = disp.bs_display_create()
        self.scratch = np.empty((262144, 2), np.int16)
        self.dev = P()
        self.generation = 0
        self.error = None
        self.check(L.birriasdr_open_ex(C.byref(self.dev), 0, FLAGS))
        self.check(L.birriasdr_set_sample_rate(self.dev, RATE))
        if RATE == 80_000_000:
            self.check(L.birriasdr_set_tuner_bandwidth(self.dev, RATE))
        self.check(L.birriasdr_set_tuner_gain_mode(self.dev, 1))
        self.set_gain(1, 4, 0)
        self.check(L.birriasdr_set_center_freq(self.dev, 5_695_000_000))
        self.configure(LIVE_SAMPLES)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def check(self, code):
        if code < 0:
            raise RuntimeError('BirriaSDR: ' + self.lib.birriasdr_strerror(code).decode())

    def _read(self):
        # The display mailbox's native callback, with small buffers: a fresh window every 0.41 ms
        # instead of every 6.5 ms, and nothing crosses into Python per callback.
        callback = C.cast(self.disp.bs_display_callback, C.c_void_p)
        code = self.lib.birriasdr_read_async(self.dev, callback, self.box, 0, BATCH)
        if code < 0:
            self.error = self.lib.birriasdr_strerror(code).decode()
            print('stream stopped:', self.error, flush=True)

    def configure(self, size):
        self.generation += 1
        self.disp.bs_display_configure(self.box, size, self.generation, 0)

    def samples(self):
        out = (C.c_uint64 * 5)()
        self.disp.bs_display_counters(self.box, out)
        return out[0]

    def tune(self, hz):
        self.check(self.lib.birriasdr_set_center_freq(self.dev, int(hz)))

    def set_gain(self, lna, lpf, digital):
        g = Gain(lna, lpf, digital)
        self.check(self.lib.birriasdr_set_gain_codes(self.dev, C.byref(g)))

    def take(self, size, after=0, timeout=0.5):
        """Next published window of `size` samples starting at or after sample `after`."""
        self.configure(size)
        count, first, gen = C.c_uint32(), C.c_uint64(), C.c_uint64()
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.error:
                raise RuntimeError('stream stopped: ' + self.error)
            r = self.disp.bs_display_take(self.box, self.scratch.ctypes.data_as(C.POINTER(C.c_int16)),
                                          len(self.scratch), C.byref(count), C.byref(first), C.byref(gen))
            if r == 1 and gen.value == self.generation and first.value >= after:
                return self.scratch[:count.value].copy()
            if r == 1:
                self.configure(size)               # too early: re-arm, or the mailbox waits 50 ms
            time.sleep(0.0002)
        raise TimeoutError('no samples from the stick')

    def close(self):
        self.lib.birriasdr_cancel_async(self.dev)
        self.reader.join(2)
        self.lib.birriasdr_close(self.dev)


class FakeStick:
    """Synthetic tones at 5695, 5806 and 5917 MHz plus noise, for testing without hardware."""
    def __init__(self):
        self.center, self.n, self.rng = 5_695_000_000, 0, np.random.default_rng()

    def tune(self, hz): self.center = int(hz)
    def set_gain(self, *g): pass
    def samples(self): return self.n
    def close(self): pass

    def take(self, size, after=0, timeout=0.5):
        t = np.arange(size) / RATE
        x = 20 * (self.rng.standard_normal(size) + 1j * self.rng.standard_normal(size))
        for f in (5_695e6, 5_806e6, 5_917e6):
            if abs(f - self.center) < RATE / 2:
                x += 3000 * np.exp(2j * np.pi * (f - self.center) * t)
        self.n += size
        return np.stack([x.real, x.imag], 1).astype(np.int16)


class Session:
    def __init__(self, stick, ws):
        self.stick, self.ws = stick, ws
        self.mode, self.lock = 'idle', threading.Lock()
        self.center = 5_695_000_000
        self.range = (5600, 6000)
        self.fft_size = 1024
        self.settle = SETTLE_US * RATE // 1_000_000   # samples discarded after a retune
        self.stats, self.last_report = [], 0.0

    def command(self, msg):
        cmd = msg.get('cmd')
        with self.lock:
            if cmd == 'gain':
                self.stick.set_gain(int(msg['lna']), int(msg['lpf']), int(msg['digital']))
            elif cmd == 'freq':
                self.center = int(msg['hz'])
                if self.mode == 'rx':
                    self.stick.tune(self.center)
            elif cmd == 'rx':
                self.mode = 'rx'
                self.stick.tune(self.center)
            elif cmd == 'sweep':
                self.range = (int(msg['startMHz']), int(msg['stopMHz']))
                self.fft_size = min(4096, max(16, int(msg.get('fftSize', 1024))))
                self.mode = 'sweep'
            elif cmd == 'stop':
                self.mode = 'idle'
        if cmd == 'info':
            self.ws.send_text(json.dumps({'type': 'info', 'name': 'BirriaSDR MT7921AU', 'rate': RATE}))

    def run(self):
        while self.ws.open:
            try:
                if self.mode == 'rx':
                    iq = self.stick.take(LIVE_SAMPLES)
                    self.ws.send_binary(iq.tobytes())
                    time.sleep(1 / 60)              # display snapshots, not a continuous stream
                elif self.mode == 'sweep':
                    self.sweep_once()
                else:
                    time.sleep(0.02)
            except (OSError, ConnectionError):
                return
            except Exception as e:
                self.ws.send_text(json.dumps({'type': 'error', 'message': str(e)}))
                self.mode = 'idle'

    def sweep_once(self):
        """One pass in SPAN_HZ steps. Each step is sent as a uint64 start frequency (Hz) of its
        first bin, then float32 dB bins at the plan's bin width, levelled like BrowSDR's FFT."""
        start, stop = self.range
        fft_size = self.fft_size * RATE // 20_000_000   # same bin width as fft_size at 20 MS/s
        bin_hz = RATE / fft_size
        keep = int(SPAN_HZ / bin_hz) // 2 * 2
        window = np.hanning(fft_size)
        offset_db = 10 * np.log10(self.fft_size / DEFAULT_FFT_SIZE)
        f = start * 1_000_000
        while self.mode == 'sweep' and f < stop * 1_000_000 and self.ws.open:
            centre = f + keep // 2 * bin_hz
            t0 = time.perf_counter()
            with self.lock:
                self.stick.tune(centre)
                mark = self.stick.samples() + self.settle
            t1 = time.perf_counter()
            iq = self.stick.take(CAPTURE, after=mark)
            t2 = time.perf_counter()
            x = (iq[:, 0] + 1j * iq[:, 1]).astype(np.complex64) / FULL_SCALE
            frames = x[: len(x) // fft_size * fft_size].reshape(-1, fft_size)
            power = np.mean(np.abs(np.fft.fftshift(np.fft.fft(frames * window, axis=1), axes=1)) ** 2, axis=0)
            db = 10 * np.log10(power / fft_size ** 2 + 1e-20) + offset_db
            lo = fft_size // 2 - keep // 2
            first_hz = centre + (lo - fft_size // 2) * bin_hz
            self.ws.send_binary(struct.pack('<Q', int(round(first_hz))) + db[lo:lo + keep].astype('<f4').tobytes())
            self.stats.append((t1 - t0, t2 - t1, time.perf_counter() - t2))
            f += keep * bin_hz
        self.report()

    def report(self):
        now = time.monotonic()
        if self.stats and now - self.last_report > 2:
            tune, wait, work = (1000 * sum(v) / len(self.stats) for v in zip(*self.stats))
            print(f'per step: retune {tune:.2f} ms, wait for samples {wait:.2f} ms, FFT+send {work:.2f} ms', flush=True)
            self.stats.clear()
            self.last_report = now


class WebSocket:
    """Just enough RFC 6455 for one local client."""
    def __init__(self, conn):
        self.conn, self.open, self.wlock = conn, True, threading.Lock()

    @staticmethod
    def accept(conn):
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = conn.recv(4096)
            if not chunk:
                return None
            data += chunk
        headers = {k.strip().lower(): v.strip() for k, _, v in
                   (line.partition(':') for line in data.decode('latin1').split('\r\n')[1:])}
        key = headers.get('sec-websocket-key')
        if not key:
            conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 27\r\n\r\nBirriaSDR bridge is running')
            return None
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        conn.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                     b'Sec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
        return WebSocket(conn)

    def _send(self, opcode, payload):
        n = len(payload)
        head = bytes([0x80 | opcode]) + (bytes([n]) if n < 126 else
                                         bytes([126]) + struct.pack('>H', n) if n < 65536 else
                                         bytes([127]) + struct.pack('>Q', n))
        with self.wlock:
            try:
                self.conn.sendall(head + payload)
            except OSError:
                self.open = False
                raise

    def send_text(self, s): self._send(1, s.encode())
    def send_binary(self, b): self._send(2, b)

    def _exact(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self.conn.recv(n - len(buf))
            if not chunk:
                raise ConnectionError
            buf += chunk
        return buf

    def receive(self):
        """Next text message, or None when the client leaves."""
        try:
            while True:
                b0, b1 = self._exact(2)
                n = b1 & 0x7F
                if n == 126: n = struct.unpack('>H', self._exact(2))[0]
                elif n == 127: n = struct.unpack('>Q', self._exact(8))[0]
                mask = self._exact(4) if b1 & 0x80 else b'\0\0\0\0'
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(self._exact(n)))
                op = b0 & 0x0F
                if op == 8:
                    break
                if op == 9:
                    self._send(10, data)
                elif op == 1:
                    return data.decode()
        except (OSError, ConnectionError):
            pass
        self.open = False
        return None


def serve(stick, port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', port))
    srv.listen(1)
    print(f'BirriaSDR bridge running on ws://127.0.0.1:{port} - keep this window open.', flush=True)
    srv.settimeout(0.5)                        # lets Ctrl+C through on Windows
    while True:
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        conn.settimeout(None)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        ws = WebSocket.accept(conn)
        if not ws:
            conn.close()
            continue
        print('BrowSDR connected', flush=True)
        session = Session(stick, ws)
        worker = threading.Thread(target=session.run, daemon=True)
        worker.start()
        def commands():
            while (text := ws.receive()) is not None:
                try:
                    session.command(json.loads(text))
                except Exception as e:
                    ws.send_text(json.dumps({'type': 'error', 'message': str(e)}))
        reader = threading.Thread(target=commands, daemon=True)
        reader.start()
        while reader.is_alive():
            reader.join(0.5)                   # short waits keep Ctrl+C working
        session.mode = 'idle'
        worker.join(2)
        conn.close()
        print('BrowSDR disconnected', flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--lib', type=Path, help='folder with birriasdr.dll, birria_display.dll, libusb-1.0.dll')
    ap.add_argument('--port', type=int, default=8075)
    ap.add_argument('--fake', action='store_true', help='synthetic tones, no stick needed')
    ap.add_argument('--rate', type=int, choices=(40, 80), default=40,
                    help='MS/s; 80 is experimental (70 MHz per sweep step, needs a fast USB 3 port)')
    ap.add_argument('--batch', type=int, default=CAPTURE,
                    help='samples per native callback, multiple of 2048 (larger can avoid overruns at 80 MS/s)')
    ap.add_argument('--settle-us', type=int, default=500, help='microseconds discarded after each retune')
    args = ap.parse_args()
    global RATE, SPAN_HZ, FLAGS, BATCH, SETTLE_US
    SETTLE_US = args.settle_us
    BATCH = max(CAPTURE, args.batch // 2048 * 2048)
    if args.rate == 80:
        RATE, SPAN_HZ, FLAGS = 80_000_000, 70_000_000, FLAGS | 4
    if args.fake:
        stick = FakeStick()
    else:
        lib = args.lib or find_lib_dir(Path(__file__).resolve().parent)
        if not lib:
            sys.exit('birriasdr.dll and birria_display.dll not found; pass --lib FOLDER')
        print('library:', lib, flush=True)
        stick = Stick(lib)
    try:
        serve(stick, args.port)
    except KeyboardInterrupt:
        pass
    finally:
        stick.close()


if __name__ == '__main__':
    main()
