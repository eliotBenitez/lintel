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

## Battery

- UPower DisplayDevice `IconName` only uses coarse buckets
  (`battery-full/good/low/caution/empty`), so e.g. 21% and 79% look the same.
  `BatteryService.iconName` builds the 10%-step `battery-level-*` name (same
  floor-to-10 rule as GNOME Shell's own indicator) and exposes UPower's name as
  `fallbackIconName` for icon themes without those icons.
