# Retaking the website's screenshots

All screenshots in `public/shots/` are real: the web client running against a seeded node, and the
Android app running on an emulator. Retake them when the UI changes.

## Web client (`phone-*`, `desktop-*`, light and dark)

```bash
pnpm build                                  # the server and client dist/ the demo node runs
node apps/site/scripts/screenshots.mjs      # or name views: ... phone-dm desktop-admin
```

`demo-network.mjs` starts a throwaway node ("Valley Gathering"), fills it through the public API, spreads
the message times over an afternoon ending at 5:42 pm, and `screenshots.mjs` photographs it with the
installed Google Chrome. Avatar seeds are picked for friendly faces; see the comments in
`demo-network.mjs`.

## Android app (`android-*`)

Uses an emulator (Android Studio's "Medium Phone API 35" works) and `android.mjs`, which taps on-screen
text and saves WebP screenshots scaled to 720 px wide.

```bash
EMU=~/Library/Android/sdk/emulator/emulator ADB=~/Library/Android/sdk/platform-tools/adb
$EMU -avd Medium_Phone_API_35 -no-window -no-audio -no-boot-anim -no-snapshot &
$ADB wait-for-device
pnpm --filter app apk && $ADB install -r apps/app/loam-host.apk
$ADB shell pm clear com.loamnet.host

# A clean status bar: 5:42, full battery, no notification icons.
$ADB shell settings put global sysui_demo_allowed 1
for args in "enter" "clock -e hhmm 1742" "battery -e level 100 -e plugged false" \
            "network -e wifi show -e level 4 -e mobile hide" "notifications -e visible false"; do
  $ADB shell am broadcast -a com.android.systemui.demo -e command $args
done

a() { node apps/site/scripts/android.mjs "$@"; }   # a dump | a tap <text> | a shot <name>
$ADB shell monkey -p com.loamnet.host -c android.intent.category.LAUNCHER 1
a shot android-setup-language && a tap English
a shot android-setup-type && a tap Community
$ADB shell input swipe 540 1900 540 500 300 && a tap Next      # the name: type "Valley Gathering"
a tap Next && a shot android-setup-connect
a tap Wi-Fi && a tap "Start the network"                        # the emulator has no hotspot
# Allow notifications when asked, then:
a shot android-share-wifi
$ADB shell input swipe 540 1900 540 600 300 && a tap "Start display mode"
# Dismiss Android's "App is pinned" sheet (Got it), wait for its toast to fade, then:
a shot android-display-wifi
$ADB shell input swipe 540 2233 540 2233 2600                   # hold to leave display mode
$ADB shell input swipe 540 1900 540 500 300 && a tap "Show a link code"
# Set the demo clock to the device's real time first, so the code's expiry matches it.
a shot android-link
a tap Close && a tap Done && a tap "Open host menu" && a tap "Emergency reset" && a shot android-reset
```

## Share image

`og-image.mjs` renders `og-image.html` (through `pnpm --filter site dev`) to `public/og-image.png`.
