import { Observable } from "@nativescript/core";

/**
 * One home-screen battery card (lens-battery-card.xml): Doto numerals, ten
 * dots and a status line. The dots are ten bound class properties rather than
 * a Repeater, which on Android lays its items out vertically inside the
 * horizontal row. Observable.set only notifies on change, so update() can be
 * called on every dashboard snapshot.
 */
export class BatteryCardModel extends Observable {
  constructor(readonly label: string, level: number | null, status: string) {
    super();
    this.update(level, status);
  }

  /** Show `level` (null: no reading yet, drawn as "--") with `status` below it. */
  update(level: number | null, status: string): void {
    // Each lit dot is 10%, rounded (72 -> seven).
    const lit = level === null ? 0 : Math.round(level / 10);
    this.set("valueText", level === null ? "--" : String(level));
    this.set("percentVisibility", level === null ? "collapse" : "visible");
    this.set("statusText", status);
    for (let dot = 1; dot <= 10; dot++) {
      this.set(`dot${dot}Class`, dot <= lit ? "lens-dot lens-dot-lit" : "lens-dot");
    }
  }
}
