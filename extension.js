// Lintel — entry point.
//
// Design rule (see docs/ARCHITECTURE.md): we NEVER destroy or replace
// Main.panel. This extension is a layout/compositor layer on top of the native
// GNOME Panel. All mutation and full restoration lives in PanelController.
//
// GNOME 45+ uses ES modules. This file is intentionally tiny: it only wires the
// controller's lifecycle to enable()/disable() and guarantees disable() fully
// tears down (Criterion #2/#3: no logout, no leaked actors/signals/timeouts).

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PanelController} from './src/panelController.js';

export default class LintelExtension extends Extension {
    enable() {
        this._controller = new PanelController(this);
        this._controller.enable();
    }

    disable() {
        // disable() must be safe even if enable() partially failed.
        this._controller?.destroy();
        this._controller = null;
    }
}
