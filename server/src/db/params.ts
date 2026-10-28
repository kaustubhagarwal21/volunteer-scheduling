/**
 * Collects bind parameters for a query whose SQL is assembled from optional pieces (filters).
 * `add` returns the placeholder ("$3"), so user input only ever travels as a bound value and is
 * never spliced into the SQL text.
 */
/** `%text%` for ILIKE, with LIKE wildcards escaped so a search for "50%" matches "50%" literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class QueryParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}
