import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isDisclosable,
  prepareExclusions,
  sanitizeConversationText,
} from "../../src/standalone/conversation-history.js";

const corpus = [
  "secret appears twice: secret",
  "contained abcdef and abc",
  "overlap xyzw where xyz and yzw overlap",
  "adjacent abcxyz",
  "unicode café \u{1f511}key",
  "Authorization: Bearer abc",
  'password="secret" token=xyz',
  "https://user:pw@example.com/abc",
  "plain text",
];
const lists: readonly (readonly string[])[] = [
  ["secret", "abc", "abcdef", "xyz", "yzw", "café", "\u{1f511}key"],
  ["", "secret", "secret", ""],
  [],
  Array.from({ length: 4096 }, (_, i) => `v${i}`),
  Array.from({ length: 4097 }, (_, i) => `v${i}`),
  ["a".repeat(64 * 1024)],
  ["a".repeat(64 * 1024 + 1)],
  ["é".repeat(32 * 1024 + 1)],
  // Duplicates are removed before the aggregate bound applies.
  Array.from({ length: 5 }, () => "d".repeat(64 * 1024)),
  // 257 distinct maximum-size values pass the 16 MiB aggregate byte bound.
  Array.from(
    { length: 257 },
    (_, i) => String(i).padStart(8, "0") + "a".repeat(64 * 1024 - 8),
  ),
  [42 as unknown as string],
];

test("prepared lists redact exactly as the raw list, including bounds and malformed values", () => {
  for (const list of lists) {
    const prepared = prepareExclusions(list);
    assert.ok(Object.isFrozen(prepared));
    for (const text of [...corpus, "x".repeat(64 * 1024 + 1)]) {
      assert.equal(
        sanitizeConversationText(text, prepared),
        sanitizeConversationText(text, list),
      );
      assert.equal(isDisclosable(text, prepared), isDisclosable(text, list));
    }
  }
  assert.equal(
    sanitizeConversationText(corpus[2]!, prepareExclusions(lists[0]!)),
    "overlap [redacted] where [redacted] and [redacted] overlap",
  );
});

test("a prepared list reads its source once; other arrays are validated on every call", () => {
  let reads = 0;
  const source = ["secret"],
    counted = new Proxy(source, {
      get(target, key, receiver) {
        if (key === "0") reads++;
        return Reflect.get(target, key, receiver);
      },
    });
  const prepared = prepareExclusions(counted);
  assert.equal(reads, 1);
  assert.equal(prepareExclusions(prepared), prepared);
  for (let i = 0; i < 5; i++)
    assert.equal(
      sanitizeConversationText("a secret", prepared),
      "a [redacted]",
    );
  assert.equal(reads, 1);

  // The prepared copy ignores later changes; a mutable legacy array reflects them.
  source.push("later");
  assert.equal(sanitizeConversationText("later", prepared), "later");
  assert.equal(sanitizeConversationText("later", counted), "[redacted]");
  assert.equal(reads, 2);

  // A frozen array the factory does not own is not trusted as prepared.
  const frozen = Object.freeze(Array.from({ length: 4097 }, (_, i) => `f${i}`));
  assert.equal(sanitizeConversationText("text", frozen), undefined);
});
