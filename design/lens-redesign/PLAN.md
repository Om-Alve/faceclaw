# Faceclaw phone UI redesign: "Lens" (HUD-native) implementation plan

You are implementing a visual and layout redesign of the Faceclaw **Android phone app UI**.
Nothing about how the app talks to the glasses changes. This document is the full brief:
read it top to bottom before touching code, then work phase by phase.

Repo: `research/work/faceclaw` (NativeScript 9 + TypeScript UI, Kotlin for BLE).
Read `CLAUDE.md` and `app/phone-ui/README.md` in the repo first.

---

## 0. Non-negotiables (read twice)

1. **No functional change to the glasses.** Do not touch anything that sends to, receives
   from, renders for, or flashes the glasses. The glasses UI is drawn by the TypeScript
   renderer in `app/ui/`, `app/graphics/` and `app/g2/`, not by CSS, so phone CSS and XML
   cannot change what the glasses show. Keep it that way.
2. **No feature may stop working.** Every action reachable on the phone today must still be
   reachable after the redesign, through the same view-model handler. Section 4 is the
   contract: every binding listed there must still be bound somewhere.
3. **Files you must not modify:**
   - `app/g2/**`, with exactly one exception: the additive, read-only snapshot fields in
     `app/g2/dashboard-controller.ts` described in section 6.1. No other edits there.
   - `app/native/**`, `app/ui/**`, `app/graphics/**`, `app/apps/**`, `app/assistant/**`
   - `native/kotlin/**`, `App_Resources/Android/src/main/java/**`,
     `App_Resources/Android/src/main/AndroidManifest.xml`, `app/g2/firmware/**`
   - `wear/**`, `App_Resources/iOS/**`
   - `app/phone-ui/onboarding-flash-page.*`, `app/phone-ui/onboarding-flash-view-model.ts`,
     `app/phone-ui/onboarding-firmware-check-page.*`,
     `app/phone-ui/onboarding-firmware-check-view-model.ts`. These drive firmware
     install and uninstall. They may change appearance only through global CSS, never through
     edits to these files. `enableSwipeBackNavigation="false"` on the flash page must stay.
   - `app/fonts/ttf/**` and `app/graphics/installed-fonts.ts` (the glasses' bundled fonts).
4. **Do not delete or rename existing view-model members**, even ones the new Android layout
   stops using. iOS (`main-page.ios.ts`) and other code depend on them. Only add.
5. **Shared files (used by iOS too) keep their structure:** `remote-controls.xml`,
   `remote-controls.css`, `remote-controls-view-model.ts`, `keyboard-input-panel.xml`,
   `keyboard-input-view-model.ts`, `pairing.css`. You may only *add* getters to
   view-models. Restyle these through the new Android-only `lens.css`, which loads after
   them and overrides them. `main-page.xml` is Android-only (iOS builds its page in code in
   `main-page.ios.ts`), so it can be rewritten freely.
6. **No new npm dependencies, no new Gradle dependencies.** Fonts and icons are plain asset
   files.
7. **Before installing a build on the user's phone,** check how the installed Faceclaw is
   signed. If it is a release build, a debug install requires an uninstall, and that wipes
   pairing and settings. In that case **stop and ask the user**. If they agree, export the
   config first with `scripts/pull_config.sh` and restore it with `scripts/push_config.sh`.
   Never uninstall without that.

---

## 1. References

- Reference screens (rendered from the approved mockup, 390x844 at 2x):
  - `screens/lens-home-dark.png` is the main screen, dark theme
  - `screens/lens-home-light.png` is the main screen, light theme
  - `screens/lens-remote-watch.png` shows the Remote sheet, Watch pad
  - `screens/lens-remote-ring.png` shows the Remote sheet, Ring pad
  - `screens/lens-mirror-minimized-dark.png` and `screens/lens-mirror-minimized-light.png`
    show the mirror minimized
- Exact values (colors, sizes, paddings, icon paths) are in `mockup/lens-mockup.dc.html`.
  It is a design-canvas file, not app code. Read its inline styles and the palette object
  in its `<script>` as the source of truth for numbers.
- Live canvas (the user can open it; it may not be accessible to you):
  https://claude.ai/artifact/NUwNxchUNMxJ6wCdcsqRTe
- **Tonal, the alternative direction (reference only, not the one to build):**
  `screens/tonal/` has the same six states rendered in the "Tonal" style: Material 3
  structure with rounded tonal cards, pill controls and a nav bar with an active pill,
  using Space Grotesk and Doto. Its exact values are in `mockup/tonal-mockup.dc.html`.
  The layout, content and behavior are identical to Lens; only the styling differs.
  **Implement Lens** (section 3). Use Tonal only if the user explicitly asks you to borrow
  a specific element from it, and then express that element in the Lens tokens, keeping
  Lens's single shape rule (radius 0) unless the user says otherwise.
  - `screens/tonal/tonal-home-dark.png`, `tonal-home-light.png`
  - `screens/tonal/tonal-remote-watch.png`, `tonal-remote-ring.png`
  - `screens/tonal/tonal-mirror-minimized-dark.png`, `tonal-mirror-minimized-light.png`
- Battery %, "Not charging" and the issue shown in the screens are sample values.
- Screens that have no mockup (Devices tab, More tab, secondary pages) are specified in
  words in section 5. Build them from the same tokens and components.

---

## 2. What the user asked for (decisions already made)

- The user drives the glasses with a Bluetooth ring (K02, via a separate `ring-grab`
  helper), so the phone app is mostly for **status and setup**. The touchpads remain
  available but are tucked into a **Remote** bottom sheet.
- **Main screen:** live mirror on top, then issues, glasses status, brightness, an input bar
  (type + mic + Remote), and a bottom nav.
- **Bottom nav:** Glasses, Devices, More. Everything in today's overflow (three-dot)
  menu moves into Devices or More, or onto the mirror strip.
- **The live mirror can be minimized** to a one-line strip, and the choice is remembered.
  While it is minimized, the phone must stop building mirror bitmaps (it saves phone
  battery). The glasses are unaffected.
- **Theme follows the system** (light and dark).
- **Look:** Nothing Phone flavor. Monochrome, dot-matrix numerals (Doto), mono labels
  (Geist Mono), Geist for text, square corners, hairline dividers, one red accent.
- Reading state the app already tracks (glasses battery, charging, worn) is allowed via
  read-only bindings.
- **Not in scope:** case battery. Faceclaw does not receive it today, so it needs separate
  protocol work. Don't add a placeholder for it.

---

## 3. Design system ("Lens")

### 3.1 Color tokens

Mirror box background is always `#000000` in both themes (it is the glasses' display).

| Token | Dark | Light | Use |
|---|---|---|---|
| `bg` | `#000000` | `#F4F4F2` | page background |
| `surface` | `#0E0E0E` | `#FFFFFF` | sheets, input field |
| `raised` | `#161616` | `#ECECE9` | touchpad surfaces |
| `line` | `#2A2A2A` | `#D2D2CE` | 1px hairlines and borders |
| `fg` | `#F2F2F2` | `#111111` | primary text, icons, active nav |
| `dim` | `#A3A3A3` | `#555555` | labels, secondary text, inactive nav |
| `mute` | `#3C3C3C` | `#C4C4C0` | unlit battery dots, sheet handle, ring markings |
| `red-fill` | `#D71921` | `#D71921` | voice button, Fix buttons, active nav bar, slider |
| `red-text` | `#FF5A4F` | `#C4161D` | warning icons and outlines, red text |
| `scrim` | `rgba(0,0,0,0.7)` | `rgba(17,17,17,0.45)` | behind the Remote sheet |

Text on `red-fill` is always `#FFFFFF`. Red is used only for issues, the voice button, the
active nav indicator and the brightness slider. Nothing else is red.

### 3.2 Type

| Role | Font file (family name) | Size (dp) | Notes |
|---|---|---|---|
| Wordmark "FACECLAW" | `Doto-Black` | 27 | letter-spacing 0.02 |
| Battery number | `Doto-Black` | 60 (the "%" is 24) | |
| Sheet title "REMOTE" | `Doto-Black` | 24 | |
| Label (caps) | `GeistMono-Regular` | 11 | uppercase, letter-spacing 0.08 |
| Button text (caps) | `GeistMono-SemiBold` | 12 | uppercase, letter-spacing 0.08 |
| Nav label | `GeistMono-SemiBold` active, `GeistMono-Medium` inactive | 11 | uppercase |
| Body / values | `Geist-Medium` | 15 to 16 | |
| Secondary text | `Geist-Regular` | 13 | color `dim` |

NativeScript `letter-spacing` is in em units (write `letter-spacing: 0.08;`).
Use one family name per weight file and do not rely on `font-weight` with custom fonts.
NativeScript on Android loads `app/fonts/<family>.ttf` by exact name.

### 3.3 Shape, spacing, touch

- Corner radius **0 everywhere** (buttons, fields, sheets, pads, switch track if styled).
- Dividers are 1px `line`. Use dividers, not cards with shadows. No elevation and no shadows.
- Page side gutter is 20 (the header's right side is 16). Cell padding is 16 to 20.
- Every tappable thing is at least **44x44 dp**. The input bar and nav are 52 to 62 tall.

### 3.4 Assets

**Fonts** (SIL OFL 1.1). Put them in `app/fonts/`, the root folder, **not** `app/fonts/ttf/`,
which holds the glasses' bundled fonts:
- `Doto-Black.ttf`: a static instance of Doto at wght 900, ROND 0, from google/fonts
  `ofl/doto`. If only the variable font is available, instance it with
  `fonttools varLib.instancer "Doto[ROND,wght].ttf" wght=900 ROND=0 -o Doto-Black.ttf`.
- `Geist-Regular.ttf`, `Geist-Medium.ttf`, `Geist-SemiBold.ttf`, `GeistMono-Regular.ttf`,
  `GeistMono-Medium.ttf`, `GeistMono-SemiBold.ttf`, as static TTFs from vercel/geist-font,
  or instanced from the variable fonts the same way.
- Add `OFL-Doto.txt` and `OFL-Geist.txt` next to them, and credit both in `ACKNOWLEDGEMENTS.md`.

**Icons.** Use Android vector drawables in `App_Resources/Android/src/main/res/drawable/`
(the resource folder only, never the `java/` folder), tinted from CSS with `tint-color`.
Source them from Phosphor Icons (MIT, "regular" weight); credit it in ACKNOWLEDGEMENTS.md.
If Phosphor isn't reachable, convert the stroke icons in `mockup/lens-mockup.dc.html`
(24x24 viewport, stroke 1.75 to 2, round caps).
Needed: `ic_lens_glasses`, `ic_lens_devices` (Bluetooth), `ic_lens_more` (three dots),
`ic_lens_camera`, `ic_lens_record`, `ic_lens_stop`, `ic_lens_remote`, `ic_lens_warning`,
`ic_lens_sun`, `ic_lens_close`, `ic_lens_chevron_up`, `ic_lens_chevron_down`,
`ic_lens_chevron_right`. Reuse the existing `ic_tab_mic` and `ic_tab_keyboard` for the
mic and keyboard.

### 3.5 CSS structure

- Create `app/phone-ui/lens.css` and import it **last** in `app/app.css`, after the existing
  imports. Do **not** import it from `app.ios.css`.
- Define the tokens as CSS custom properties on the theme root classes that
  `@nativescript/theme` already puts on the root view (the app already relies on
  `.ns-dark`):
  ```css
  .ns-root, .ns-light { --lens-bg: #F4F4F2; --lens-fg: #111111; /* ... */ }
  .ns-dark { --lens-bg: #000000; --lens-fg: #F2F2F2; /* ... */ }
  ```
  Verify in phase 0 that `var(--lens-*)` inherits into child views on this NativeScript
  version (probe with one Label). If it does not, fall back to paired selectors
  (`.lens-x { ... }` plus `.ns-dark .lens-x { ... }`), which is the pattern `app.css`
  already uses. Either way, keep every color in `lens.css`; no hex values in XML.
- Name every Lens class with a `lens-` prefix so nothing collides with theme or legacy classes.

---

## 4. The binding contract (must survive)

Today's Android main page (`main-page.xml`, `remote-controls.xml`,
`keyboard-input-panel.xml`) binds the following. **Every row must still be bound in the new
layout, to the same member.** "New home" says where it goes.

### Header and overflow menu
| Binding(s) | Today | New home |
|---|---|---|
| `connectionStatusLabel`, `onConnectionStatusTap` | action bar status text | header connection button (text uppercase, 7dp square glyph before it) |
| `onWarningIconTap`, `warningIconVisibility` | the warning emoji | header issue button (red outline, warning icon + count). Visibility stays `warningIconVisibility`. Tap behavior is in 5.1 |
| `evenHubPhoneUiIcon`, `onEvenHubPhoneUiTap`, `evenHubPhoneUiVisibility` | the app icon in the action bar | header, 44x44 outline button left of the connection button |
| `buttonLabel`, `onTap`, `connectItemEnabled`, `glassesMenuItemsVisibility` | Connect/Disconnect in the overflow menu | Devices tab, connection row action button |
| `onPairGlassesTap`, `canRun` | "Pair glasses" in the overflow menu | Devices tab row |
| `onPermissionsTap` | "Permissions" in the overflow menu | Devices tab row |
| `onConversationsTap` | "Conversations" in the overflow menu | More tab row |
| `onTakeScreenshotTap` | "Take screenshot" in the overflow menu | mirror strip, camera icon button |
| `onRecordScreenTap` | "Record screen" in the overflow menu | mirror strip, record icon button |
| `onStopRecordingTap`, `stopRecordingButtonVisibility` | bottom "Stop recording" button | mirror strip: while recording, the record button is replaced by a red-filled "STOP" button (see 6.2 `recordButtonVisibility`) |
| `onUninstallFirmwareTap`, `canRun`, `glassesMenuItemsVisibility` | the overflow menu | Devices tab, "Danger zone" row |

### Mirror
| Binding(s) | New home |
|---|---|
| `displayPreview`, `displayPreviewVisibility`, `displayPreviewHeight` | full-bleed mirror Image (`stretch="fill"`) |
| `onMirrorTap`, `onMirrorDoubleTap`, `onMirrorLongPress`, `onMirrorSwipe` | the same Image (keep all four gestures) |
| `displayPreviewMessage`, `displayPreviewMessageVisibility` | message box in place of the mirror, same height, `#000` background, white centered text |
| `landscapeDisplayPreviewWidth/Height`, `onLandscapePreviewLayoutChanged`, `portraitLayoutVisibility`, `landscapeLayoutVisibility` | landscape layout (5.7) |

### Status (old Settings tab)
| Binding(s) | New home |
|---|---|
| `displayModeLabel`, `onDisplayModeTap` | Display mode cell. Show the new `displayModeValue` getter (the label without " ▾") plus a chevron icon. Tap still calls `onDisplayModeTap` |
| `brightnessPercent`, `onBrightnessChange`, `brightnessSliderEnabled` | brightness row Slider (min 2, max 100, as today) |
| `brightnessAuto`, `onBrightnessAutoChange` | Auto brightness cell Switch |

### Remote (old Watch and Ring tabs)
| Binding(s) | New home |
|---|---|
| `onWatchTabTap`, `onRingTabTap`, `watchTabVisibility`, `ringTabVisibility`, `watchTabClass`, `ringTabClass` | Remote sheet's two-segment control and pads |
| `onPadTap`, `onPadDoubleTap`, `onPadLongPress`, `onPadSwipe`, `onPadTouch` | Watch pad (keep the `android:` prefixes on the gesture attributes exactly as in `remote-controls.xml`) |
| `watchFaceWidth`, `watchFaceHeight`, `padFocusLine`, `padFocusClass`, `padWakeHintVisibility` | Watch pad size and center text |
| `onRingPadTap`, `onRingPadDoubleTap`, `onRingPadLongPress`, `onRingPadSwipe`, `onRingPadTouch`, `ringTouchpadHeight` | Ring pad with its six cosmetic markings (`isUserInteractionEnabled="false"`) |
| `onControlsContentLayoutChanged` | **the pad container in the sheet.** Without it `watchFaceHeight` and `ringTouchpadHeight` never get measured |
| `controlsVisibility` | the Remote sheet (it must collapse while the keyboard panel or text editor is up) |
| `onSyntheticMicTap` | input bar mic button |
| `onKeyboardTap` | input bar "Type a message" button |

### Issues (old warnings modal)
| Binding(s) | New home |
|---|---|
| `evenAppConflictWarningVisibility`, `evenAppConflictMessage`, `onOpenEvenAppSettingsTap` | issue row, button "OPEN" |
| `firmwareWarningVisibility`, `firmwareWarningMessage`, `onInstallFirmwareTap` | issue row, button "INSTALL" |
| `batteryOptimizationWarningVisibility`, `onAllowBackgroundUsageTap` | issue row, title "Background use is restricted", body is the existing sentence, button "FIX" |
| `fontsMissingWarningVisibility`, `onPrepareFontsTap` | issue row, title "G2 fonts not prepared", body is the existing sentence, button "PREPARE" |
| `alarmReliabilityWarningVisibility`, `alarmReliabilityMessage`, `onFixAlarmReliabilityTap` | issue row, button "OPEN" |
| `warningsModalVisibility`, `warningsModalWidth`, `onWarningsModalCloseTap` | not used by the new Android layout. Keep the members; don't delete them |

### Overlays (keep, restyle)
| Binding(s) | New home |
|---|---|
| `textSettingEditorVisibility` and every `activeTextSetting*`, `secondaryTextSetting*`, `activeTextEditor*`, `primaryTextSettingReturnKeyType`, `onTextSetting*`, `onPrimaryTextSettingReturnPress`, `onSecondaryTextSettingReturnPress` | the same text-setting editor overlay, restyled. **Keep ids `settingsTextField` and `secondarySettingsTextField`** (main-page.ts looks them up) |
| `keyboardInputModel` → `<rc:keyboard-input-panel>` | keep the component as is (shared with iOS) and restyle via `lens.css`. **Keep id `keyboardInputField`** |
| `bleBandwidthLabel`, `bleBandwidthVisibility` | keep the bottom overlay label (developer setting), above the nav |
| `loaded`, `unloaded`, `navigatingTo` page events | unchanged |

---

## 5. Screen specs

### 5.1 Main page, Glasses tab (portrait). See `lens-home-dark.png` and `lens-home-light.png`

Page: `actionBarHidden="true"` (the header is drawn in-page). Background `bg`.
Structure, top to bottom:

1. **Header** (padding 20/16/12/20). Wordmark "FACECLAW" on the left. On the right, in order:
   the EvenHub app button (when visible), the connection button (44 tall, 1px `line`
   border, `GeistMono-Medium` 11 caps, 7dp `fg` square glyph), and the issue button (44x44
   minimum, 1px `red-text` border, warning icon + `warningCount`).
   Issue button tap: switch to the Glasses tab if needed and scroll the home ScrollView to
   the issues block (page code-behind, `scrollToVerticalOffset`). Don't open the old modal.
2. **Mirror** (only when the mirror is expanded): full-bleed, no side padding, height
   `displayPreviewHeight`, background `#000`. The message box replaces it when
   `displayPreviewMessageVisibility` is visible.
3. **Mirror strip** (always visible). Bottom hairline. On the left is a toggle button that
   fills the width (min 44 tall):
   - expanded: chevron-up icon (`dim`) and "LIVE MIRROR" (label style)
   - minimized: chevron-down icon, "MIRROR MINIMIZED" (label style) above `padFocusLine`
     (`Geist-Medium` 15)

   On the right are two 44x44 icon buttons: camera (`onTakeScreenshotTap`) and record
   (`onRecordScreenTap`). While recording, the record button is replaced by a red-filled
   "STOP" button (`onStopRecordingTap`).
4. **Issues**: one row per warning (section 4), each with its own visibility binding, so
   any number can show. Each row has a 20dp `red-text` warning icon, a title (`Geist-Medium`
   15), a body (`Geist-Regular` 13 `dim`), and a red-filled caps button on the right (44
   tall). Rows are separated by hairlines. The whole block collapses when
   `warningIconVisibility` is collapsed.
5. **Status grid**: two columns separated by a vertical hairline, with a bottom hairline.
   - Left cell: "GLASSES BATTERY" label; `glassesBatteryText` in Doto 60 plus "%" in Doto 24
     (show "--" with no %, when unknown); a row of 10 square 10x10 dots with 4dp gaps, lit
     `fg` and unlit `mute` (from `batteryDots`); then `glassesChargingLabel` (label style).
   - Right column, two stacked cells: "DISPLAY MODE" plus a full-width button showing
     `displayModeValue` with a chevron (`onDisplayModeTap`); a hairline; then "AUTO
     BRIGHTNESS" plus "On"/"Off" (`brightnessAutoLabel`) with the Switch on the right. Tint
     the Switch red when on and `mute`/`dim` when off. The native Switch shape is fine; the
     square switch in the mockup is not required.
6. **Brightness row**: sun icon (`dim`), Slider (thumb and filled track `red-fill`, unfilled
   track `line`), value label (`GeistMono-Medium` 13, from `brightnessPercent`). Bottom
   hairline. While Auto is on, the slider is disabled; show it at 40% opacity.
7. Items 2 to 6 scroll inside a ScrollView that fills the remaining height. Items 1, 8 and 9
   are fixed.
8. **Input bar** (top hairline, padding 12/16, 8dp gaps):
   - "Type a message" button: `surface` fill, `line` border, keyboard icon, `dim` text,
     52 tall, fills the remaining width; taps `onKeyboardTap`.
   - Mic button: 52x52, `red-fill`, white mic icon, taps `onSyntheticMicTap`.
   - "REMOTE" button: 52 tall, 1px `fg` border, remote icon + caps text; opens the Remote
     sheet.
9. **Bottom nav**: three equal tabs (Glasses, Devices, More), icon (24) over caps label
   (11), 62 tall plus a 10 bottom inset, with a top hairline. The active tab has a 2dp
   `red-fill` bar on its top edge and `fg` color. Inactive tabs are `dim`.
   Android hardware Back on Devices or More returns to Glasses. On Glasses it behaves as
   today.

### 5.2 Remote sheet. See `lens-remote-watch.png` and `lens-remote-ring.png`

Create a new Android-only component, `app/phone-ui/lens-remote-sheet.xml`. Don't modify
`remote-controls.xml`. Use it in `main-page.xml`, bound to the page's MainViewModel.

- Overlay: a full-page `scrim` layer. Tapping the scrim closes the sheet. The sheet is
  anchored to the bottom with `surface` background and a top hairline, about 548dp tall.
  Optional: slide up with `translateY` over 200ms.
- Content: a 40x4 `mute` handle; "REMOTE" (Doto 24) with a close icon button (44x44); a
  two-segment control "WATCH" / "RING" (1px `line` border; selected segment filled `fg`
  with `bg` text; driven by `watchTabClass`/`ringTabClass` + `onWatchTabTap`/`onRingTabTap`).
- **Watch pad** (`watchTabVisibility`): `raised` fill, 1px `line` border, width
  `watchFaceWidth` and height `watchFaceHeight`, with every gesture binding from
  `remote-controls.xml`. Center: label "FOCUSED" (label style, add it as a static Label with
  `isUserInteractionEnabled="false"`), then `padFocusLine` (`Geist-Medium` 26,
  `padFocusClass`), then the existing wake hint (`padWakeHintVisibility`). Below the pad
  is a legend of four columns, caps label over value: TAP/Select, 2× TAP/Back,
  HOLD/Menu, SWIPE/Navigate.
- **Ring pad** (`ringTabVisibility`): a 96-wide strip, height `ringTouchpadHeight`, `raised`
  fill with a border, and six 28x2 `mute` markings in the same rows structure as
  `remote-controls.xml`. Legend: SWIPE ↕/Scroll, TAP/Click, 2× TAP/Double, HOLD/Long.
- Footer (top hairline): "Tap, then hold, on either pad opens the G2 system menu."
- The container that holds the pads gets `layoutChanged="{{ onControlsContentLayoutChanged }}"`.
  The sizing math in `MainViewModel.watchFaceWidth` assumes about 56dp of horizontal
  padding in portrait, so keep the sheet's pad container at 20dp side padding (or adjust
  the XML padding until the pad is fully visible). Don't rewrite that getter.
- Visibility: open state is page-level UI state (6.2 `remoteSheetVisibility`), and it is also
  hidden whenever `controlsVisibility` is collapsed.
- Hardware Back closes the sheet first.

### 5.3 Mirror minimized. See `lens-mirror-minimized-*.png`

- The mirror Image (and message box) collapse. Only the strip (5.1 item 3) remains, showing
  the focus line.
- The state persists across launches (6.3).
- While minimized, the phone must stop producing mirror frames (6.3). Screenshot and Record
  keep working, because recording is a separate consumer inside dashboard-controller.

### 5.4 Devices tab (no mockup; build from the tokens)

Replaces the scroll area of the Glasses tab. The header, input bar and nav stay. Rows are
full-width buttons, min 56 tall, padding 20, separated by hairlines. Each row has a title
(`Geist-Medium` 16), an optional secondary line (`Geist-Regular` 13 `dim`), and a
chevron-right icon unless it has its own button.

1. Section label "GLASSES" (label style, padding 20/20/8).
2. Connection row: title `connectionStatusLabel`, secondary `status` (the full status
   string), and on the right a caps outline button `buttonLabel` → `onTap`, with
   `isEnabled="{{ connectItemEnabled }}"`. The whole row uses
   `visibility="{{ glassesMenuItemsVisibility }}"`.
3. "Pair glasses" → `onPairGlassesTap` (`isEnabled="{{ canRun }}"`).
4. "Permissions" → `onPermissionsTap`.
5. Section label "DANGER ZONE" in `red-text`, then the "Uninstall custom firmware" row
   (title in `red-text`) → `onUninstallFirmwareTap`, with `isEnabled="{{ canRun }}"` and
   `visibility="{{ glassesMenuItemsVisibility }}"`. Leave a 24dp gap above this section.
   Don't add any extra confirmation logic and don't remove the existing one; the handler
   already routes into the flash flow.

### 5.5 More tab (no mockup)

Same row style as Devices.
1. "Conversations" → `onConversationsTap`.
2. "License (GPLv3)" and "Privacy Policy". Add two new handlers on MainViewModel that
   navigate exactly like `OnboardingViewModel.openDocument` in
   `phone-ui/onboarding-view-model.ts` (moduleName `phone-ui/document-page`, same context
   shape, files "LICENSE" and "PRIVACY").
3. Footer: "Faceclaw " + `FACECLAW_VERSION` from `app/version.ts` (label style, `dim`).

### 5.6 Keyboard panel and text-setting editor

- Both are bottom-anchored overlays today with class `system-name-modal`. Keep their XML
  structure, bindings and ids. Restyle them in `lens.css`: `surface` background, 1px `line`
  border, radius 0, label-style titles, square buttons (primary = `red-fill`).
- They are deliberately light in dark mode today, because of white-on-white TextField bugs
  (see the comments in `app.css` and `applySettingsTextFieldContrast` in `main-page.ts`).
  Make them theme-aware. Update `applySettingsTextFieldContrast` in `main-page.ts` to pick
  text, background and hint colors from the current theme (`Application.systemAppearance()`)
  instead of the fixed #222/#fff. Then **test both themes for white-on-white or
  black-on-black text** in every field, including password fields and the keyboard panel's
  TextView. If you cannot make the dark variant reliably readable, keep the panels light
  (as today) and only restyle shape and type. Readability wins.

### 5.7 Landscape

Today's landscape layout puts the mirror on the left and a 345dp controls column on the
right. New layout: columns `*,360`.
- Left: the mirror (keep `landscapeDisplayPreviewWidth/Height` and
  `onLandscapePreviewLayoutChanged` exactly as today). When the mirror is minimized, the
  left column collapses and the right column takes the full width.
- Right: header, mirror strip, the scrolling content, input bar, nav.
- The Remote sheet in landscape spans the right column, or the full width when that's
  simpler; the pads must be fully visible.

### 5.8 Secondary pages (phase 6, CSS-first)

Pages: conversations, conversation, ask, speakers, permissions, pairing, config, document,
plus the onboarding pages (welcome, unpair). Only CSS for the onboarding pages.
- ActionBar: `bg` background, `fg` title (`GeistMono-SemiBold` 13 caps), no elevation.
- Global Button: radius 0, 1px `line` border, transparent fill, `GeistMono-SemiBold` 12
  caps, min-height 48. `Button.-primary` is `red-fill` with white text. Overrides go in
  `lens.css`.
- TextField / SearchBar: `surface` fill, 1px `line` border, radius 0.
- Rows (`.conversation-row`, `.pairing-row`): hairline separators, no card backgrounds.
- Chips (`.speaker-chip`): square, 1px border. Keep their bound background colors
  (`chipBackground`), because speaker colors are data.
- Keep every XML binding. If a page needs a class added to an element to style it, adding
  `class` is fine; don't restructure layouts or touch view-models.
- The flash and firmware-check pages: **no file edits.** They inherit the global CSS only.
  Check them visually afterwards for anything that became unreadable.

---

## 6. Code changes

### 6.1 The only `app/g2` change: read-only snapshot fields

In `app/g2/dashboard-controller.ts`:
- Add `private lastHeadsetCharging = false;` next to `lastHeadsetBattery`.
- In the existing `communicator.onBatteryState` callback, add one line that stores
  `this.lastHeadsetCharging = state.chargingStatus > 0;`. Change nothing else in that
  callback.
- Add to `DashboardSnapshot`: `headsetBattery: number | null;`, `headsetCharging: boolean;`,
  `glassesWorn: boolean | null;`.
- In `snapshot()`, fill them from `this.lastHeadsetBattery`, `this.lastHeadsetCharging`
  and `this.glassesWorn`.
- The battery callback already calls `this.emit()`, so subscribers update. **Don't** add
  emits, timers or any send to the glasses.

### 6.2 MainViewModel additions (`app/phone-ui/main-view-model.ts`; add only)

- `glassesBatteryText` ("72", or "--" when null), `glassesBatteryPercentVisibility`,
  `batteryDots` (an array of 10 `{ lit: boolean }` for a Repeater, or ten class getters),
  and `glassesChargingLabel` ("CHARGING", "NOT CHARGING", or "" when unknown or
  disconnected). Notify on snapshot change, following the file's existing
  `notifyPropertyChange` pattern.
- `warningCount`: the number of the five warning booleans that are true.
- `displayModeValue`: `displayLayoutSetting.displayValue()`, without the arrow. You may add
  it on `RemoteControlsViewModel`; adding a getter there is safe for iOS. Notify it wherever
  `displayModeLabel` is notified.
- `brightnessAutoLabel`: "On" or "Off".
- `recordButtonVisibility`: the inverse of `stopRecordingButtonVisibility`.
- Main tab state: `mainTab: 'glasses' | 'devices' | 'more'`, in memory only (same pattern as
  `lastControlsTab`), with `glassesPanelVisibility`, `devicesPanelVisibility`,
  `morePanelVisibility`, tab class getters, and `onGlassesNavTap`/`onDevicesNavTap`/
  `onMoreNavTap`.
- Remote sheet state: `remoteSheetVisibility`, `onRemoteOpenTap`, `onRemoteCloseTap`. Also
  give hardware Back a way to close it: expose `closeTransientUi(): boolean`, which closes the
  sheet or returns to the Glasses tab, and returns whether it did anything.
- `onLicenseTap`, `onPrivacyTap` (5.5).

### 6.3 Mirror minimize

- Persist with `ApplicationSettings` from `@nativescript/core`, key
  `phoneUi.mirrorMinimized` (boolean, default false). This is a phone-only preference. Do
  **not** add it to `ui/dashboard-settings.ts` (those are the glasses' settings menus).
- MainViewModel: `mirrorMinimized` (boolean getter), `mirrorExpandedVisibility`,
  `mirrorMinimizedVisibility`, `mirrorToggleLabel` (accessibility text: "Minimize live
  mirror" or "Show live mirror"), `onMirrorToggleTap`.
- `app/phone-ui/main-page.ts` registers the preview with
  `dashboardController.attachPhonePreview(() => page.isLoaded && !model.displayPreviewMessage && (...))`.
  Add `&& !model.mirrorMinimized` to that predicate. That is the whole power-saving
  mechanism: `updateCompositePreview` already returns early when the predicate is false,
  and screen recording is checked before it, so recording keeps working. Don't change
  dashboard-controller for this.
- When the mirror is re-expanded, the next frame arrives within the controller's existing
  1s safety poll. A stale frame for up to 1s is acceptable. Don't add a refresh API.

### 6.4 Page code-behind (`app/phone-ui/main-page.ts`)

- Hardware Back: subscribe to `Application.android` `activityBackPressed` while the page is
  loaded. If `model.closeTransientUi()` returns true, set `args.cancel = true`. Unsubscribe
  in `cleanupPage`.
- Issue-button scroll (5.1).
- Theme-aware `applySettingsTextFieldContrast` (5.6).
- Optional: set the Android status bar and navigation bar colors to the `bg` token for the
  current theme.

---

## 7. Phases

Work on a branch (`git checkout -b lens-phone-ui` in `research/work/faceclaw`). Commit at
the end of each phase. Don't push. Every phase ends with `./build.sh`, `./lint.sh` and
`npm test` passing, and from phase 2 on, an install plus a manual check on the phone.

0. **Baseline.**
   - Read the files named in section 4. Make sure `build_paths.sh` exists (ask the user if
     the environment isn't configured).
   - Build. Check the installed app's signature (rule 0.7). Install.
   - Screenshot every current screen with `adb exec-out screencap -p`, in both themes, as a
     before-set.
   - Run the CSS-variable probe (3.5).
1. **Foundations.**
   - Add the fonts, the icons and `lens.css` (tokens plus base `lens-*` classes).
   - No layout changes yet. The build passes and the app looks the same.
2. **Data and state.** Do 6.1, 6.2 and 6.3 (view-model side only). Log the new getters once
   to verify battery and charging values against the glasses' top bar.
3. **Main page, portrait.** Rewrite `main-page.xml`: header, mirror and strip, issues,
   status, brightness, input bar, nav, overlays (BLE label, text editor, keyboard panel).
   Hook up the mirror predicate (6.3) and Back handling (6.4).
4. **Remote sheet.** Build 5.2.
5. **Devices and More tabs.** Build 5.4 and 5.5.
6. **Landscape and overlays.** Do 5.7 and 5.6.
7. **Secondary pages.** Do 5.8.
8. **Full QA.** Run section 8 in both themes and both orientations. Compare against the
   reference screens. Compare the before-set to confirm nothing went missing.

---

## 8. QA checklist (all must pass on the phone, glasses connected)

Run it in dark and light (switch the system theme), and in portrait plus landscape where
relevant.

**Glasses link**
- [ ] Glasses connect automatically on app start, and the header shows "CONNECTED".
- [ ] Tapping the connection button shows the full status dialog.
- [ ] Devices → Disconnect, then Connect: works, and the label and enabled state follow
      `buttonLabel`/`connectItemEnabled`.

**Mirror**
- [ ] The mirror updates live.
- [ ] Mirror tap, double-tap, long-press and swipe drive the glasses as before.
- [ ] Minimize: the mirror collapses and the strip shows the focus line. Kill and relaunch
      the app: it is still minimized. Expand: frames resume within about 1s.
- [ ] While minimized, mirror bitmaps stop. Verify with a temporary log in the predicate,
      or by watching memory/CPU, then remove any temporary logging.
- [ ] Screenshot works while expanded and while minimized.
- [ ] Record → STOP works while expanded and while minimized, and the GIF is saved.
- [ ] The silent-mode or low-battery message box shows in place of the mirror where it did
      before.

**Status**
- [ ] Glasses battery % matches the glasses' own top-bar battery, and charging shows when
      the glasses are on the charger.
- [ ] Display mode picker opens, changes the mode on the glasses, and the value updates.
- [ ] The brightness slider changes the glasses' brightness. Auto on/off works, and the
      slider disables under Auto.

**Issues**
- [ ] Each issue row appears when its condition is true, and its button does what the old
      modal button did. At minimum, test battery optimization (revoke the exemption in
      Android settings) and the Even app conflict, if reproducible.
- [ ] The header count matches the rows. Tapping it scrolls to them.

**Input**
- [ ] The mic button fires the wakeword on the glasses.
- [ ] "Type a message" opens the keyboard panel. Send to Agent and App both work. History
      and the phone/glasses visibility toggle work. Discard works.
- [ ] A text setting edited from the glasses (e.g. an API key) opens the editor on the
      phone. Submit and Cancel work, including password fields and the toggle variant.
- [ ] Text is readable in both themes in every field.

**Remote sheet**
- [ ] Opens and closes via the button, X, scrim tap and hardware Back.
- [ ] Watch pad: tap, double-tap, hold and swipes (all four directions) all drive the
      glasses. The focus line updates. The wake hint shows when the display is asleep, and
      double-tap wakes it.
- [ ] Ring pad: vertical swipes, tap, double-tap and hold behave like the ring.
- [ ] Tap-then-hold on either pad opens the G2 system menu.
- [ ] The sheet hides while the keyboard panel or text editor is up.

**Navigation**
- [ ] Devices: Pair glasses opens pairing. Permissions opens permissions. Uninstall custom
      firmware opens the existing flash flow (**back out at the first confirmation; do not
      actually uninstall**).
- [ ] More: Conversations works (list, search, open, Ask, Speakers). License and Privacy
      open.
- [ ] Back on Devices or More returns to Glasses. Back on Glasses behaves as before.
- [ ] The EvenHub phone-UI header button appears with an EvenHub app in the foreground and
      opens its phone UI.
- [ ] Preview-only mode (no glasses paired) still works: the header shows the preview
      state and the glasses-only rows are hidden.

**Other**
- [ ] The developer BLE bandwidth label still shows when its setting is on.
- [ ] Onboarding pages and the flash/firmware-check pages are readable in both themes
      (visual check only; don't run a flash).
- [ ] The K02 ring (driven by `ring-grab`) still controls the glasses after the new build is
      installed.
- [ ] `./build.sh`, `./lint.sh` and `npm test` are clean.
- [ ] `git diff --stat` only touches the files allowed by section 0.

---

## 9. Gotchas from the existing code

- A `GridLayout` without explicit `rows` gets an implicit star row that balloons inside
  star-sized parents. Use `rows="auto"` deliberately (see the comments in
  `remote-controls.xml` and `main-page.xml`).
- NativeScript has no `maxHeight`. The keyboard panel caps its height with a fixed-height
  transparent wrapper. Keep that trick if you touch the wrapper.
- The pad gesture attributes are `android:`-prefixed on purpose (iOS feeds raw touches
  separately). Keep the prefix in the new sheet XML for consistency.
- `watchFaceWidth` hard-codes layout assumptions (the 56dp portrait padding, the 345dp
  landscape column). If the pad looks clipped, adjust padding in XML to fit those
  assumptions, or update the numbers **and** their comments together, in the view-model
  only.
- `main-page.ts` finds `settingsTextField`, `secondarySettingsTextField` and
  `keyboardInputField` by id. Renaming any of them silently breaks keyboard focus.
- `@nativescript/theme` sets `.ns-dark` on the root. Use it; don't add a second theme
  mechanism.
- Fonts in `app/fonts/ttf/` are bundled for the glasses' font picker
  (`graphics/installed-fonts.ts`). Put the new UI fonts in `app/fonts/`.

---

## 10. Out of scope / follow-ups

- **Case battery.** It needs reverse-engineering of which BLE message carries `case_soc` (the
  Even app logs a `sys.chg.case_status` tracepoint with `case_soc`/`case_charging`) and
  Kotlin parsing. It is a separate task with its own safety review.
- **iOS.** Leave iOS on its current UI. Don't break its build. Shared files only get additive
  getters, and CSS changes go only to the Android-only `lens.css`.
- **R1 ring battery** is tracked by the app (`ringBattery`), but the user has no R1. Don't
  surface it now.
