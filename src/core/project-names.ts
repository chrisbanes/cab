/**
 * The identity of a project name for uniqueness and for telling duplicates apart.
 * Locale-independent, so macOS and Linux agree; SQL lower() would fold ASCII only.
 */
export function projectNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}
