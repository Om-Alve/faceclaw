/**
 * Device-facing render transforms, adapted from pawaca/even-better
 * src/render.ts (MIT; see ACKNOWLEDGEMENTS.md). Pure `string -> string`
 * functions that fit agent output to the glasses' narrow panel; the reader
 * applies them to entry text just before wrapping.
 */

/**
 * Reflow markdown tables into a vertical list, since a grid wraps into
 * unreadable soup on a narrow panel. The first column becomes an item heading
 * and the rest `key: value` lines beneath it:
 *
 *   | Name  | Age | City |        • Alice
 *   |-------|-----|------|   →      Age: 30
 *   | Alice | 30  | NYC  |          City: NYC
 *
 * Non-table text passes through untouched.
 */
export function reflowTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const block = tableAt(lines, i);
    if (block) {
      out.push(...renderTable(block.header, block.rows));
      i = block.end;
    } else {
      out.push(lines[i] ?? "");
      i++;
    }
  }
  return out.join("\n");
}

interface TableBlock {
  header: string[];
  rows: string[][];
  /** Index after the table. */
  end: number;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

const looksLikeRow = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.includes("|") && (trimmed.startsWith("|") || (trimmed.match(/\|/g)?.length ?? 0) >= 2);
};

/** A markdown table at `start`: header row, separator, at least one data row. */
function tableAt(lines: string[], start: number): TableBlock | null {
  const header = lines[start];
  const separator = lines[start + 1];
  if (!header || !separator || !looksLikeRow(header) || !isSeparator(separator)) return null;
  const columns = splitRow(header);
  if (columns.length < 2) return null;
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!looksLikeRow(line) || isSeparator(line)) break;
    rows.push(splitRow(line));
    i++;
  }
  if (rows.length === 0) return null;
  return { header: columns, rows, end: i };
}

function renderTable(header: string[], rows: string[][]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    out.push(`• ${row[0] ?? ""}`.trimEnd());
    for (let column = 1; column < header.length; column++) {
      const key = header[column] ?? "";
      const value = row[column] ?? "";
      if (!value) continue;
      out.push(key ? `  ${key}: ${value}` : `  ${value}`);
    }
  }
  return out;
}

/**
 * Strip the heavy box-drawing borders (╭─┬─╮ │ ├ …) a terminal draws around
 * tool boxes. A scraped box cannot be re-tabulated reliably, but dropping the
 * border glyphs and separator-only rows leaves the cell text legible.
 */
export function stripBoxBorders(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[│┃]/g, " ").replace(/\s{2,}/g, "  ").trimEnd())
    .filter((line) => !/^[\s─━┄┈╌═┌┬┐├┼┤└┴┘╭┬╮╰┴╯╞╪╡]+$/.test(line))
    .join("\n");
}

/** The glasses render pipeline. Order matters: reflow tables while their `|`
 *  structure is intact, then strip any residual box borders. */
export function renderForGlasses(text: string): string {
  return stripBoxBorders(reflowTables(text));
}
