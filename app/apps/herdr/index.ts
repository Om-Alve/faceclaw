import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";
import { onSettingsStoreChanged } from "../../native/settings-store";
import { hasHerdrBackgroundWork } from "./background";
import { HERDR_MACHINES_KEY } from "./machines";

/** The one place the worker is constructed (string-literal path for the webpack worker loader). */
const createWorker = () => new Worker("./herdr-app.worker");

/** The boot hook's settings listener; replaced if a controller boots again. */
let stopWatchingSettings: (() => void) | null = null;

const herdrApp: AppDefinition = {
  appId: "herdr",
  title: "Herdr",
  icon: "herdr",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker,
      // One window: Back always moves one level up, and a wake has one place to land.
      windowId: "herdr:main",
      title: "Herdr",
      iconLetter: "H",
      icon: "herdr",
      matchExistingBy: "windowId",
      // The watch's four directions are meaningful in the pane reader and Keys mode.
      acceptsDirectional: true,
    }),
  /**
   * Keep the worker (and its machine connections) alive with no window open
   * for the Glanceboard widget or the optional wake-on-blocked watch.
   */
  boot: (ctx) => {
    const ensureWorker = () => {
      if (hasHerdrBackgroundWork()) ctx.ensureWorkerHost(createWorker);
    };
    ensureWorker();
    stopWatchingSettings?.();
    stopWatchingSettings = onSettingsStoreChanged((key) => {
      if (key.startsWith("glanceboard.") || key === HERDR_MACHINES_KEY || key.startsWith("herdr.")) ensureWorker();
    });
  },
};

export default herdrApp;
