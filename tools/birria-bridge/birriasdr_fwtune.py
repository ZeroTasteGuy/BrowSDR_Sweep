"""On-chip retune for BirriaSDR (apply after birriasdr_rfburst.py; idempotent).

Run: python birriasdr_fwtune.py PATH\\TO\\birriasdr
Opt-in with BIRRIASDR_FW_TUNE=1. During a running stream, a high-band retune
(>= 4 GHz, experimental tuning) is sent to the stick's streaming firmware as a
small RF script instead of ~30 separate USB register transactions:
  - the script for each frequency is uploaded once (one USB write) and cached
    in MCU memory for the rest of the stream,
  - each retune is then one 8-byte doorbell write plus completion polls.
The firmware runs (without blocking the sample DMA) exactly the host's retune_high() sequence (same registers,
same order, same calibration poll). Without BIRRIASDR_FAST_TUNE=1 the host
still reads the frequency word back and checks it. If the firmware does not
answer within 20 ms, the driver switches back to the host path for the rest of
the stream.
Also replaces src/chips/mt7921_image.h with the rebuilt firmware image (built
from the patched firmware/iq_stream.S with nds32le-elf binutils), and lets the
ROM download frame hold the larger image.
"""
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fwtune_asm  # noqa: E402

root = Path(sys.argv[1])


def edit(rel, pairs):
    p = root / rel
    s = p.read_text()
    for pair in pairs:
        old, new = pair[:2]
        marker = pair[2] if len(pair) > 2 else new
        if marker in s:
            continue                       # already applied
        if old not in s:
            sys.exit(f'{rel}: anchor not found (apply birriasdr_rfburst.py first?):\n{old}')
        s = s.replace(old, new, 1)
    p.write_text(s)
    print('patched', rel)


asm = root / 'firmware/iq_stream.S'
asm.write_text(fwtune_asm.patch(asm.read_text()))
shutil.copyfile(HERE / 'mt7921_image_fwtune.h', root / 'src/chips/mt7921_image.h')
print('patched firmware/iq_stream.S, replaced src/chips/mt7921_image.h')

edit('src/chips/mt7921_boot.c', [
    ('    uint8_t frame[1200] = {0}, reply[4096];',
     '    uint8_t frame[4200] = {0}, reply[4096];   /* on-chip retune image is ~2.1 KiB */'),
])

edit('src/internal.h', [
    ('''        uint32_t rate_baseline[2];
        bool rate_saved;''', '''        uint32_t rate_baseline[2];
        bool rate_saved;
        /* On-chip retune (BIRRIASDR_FW_TUNE), reset by mt_start(). */
        uint64_t fw_slot_hz[64];
        unsigned fw_slots;
        uint32_t fw_sequence, fw_routing;
        bool fw_checked, fw_off, fw_routing_known;'''),
])

edit('src/chips/mt7921_capture.c', [
    ('''int mt_start(birriasdr_dev_t *dev)
{
    return bs_write32(dev, BS_MMIO, MT_MAILBOX + 60, 1);''', '''int mt_start(birriasdr_dev_t *dev)
{
    /* A new firmware run starts with an empty script cache. */
    dev->mt7921.fw_slots = 0;
    dev->mt7921.fw_checked = false;
    dev->mt7921.fw_off = false;
    dev->mt7921.fw_routing_known = false;
    return bs_write32(dev, BS_MMIO, MT_MAILBOX + 60, 1);'''),
])

edit('src/chips/mt7921_rf.c', [
    ('''void mt_rf_fast(bool enable)
{
    rf_options();''', '''/* Registers changed behind our back (on-chip retune): drop the shadow. */
void mt_rf_forget(void)
{
    rf_shadow_count = 0;
}

void mt_rf_fast(bool enable)
{
    rf_options();'''),
])

edit('src/chips/mt7921.h', [
    ('void mt_rf_fast(bool enable);', 'void mt_rf_fast(bool enable);\nvoid mt_rf_forget(void);'),
])

