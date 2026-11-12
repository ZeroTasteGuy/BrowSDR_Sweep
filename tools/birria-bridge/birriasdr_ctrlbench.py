"""Measurement-only patch for BirriaSDR (apply after birriasdr_rfburst.py; idempotent).

Apply after birriasdr_fastio.py. Run: python birriasdr_ctrlbench.py PATH\\TO\\birriasdr
With BIRRIASDR_BENCH_CTRL=1, the first 3 live retunes first time 24 control
reads of the RF bridge status register (0x7c004000, read only, harmless):
once one after another (as the driver does today) and once all submitted at
the same time as asynchronous transfers. If the async time per read is much
lower, pipelining the retune's register writes is worth building.
Needs a running stream (its event thread completes the async transfers).
"""
import sys
from pathlib import Path

root = Path(sys.argv[1])

def edit(rel, old, new):
    p = root / rel
    s = p.read_text()
    if new in s:
        return
    if old not in s:
        sys.exit(f'{rel}: anchor not found:\n{old}')
    p.write_text(s.replace(old, new, 1))
    print('patched', rel)

BENCH = r'''
/* Measurement only (BIRRIASDR_BENCH_CTRL): sequential vs pipelined control reads. */
struct bench_slot { volatile int done; int status; };
static void LIBUSB_CALL bench_done(struct libusb_transfer *transfer)
{
    struct bench_slot *slot = transfer->user_data;
    slot->status = transfer->status;
    slot->done = 1;
}

void bs_bench_control(birriasdr_dev_t *dev)
{
    enum { N = 24 };
    const uint32_t address = 0x7c004000;
    uint8_t bytes[4];
    struct libusb_transfer *xfer[N] = {0};
    unsigned char buffer[N][LIBUSB_CONTROL_SETUP_SIZE + 4];
    struct bench_slot slot[N];
    int fails = 0, pending = 0, bad = 0;
    uint64_t start = bs_now_ns(), sync_ns, async_ns;
    for (int i = 0; i < N; ++i)
        if (bs_control(dev, 0xc0, 0x63, (uint16_t)(address >> 16), (uint16_t)address, bytes, 4) < 0)
            ++fails;
    sync_ns = bs_now_ns() - start;
    start = bs_now_ns();
    for (int i = 0; i < N; ++i) {
        slot[i].done = 0;
        slot[i].status = -1;
        xfer[i] = libusb_alloc_transfer(0);
        if (!xfer[i]) { slot[i].done = 1; ++bad; continue; }
        libusb_fill_control_setup(buffer[i], 0xc0, 0x63, (uint16_t)(address >> 16), (uint16_t)address, 4);
        libusb_fill_control_transfer(xfer[i], dev->handle, buffer[i], bench_done, &slot[i], 1000);
        if (libusb_submit_transfer(xfer[i]) < 0) { slot[i].done = 1; ++bad; }
    }
    for (;;) {
        pending = 0;
        for (int i = 0; i < N; ++i) pending += !slot[i].done;
        if (!pending || bs_now_ns() - start > UINT64_C(1500000000)) break;
    }
    async_ns = bs_now_ns() - start;
    for (int i = 0; i < N; ++i) {
        if (slot[i].done && slot[i].status != LIBUSB_TRANSFER_COMPLETED && slot[i].status != -1) ++bad;
        if (slot[i].done && xfer[i]) libusb_free_transfer(xfer[i]);   /* else leak: still owned by libusb */
    }
    fprintf(stderr, "ctrl bench: sequential %.1f us/read (%d failed), pipelined %.1f us/read (%d failed, %d unfinished)\n",
            sync_ns / 1000.0 / N, fails, async_ns / 1000.0 / N, bad, pending);
}
'''

edit('src/usb.c', '/* ROM command/download packets must be transmitted in full.',
     BENCH.lstrip('\n') + '\n/* ROM command/download packets must be transmitted in full.')
edit('src/internal.h', 'uint64_t bs_now_ns(void);',
     'uint64_t bs_now_ns(void);\nvoid bs_bench_control(birriasdr_dev_t *dev);')
edit('src/chips/mt7921_tune.c', '''        if (trace < 0) trace = getenv("BIRRIASDR_TRACE_TUNE") != NULL;''', '''        if (trace < 0) trace = getenv("BIRRIASDR_TRACE_TUNE") != NULL;
        static int benches;
        if (benches < 3 && getenv("BIRRIASDR_BENCH_CTRL")) { ++benches; bs_bench_control(dev); }''')
s = (root / 'src/chips/mt7921_tune.c').read_text()
if '#include <stdlib.h>' not in s:
    (root / 'src/chips/mt7921_tune.c').write_text(s.replace('#include "mt7921.h"', '#include "mt7921.h"\n#include <stdlib.h>', 1))
print('done')
