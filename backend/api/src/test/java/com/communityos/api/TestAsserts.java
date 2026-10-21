package com.communityos.api;

/** The one assertion the JUnit shim lacks. */
public final class TestAsserts {
    private TestAsserts() {}
    public static void assertNotEquals(Object a, Object b) { if (java.util.Objects.equals(a, b)) throw new AssertionError("expected different values but both were <" + a + ">"); }
}
