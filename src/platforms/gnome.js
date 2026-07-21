'use strict';

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;

var GnomeRuntime = class GnomeRuntime {
    constructor(timeoutSeconds) {
        this._session = new Soup.Session();
        this._session.timeout = timeoutSeconds;
    }

    destroy() {
        this._session.abort();
    }

    readTextFile(path) {
        const file = Gio.File.new_for_path(path);
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            throw new Error(`Could not read ${path}`);
        return imports.byteArray.toString(bytes);
    }

    getCodexAuthPath() {
        return GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'auth.json']);
    }

    isProcessRunning(name) {
        try {
            const [, , , status] = GLib.spawn_command_line_sync(`pgrep -x ${name}`);
            return status === 0;
        } catch (_error) {
            return false;
        }
    }

    fetchJson(url, headers, callback) {
        const message = Soup.Message.new('GET', url);
        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);

        this._session.queue_message(message, (_session, response) => {
            try {
                if (response.status_code < 200 || response.status_code >= 300)
                    throw new Error(`Usage API HTTP ${response.status_code}`);
                callback(null, JSON.parse(response.response_body.data));
            } catch (error) {
                callback(error, null);
            }
        });
    }
};
