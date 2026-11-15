import { Dialogs, Frame, Observable, type ImageSource } from '@nativescript/core';
import { brightnessSetting, displayLayoutSetting, type BrightnessSetting, phoneInputStyleSetting, type PhoneInputStyle } from '../ui/dashboard-settings';
import type { PhoneUiButton } from '../apps/evenhub/manager';

/** Shared state and actions for remote-controls.xml; transport stays in the host. */
export class RemoteControlsViewModel extends Observable {
  // The pad on screen. Cached so a settings-store change only notifies (and the
  // host only cancels gestures in flight) when the style really changed.
  private _inputStyle: PhoneInputStyle = phoneInputStyleSetting.get();
  private _evenHubPhoneUi: PhoneUiButton | null = null;

  // ---- which touchpad is showing (Settings > Phone input style) ----

  get watchPadVisibility(): "visible" | "collapse" {
    return this._inputStyle === "watch" ? "visible" : "collapse";
  }

  get ringPadVisibility(): "visible" | "collapse" {
    return this._inputStyle === "ring" ? "visible" : "collapse";
  }

  /** Re-read the input style; the host calls this when any setting changes (it can change from the glasses too). */
  public refreshInputStyle(): void {
    const style = phoneInputStyleSetting.get();
    if (style === this._inputStyle) return;
    this._inputStyle = style;
    this.notifyPropertyChange("watchPadVisibility", this.watchPadVisibility);
    this.notifyPropertyChange("ringPadVisibility", this.ringPadVisibility);
  }

  /**
   * The watch face's status line reads "Display off": dim it and show the wake
   * gesture under it. The host overrides this and notifies padFocusClass and
   * padWakeHintVisibility when it changes.
   */
  protected get padDisplayAsleep(): boolean {
    return false;
  }

  get padFocusClass(): string {
    return this.padDisplayAsleep ? "pad-focus pad-focus-asleep" : "pad-focus";
  }

  get padWakeHintVisibility(): "visible" | "collapse" {
    return this.padDisplayAsleep ? "visible" : "collapse";
  }

  /**
   * A smaller line under the watch face's status line, or "" to hide it: the
   * charging case's level while the glasses charge in it. The host overrides
   * this and notifies padDetailLine and padDetailVisibility when it changes.
   */
  get padDetailLine(): string {
    return "";
  }

  get padDetailVisibility(): "visible" | "collapse" {
    return this.padDetailLine ? "visible" : "collapse";
  }

  // ---- the button bar: EvenHub phone UI, voice, keyboard, settings ----
  //
  // The mic and keyboard buttons (onSyntheticMicTap, onKeyboardTap) are the
  // host's: they go straight to its transport.

  /** Host hook: overlay this EvenHub app's phone UI over the main page. */
  showEvenHubPhoneUi: (windowId: string) => void = () => {};

  /**
   * The foreground glasses window's phone-UI button (phoneUiButton), or null
   * when it isn't an EvenHub app or its phone UI is already showing; set by
   * the host.
   */
  get evenHubPhoneUi(): PhoneUiButton | null {
    return this._evenHubPhoneUi;
  }

  set evenHubPhoneUi(value: PhoneUiButton | null) {
    const current = this._evenHubPhoneUi;
    if (current?.windowId === value?.windowId && current?.icon === value?.icon && current?.title === value?.title) return;
    this._evenHubPhoneUi = value;
    this.notifyPropertyChange("evenHubPhoneUiIcon", this.evenHubPhoneUiIcon);
    this.notifyPropertyChange("evenHubPhoneUiVisibility", this.evenHubPhoneUiVisibility);
    this.notifyPropertyChange("evenHubPhoneUiLabel", this.evenHubPhoneUiLabel);
  }

  /** The app's own icon (white on transparent; the stylesheet tints it like the other buttons'). */
  get evenHubPhoneUiIcon(): ImageSource | null {
    return this._evenHubPhoneUi?.icon ?? null;
  }

  get evenHubPhoneUiVisibility(): "visible" | "collapse" {
    return this._evenHubPhoneUi?.icon ? "visible" : "collapse";
  }

  /** The button's accessibility label. */
  get evenHubPhoneUiLabel(): string {
    return this._evenHubPhoneUi ? `Open ${this._evenHubPhoneUi.title} on phone` : "";
  }

  onEvenHubPhoneUiTap(): void {
    // Gated on the icon like the button's visibility, so a hidden button does nothing.
    const button = this._evenHubPhoneUi;
    if (button?.icon) this.showEvenHubPhoneUi(button.windowId);
  }

