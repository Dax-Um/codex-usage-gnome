'use strict';

// Provider-neutral quota model. Providers only need to return buckets in this
// shape, so the UI does not need to know which service supplied them.
var DEFAULT_FAILURE_BUCKETS = [
    { label: 'Codex · 5시간', remaining: 0 },
    { label: 'Codex · 주간', remaining: 0 },
];

function clampPercent(value) {
    if (!Number.isFinite(value))
        return null;
    if (value <= 1 && value >= 0)
        value *= 100;
    return Math.max(0, Math.min(100, value));
}

function createSummary(buckets) {
    const validBuckets = buckets.filter(bucket => Number.isFinite(bucket.remaining));
    if (validBuckets.length === 0) {
        return {
            detail: 'No recognizable usage percentages in response.',
            buckets: [],
        };
    }

    const tightest = validBuckets.reduce((lowest, bucket) =>
        bucket.remaining < lowest.remaining ? bucket : lowest, validBuckets[0]);
    return {
        detail: `${Math.round(tightest.remaining)}% remaining`,
        buckets: validBuckets,
    };
}

function createFailureSummary(lastSummary, fallbackBuckets = DEFAULT_FAILURE_BUCKETS) {
    const source = lastSummary?.buckets?.length > 0 ? lastSummary.buckets : fallbackBuckets;
    return {
        detail: null,
        buckets: source.map(bucket => ({ ...bucket, remaining: 0 })),
    };
}
