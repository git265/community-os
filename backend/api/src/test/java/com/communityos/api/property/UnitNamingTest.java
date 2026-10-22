package com.communityos.api.property;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.property.domain.UnitNaming;
import com.communityos.api.shared.domain.DomainException;
import org.junit.jupiter.api.Test;

/** How unit numbers are written: the character rules, naming patterns, numbers made for bulk add. */
class UnitNamingTest {
    @Test void characterRules() {
        assertEquals("Villa 12", UnitNaming.normalize("  Villa   12 "));
        assertEquals("villa 12", UnitNaming.key(" VILLA  12"));
        assertNull(UnitNaming.problem("A-1204", null, null)); assertNull(UnitNaming.problem("T2/0101", null, null)); assertNull(UnitNaming.problem("Ph.1 12B", null, null));
        assertNotNull(UnitNaming.problem("", null, null));
        assertNotNull(UnitNaming.problem("Villa #12", null, null), "no #");
        assertNotNull(UnitNaming.problem("-12", null, null), "starts with a letter or digit");
        assertNotNull(UnitNaming.problem("12-", null, null), "ends with one");
        assertNotNull(UnitNaming.problem("x".repeat(41), null, null));
        assertEquals("Villa 12", UnitNaming.check(" Villa  12 ", null, null));
    }

    @Test void patterns() {
        assertNull(UnitNaming.problem("Villa 7", "Villa {n}", null)); assertNull(UnitNaming.problem("villa 135", "Villa {n}", null), "the text ignores case");
        assertNotNull(UnitNaming.problem("V7", "Villa {n}", null));
        assertNull(UnitNaming.problem("A-007", "A-{n:3}", null)); assertNotNull(UnitNaming.problem("A-07", "A-{n:3}", null), "exactly 3 digits");
        assertNull(UnitNaming.problem("T2-1204", "{block}-{floor}{n:2}", "T2"));
        assertNotNull(UnitNaming.problem("T3-1204", "{block}-{floor}{n:2}", "T2"), "another block's code");
        assertNotNull(UnitNaming.problem("T2-1204", "{block}-{floor}{n:2}", null), "{block} needs a block");
        assertNull(UnitNaming.problem("12B", "{n}{letter}", null)); assertNotNull(UnitNaming.problem("12BB", "{n}{letter}", null));
        String why = UnitNaming.problem("V7", "Villa {n}", null);
        assertTrue(why.contains("Villa {n}") && why.contains("Villa 1"), "says the pattern and gives an example: " + why);
    }

    @Test void savingAPattern() {
        assertNull(UnitNaming.checkPattern("  "));
        assertEquals("Villa {n}", UnitNaming.checkPattern(" Villa {n} "));
        assertThrows(DomainException.RuleViolated.class, () -> UnitNaming.checkPattern("Villa {num}"), "unknown part");
        assertThrows(DomainException.RuleViolated.class, () -> UnitNaming.checkPattern("{n}-{n}"), "twice");
        assertThrows(DomainException.RuleViolated.class, () -> UnitNaming.checkPattern("{block}"), "nothing varies");
        assertThrows(DomainException.RuleViolated.class, () -> UnitNaming.checkPattern("Villa # {n}"), "characters");
        assertThrows(DomainException.RuleViolated.class, () -> UnitNaming.checkPattern("{n:9}"), "width 1-6");
    }

    @Test void numbersForBulkAdd() {
        assertEquals("Villa 7", UnitNaming.make("Villa {n}", null, null, 7));
        assertEquals("T2-1204", UnitNaming.make("{block}-{floor}{n:2}", "T2", 12, 4));
        assertNull(UnitNaming.make("{block}-{floor}{n:2}", "T2", null, 4), "a floor is needed");
        assertNull(UnitNaming.make("{n}{letter}", null, null, 4), "a letter cannot be made up");
    }

    @Test void villasAndTowersTogether() {
        String p = "Villa {n} or {block}-{floor}{n:2}";
        assertEquals(p, UnitNaming.checkPattern("  " + p + " "));
        assertEquals(java.util.List.of("Villa {n}", "{block}-{floor}{n:2}"), UnitNaming.alternatives("Villa {n} | {block}-{floor}{n:2}"));
        assertNull(UnitNaming.problem("Villa 135", p, null), "a villa without a block");
        assertNull(UnitNaming.problem("A-1204", p, "A"), "a flat in block A");
        assertNull(UnitNaming.problem("Villa 7", p, "A"), "either alternative, whatever the block");
        String why = UnitNaming.problem("Flat 9", p, "A");
        assertTrue(why.contains("Villa 1 or A-101"), why);
        assertNotNull(UnitNaming.problem("-101", p, null), "{block} is not matched by nothing");
        assertEquals("Villa 3", UnitNaming.make(p, null, null, 3), "the first alternative that can be made");
        assertEquals("bad-pattern", assertThrows(com.communityos.api.shared.domain.DomainException.RuleViolated.class, () -> UnitNaming.checkPattern("Villa {n} or villa {n}")).code());
        assertTrue(assertThrows(com.communityos.api.shared.domain.DomainException.RuleViolated.class, () -> UnitNaming.checkPattern("Villa {n} or {num}")).getMessage().startsWith("“{num}”"));
        assertTrue(assertThrows(com.communityos.api.shared.domain.DomainException.RuleViolated.class, () -> UnitNaming.checkPattern("A-{n}, B-{n}")).getMessage().contains("“or”"), "a comma is not a separator");
    }
}
