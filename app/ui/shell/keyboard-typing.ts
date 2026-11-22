import { shell } from "./shell";

/**
 * Apply watch keystrokes to the keyboard dialog's draft, opening the dialog
 * (and showing it on the glasses) if needed. False when no dialog can open
 * now. Shared by the Android and iOS remote-input hosts.
 */
export function typeIntoKeyboardDialog(keys: string, requestShellRender: () => void): boolean {
  if (!shell.isScreenOn()) shell.wake("window");
  const session = shell.startKeyboardInput();
  if (!session) return false;
  if (session.visibility === "phone") session.setVisibility("both");
  session.type(keys);
  requestShellRender();
  return true;
}
