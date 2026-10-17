import { caseFoldingDifferences } from "./case-folding.js";

/** Unicode default full case folding, one code point at a time (no final-sigma context). */
function caseFold(text: string): string {
  let folded = "";
  for (const character of text)
    folded +=
      caseFoldingDifferences.get(character.codePointAt(0) as number) ??
      character.toLowerCase();
  return folded;
}

/**
 * The one definition of "the same project name": trim, then Unicode canonical caseless
 * matching (D145: NFD, default full case folding, NFD). The domain check, the web labels and
 * test fixtures all compare names through it.
 *
 * Folds together: ς, σ and Σ; ß, ẞ and SS; the Kelvin sign and K; ligatures such as ﬃ; I and
 * i; and composed with decomposed letters. Keeps apart, as Unicode default folding does:
 * dotless ı from I and i (Turkic pairing is not applied), İ (folds to i and a combining dot)
 * from I, compatibility forms (fullwidth letters, ², ㎏), spacing inside a name, and lookalike
 * letters from other scripts. Case mapping is the root locale, never the host's. SQL lower()
 * is ASCII-only, so no query can make this comparison.
 */
export function projectNameKey(name: string): string {
  return caseFold(name.trim().normalize("NFD")).normalize("NFD");
}
