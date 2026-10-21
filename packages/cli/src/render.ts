/**
 * Terminal output.
 *
 * Colour is opt-out via NO_COLOR and off automatically when stdout is not a TTY,
 * so `relay runs list > file` produces something greppable rather than something
 * full of escape codes.
 */

const useColor = process.stdout.isTTY === true && !process.env["NO_COLOR"];

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap("2");
export const bold = wrap("1");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

/** Statuses, coloured by what they mean for the person reading. */
export function status(value: string): string {
  switch (value) {
    case "completed":
      return green(value);
    case "failed":
    case "rejected":
    case "aborted":
      return red(value);
    case "awaiting-approval":
    case "awaiting-input":
      return yellow(value);
    default:
      return cyan(value);
  }
}

/** Credits as dollars. Integer cents in, never a float. */
export function money(credits: number): string {
  const negative = credits < 0;
  const abs = Math.abs(Math.trunc(credits));
  return `${negative ? "-" : ""}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function when(iso?: string): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function table(rows: string[][], gap = 2): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - visibleLength(cell) + gap),
        )
        .join(""),
    )
    .join("\n");
}

/** Length ignoring ANSI codes, so colour does not break column alignment. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function fail(message: string): never {
  console.error(red(message));
  process.exit(1);
}
