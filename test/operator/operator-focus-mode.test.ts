import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOCUS_MODE_KEY,
  focusShortcutApplies,
  rememberFocusMode,
  rememberedFocusMode,
} from "../../web/src/focus-mode.js";

const press = (over = {}) => ({
  key: "\\",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  ...over,
});
const el = (tagName: string, over = {}) => ({
  tagName,
  isContentEditable: false,
  closest: () => null,
  ...over,
});

test("the focus shortcut ignores fields, dialogs, modifiers, repeats and other keys", () => {
  assert.equal(focusShortcutApplies(press(), el("DIV")), true);
  assert.equal(focusShortcutApplies(press(), null), true);
  for (const tag of ["TEXTAREA", "INPUT", "SELECT"])
    assert.equal(focusShortcutApplies(press(), el(tag)), false, tag);
  assert.equal(
    focusShortcutApplies(press(), el("DIV", { isContentEditable: true })),
    false,
  );
  assert.equal(
    focusShortcutApplies(press(), el("DIV", { closest: () => ({}) })),
    false,
  );
  for (const over of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { key: "|" },
    { key: "a" },
    { repeat: true },
    { isComposing: true },
    { defaultPrevented: true },
  ])
    assert.equal(
      focusShortcutApplies(press(over), el("DIV")),
      false,
      `${JSON.stringify(over)}`,
    );
});

async function withStorage(storage: unknown, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("the remembered focus mode reads only 1 as on and survives blocked storage", async () => {
  assert.equal(rememberedFocusMode(), false);
  for (const [value, expected] of [
    [null, false],
    ["", false],
    ["0", false],
    ["1", true],
  ] as const)
    await withStorage({ getItem: () => value }, () =>
      assert.equal(rememberedFocusMode(), expected, String(value)),
    );
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  await withStorage(blocked, () => {
    assert.equal(rememberedFocusMode(), false);
    rememberFocusMode(true);
  });
  const store = new Map<string, string>();
  await withStorage(
    {
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    () => {
      rememberFocusMode(true);
      assert.equal(store.get(FOCUS_MODE_KEY), "1");
      rememberFocusMode(false);
      assert.equal(store.has(FOCUS_MODE_KEY), false);
    },
  );
});
