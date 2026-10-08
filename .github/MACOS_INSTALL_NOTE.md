### macOS: opening the app on first launch

This build is not Apple-signed, so Gatekeeper blocks the very first open
("damaged / can't be opened"). This is expected and the app is safe to run.

1. Open the DMG and drag OverSteer into Applications.
2. Try to open it once, then open System Settings → Privacy & Security and
   scroll down to Security. If you see an **Open Anyway** button for
   OverSteer, click it, then **Open** in the confirmation dialog.
3. If there is no Open Anyway button, run this once in Terminal instead
   (adjust the path if you put the app somewhere else):
   `xattr -cr /Applications/OverSteer.app`
   Then open the app normally.

From the second launch on, it opens with no extra steps.
