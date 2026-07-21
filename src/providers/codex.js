'use strict';

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Usage = Me.imports.src.domain.usage;

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}

function looksLikeRemainingKey(key) {
    const lower = key.toLowerCase();
    return (lower.includes('remaining') || lower.includes('left') || lower.includes('available')) &&
        (lower.includes('percent') || lower.includes('pct') || lower.endsWith('_p') || lower === 'remaining');
}

function looksLikeUsedKey(key) {
    const lower = key.toLowerCase();
    return (lower.includes('used') || lower.includes('usage')) &&
        (lower.includes('percent') || lower.includes('pct') || lower === 'used');
}

function collectUsageBuckets(value, path = 'usage', buckets = []) {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => collectUsageBuckets(entry, `${path}[${index}]`, buckets));
        return buckets;
    }
    if (!isObject(value))
        return buckets;

    let remaining = null;
    let used = null;
    let limit = null;
    let reset = null;
    const label = value.name || value.label || value.window || value.type || path;
    for (const [key, raw] of Object.entries(value)) {
        const number = numberValue(raw);
        const lower = key.toLowerCase();
        if (number !== null) {
            if (looksLikeRemainingKey(key))
                remaining = Usage.clampPercent(number);
            else if (looksLikeUsedKey(key))
                used = Usage.clampPercent(number);
            else if (lower === 'limit' || lower.endsWith('_limit') || lower.includes('quota'))
                limit = number;
            else if (lower === 'used' || lower.endsWith('_used'))
                used = number;
            else if (lower === 'remaining' || lower.endsWith('_remaining'))
                remaining = number;
            if ((lower.includes('reset') || lower.includes('renew')) && number > 0)
                reset = new Date(number < 100000000000 ? number * 1000 : number).toISOString();
        } else if (typeof raw === 'string' && (lower.includes('reset') || lower.includes('renew'))) {
            reset = raw;
        }
    }
    if (remaining === null && limit !== null && used !== null && limit > 0)
        remaining = Usage.clampPercent(((limit - used) / limit) * 100);
    if (remaining === null && used !== null && used >= 0 && used <= 100)
        remaining = Usage.clampPercent(100 - used);
    if (remaining !== null)
        buckets.push({ label: String(label), remaining, reset });

    for (const [key, raw] of Object.entries(value)) {
        if (isObject(raw) || Array.isArray(raw))
            collectUsageBuckets(raw, `${path}.${key}`, buckets);
    }
    return buckets;
}

function formatWindow(seconds) {
    if (seconds >= 6 * 86400)
        return '주간';
    if (seconds >= 4 * 3600 && seconds <= 6 * 3600)
        return '5시간';
    if (seconds >= 3600)
        return `${Math.round(seconds / 3600)}시간`;
    return '사용량';
}

function bucketFromWindow(window, productName) {
    if (!isObject(window))
        return null;

    const used = Usage.clampPercent(numberValue(window.used_percent));
    if (used === null)
        return null;

    const resetAt = numberValue(window.reset_at);
    return {
        label: `${productName} · ${formatWindow(numberValue(window.limit_window_seconds) || 0)}`,
        remaining: 100 - used,
        reset: resetAt ? new Date(resetAt * 1000).toISOString() : null,
    };
}

function codexUsageBuckets(json) {
    const buckets = [];
    const base = json?.rate_limit;
    for (const window of [base?.primary_window, base?.secondary_window]) {
        const bucket = bucketFromWindow(window, 'Codex');
        if (bucket)
            buckets.push(bucket);
    }

    for (const additional of json?.additional_rate_limits || []) {
        const name = additional?.limit_name || '추가 모델';
        for (const window of [additional?.rate_limit?.primary_window, additional?.rate_limit?.secondary_window]) {
            const bucket = bucketFromWindow(window, name);
            if (bucket)
                buckets.push(bucket);
        }
    }
    return buckets;
}

// A provider contains service-specific authentication and response parsing;
// platform work is injected through runtime so it can be replaced elsewhere.
var CodexUsageProvider = class CodexUsageProvider {
    constructor(runtime) {
        this.id = 'codex';
        this.displayName = 'Codex';
        this._runtime = runtime;
    }

    isActive() {
        return this._runtime.isProcessRunning('codex');
    }

    fetchUsage(callback) {
        let token;
        try {
            const authPath = this._runtime.getCodexAuthPath();
            const auth = JSON.parse(this._runtime.readTextFile(authPath));
            token = auth?.tokens?.access_token || auth?.access_token;
            if (!token)
                throw new Error(`No access token in ${authPath}; run: codex login`);
        } catch (error) {
            callback(error, null);
            return;
        }

        this._runtime.fetchJson(USAGE_URL, {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': 'codex-usage-gnome-extension/1.0',
        }, (error, json) => {
            if (error) {
                callback(error, null);
                return;
            }
            let buckets = codexUsageBuckets(json);
            // Retain support for an API schema change without exposing its
            // internal JSON paths in the GNOME UI.
            if (buckets.length === 0)
                buckets = collectUsageBuckets(json).filter(bucket => Number.isFinite(bucket.remaining));
            callback(null, Usage.createSummary(buckets));
        });
    }
};
