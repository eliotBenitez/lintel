# GNOME 50 top bar — baseline reference

> Status: values below are transcribed from the **project brief**, not yet
> verified line-by-line against gnome-shell 50 sources. Treat as the intended
> baseline; confirm against the real tree before relying on any exact number
> (see "To verify" at the bottom). This is the *starting point*, not the Tahoe
> design — see `MACOS_REFERENCE.md` for the target.

## Structure

`Main.panel` is an `St.Widget` with three boxes, placed inside
`Main.layoutManager.panelBox` (which has `affectsStruts: true`).

```
_leftBox        _centerBox        _rightBox
statusArea      menuManager
```

Default user-session layout (from `sessionMode.js`):

```
LEFT    activities
CENTER  dateMenu
RIGHT   screenRecording, screenSharing, dwellClick, a11y, keyboard, quickSettings
```

Roles we rely on (mirrored in `src/compat/panelAdapter.js`): `activities`,
`dateMenu`, `quickSettings`, `keyboard`, `a11y`, `dwellClick`,
`screenRecording`, `screenSharing`.

## Metrics (brief — verify)

```
$panel_height   : 2.2em
$base_font_size : 11pt      font-weight: bold
$base_padding   : 6px
$base_margin    : 4px
$base_icon_size : 16px
```

## Colours (brief — verify)

| Element            | Light                    | Dark        |
|--------------------|--------------------------|-------------|
| Topbar background  | `#FAFAFB`                | `#000000`   |
| Text / icons       | `#222226`                | `#FFFFFF`   |
| Bottom border      | `rgba(34,34,38,0.10)`    | transparent |
| Recording          | `#C01C28`                | `#C01C28`   |
| Privacy / sharing  | `#E66100`                | `#FF7800`   |

Button states: normal transparent; hover ≈ 17% fg; active ≈ 28% fg;
active+hover ≈ 32% fg; 150ms transition; effectively pill radius.

In Overview / lock / login the panel background is fully transparent.

## Quick Settings (Control Center analogue)

Passes through Wi-Fi/NM, Bluetooth, output volume, mic, brightness, camera,
location, remote access, Thunderbolt, Night Light, Dark Mode, Do Not Disturb,
keyboard backlight, Power Profiles, Airplane Mode, autorotate, background apps,
system actions. Privacy indicators are deliberately ordered first.

## To verify (do this in the research stage)

Check the exact version tag matching the installed Shell:

```
js/ui/panel.js         PANEL_ITEM_IMPLEMENTATIONS, _leftBox/_centerBox/_rightBox,
                       toggleCalendar/closeCalendar/toggleQuickSettings
js/ui/panelMenu.js     PanelMenu.Button `.container`
js/ui/sessionMode.js   panel layout per mode; Activities role name in 50
js/ui/quickSettings.js indicator container / roles
js/ui/dateMenu.js      dateMenu structure
js/ui/layout.js        panelBox / struts
data/theme/*.scss      $panel_height and colour tokens (ground-truth numbers)
```
