'use strict';

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const St = imports.gi.St;
const Soup = imports.gi.Soup;
const Clutter = imports.gi.Clutter;
const Cairo = imports.cairo;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const AUTH_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'auth.json']);
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REFRESH_SECONDS = 60;
const ACTIVITY_CHECK_SECONDS = 5;
const REQUEST_TIMEOUT_SECONDS = 20;
const DEFAULT_FAILURE_BUCKETS = [
    { label: 'Codex · 5시간', remaining: 0 },
    { label: 'Codex · 주간', remaining: 0 },
];

let indicator = null;

function readTextFile(path) {
    const file = Gio.File.new_for_path(path);
    const [ok, bytes] = file.load_contents(null);
    if (!ok)
        throw new Error(`Could not read ${path}`);
    return imports.byteArray.toString(bytes);
}

function readAccessToken() {
    const auth = JSON.parse(readTextFile(AUTH_PATH));
    const token = auth?.tokens?.access_token || auth?.access_token;
    if (!token)
        throw new Error(`No access token in ${AUTH_PATH}; run: codex login`);
    return token;
}

function isCodexRunning() {
    // `codex` is the CLI's process name after its Node launcher execs the
    // native binary.  Keep this separate from usage polling: checking every
    // few seconds makes the indicator appear promptly without hitting the
    // account API until Codex is actually in use.
    try {
        const [, , , status] = GLib.spawn_command_line_sync('pgrep -x codex');
        return status === 0;
    } catch (_error) {
        return false;
    }
}

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

function clampPercent(value) {
    if (!Number.isFinite(value))
        return null;
    if (value <= 1 && value >= 0)
        value *= 100;
    return Math.max(0, Math.min(100, value));
}

function looksLikeRemainingKey(key) {
    const k = key.toLowerCase();
    return (k.includes('remaining') || k.includes('left') || k.includes('available')) &&
        (k.includes('percent') || k.includes('pct') || k.endsWith('_p') || k === 'remaining');
}

function looksLikeUsedKey(key) {
    const k = key.toLowerCase();
    return (k.includes('used') || k.includes('usage')) &&
        (k.includes('percent') || k.includes('pct') || k === 'used');
}

function looksLikeResetKey(key) {
    const k = key.toLowerCase();
    return k.includes('reset') || k.includes('resets') || k.includes('renew');
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
    let label = value.name || value.label || value.window || value.type || path;

    for (const [key, raw] of Object.entries(value)) {
        const n = numberValue(raw);
        const k = key.toLowerCase();

        if (n !== null) {
            if (looksLikeRemainingKey(key))
                remaining = clampPercent(n);
            else if (looksLikeUsedKey(key))
                used = clampPercent(n);
            else if (k === 'limit' || k.endsWith('_limit') || k.includes('quota'))
                limit = n;
            else if (k === 'used' || k.endsWith('_used'))
                used = n;
            else if (k === 'remaining' || k.endsWith('_remaining'))
                remaining = n;
            if (looksLikeResetKey(key) && n > 0) {
                const millis = n < 100000000000 ? n * 1000 : n;
                reset = new Date(millis).toISOString();
            }
        } else if (typeof raw === 'string' && looksLikeResetKey(key)) {
            reset = raw;
        }
    }

    if (remaining === null && limit !== null && used !== null && limit > 0)
        remaining = clampPercent(((limit - used) / limit) * 100);

    if (remaining === null && used !== null && used >= 0 && used <= 100)
        remaining = clampPercent(100 - used);

    if (remaining !== null) {
        buckets.push({
            label: String(label),
            remaining,
            reset,
        });
    }

    for (const [key, raw] of Object.entries(value)) {
        if (isObject(raw) || Array.isArray(raw))
            collectUsageBuckets(raw, `${path}.${key}`, buckets);
    }

    return buckets;
}

function formatReset(reset) {
    if (!reset)
        return '';

    const timestamp = Date.parse(reset);
    if (!Number.isFinite(timestamp))
        return ` reset ${reset}`;

    const seconds = Math.max(0, Math.floor((timestamp - Date.now()) / 1000));
    if (seconds < 60)
        return ' resets <1m';
    if (seconds < 3600)
        return ` resets ${Math.ceil(seconds / 60)}m`;
    if (seconds < 86400)
        return ` resets ${Math.ceil(seconds / 3600)}h`;
    return ` resets ${Math.ceil(seconds / 86400)}d`;
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

    const used = clampPercent(numberValue(window.used_percent));
    if (used === null)
        return null;

    const resetAt = numberValue(window.reset_at);
    return {
        label: `${productName} · ${formatWindow(numberValue(window.limit_window_seconds) || 0)}`,
        remaining: 100 - used,
        reset: resetAt ? new Date(resetAt * 1000).toISOString() : null,
    };
}

