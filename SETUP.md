# Setup

The extension's icons (`icons/icon-16.png`, `icons/icon-32.png`, `icons/icon-48.png`, `icons/icon-128.png`) are already generated from `icons/icon.svg` and wired into `manifest.json`. No manual conversion is needed.

If you ever need to regenerate them from the SVG on macOS:

```bash
qlmanage -t -s 256 -o icons icons/icon.svg
for size in 16 32 48 128; do
  sips -z $size $size icons/icon.svg.png --out icons/icon-${size}.png
done
rm icons/icon.svg.png
```

## Testing the Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this directory
4. Visit any website and click the extension icon to test
