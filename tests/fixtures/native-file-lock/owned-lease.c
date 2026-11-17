/*
 * Qualification build wrapper around the sole private Locks native source.
 * Zones: native resource lifetime, disposable validation
 * Fault switches remain fixture-only; distribution builds reject them.
 */
#include "../../../native/locks.c"