FW = r'''/* On-chip retune (BIRRIASDR_FW_TUNE). The control block and script slots live
 * in MCU data memory that the stream program does not use; see
 * firmware/iq_stream.S (run_script) for the layout and opcodes. */
#define FW_CTRL 0x02041000u
#define FW_MAGIC 0x31525446u
#define FW_SLOTS 0x02041200u
#define FW_SLOT_BYTES 512u
#define FW_NOT_HANDLED 1

static size_t fw_op(uint32_t *words, size_t n, unsigned op, uint32_t address, uint32_t a, uint32_t b)
{
    words[n] = (uint32_t)op << 24 | MT_SYNTH_PORT << 13 | address;
    words[n + 1] = a;
    words[n + 2] = b;
    return n + 3;
}

/* Same sequence as retune_high() + run_calibration() + finish_calibration(). */
static size_t fw_script(uint32_t *w, uint64_t hz, uint32_t routing, uint32_t *word_out)
{
    uint64_t divider = (hz * (UINT64_C(1) << 20) + 25000000) / 50000000;
    uint32_t word = 0x80000000u | (uint32_t)divider;
    static const unsigned boundaries[] = {4996,5196,5396,5596,5796,5996,6196,6396,6596,6796,6996,7126};
    unsigned code = 0x14;
    size_t n = 0;
    for (unsigned i = 0; i < 12; ++i) if (hz / 1000000 < boundaries[i]) { code = 0x18 + i; break; }
    n = fw_op(w, n, 2, 0x240, 0, 0xf0000000);
    n = fw_op(w, n, 2, 0x204, 0xc00000, 0xc00000);
    n = fw_op(w, n, 2, 0x21c, 0x60000, 0x60000);
    n = fw_op(w, n, 1, 0xcf8, 0x90, 0);
    n = fw_op(w, n, 1, 0xca8, word, 0);
    n = fw_op(w, n, 1, 0xcac, (uint32_t)(hz * 24 / 5000000) - 2, 0);
    n = fw_op(w, n, 2, 0xcb8, 0xffff0, code * 0x1010);
    n = fw_op(w, n, 2, 0xd20, 4, 0);
    n = fw_op(w, n, 2, 0xcc4, 0, 1u << 30);
    n = fw_op(w, n, 1, 0xce0, 0x42956473, 0);
    n = fw_op(w, n, 2, 0xcc8, 0, 1);
    n = fw_op(w, n, 2, 0xcc4, 0, 1u << 29);
    n = fw_op(w, n, 3, 0xd7c, 1u << 21, 1u << 21);
    n = fw_op(w, n, 2, 0xcc4, 1u << 29, 0);
    n = fw_op(w, n, 2, 0xcc4, 1u << 30, 0);
    n = fw_op(w, n, 4, 0xc0c, MT_SYNTH_PORT << 13 | 0xd78, 0);
    n = fw_op(w, n, 2, 0xcc4, (1u << 29) | (1u << 30), 0);
    n = fw_op(w, n, 2, 0xcc8, 1, 0);
    n = fw_op(w, n, 2, 0xd20, 0, 4);
    n = fw_op(w, n, 1, 0xce0, 0, 0);
    n = fw_op(w, n, 2, 0x240, 0xf0000000, routing & 0xf0000000);
    n = fw_op(w, n, 0, 0, 0, 0);
    *word_out = word;
    return n;
}

static int fw_mmio_write(birriasdr_dev_t *dev, uint32_t address, const uint32_t *words, size_t count)
{
    uint8_t bytes[FW_SLOT_BYTES];
    for (size_t i = 0; i < count; ++i) bs_put_le32(bytes + 4 * i, words[i]);
    ++bs_io_count;
    return bs_control(dev, 0x5f, 0x66, (uint16_t)(address >> 16), (uint16_t)address,
                      bytes, (uint16_t)(4 * count));
}

static int fw_mmio_read(birriasdr_dev_t *dev, uint32_t address, uint32_t *words, size_t count)
{
    uint8_t bytes[64];
    ++bs_io_count;
    BS_TRY(bs_control(dev, 0xdf, 0x63, (uint16_t)(address >> 16), (uint16_t)address,
                      bytes, (uint16_t)(4 * count)));
    for (size_t i = 0; i < count; ++i) words[i] = bs_get_le32(bytes + 4 * i);
    return 0;
}

static int fw_retune(birriasdr_dev_t *dev, uint64_t hz)
{
    uint32_t script[FW_SLOT_BYTES / 4], word, status[3], doorbell[2];
    unsigned slot;
    uint64_t deadline;
    size_t n;
    if (!getenv("BIRRIASDR_FW_TUNE") || dev->mt7921.fw_off ||
        atomic_load(&dev->run_state) != BS_RUNNING ||
        !(dev->open_flags & BIRRIASDR_OPEN_EXPERIMENTAL_TUNING) || hz < UINT64_C(4000000000))
        return FW_NOT_HANDLED;
    if (!dev->mt7921.fw_checked) {
        uint32_t magic;
        BS_TRY(fw_mmio_read(dev, FW_CTRL, &magic, 1));
        dev->mt7921.fw_checked = true;
        dev->mt7921.fw_off = magic != FW_MAGIC;
        if (dev->mt7921.fw_off) return FW_NOT_HANDLED;
    }
    BS_TRY(select_band(dev, true));
    if (!dev->mt7921.fw_routing_known) {
        BS_TRY(mt_rf_read(dev, MT_SYNTH_PORT, 0x240, &dev->mt7921.fw_routing));
        dev->mt7921.fw_routing_known = true;
    }
    n = fw_script(script, hz, dev->mt7921.fw_routing, &word);
    if (n > FW_SLOT_BYTES / 4) return FW_NOT_HANDLED;   /* never overrun a slot */
    for (slot = 0; slot < dev->mt7921.fw_slots; ++slot)
        if (dev->mt7921.fw_slot_hz[slot] == hz) break;
    if (slot == dev->mt7921.fw_slots) {
        if (slot == 64) slot = 63;               /* cache full: reuse the last slot */
        BS_TRY(fw_mmio_write(dev, FW_SLOTS + slot * FW_SLOT_BYTES, script, n));
        dev->mt7921.fw_slot_hz[slot] = hz;
        if (slot == dev->mt7921.fw_slots) ++dev->mt7921.fw_slots;
    }
    doorbell[0] = FW_SLOTS + slot * FW_SLOT_BYTES;
    doorbell[1] = ++dev->mt7921.fw_sequence;
    BS_TRY(fw_mmio_write(dev, FW_CTRL + 4, doorbell, 2));
    mt_rf_forget();
    deadline = bs_now_ns() + UINT64_C(20000000);
    for (;;) {
        BS_TRY(fw_mmio_read(dev, FW_CTRL + 12, status, 3));
        if (status[0] == doorbell[1]) break;
        if (bs_now_ns() > deadline) {
            dev->mt7921.fw_off = true;           /* back to the host path for this stream */
            return FW_NOT_HANDLED;
        }
    }
    if (getenv("BIRRIASDR_TRACE_TUNE"))
        fprintf(stderr, "fw retune %llu Hz: slot %u, %u us on chip, status %u\n",
                (unsigned long long)hz, slot, status[2], status[1]);
    if (status[1]) return BIRRIASDR_ERROR_STATE;
    if (!getenv("BIRRIASDR_FAST_TUNE")) {
        uint32_t actual;
        BS_TRY(mt_rf_read(dev, MT_SYNTH_PORT, 0xca8, &actual));
        if (actual != (word & 0x7fffffff)) return BIRRIASDR_ERROR_STATE;
    }
    return 0;
}

int mt_change_frequency(birriasdr_dev_t *dev, uint64_t frequency_hz)'''

