export function containsControlCharacters(value: string): boolean {
  return value.split("").some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function decodeSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      containsControlCharacters(decoded)
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}
