'use strict';

const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { UsageController } = Me.imports.src.controller;
const { CodexUsageProvider } = Me.imports.src.providers.codex;
const { GnomeRuntime } = Me.imports.src.platforms.gnome;
const { GnomePanelView } = Me.imports.src.ui['gnome-panel'];

const REQUEST_TIMEOUT_SECONDS = 20;

let controller = null;
let runtime = null;
let view = null;

function init() {
}

function enable() {
    runtime = new GnomeRuntime(REQUEST_TIMEOUT_SECONDS);
    const provider = new CodexUsageProvider(runtime);
    view = new GnomePanelView(() => controller.refresh());
    controller = new UsageController(provider, view);
    Main.panel.addToStatusArea('codex-usage', view, 1, 'right');
    controller.start();
}

function disable() {
    if (controller) {
        controller.destroy();
        controller = null;
    }
    if (view) {
        view.destroy();
        view = null;
    }
    if (runtime) {
        runtime.destroy();
        runtime = null;
    }
}
