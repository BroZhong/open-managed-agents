/** A value as one single-quoted word for `sh`: nothing in it is expanded. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
