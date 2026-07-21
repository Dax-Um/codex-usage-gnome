'use strict';

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

function batteryBar(percent) {
    const filled = Math.round(percent / 10);
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function panelBucketLabel(bucket) {
    const label = bucket.label;
    if (label.includes('Codex-Spark') || label.includes('codex-spark') || label.includes('Spark'))
        return 'Spark:';
    if (label.includes('주간'))
        return 'Weekly:';
    if (label.includes('5시간'))
        return '5-hour:';
    return `${label.replace(/^Codex\s*·\s*/, '')}:`;
}
