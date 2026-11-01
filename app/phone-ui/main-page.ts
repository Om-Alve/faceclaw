import { Application, Color, EventData, isAndroid, Observable, Page, ScrollView, TextField, TextView, View } from '@nativescript/core'
import { MainViewModel } from './main-view-model'
import { dashboardController } from '../g2/dashboard-controller'

const SETTINGS_TEXT_COLOR = new Color('#222222')
const SETTINGS_BACKGROUND_COLOR = new Color('#ffffff')
const SETTINGS_PLACEHOLDER_COLOR = new Color('#666666')

export function navigatingTo(args: EventData) {
  const page = <Page>args.object
  page.bindingContext = new MainViewModel()
}

type MainPageState = {
  model: MainViewModel
  propertyChangeHandler: (args: EventData & { propertyName?: string }) => void
  orientationHandler: () => void
  detachPreview: () => void
  backHandler?: (args: { cancel: boolean }) => void
}

function getPageState(page: Page): MainPageState | undefined {
  return (page as Page & { __mainPageState?: MainPageState }).__mainPageState
}

function setPageState(page: Page, state?: MainPageState): void {
  ;(page as Page & { __mainPageState?: MainPageState }).__mainPageState = state
}

function cleanupPage(page: Page): void {
  const state = getPageState(page)
  if (!state) {
    setPageState(page, undefined)
    return
  }
  state.model.off(Observable.propertyChangeEvent, state.propertyChangeHandler)
  state.detachPreview()
  Application.off(Application.orientationChangedEvent, state.orientationHandler)
  if (state.backHandler) {
    Application.android?.off("activityBackPressed", state.backHandler)
  }
  // navigatingTo builds a fresh model each visit; drop the old one's
  // controller/settings subscriptions or every navigation leaks a listener.
  state.model.dispose()
  setPageState(page, undefined)
}

/**
 * Readable colours for the light editor panels in both themes. selectAllOnFocus
 * suits replacing an existing setting value; a message being composed keeps
 * its caret where the user taps.
 */
function applySettingsTextFieldContrast(textField: TextField | TextView, selectAllOnFocus = true): void {
  textField.color = SETTINGS_TEXT_COLOR
  textField.backgroundColor = SETTINGS_BACKGROUND_COLOR
  textField.placeholderColor = SETTINGS_PLACEHOLDER_COLOR

  if (!isAndroid) {
    return
  }

  const nativeTextField = (textField as (TextField | TextView) & { nativeView?: android.widget.EditText }).nativeView
  if (!nativeTextField) {
    return
  }

  nativeTextField.setTextColor(android.graphics.Color.rgb(34, 34, 34))
  nativeTextField.setHintTextColor(android.graphics.Color.rgb(102, 102, 102))
  // Editing an existing value usually means replacing it: select all on focus
  // so typing starts fresh but the current value stays visible.
  nativeTextField.setSelectAllOnFocus(selectAllOnFocus)
}

/**
 * Leaving keyboard-input mode: the glasses navigated away from the text
 * setting, so the phone's keyboard has nothing to type into any more.
 */
function dismissTextEditorKeyboard(page: Page): void {
  page.getViewById<TextField>('settingsTextField')?.dismissSoftInput()
  page.getViewById<TextField>('secondarySettingsTextField')?.dismissSoftInput()
}

function focusTextEditor(page: Page): void {
  setTimeout(() => {
    const textField = page.getViewById<TextField>('settingsTextField')
    const secondaryTextField = page.getViewById<TextField>('secondarySettingsTextField')
    if (textField) {
      applySettingsTextFieldContrast(textField)
    }
    if (secondaryTextField) {
      applySettingsTextFieldContrast(secondaryTextField)
    }
    textField?.focus()
  }, 0)
}

/** The keyboard dialog closed on the glasses (sent, discarded, or screen off). */
function dismissKeyboardInputKeyboard(page: Page): void {
  page.getViewById<TextView>('keyboardInputField')?.dismissSoftInput()
}

/** The keyboard dialog opened: bring up the IME on its field right away. */
function focusKeyboardInput(page: Page): void {
  setTimeout(() => {
    const textField = page.getViewById<TextView>('keyboardInputField')
    if (textField) {
      applySettingsTextFieldContrast(textField, false)
      textField.focus()
    }
  }, 0)
}

