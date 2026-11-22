# Main-screen UI

## Android: the Tonal layout

The Android main screen implements the "Tonal" design, built from
`main-page.xml` and `lens-remote-sheet.xml` and styled by `lens.css` (imported
last from `app/app.css`, never from `app.ios.css`). It draws its own header
(`actionBarHidden`), puts the touchpads behind the Remote bottom sheet, and
uses the bottom nav for Glasses / Devices / More. `lens.css` also restyles the
secondary Android pages and the shared keyboard/setting panels; the shared
XML and view models are not edited, only overridden. iOS keeps its own page
(`main-page.ios.ts`) and never loads `lens.css`.

Fonts live in `app/fonts/` (Space Grotesk for text, Doto for the battery
numerals); `app/fonts/ttf/` remains the glasses' bundled font folder. Device
screenshots from this implementation are in
`design/lens-redesign/screens/tonal/impl/`.

## Shared with iOS

Android and iOS share `remote-controls.xml`, `remote-controls.css`, and
`RemoteControlsViewModel`: the bar of icon buttons under the mirror (the
foreground EvenHub app's phone UI, microphone, keyboard, settings) and the
touchpad below it, which is the simulated watch face or the ring pad according
to the Phone input style setting. The settings button opens `settings-page.xml`
(`SettingsViewModel`, `settings-page.css`), also shared: display mode,
brightness/Auto, Phone input style and battery levels. That page needs no host:
it reads the settings store, the shell's battery levels and
`g2/glasses-presence`, which both platforms' controllers feed. Import the
stylesheets at the top of each platform's application CSS (before any rules),
so the NativeScript CSS pipeline includes them; iOS also has to register each
shared page in `onboarding-register.ios.ts`.

Android's `MainViewModel` extends that shared model and connects it to
`dashboardController`. iOS loads the same XML with `Builder.load` and connects
it to `IosPreviewController`. The watch face's status line ("Display off", the
foreground window's title, ...) is worded once, in `g2/glasses-display-state`:
each controller fills in a `GlassesDisplayState` and hands the resulting
`glassesPadStatus` to the model's `setPadStatus`, so the two platforms can't
drift apart. Keep platform-specific transport, page lifecycle,
and navigation in those adapters. Android uses NativeScript gesture events;
iOS feeds raw touches to `PhoneGestureRecognizer`, so the discrete pad gesture
bindings in the XML are Android-only to avoid delivering each gesture twice.

The iOS shell uses the same portrait preview-above-controls layout and 345-DIP
landscape controls column. It respects safe areas, uses the same overflow menu
labels/order, and retains device diagnostics under the connection status.
Conversations and Record screen are disabled on iOS because their storage and
recording services are currently Android-only. Take screenshot opens the iOS
share sheet. Text settings still use native dialogs. Keyboard input uses the
shared `keyboard-input-panel.xml` multiline editor and shell keyboard session,
with separate Agent and App destinations when available. iOS keeps the editor
above the software keyboard in both orientations.

Voice input uses the glasses microphone when connected and the phone's default
audio input in preview mode. The phone path requires both Speech Recognition
and Microphone permissions and stops when Faceclaw leaves the foreground;
connected-glasses capture retains its existing background behavior.

The iOS microphone, keyboard and settings image assets (`ic_control_*`) are 3x
rasterizations of the Android vector drawables with the same names; regenerate
them from those vectors if the icon designs change. The EvenHub button's icon
is the app's own, rendered white on transparent; `.control-icon` tints all four
alike.
