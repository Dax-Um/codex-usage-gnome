'use strict';

const GLib = imports.gi.GLib;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Usage = Me.imports.src.domain.usage;

var UsageController = class UsageController {
    constructor(provider, view, options = {}) {
        this._provider = provider;
        this._view = view;
        this._refreshSeconds = options.refreshSeconds || 60;
        this._activityCheckSeconds = options.activityCheckSeconds || 5;
        this._isActive = false;
        this._lastSummary = null;
        this._refreshTimerId = 0;
        this._activityTimerId = 0;
    }

    start() {
        this._view.hide();
        this._checkActivity();
        this._refreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._refreshSeconds, () => {
                if (this._isActive)
                    this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
        this._activityTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._activityCheckSeconds, () => {
                this._checkActivity();
                return GLib.SOURCE_CONTINUE;
            });
    }

    destroy() {
        for (const timerId of ['_refreshTimerId', '_activityTimerId']) {
            if (this[timerId]) {
                GLib.source_remove(this[timerId]);
                this[timerId] = 0;
            }
        }
    }

    refresh() {
        if (!this._isActive)
            return;
        this._view.showLoading(this._provider.displayName);
        this._provider.fetchUsage((error, summary) => {
            if (!this._isActive)
                return;
            if (error) {
                const failure = Usage.createFailureSummary(this._lastSummary);
                this._view.showError(error.message, failure);
                return;
            }
            if (summary.buckets.length === 0) {
                this._view.showError(summary.detail, Usage.createFailureSummary(this._lastSummary));
                return;
            }
            this._lastSummary = summary;
            this._view.showSummary(summary);
        });
    }

    _checkActivity() {
        const active = this._provider.isActive();
        if (active === this._isActive)
            return;
        this._isActive = active;
        if (!active) {
            this._view.menu.close();
            this._view.hide();
            return;
        }
        this.refresh();
    }
};
