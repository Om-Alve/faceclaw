import { isValidMacAddress, loadDeviceAddresses, loadPairedGlassesIdentityForAddresses } from "./device-addresses";
import { GlassesHardwareIdentity } from "./glasses-hardware-identity";
import { publishHomeWidget } from "../native/home-widget";
import { shell } from "../ui/shell/shell";

// The paired serial's frame shape, decoded once per serial: the controller
// publishes on every state change.
let frameSerial: string | null = null;
let frame: string | null = null;

/**
 * Mirror the tile-relevant state into the Android 2x2 home widget. The
 * controller calls this from emit(), its single funnel for battery, case and
 * phase changes, and once a minute while connected so the widget's report time
 * stays fresh. The bridge drops publishes that would not change the tile.
 */
export function publishHomeWidgetState(phase: string): void {
  const levels = shell.getBatteryLevels();
  const addresses = loadDeviceAddresses();
  publishHomeWidget({
    paired: isValidMacAddress(addresses.left) && isValidMacAddress(addresses.right),
    connected: phase === "connected" || phase === "charging",
    // The case's own report says whether the glasses are docked (caseCharging
    // is null otherwise), which also covers a full pair that never enters
    // charging mode. Else the same test as updateGlassesPresence: "charging"
    // is a live link from the case.
    docked: levels.caseCharging !== null || phase === "charging" || levels.headsetCharging === true,
    glasses: levels.headset,
    glassesCharging: levels.headsetCharging,
    caseBattery: levels.case,
    caseCharging: levels.caseCharging,
    frame: frameFor(addresses),
  });
}

/** Frame A/B/C of the paired glasses. */
function frameFor(addresses: ReturnType<typeof loadDeviceAddresses>): string | null {
  const serial = loadPairedGlassesIdentityForAddresses(addresses)?.serial ?? "";
  if (serial !== frameSerial) {
    frameSerial = serial;
    frame = GlassesHardwareIdentity.decode(serial)?.frame ?? null;
  }
  return frame;
}
