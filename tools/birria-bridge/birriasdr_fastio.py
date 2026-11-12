"""Apply the 'fast live retune' changes to a BirriaSDR source tree (idempotent).

Run: python birriasdr_fastio.py PATH\\TO\\birriasdr
Changes (live retunes only, boot/startup paths untouched except the poll spin):
 1. io.c bs_poll32: spin on reads for the first 2 ms instead of sleeping 100 us
    (Windows rounds that sleep up to ~1 ms or more).
 2. io.c: count USB register reads/writes (bs_io_count) for tracing.
 3. mt7921_rf.c rf_transfer: during a live retune, cache the command register's
    upper half and skip the pre-transfer busy poll when our own previous transfer
    already saw the bridge idle. Saves 2 of ~6 USB round trips per RF access.
 4. mt7921_tune.c mt_change_frequency: enable 3 for its duration; with env
    BIRRIASDR_TRACE_TUNE=1 print USB ops and microseconds per retune to stderr.
"""
import re, sys
from pathlib import Path

root = Path(sys.argv[1])
def edit(rel, pairs):
    p = root / rel
    s = p.read_text()
    for old, new in pairs:
        marker = next((l for l in new.splitlines() if l.strip() and l not in old), new)
        if new in s or marker in s:
            continue                       # already applied
        if old not in s:
            sys.exit(f'{rel}: anchor not found:\n{old}')
        s = s.replace(old, new, 1)
    p.write_text(s)
    print('patched', rel)

edit('src/io.c', [
("""int bs_read32(birriasdr_dev_t *dev, enum bs_space space, uint32_t address, uint32_t *value)
{
    return""", """unsigned long long bs_io_count;

int bs_read32(birriasdr_dev_t *dev, enum bs_space space, uint32_t address, uint32_t *value)
{
    ++bs_io_count;
    return"""),
("""int bs_write32(birriasdr_dev_t *dev, enum bs_space space, uint32_t address, uint32_t value)
{
    return""", """int bs_write32(birriasdr_dev_t *dev, enum bs_space space, uint32_t address, uint32_t value)
{
    ++bs_io_count;
    return"""),
("""    uint64_t deadline = bs_now_ns() + (uint64_t)timeout_ms * 1000000u;
    do {
        uint32_t value;
        BS_TRY(bs_read32(dev, space, address, &value));
        if ((value & mask) == expected)
            return 0;
        bs_sleep_us(100);""", """    uint64_t start = bs_now_ns();
    uint64_t deadline = start + (uint64_t)timeout_ms * 1000000u;
    do {
        uint32_t value;
        BS_TRY(bs_read32(dev, space, address, &value));
        if ((value & mask) == expected)
            return 0;
        /* Each read is already a USB round trip; spin for the first 2 ms. */
        if (bs_now_ns() - start > 2000000u)
            bs_sleep_us(100);"""),
])

edit('src/chips/mt7921_rf.c', [
("""static int rf_transfer(birriasdr_dev_t *dev, unsigned port, uint32_t address,
                       uint32_t *value, bool read)
{""", """/* Live-retune fast path (single device, control mutex held): remember the
 * command register's upper half and whether our last transfer left the bridge
 * idle, so a transfer needs no read-before-write and no pre-poll. */
static bool rf_fast;
static bool rf_idle[2], rf_known[2];
static uint32_t rf_upper[2];

void mt_rf_fast(bool enable)
{
    rf_fast = enable;
    rf_idle[0] = rf_idle[1] = rf_known[0] = rf_known[1] = false;
}

static int rf_transfer(birriasdr_dev_t *dev, unsigned port, uint32_t address,
                       uint32_t *value, bool read)
{"""),
("""    BS_TRY(bs_poll32(dev, BS_BRIDGE, base, busy, 0, 100));
    BS_TRY(bs_read32(dev, BS_BRIDGE, command, &control));
    control = (control & 0xffff0000u) | port << 13 | address | (read ? 0x1000 : 0);
    BS_TRY(bs_write32(dev, BS_BRIDGE, command, control));
    BS_TRY(bs_write32(dev, BS_BRIDGE, command + 4, read ? 0 : *value));
    BS_TRY(bs_poll32(dev, BS_BRIDGE, base, busy, 0, 100));
    return read ? bs_read32(dev, BS_BRIDGE, command + 8, value) : 0;""", """    unsigned slot = port == MT_TOP_PORT;
    int result;
    if (!(rf_fast && rf_idle[slot]))
        BS_TRY(bs_poll32(dev, BS_BRIDGE, base, busy, 0, 100));
    rf_idle[slot] = false;
    if (!(rf_fast && rf_known[slot])) {
        BS_TRY(bs_read32(dev, BS_BRIDGE, command, &control));
        rf_upper[slot] = control & 0xffff0000u;
        rf_known[slot] = true;
    }
    control = rf_upper[slot] | port << 13 | address | (read ? 0x1000 : 0);
    BS_TRY(bs_write32(dev, BS_BRIDGE, command, control));
    BS_TRY(bs_write32(dev, BS_BRIDGE, command + 4, read ? 0 : *value));
    BS_TRY(bs_poll32(dev, BS_BRIDGE, base, busy, 0, 100));
    rf_idle[slot] = true;
    if (!read) return 0;
    result = bs_read32(dev, BS_BRIDGE, command + 8, value);
    if (result < 0) rf_idle[slot] = false;
    return result;"""),
])

edit('src/chips/mt7921.h', [
("""int mt_set_frequency(birriasdr_dev_t *dev, uint64_t frequency_hz);""",
"""int mt_set_frequency(birriasdr_dev_t *dev, uint64_t frequency_hz);
void mt_rf_fast(bool enable);
extern unsigned long long bs_io_count;"""),
])

edit('src/chips/mt7921_tune.c', [
("""    result = mt_set_frequency(dev, frequency_hz);
    if (result < 0 && mt_set_frequency(dev, dev->frequency) < 0)
        return BIRRIASDR_ERROR_STATE;
    return result;""", """    {
        static int trace = -1;
        unsigned long long ops = bs_io_count;
        uint64_t start = bs_now_ns();
        if (trace < 0) trace = getenv("BIRRIASDR_TRACE_TUNE") != NULL;
        mt_rf_fast(true);
        result = mt_set_frequency(dev, frequency_hz);
        mt_rf_fast(false);
        if (trace)
            fprintf(stderr, "retune %llu Hz: %llu usb ops, %llu us, result %d\\n",
                    (unsigned long long)frequency_hz, bs_io_count - ops,
                    (unsigned long long)((bs_now_ns() - start) / 1000), result);
    }
    if (result < 0 && mt_set_frequency(dev, dev->frequency) < 0)
        return BIRRIASDR_ERROR_STATE;
    return result;"""),
])
s = (root / 'src/chips/mt7921_tune.c').read_text()
for inc in ('#include <stdlib.h>', '#include <stdio.h>'):
    if inc not in s:
        s = s.replace('#include "mt7921.h"', '#include "mt7921.h"\n' + inc, 1)
(root / 'src/chips/mt7921_tune.c').write_text(s)
print('done')