# Upgrade a tree patched by the first version (256-byte slots overflowed: the
# script is 66 words).
t = root / 'src/chips/mt7921_tune.c'
s = t.read_text()
if '#define FW_SLOT_BYTES 256u' in s:
    s = s.replace('#define FW_SLOT_BYTES 256u', '#define FW_SLOT_BYTES 512u')
    s = s.replace('''    n = fw_script(script, hz, dev->mt7921.fw_routing, &word);
''', '''    n = fw_script(script, hz, dev->mt7921.fw_routing, &word);
    if (n > FW_SLOT_BYTES / 4) return FW_NOT_HANDLED;   /* never overrun a slot */
''', 1)
    t.write_text(s)
    print('upgraded src/chips/mt7921_tune.c to 512-byte script slots')

edit('src/chips/mt7921_tune.c', [
    ('int mt_change_frequency(birriasdr_dev_t *dev, uint64_t frequency_hz)', FW,
     'static int fw_retune('),
    ('''        mt_rf_fast(true);
        result = mt_set_frequency(dev, frequency_hz);''', '''        mt_rf_fast(true);
        result = fw_retune(dev, frequency_hz);
        if (result == FW_NOT_HANDLED)
            result = mt_set_frequency(dev, frequency_hz);'''),
    ('''    BS_TRY(fw_mmio_write(dev, FW_CTRL + 4, doorbell, 2));
    mt_rf_forget();
''', '''    BS_TRY(fw_mmio_write(dev, FW_CTRL + 4, doorbell, 2));
    mt_rf_forget();
    {   /* The script takes ~0.6-1 ms on chip: poll less, leave USB to the samples. */
        uint64_t first = bs_now_ns() + UINT64_C(500000);
        while (bs_now_ns() < first) {}
    }
'''),
])
s = (root / 'src/chips/mt7921_tune.c').read_text()
for inc in ('#include <stdio.h>', '#include <stdlib.h>'):
    if inc not in s:
        s = s.replace('#include "mt7921.h"', '#include "mt7921.h"\n' + inc, 1)
(root / 'src/chips/mt7921_tune.c').write_text(s)
print('done')
