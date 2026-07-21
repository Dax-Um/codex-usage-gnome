'use strict';

const GObject = imports.gi.GObject;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Cairo = imports.cairo;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Format = Me.imports.src.ui.format;

var HorizontalBattery = GObject.registerClass(
class HorizontalBattery extends St.DrawingArea {
    _init() {
        super._init({
            width: 25,
            height: 13,
            y_align: Clutter.ActorAlign.CENTER,
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

var GnomePanelView = GObject.registerClass(
class GnomePanelView extends PanelMenu.Button {
    _init(onRefresh) {
        super._init(0.0, 'Usage');
        this._onRefresh = onRefresh;
        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            style: 'spacing: 7px;',
            y_align: St.Align.MIDDLE,
            y_expand: true,
        });
        this._panelBuckets = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
            translation_y: 2,
            style: 'spacing: 12px;',
        });
        this._box.add_child(this._panelBuckets);
        this.add_child(this._box);

        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        this._refreshItem.connect('activate', () => this._onRefresh());
        this.menu.addMenuItem(this._refreshItem);
        this._statusItem = new PopupMenu.PopupMenuItem('Starting…', { reactive: false });
        this.menu.addMenuItem(this._statusItem);
        this._bucketsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._bucketsSection);
    }

    showLoading(providerName) {
        this._statusItem.label.set_text(`${providerName} usage를 불러오는 중…`);
        this._bucketsSection.removeAll();
    }

    showError(message, summary) {
        this._setPanelBuckets(summary.buckets, 'Fail');
        this._statusItem.label.set_text(message);
        this._bucketsSection.removeAll();
        this.show();
    }

    showSummary(summary) {
        this._setPanelBuckets(summary.buckets);
        const tightest = summary.buckets.reduce((lowest, bucket) =>
            bucket.remaining < lowest.remaining ? bucket : lowest, summary.buckets[0]);
        this._statusItem.label.set_text(`${summary.detail}${Format.formatReset(tightest.reset)}`);
        this.show();

        this._bucketsSection.removeAll();
        for (const bucket of summary.buckets.slice(0, 8)) {
            const remaining = Math.round(bucket.remaining);
            const text = `${bucket.label}\n${Format.batteryBar(remaining)} ${remaining}%${Format.formatReset(bucket.reset)}`;
            this._bucketsSection.addMenuItem(new PopupMenu.PopupMenuItem(text, { reactive: false }));
        }
    }

    _setPanelBuckets(buckets, valueText = null) {
        this._panelBuckets.destroy_all_children();
        for (const bucket of buckets) {
            const item = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 4px;',
            });
            const label = new St.Label({
                text: Format.panelBucketLabel(bucket),
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
});