  /** The gear button: display mode, brightness, battery levels and the input style. */
  onSettingsTap(): void {
    Frame.topmost()?.navigate({ moduleName: "phone-ui/settings-page" });
  }
  get displayModeLabel(): string {
    return displayLayoutSetting.displayValue() + " ▾";
  }

  /**
   * The same value without the ↓: the Lens layout draws its own chevron icon,
   * so the text must not carry a second one.
   */
  get displayModeValue(): string {
    return displayLayoutSetting.displayValue();
  }

  async onDisplayModeTap(): Promise<void> {
    const current = displayLayoutSetting.get();
    // Full Screen is offered only with a bottom or popup app switcher.
    const values = displayLayoutSetting.values.filter((value) => !displayLayoutSetting.isDisabled(value));
    const options = values.map((value) => displayLayoutSetting.displayValue(value) + (value === current ? "  ✓" : ""));
    const picked = await Dialogs.action({ title: "Display mode", cancelButtonText: "Cancel", actions: options });
    const index = options.indexOf(picked);
    if (index < 0) return;
    const value = values[index]!;
    if (value !== current) displayLayoutSetting.set(value);
    this.notifyPropertyChange("displayModeLabel", this.displayModeLabel);
    this.notifyPropertyChange("displayModeValue", this.displayModeValue);
  }

  get brightnessAuto(): boolean {
    return brightnessSetting.get() === "auto";
  }

  get brightnessSliderEnabled(): boolean {
    return !this.brightnessAuto;
  }

  /** The Auto cell's own text, without a Switch two-way binding. */
  get brightnessAutoLabel(): string {
    return this.brightnessAuto ? "On" : "Off";
  }

  /** The Lens switch is drawn from classes, not the platform Switch. */
  get brightnessAutoSwitchClass(): string {
    return this.brightnessAuto ? "lens-switch lens-switch-on" : "lens-switch";
  }

  /**
   * While Auto is on the manual level is meaningless, so the Lens slider is
   * shown dimmed rather than hidden (it keeps the row's height stable).
   */
  get brightnessSliderClass(): string {
    return this.brightnessSliderEnabled ? "lens-slider" : "lens-slider lens-slider-disabled";
  }

  /** The slider's position; while Auto, the last manual level (or 50). */
  get brightnessPercent(): number {
    const value = brightnessSetting.get();
    if (value === "auto") return this.lastManualBrightness;
    const numeric = parseInt(value, 10);
    return Number.isFinite(numeric) ? numeric : 50;
  }

  /** The Tonal brightness card shows the value with its unit. */
  get brightnessPercentLabel(): string {
    return `${this.brightnessPercent}%`;
  }

  private lastManualBrightness = 50;

  onBrightnessChange(args: { value?: number; object?: { value?: number } }): void {
    if (this.brightnessAuto) return;
    const raw = typeof args.value === "number" ? args.value : Number(args.object?.value ?? NaN);
    if (!Number.isFinite(raw)) return;
    // The setting only has every tenth level; snap to the nearest.
    const level = Math.min(100, Math.max(2, Math.round(raw / 10) * 10));
    this.lastManualBrightness = level;
    const value = String(level) as BrightnessSetting;
    if (brightnessSetting.get() !== value) brightnessSetting.set(value);
  }

  onBrightnessAutoChange(args: { value?: boolean; object?: { checked?: boolean } }): void {
    const on = typeof args.value === "boolean" ? args.value : Boolean(args.object?.checked);
    if (on) {
      if (brightnessSetting.get() !== "auto") {
        this.lastManualBrightness = this.brightnessPercent;
        brightnessSetting.set("auto");
      }
    } else if (brightnessSetting.get() === "auto") {
      brightnessSetting.set(String(this.lastManualBrightness) as BrightnessSetting);
    }
    this.refreshDisplayControls();
  }

  public refreshDisplayControls(): void {
    this.notifyPropertyChange("brightnessAuto", this.brightnessAuto);
    this.notifyPropertyChange("brightnessSliderEnabled", this.brightnessSliderEnabled);
    this.notifyPropertyChange("brightnessPercent", this.brightnessPercent);
    this.notifyPropertyChange("brightnessPercentLabel", this.brightnessPercentLabel);
    this.notifyPropertyChange("displayModeLabel", this.displayModeLabel);
    this.notifyPropertyChange("displayModeValue", this.displayModeValue);
    this.notifyPropertyChange("brightnessAutoLabel", this.brightnessAutoLabel);
    this.notifyPropertyChange("brightnessAutoSwitchClass", this.brightnessAutoSwitchClass);
    this.notifyPropertyChange("brightnessSliderClass", this.brightnessSliderClass);
  }

}