/** The header's issue button: bring the rows into view on the active layout. */
function scrollToIssues(page: Page, model: MainViewModel): void {
  const landscape = model.landscapeLayoutVisibility === "visible"
  const scrollView = page.getViewById<ScrollView>(landscape ? "homeScrollLandscape" : "homeScroll")
  const block = page.getViewById<View>(landscape ? "issuesBlockLandscape" : "issuesBlock")
  if (!scrollView || !block) return
  // Both positions are window-relative, so their difference is the block's
  // offset inside the scroll content; add the current offset to land on it.
  const offset = block.getLocationInWindow().y - scrollView.getLocationInWindow().y
  scrollView.scrollToVerticalOffset(Math.max(0, scrollView.verticalOffset + offset), false)
}

/**
 * The Remote sheet's height is derived from page and header sizes cached by
 * their layoutChanged handlers, and those can miss a resize: typing (keyboard
 * up, page shrunk) and then leaving the app left the cache at the shrunk
 * height, pinning the sheet at its floor with the pad squashed. Re-read the
 * live sizes when the page comes back and whenever the sheet shows; unchanged
 * sizes are a no-op in the handlers.
 */
function remeasureSheetBounds(page: Page, model: MainViewModel): void {
  const root = page.getViewById<View>('portraitRoot')
  const header = page.getViewById<View>('pageHeader')
  if (root) model.onPortraitRootLayoutChanged({ object: root })
  if (header) model.onPageHeaderLayoutChanged({ object: header })
}

export function loaded(args: EventData) {
  const page = args.object as Page
  cleanupPage(page)
  dashboardController.refreshEvenAppStatus()

  const model = page.bindingContext as MainViewModel | null
  // Re-subscribe after a suspend/resume cycle (unloaded disposed the model);
  // a no-op on the first load after construction.
  model?.attach()
  // Automatically connect on reaching the main page (no-op if already
  // connected or if no glasses are configured).
  void model?.autoConnect()
  // Reopen the apps that were open before the last restart (no-op after the
  // first load).
  void dashboardController.restoreOpenApps()
  const settingsTextField = page.getViewById<TextField>('settingsTextField')
  model?.refreshLayoutMetrics()
  if (settingsTextField) {
    applySettingsTextFieldContrast(settingsTextField)
  }
  if (!model) {
    return
  }

  const state: MainPageState = {
    model,
    detachPreview: dashboardController.attachPhonePreview(() =>
      page.isLoaded && !model.displayPreviewMessage && !model.mirrorMinimized && (!isAndroid || !!page.android?.isShown())),
    orientationHandler: () => {
      setTimeout(() => {
        model.refreshLayoutMetrics()
      }, 0)
    },
    propertyChangeHandler: (propertyArgs) => {
      if (propertyArgs.propertyName === 'activeTextSettingId') {
        if (model.isTextSettingEditorActive) {
          focusTextEditor(page)
        } else {
          dismissTextEditorKeyboard(page)
        }
      } else if (propertyArgs.propertyName === 'keyboardInputActive') {
        if (model.keyboardInputActive) {
          focusKeyboardInput(page)
        } else {
          dismissKeyboardInputKeyboard(page)
        }
      } else if (propertyArgs.propertyName === 'remoteSheetVisibility') {
        if (model.remoteSheetVisibility === 'visible') {
          remeasureSheetBounds(page, model)
        }
      } else if (propertyArgs.propertyName === 'scrollToIssues') {
        // Let the Glasses tab lay out first (the button may have switched to it).
        setTimeout(() => scrollToIssues(page, model), 0)
      }
    },
  }

  // Hardware Back closes the Remote sheet, then returns to the Glasses tab;
  // otherwise it behaves as it always has (leaving the page).
  state.backHandler = (backArgs: { cancel: boolean }) => {
    if (model.closeTransientUi()) {
      backArgs.cancel = true
    }
  }
  Application.android?.on("activityBackPressed", state.backHandler)

  model.on(Observable.propertyChangeEvent, state.propertyChangeHandler)
  Application.on(Application.orientationChangedEvent, state.orientationHandler)
  setPageState(page, state)
  remeasureSheetBounds(page, model)
  if (model.isTextSettingEditorActive) {
    focusTextEditor(page)
  }
  if (model.keyboardInputActive) {
    focusKeyboardInput(page)
  }
}

export function unloaded(args: EventData) {
  cleanupPage(args.object as Page)
}
