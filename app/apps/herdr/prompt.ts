/**
 * Permission and question menu grammar for the answer screen, adapted from
 * pawaca/even-better src/parse.ts (MIT; see ACKNOWLEDGEMENTS.md).
 *
 * A blocked Claude or Codex pane paints a numbered chooser into the terminal:
 * "N. label" rows, with the highlighted row carrying the agent's selection
 * marker (`❯` for Claude, `›` for Codex). The rendered menu is the only signal
 * the app has, so this module parses it and hands back the keys each agent
 * actually accepts.
 *
 * Pure: text in, choices out. The worker owns the menu that draws them.
 */
import { isAllowedKey } from "./protocol";

export interface MenuOption {
  digit: string;
  label: string;
}

/** The marker on the highlighted row: Claude's `❯`, Codex's `›`, or none. */
export type MenuMarker = "❯" | "›" | "";

export interface ParsedMenu {
  title: string;
  options: MenuOption[];
  /** Which key grammar the menu expects. */
  marker: MenuMarker;
}

/** An answer row: a label for the glasses and the bridge keys that send it. */
export interface AnswerChoice {
  label: string;
  keys: string[];
}

// A leading selection marker is skipped, else the highlighted option is missed
// (a 3-option Codex approval then mis-parses into a 2-option "question").
const OPTION_ROW = /^\s*(?:([❯›])\s*)?(\d)[.)]\s+(.+?)\s*$/;

/**
 * Parse the numbered selection menu on screen. Options are accepted only as a
 * contiguous 1,2,3,… run: Codex also prefixes its *input line* with `›`, so a
 * numbered prompt echo ("› 1. update the readme") must not read as a menu.
 * Keep the last valid run — the live dialog paints at the bottom.
 */
export function parseMenu(text: string): ParsedMenu | null {
  const lines = text.split("\n");
  const hits: { idx: number; digit: number; label: string; marker: MenuMarker }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = OPTION_ROW.exec(lines[i] ?? "");
    if (!match) continue;
    hits.push({ idx: i, digit: Number(match[2]), label: match[3] ?? "", marker: (match[1] as MenuMarker | undefined) ?? "" });
  }

  let best: typeof hits = [];
  let run: typeof hits = [];
  for (const hit of hits) {
    const prev = run[run.length - 1];
    // A wrapped label may leave one line between rows; the numbers must still climb by one.
    if (prev && hit.idx - prev.idx <= 2 && hit.digit === prev.digit + 1) run.push(hit);
    else {
      if (run.length >= 2 && run[0]?.digit === 1) best = run;
      run = hit.digit === 1 ? [hit] : [];
    }
  }
  if (run.length >= 2 && run[0]?.digit === 1) best = run;
  if (best.length < 2) return null;

  const first = best[0]!;
  const marked = best.find((hit) => hit.marker !== "");

  // Title: the nearest content line above the first option.
  let title = "";
  for (let i = first.idx - 1; i >= 0 && first.idx - i < 8; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line || /^[─═╌┄┈\s]+$/.test(line)) continue;
    title = line.replace(/^[│┃]\s*/, "").replace(/\s*[│┃]$/, "");
    break;
  }

  return {
    title,
    options: best.map((hit) => ({ digit: String(hit.digit), label: hit.label })),
    marker: marked?.marker ?? "",
  };
}

export interface ClassifiedMenu {
  kind: "permission" | "question";
  allow?: MenuOption;
  allowAlways?: MenuOption;
  deny?: MenuOption;
}

/** Decide whether a parsed menu is a yes/no permission prompt or a question form. */
export function classifyMenu(menu: ParsedMenu): ClassifiedMenu {
  let allow: MenuOption | undefined;
  let allowAlways: MenuOption | undefined;
  let deny: MenuOption | undefined;
  for (const option of menu.options) {
    const label = option.label.toLowerCase();
    if (/^yes\b/.test(label)) {
      if (/always|don'?t ask|during this session/.test(label)) allowAlways = allowAlways ?? option;
      else allow = allow ?? option;
    } else if (/^(no|cancel|deny)\b/.test(label)) {
      deny = deny ?? option;
    }
  }
  if (allow && deny) return { kind: "permission", allow, allowAlways, deny };
  return { kind: "question" };
}

/**
 * Detect a live Codex tool-approval dialog: a parseable menu, a **marked**
 * option row, and the "enter to confirm … esc to cancel" footer just below it.
 * Codex approvals are not hooks, so the screen is the only signal, and each
 * guard rules out a false positive the others miss: the footer appears in
 * ordinary output, parseMenu accepts unmarked prose lists, and `›` is also
 * Codex's input prompt — but only a live dialog puts a marked row above the
 * footer.
 */
export function isCodexApprovalScreen(text: string): boolean {
  if (parseMenu(text) === null) return false;
  const lines = text.split("\n");
  // ANY marked row, not just the first: a stale `› N.` echo can sit above the dialog.
  return lines.some((line, i) => {
    if (!/^[ \t]*[❯›][ \t]*\d[.)]\s/.test(line)) return false;
    const below = lines.slice(i, i + 8).join("\n");
    return /enter to confirm\b/i.test(below) && /esc to cancel\b/i.test(below);
  });
}

/** Keys must be lowercase combos the bridge accepts, or the answer is refused. */
function validKeys(keys: readonly string[]): string[] | null {
  const lowered = keys.map((key) => key.toLowerCase());
  return lowered.length > 0 && lowered.every((key) => isAllowedKey(key)) ? lowered : null;
}

/**
 * The choices to show for a blocked prompt, or [] when no menu is parseable.
 *
 * Claude selects with the option digit, so its choices carry the exact parsed
 * digits; the semantic rows get short labels ("Allow", "Allow always", "Deny")
 * because Claude's own labels are long and redundant with the digit.
 *
 * Codex selects by moving the highlight, never by digit: the ladder is
 * Enter (allow), Down then Enter (allow always) and Esc (deny). Its labels stay
 * as parsed, since they carry the `(y)`/`(p)`/`(esc)` hints.
 */
export function answerChoices(promptText: string): AnswerChoice[] {
  const menu = parseMenu(promptText);
  if (!menu) return [];

  const classified = classifyMenu(menu);
  if (classified.kind === "question") {
    return menu.options.slice(0, 9).flatMap((option) => {
      const keys = validKeys([option.digit]);
      return keys ? [{ label: option.label, keys }] : [];
    });
  }

  const choices: AnswerChoice[] = [];
  if (menu.marker === "›") {
    if (classified.allow) choices.push({ label: classified.allow.label, keys: ["enter"] });
    if (classified.allowAlways) choices.push({ label: classified.allowAlways.label, keys: ["down", "enter"] });
    if (classified.deny) choices.push({ label: classified.deny.label, keys: ["esc"] });
  } else {
    for (const option of menu.options) {
      const label = semanticLabel(classified, option) ?? option.label;
      choices.push({ label, keys: [option.digit] });
    }
  }

  return choices.flatMap((choice) => {
    const keys = validKeys(choice.keys);
    return keys ? [{ label: choice.label, keys }] : [];
  });
}

/** "Allow" / "Allow always" / "Deny" for the classified rows, else null. */
function semanticLabel(classified: ClassifiedMenu, option: MenuOption): string | null {
  if (classified.allow === option) return "Allow";
  if (classified.allowAlways === option) return "Allow always";
  if (classified.deny === option) return "Deny";
  return null;
}
