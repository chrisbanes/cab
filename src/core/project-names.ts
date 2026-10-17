/**
 * The one definition of "the same project name": trim, compose (NFC), case-fold, compose again.
 * The domain check, the web labels and test fixtures all compare names through it.
 *
 * The fold is `toUpperCase()` then `toLowerCase()`, both locale-independent (the root locale,
 * so Turkish rules never apply), plus ß to ss. An approximation of Unicode full case folding
 * that needs no dependency. It folds ς, σ and Σ together, ß, ẞ and SS, the Kelvin sign and K,
 * ligatures such as ﬃ, and the dotless ı with I and i. It keeps İ (U+0130) equal to i with a
 * combining dot, not to I. It does not fold compatibility forms (fullwidth letters, ², ㎏), spacing
 * inside a name, or lookalike letters from other scripts; those stay different names.
 * SQL lower() is ASCII-only, so no query can make this comparison.
 */
export function projectNameKey(name: string): string {
  return name
    .trim()
    .normalize("NFC")
    .toUpperCase()
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFC");
}
