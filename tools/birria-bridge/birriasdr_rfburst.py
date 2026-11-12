"""Second fast-retune step for BirriaSDR (apply after birriasdr_fastio.py; idempotent).

Run: python birriasdr_rfburst.py PATH\\TO\\birriasdr
During live retunes only (mt_rf_fast), all opt-in and measured with
BIRRIASDR_TRACE_TUNE=1:
  BIRRIASDR_RF_SHADOW=1  read-modify-write uses the last value we read or wrote
                         for that RF register instead of a fresh read (saves 4
                         USB ops per update). Status reads stay real reads.
  BIRRIASDR_RF_BURST=1   write the bridge's command and data words in one 8-byte
                         vendor write (mt76's WRITE_EXT accepts multiple words).
  BIRRIASDR_RF_NOPOLL=1  skip the busy poll after a write (a USB round trip
                         outlasts the SPI transfer); reads still poll.
With SHADOW, the retune's routing read (RF 0x240) also comes from the shadow.
BIRRIASDR_FAST_TUNE=1 (earlier patch) skips only the final readback. Never use
=2: it skips PLL calibration and reception is lost.
The final frequency readback of each retune catches a broken combination.
"""
import sys
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
            sys.exit(f'{rel}: anchor not found (apply birriasdr_fastio.py first?):\n{old}')
        s = s.replace(old, new, 1)
    p.write_text(s)
    print('patched', rel)

