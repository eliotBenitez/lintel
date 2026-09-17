# Project Memory

## Notification Center

- GNOME Shell 50's `MessageGroupExpanderLayout` allocates collapsed messages
  almost on top of one another. Its stock theme prevents content bleed with
  opaque message backgrounds; translucent custom cards need to hide the inner
  content of actors marked `second-in-stack` or `lower-in-stack` instead.
- `NotificationMessageGroup` updates those pseudo-classes before emitting
  `notification-added` and `notify::expanded`. Individual message
  `style-changed` signals cover reorderings, so those are the synchronization
  points used by `LintelNotificationCenter`.
- Hiding the older content is not sufficient: a translucent front card still
  composites the complete rectangular surfaces underneath it. Collapsed stack
  layers must be opaque; expanded messages remain translucent.

## Control Center

- An `St.Label` whose `text` was set to `''` reads back `text` as `null` in
  GJS. Never branch on `label.text.length`; test the value you assigned.
- `NM.Device.disconnect()` is NetworkManager's device-disconnect operation,
  not GObject's signal removal helper. Passing a signal handler ID to it makes
  GJS report that `cancellable` received a number. Remove handlers from
  `NM.Device` with `GObject.signal_handler_disconnect(device, id)`.
- Headless click tests (`gnome-shell-test-tool` + a Clutter virtual pointer
  device): the first button press of the session is swallowed and closes the
  open popup. Spend one throwaway click before asserting anything, or a working
  control looks dead. `gnome-shell-test-tool` uses temporary XDG dirs, so
  settings the test writes do not leak into the live session.
- The headless shell talks to the host's system bus, so NetworkManager, UPower
  and `brightnessctl` report the dev laptop's real hardware, while session
  services such as GNOME's Rfkill are absent (Bluetooth reads as missing). To
  exercise desktop/PC cases, shadow the service getters on the instance with
  `Object.defineProperty(cc._net, 'wifiAvailable', {get: () => false})` and
  call `cc._sync()`.
- NetworkManager running does not mean Wi-Fi exists: its root `WirelessEnabled`
  is true on a machine with no Wi-Fi card. Ask libnm for a `DeviceType.WIFI`
  device. Veth, bridge and tun devices are separate device types, so filtering
  on `DeviceType.ETHERNET` alone leaves only real wired ports.
- A `CCTile` in compact mode has a natural height of only its 22px glyph. The
  grid must allocate circles a square cell explicitly, or a row made only of
  circles collapses to 24px tall.
- `Clutter.BinLayout` (GNOME 50) fills a child along an axis only when the child
  *expands* on it; `y_align: FILL` without `y_expand` centres the child at its
  natural height. Allocation dumps of the container look right while the child
  is drawn smaller — measure the child itself.
- GJS `Clutter.LayoutManager` subclasses on GNOME 50 use
  `vfunc_allocate(container, box)` (no flags) and
  `vfunc_get_preferred_height(container, forWidth)` returning `[min, nat]`;
  the box is already the content box, so offset children by `box.x1/y1`.
  Custom lengths are read with `peek_theme_node()?.lookup_length(name, false)`,
  which returns `[found, value]` and is safe before the actor is styled.
- The headless test shell reaches the host's power-profiles-daemon on the
  system bus: a test that clicks Power Mode changes the laptop's real profile
  unless `setProfile` is stubbed. The same goes for anything NetworkManager or
  rfkill backed.
- `msgmerge` can attach `fuzzy` to an existing flags line
  (`#, fuzzy, javascript-format`); stripping only a bare `#, fuzzy` line leaves
  the translation ignored by `msgfmt`. Check with
  `msgattrib --only-fuzzy po/ru.po`.
- `Gio.Settings.set_*` on a key the compiled schema lacks aborts the Shell
  process, not just the extension. Check `settings.settings_schema.has_key()`
  before writing any key added in a newer version.

## Battery

- UPower DisplayDevice `IconName` only uses coarse buckets
  (`battery-full/good/low/caution/empty`), so e.g. 21% and 79% look the same.
  `BatteryService.iconName` builds the 10%-step `battery-level-*` name (same
  floor-to-10 rule as GNOME Shell's own indicator) and exposes UPower's name as
  `fallbackIconName` for icon themes without those icons.

## Fullscreen reveal

- GNOME 50 `Layout.PressureBarrier` (`resource:///org/gnome/shell/ui/layout.js`)
  is exported and reusable; `Meta.Barrier` takes `backend: global.backend`
  (not `display`). A horizontal barrier coincident with the screen's top edge
  still reports hits, as the hot corner's does.
- `PressureBarrier.removeBarrier()` splices `indexOf(barrier)` without checking
  for -1, so removing a barrier after `destroy()` drops an unrelated entry.
  Remove barriers first, then destroy the PressureBarrier.
- A barrier removed while the pointer is on it never gets `left`, so the
  PressureBarrier stays `_isTriggered` and ignores the next barrier until the
  pointer moves off once. It self-heals; do not reach into the private field.
- A barrier does not release the pointer when triggered, so never place one on
  an edge shared with another monitor.

## Shared module state

- Module-level singletons (`_store` in `weather.js`, `systemStats.js`) survive
  disable, because the Shell caches extension modules until relogin. A
  refcount alone strands timers if one consumer's `destroy()` is missed, and a
  consumer from a previous enable can decrement the *new* store's count.
  Disable calls `shutdown*()` as a backstop, and consumers only touch the
  refcount when `this._store === _store`.

## Dynamic stylesheet

- The generated sheet is loaded into the whole Shell theme, not scoped to the
  panel: a setting value containing `}` escapes `#panel.lintel` and styles any
  actor. Only validated values (`src/cssValues.js`) may be interpolated; free
  text is rejected, not escaped.
