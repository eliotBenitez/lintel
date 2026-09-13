# Tahoe reference captures

Source screenshots of the real macOS Tahoe UI, used as the measurement truth for
this extension's panel, menus and Control Center.

- **Origin:** Stephen Hackett's Aqua Screenshot Library —
  <https://512pixels.net/projects/aqua-screenshot-library/macos-26-tahoe/>
- **Downloaded from:** `https://media.512pixels.net/downloads/macos-screenshots/26/`
- **Do not use the `-scaled` variants** the gallery page links to; those are
  864 x 540 and far too small to measure.

## Scale

Every full-screen file is **2880 x 1800**, a 2x capture of a **1440 x 900 point**
screen, so

```
1 macOS point = 2 image pixels
```

Verified against the menu bar: its glyph rows span y = 17..38, which puts the
content centre at ~12.75 pt inside the 24 pt bar.

`26-Tahoe-Settings-Menu-Bar.png` is the exception: it is a **window** capture,
1670 x 1474, still at 2x (an 835 pt wide Settings window).

Note this is a *different* scale from the earlier hand-supplied capture used in
`docs/MACOS_REFERENCE.md`, which was a video frame at 1.667 px/pt. These files
supersede it — they are native, unscaled and unblurred, and they measurably
disagree with it: blur in the video inflated every glyph's ink extent, which
shrank the measured gaps between glyphs by roughly 2.5 pt each.

## Contents

| File | Shows |
|------|-------|
| `26-Tahoe-Desktop.png` | A clean desktop — **the menu bar reference**; supersedes the video frame the metrics table was first measured from |
| `26-Tahoe-About-This-Mac-Menu.png` | The Apple menu open: About This Mac / System Settings… / App Store / Recent Items ▸ / Force Quit… / Sleep / Restart… / Shut Down… / Lock Screen / Log Out — the exact grouping `systemMenu.js` mirrors |
| `26-Tahoe-Settings-Menu-Bar.png` | System Settings → Menu Bar, including the **Clock Options…** button and a "Show menu bar background" toggle |
| `26-Tahoe-Notification-Center.png` | Notification Center open, plus a live banner above it |
| `26-Tahoe-Finder-Control-Center.png` | Control Center: Wi-Fi / Bluetooth / AirDrop rows, Now Playing, Focus, Stage Manager and Screen Mirroring tiles, Display and Sound sliders |
| `26-Tahoe-Finder-Control-Center-Edit.png` | Control Center in editing mode, with the module picker |
| `26-Tahoe-Finder-Menu.png` | An open app menu — menu material, row height, separators, shortcut column |
| `26-Tahoe-Time-Machine-Menu.png` | An open status menu, the analogue of our Wi-Fi / battery popups |

## Measuring

`identify` and ImageMagick work directly on these; for anything finer, read the
pixels. The technique used so far is column/row edge counting — a card's border
produces a column where most rows differ sharply from their neighbour four
pixels left, which locates panel and card boundaries to the pixel:

```python
from PIL import Image
import numpy as np
a = np.asarray(Image.open('26-Tahoe-Notification-Center.png').convert('RGB')).astype(float)
L = 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]
score = [(x, int((np.abs(L[60:1200, x] - L[60:1200, x-4]) > 14).sum()))
         for x in range(1700, L.shape[1]-1)]
print(sorted(score, key=lambda s: -s[1])[:8])   # -> the card column's edges
```

## Provenance

These depict Apple software and are Apple's artwork; they are kept here as a
design reference for comparison work, not as anything shipped. They are not part
of the extension — `install.sh` symlinks the checkout, so keep them out of any
package built for distribution (`dist/`), and think twice before pushing 33 MB
of Apple UI screenshots to a public remote.