edit('src/chips/mt7921_rf.c', [
("""void mt_rf_fast(bool enable)
{
    rf_fast = enable;""", """/* Shadow of RF registers we read or wrote, keyed by port/address. */
#define RF_SHADOW 64
static struct { uint32_t key, value; } rf_shadow[RF_SHADOW];
static unsigned rf_shadow_count;
static int rf_opt_shadow = -1, rf_opt_burst, rf_opt_nopoll;

static void rf_options(void)
{
    if (rf_opt_shadow >= 0) return;
    rf_opt_shadow = getenv("BIRRIASDR_RF_SHADOW") != NULL;
    rf_opt_burst = getenv("BIRRIASDR_RF_BURST") != NULL;
    rf_opt_nopoll = getenv("BIRRIASDR_RF_NOPOLL") != NULL;
}

static uint32_t *rf_shadow_slot(unsigned port, uint32_t address, bool create)
{
    uint32_t key = port << 16 | address;
    for (unsigned i = 0; i < rf_shadow_count; ++i)
        if (rf_shadow[i].key == key) return &rf_shadow[i].value;
    if (!create || rf_shadow_count == RF_SHADOW) return NULL;
    rf_shadow[rf_shadow_count].key = key;
    return &rf_shadow[rf_shadow_count++].value;
}

static void rf_remember(unsigned port, uint32_t address, uint32_t value)
{
    uint32_t *slot = rf_shadow_slot(port, address, true);
    if (slot) *slot = value;
}

void mt_rf_fast(bool enable)
{
    rf_options();
    rf_fast = enable;"""),
("""    control = rf_upper[slot] | port << 13 | address | (read ? 0x1000 : 0);
    BS_TRY(bs_write32(dev, BS_BRIDGE, command, control));
    BS_TRY(bs_write32(dev, BS_BRIDGE, command + 4, read ? 0 : *value));
    BS_TRY(bs_poll32(dev, BS_BRIDGE, base, busy, 0, 100));
    rf_idle[slot] = true;
    if (!read) return 0;""", """    control = rf_upper[slot] | port << 13 | address | (read ? 0x1000 : 0);
    if (rf_fast && rf_opt_burst) {
        uint8_t words[8];
        bs_put_le32(words, control);
        bs_put_le32(words + 4, read ? 0 : *value);
        ++bs_io_count;
        BS_TRY(bs_control(dev, 0x40, 0x66, (uint16_t)(command >> 16), (uint16_t)command,
                          words, sizeof(words)));
    } else {
        BS_TRY(bs_write32(dev, BS_BRIDGE, command, control));
        BS_TRY(bs_write32(dev, BS_BRIDGE, command + 4, read ? 0 : *value));
    }
    if (!read && rf_fast && rf_opt_nopoll) {
        rf_idle[slot] = false;              /* the next access polls first */
        rf_remember(port, address, *value);
        return 0;
    }
    BS_TRY(bs_poll32(dev, BS_BRIDGE, base, busy, 0, 100));
    rf_idle[slot] = true;
    if (!read) {
        rf_remember(port, address, *value);
        return 0;
    }"""),
("""    result = bs_read32(dev, BS_BRIDGE, command + 8, value);
    if (result < 0) rf_idle[slot] = false;
    return result;""", """    result = bs_read32(dev, BS_BRIDGE, command + 8, value);
    if (result < 0) rf_idle[slot] = false;
    else rf_remember(port, address, *value);
    return result;"""),
("""    uint32_t value;
    BS_TRY(mt_rf_read(dev, port, address, &value));
    return mt_rf_write(dev, port, address, (value & ~clear) | set);""", """    uint32_t value, *known = rf_fast && rf_opt_shadow ? rf_shadow_slot(port, address, false) : NULL;
    if (known)
        value = *known;
    else
        BS_TRY(mt_rf_read(dev, port, address, &value));
    return mt_rf_write(dev, port, address, (value & ~clear) | set);"""),
("""static void rf_remember(unsigned port, uint32_t address, uint32_t value)
{
    uint32_t *slot = rf_shadow_slot(port, address, true);""", """static void rf_remember(unsigned port, uint32_t address, uint32_t value)
{
    /* Startup touches far more registers than the table holds, and any access
     * outside a live retune may change them: keep only the retune's own. */
    if (!rf_fast) {
        rf_shadow_count = 0;
        return;
    }
    uint32_t *slot = rf_shadow_slot(port, address, true);"""),
("""    rf_opt_nopoll = getenv("BIRRIASDR_RF_NOPOLL") != NULL;
}""", """    rf_opt_nopoll = getenv("BIRRIASDR_RF_NOPOLL") != NULL;
    if (getenv("BIRRIASDR_TRACE_TUNE"))
        fprintf(stderr, "rf options: shadow %d burst %d nopoll %d\\n",
                rf_opt_shadow, rf_opt_burst, rf_opt_nopoll);
}"""),
("""        rf_idle[slot] = false;              /* the next access polls first */""",
 """        /* A USB round trip (~80 us) outlasts the SPI transfer: treat the
         * bridge as idle. The retune's final readback still checks it. */
        rf_idle[slot] = true;"""),
("""/* Read one analog register; TOP and Wi-Fi banks are explicitly distinguished. */""",
 """/* During a live retune with BIRRIASDR_RF_SHADOW, return a register we set
 * ourselves from the shadow (never use this for status registers). */
int mt_rf_read_shadow(birriasdr_dev_t *dev, unsigned port, uint32_t address, uint32_t *value)
{
    uint32_t *known = rf_fast && rf_opt_shadow ? rf_shadow_slot(port, address, false) : NULL;
    if (!known) return mt_rf_read(dev, port, address, value);
    *value = *known;
    return 0;
}

/* Read one analog register; TOP and Wi-Fi banks are explicitly distinguished. */"""),
])
edit('src/chips/mt7921.h', [
("""void mt_rf_fast(bool enable);""", """void mt_rf_fast(bool enable);
int mt_rf_read_shadow(birriasdr_dev_t *dev, unsigned port, uint32_t address, uint32_t *value);"""),
])
edit('src/chips/mt7921_tune.c', [
("""    BS_TRY(mt_rf_read(dev,MT_SYNTH_PORT,0x240,&routing));
    int result=mt_rf_update(dev,MT_SYNTH_PORT,0x240,0,0xf0000000);""",
 """    BS_TRY(mt_rf_read_shadow(dev,MT_SYNTH_PORT,0x240,&routing));
    int result=mt_rf_update(dev,MT_SYNTH_PORT,0x240,0,0xf0000000);"""),
])
s = (root / 'src/chips/mt7921_rf.c').read_text()
if '#include <stdio.h>' not in s:
    s = s.replace('#include "mt7921.h"', '#include "mt7921.h"\n#include <stdio.h>', 1)
if '#include <stdlib.h>' not in s:
    s = s.replace('#include "mt7921.h"', '#include "mt7921.h"\n#include <stdlib.h>', 1)
(root / 'src/chips/mt7921_rf.c').write_text(s)
print('done')