// The WHAM endpoint has an explicit schema.  Reading it directly avoids
// displaying implementation paths such as "usage.rate_limit.primary_window".
function knownUsageBuckets(json) {
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

function batteryBar(percent) {
    const filled = Math.round(percent / 10);
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function panelBucketLabel(bucket) {
    const label = bucket.label;
    if (label.includes('Codex-Spark') || label.includes('codex-spark') || label.includes('Spark')) {
        return 'Spark:';
    }
    if (label.includes('주간'))
        return 'Weekly:';
    if (label.includes('5시간'))
        return '5-hour:';
    return `${label.replace(/^Codex\s*·\s*/, '')}:`;
}

// GNOME's symbolic battery glyph is portrait-oriented.  Draw a compact
// landscape version so quota reads like the iPhone-style battery indicator.
var HorizontalBattery = GObject.registerClass(
class HorizontalBattery extends St.DrawingArea {
    _init() {
        super._init({
            width: 25,
            height: 13,
            y_align: Clutter.ActorAlign.CENTER,
            // The drawn battery's optical centre sits slightly above a
            // panel label's glyph centre; nudge it down by one pixel.
            translation_y: 1,
        });
        this._percent = 0;
        this.connect('repaint', () => this._draw());
    }

    setPercent(percent) {
        this._percent = Math.max(0, Math.min(100, percent));
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const bodyX = 1;
        const bodyY = 2;
        const bodyWidth = width - 5;
        const bodyHeight = height - 4;
        const radius = 2;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        cr.setLineWidth(1.4);
        cr.setSourceRGBA(0.95, 0.96, 0.97, 0.92);
        cr.newSubPath();
        cr.arc(bodyX + radius, bodyY + radius, radius, Math.PI, Math.PI * 1.5);
        cr.arc(bodyX + bodyWidth - radius, bodyY + radius, radius, Math.PI * 1.5, Math.PI * 2);
        cr.arc(bodyX + bodyWidth - radius, bodyY + bodyHeight - radius, radius, 0, Math.PI * 0.5);
        cr.arc(bodyX + radius, bodyY + bodyHeight - radius, radius, Math.PI * 0.5, Math.PI);
        cr.closePath();
        cr.stroke();

        cr.rectangle(bodyX + bodyWidth + 1, bodyY + 3, 2.5, bodyHeight - 6);
        cr.fill();

        const fillWidth = Math.max(0, (bodyWidth - 4) * this._percent / 100);
        if (fillWidth > 0) {
            const red = this._percent <= 15 ? 0.95 : 0.25;
            const green = this._percent <= 15 ? 0.30 : 0.85;
            cr.setSourceRGBA(red, green, 0.45, 0.96);
            cr.rectangle(bodyX + 2, bodyY + 2, fillWidth, bodyHeight - 4);
            cr.fill();
        }
        cr.$dispose();
    }
});

function summarizeUsage(json) {
    let buckets = knownUsageBuckets(json);
    // Retain a fallback for future API schema changes.
    if (buckets.length === 0)
        buckets = collectUsageBuckets(json)
            .filter(bucket => Number.isFinite(bucket.remaining));

    if (buckets.length === 0)
        return {
            label: 'Codex ?',
            detail: 'No recognizable usage percentages in response.',
            buckets: [],
        };

    // Keep the API's window order in the panel (5시간, 주간, then additional
    // models) while still using the tightest value for the menu summary.
    const tightest = buckets.reduce((lowest, bucket) =>
        bucket.remaining < lowest.remaining ? bucket : lowest, buckets[0]);
    return {
        label: `${Math.round(tightest.remaining)}%`,
        detail: `${Math.round(tightest.remaining)}% remaining${formatReset(tightest.reset)}`,
        buckets,
    };
}

var CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Codex Usage');

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            style: 'spacing: 7px;',
            y_align: St.Align.MIDDLE,
            y_expand: true,
        });
        this._panelBuckets = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
            // Match the visual baseline of the adjacent Korean panel text.
            translation_y: 2,
            // About three normal spaces between quota groups.
            style: 'spacing: 12px;',
        });
        this._box.add_child(this._panelBuckets);
        this.add_child(this._box);

        this._session = new Soup.Session();
        this._session.timeout = REQUEST_TIMEOUT_SECONDS;
        this._timerId = 0;
        this._activityTimerId = 0;
        this._isActive = false;
        this._lastSummary = null;

        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        this._refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(this._refreshItem);

        this._statusItem = new PopupMenu.PopupMenuItem('Starting…', { reactive: false });
        this.menu.addMenuItem(this._statusItem);

        this._bucketsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._bucketsSection);

        // Keep the top bar empty until a request either succeeds or fails.
        // Codex activity alone is not a usage value.
        this.hide();
        this._checkActivity();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_SECONDS,
            () => {
                if (this._isActive)
                    this.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
        this._activityTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            ACTIVITY_CHECK_SECONDS,
            () => {
                this._checkActivity();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._activityTimerId) {
            GLib.source_remove(this._activityTimerId);
            this._activityTimerId = 0;
        }
        super.destroy();
    }

    _checkActivity() {
        const active = isCodexRunning();
        if (active === this._isActive)
            return;

        this._isActive = active;
        if (!active) {
            this.menu.close();
            this.hide();
            return;
        }

        this._statusItem.label.set_text('Codex usage를 불러오는 중…');
        this._bucketsSection.removeAll();
        this.refresh();
    }

    _setError(message) {
        const buckets = this._lastSummary?.buckets?.length > 0
            ? this._lastSummary.buckets.map(bucket => ({ ...bucket, remaining: 0 }))
            : DEFAULT_FAILURE_BUCKETS;
        this._setPanelBuckets(buckets, 'Fail');
        this._statusItem.label.set_text(message);
        this._bucketsSection.removeAll();
        this.show();
    }

    _setPanelBuckets(buckets, valueText = null) {
        this._panelBuckets.destroy_all_children();
        if (buckets.length === 0) {
            this._panelBuckets.add_child(new St.Label({
                text: 'Codex !',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        for (const bucket of buckets) {
            const item = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                // A compact single-space-like gap inside each group.
                style: 'spacing: 4px;',
            });
            const label = new St.Label({
                text: panelBucketLabel(bucket),
                y_align: Clutter.ActorAlign.CENTER,
                translation_y: 1,
                style: 'margin: 0;',
            });
            const battery = new HorizontalBattery();
            battery.setPercent(bucket.remaining);
            const percent = new St.Label({
                text: valueText || `${Math.round(bucket.remaining)}%`,
                y_align: Clutter.ActorAlign.CENTER,
                translation_y: 1,
                style: valueText ? 'margin: 0; color: #ff4d4f;' : 'margin: 0;',
            });
            item.add_child(label);
            item.add_child(battery);
            item.add_child(percent);
            this._panelBuckets.add_child(item);
        }
    }

    _setSummary(summary) {
        this._lastSummary = summary;
        this._setPanelBuckets(summary.buckets);
        this._statusItem.label.set_text(summary.detail);
        this.show();

        this._bucketsSection.removeAll();
        const visibleBuckets = summary.buckets.slice(0, 8);
        for (const bucket of visibleBuckets) {
            const remaining = Math.round(bucket.remaining);
            const text = `${bucket.label}\n${batteryBar(remaining)} ${remaining}%${formatReset(bucket.reset)}`;
            this._bucketsSection.addMenuItem(new PopupMenu.PopupMenuItem(text, { reactive: false }));
        }
    }

    refresh() {
        if (!this._isActive)
            return;

        let token;
        try {
            token = readAccessToken();
        } catch (error) {
            this._setError(error.message);
            return;
        }

        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('Accept', 'application/json');
        message.request_headers.append('User-Agent', 'codex-usage-gnome-extension/1.0');

        this._session.queue_message(message, (_session, response) => {
            try {
                if (response.status_code < 200 || response.status_code >= 300)
                    throw new Error(`Codex usage HTTP ${response.status_code}`);

                const text = response.response_body.data;
                const json = JSON.parse(text);
                if (this._isActive)
                    this._setSummary(summarizeUsage(json));
            } catch (error) {
                if (this._isActive)
                    this._setError(error.message);
            }
        });
    }
});

function init() {
}

function enable() {
    indicator = new CodexUsageIndicator();
    Main.panel.addToStatusArea('codex-usage', indicator, 1, 'right');
}

function disable() {
    if (indicator) {
        indicator.destroy();
        indicator = null;
    }
}
