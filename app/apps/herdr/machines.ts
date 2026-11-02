/**
 * Herdr machine registry: the bridges this app knows about, stored as JSON under
 * one settings key (the Terminal app's connections.ts pattern). Every isolate
 * sees the same list and change notifications ride the ordinary settings-store
 * channel, so the phone editor, the worker, and the Glanceboard agree.
 *
 * A record is local to the phone: its id never comes from the server, and the
 * display label is either what the wearer called it or the bridge's
 * `hello.machine`. Records that report the same machine are deduplicated by the
 * worker (see duplicateMachineIds in model.ts).
 */
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { machineIdForUrl, parseBridgeUrl, type ParsedBridgeUrl } from "./model";

export const HERDR_MACHINES_KEY = "herdr.machines";
/** The phone editor's scratch field for a URL being typed (never a stored machine). */
export const HERDR_URL_DRAFT_KEY = "herdr.urlDraft";
/** The shared draft the phone editor types message text into. */
export const HERDR_COMPOSE_DRAFT_KEY = "herdr.composeDraft";

export type HerdrMachine = {
  /** Stable local id, assigned at add time. */
  id: string;
  /** What the wearer calls it; empty falls back to the reported machine name. */
  label: string;
  /** HTTPS base URL, normalized (see parseBridgeUrl). */
  url: string;
  /** Auto-connect while the app or its widget needs it. */
  enabled: boolean;
  /** `hello.machine` from the last successful connection, for dedupe and display. */
  machine: string | null;
};

function normalizeRecord(value: unknown): HerdrMachine | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const url = typeof item.url === "string" ? item.url : "";
  if (!id || !parseBridgeUrl(url)) return null;
  return {
    id,
    label: typeof item.label === "string" ? item.label : "",
    url,
    enabled: item.enabled !== false,
    machine: typeof item.machine === "string" && item.machine ? item.machine : null,
  };
}

export function loadMachines(): HerdrMachine[] {
  const raw = getStringSetting(HERDR_MACHINES_KEY, "");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRecord).filter((machine): machine is HerdrMachine => machine !== null);
  } catch {
    return [];
  }
}

export function saveMachines(machines: readonly HerdrMachine[]): void {
  setStringSetting(HERDR_MACHINES_KEY, JSON.stringify(machines));
}

/** Add or replace a machine record (by id). */
export function upsertMachine(machine: HerdrMachine): void {
  const machines = loadMachines();
  const index = machines.findIndex((candidate) => candidate.id === machine.id);
  if (index >= 0) machines[index] = machine;
  else machines.push(machine);
  saveMachines(machines);
}

export function updateMachine(id: string, update: Partial<Omit<HerdrMachine, "id">>): void {
  const machines = loadMachines();
  const machine = machines.find((candidate) => candidate.id === id);
  if (!machine) return;
  Object.assign(machine, update);
  saveMachines(machines);
}

export function removeMachine(id: string): void {
  saveMachines(loadMachines().filter((machine) => machine.id !== id));
}

/**
 * Add a machine from a typed or scanned URL. A URL already present returns the
 * existing record; two URLs for the same host collapse to one record.
 */
export function addMachineFromUrl(input: string, label = ""): { machine: HerdrMachine; added: boolean } | { error: string } {
  const parsed = parseBridgeUrl(input);
  if (!parsed) return { error: "That isn't a bridge URL. Use https://<machine>.<tailnet>.ts.net" };
  const machines = loadMachines();
  const existing = machines.find((machine) => {
    const known = parseBridgeUrl(machine.url);
    return known !== null && known.baseUrl === parsed.baseUrl;
  });
  if (existing) return { machine: existing, added: false };
  const machine: HerdrMachine = {
    id: uniqueMachineId(parsed, machines),
    label: label.trim(),
    url: parsed.baseUrl,
    enabled: true,
    machine: null,
  };
  saveMachines([...machines, machine]);
  return { machine, added: true };
}

function uniqueMachineId(parsed: ParsedBridgeUrl, machines: readonly HerdrMachine[]): string {
  const base = machineIdForUrl(parsed);
  const taken = new Set(machines.map((machine) => machine.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/** Display label: the wearer's label, else the reported machine name, else the URL host. */
export function machineDisplayName(machine: HerdrMachine): string {
  if (machine.label) return machine.label;
  if (machine.machine) return machine.machine;
  return parseBridgeUrl(machine.url)?.host ?? machine.url;
}

/** Whether the Glanceboard Herdr widget asks for connections while no window is open. */
export function machineUrlSetting(): string {
  return getStringSetting(HERDR_URL_DRAFT_KEY, "");
}
