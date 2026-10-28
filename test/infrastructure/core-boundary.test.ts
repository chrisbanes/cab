import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { type ESTree, parseSync, Visitor } from "vite";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

function resolveRelativeImport(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier);
  const extension = extname(target);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension))
    return `${target.slice(0, -extension.length)}${extension === ".jsx" ? ".tsx" : ".ts"}`;
  return target;
}

function scanCoreGraph(coreRoot: string): string[] {
  const files = sourceFiles(coreRoot);
  if (!files.length) return ["Core source directory is missing or empty"];

  const root = resolve(coreRoot);
  const violations: string[] = [];
  const recordImport = (file: string, specifier: string) => {
    if (
      specifier.startsWith("node:") &&
      specifier !== "node:module" &&
      specifier !== "node:process"
    )
      return;
    if (specifier === "zod") return;
    if (!specifier.startsWith(".")) {
      violations.push(
        `${relative(root, file)} imports forbidden external module ${specifier}`,
      );
      return;
    }
    const target = resolveRelativeImport(file, specifier);
    if (target !== root && !target.startsWith(`${root}${sep}`))
      violations.push(
        `${relative(root, file)} imports outside core: ${specifier}`,
      );
  };

  const flag = (file: string, message: string) =>
    violations.push(`${relative(root, file)} ${message}`);
  const literalSource = (node: ESTree.Node | null | undefined) =>
    node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : undefined;

  for (const file of files) {
    const result = parseSync(file, readFileSync(file, "utf8"));
    for (const error of result.errors)
      flag(file, `failed to parse: ${error.message}`);
    new Visitor({
      ImportDeclaration(node) {
        recordImport(file, String(node.source.value));
      },
      ExportNamedDeclaration(node) {
        if (node.source) recordImport(file, String(node.source.value));
      },
      ExportAllDeclaration(node) {
        recordImport(file, String(node.source.value));
      },
      TSImportEqualsDeclaration(node) {
        const reference = node.moduleReference;
        if (reference.type !== "TSExternalModuleReference") return;
        const specifier = literalSource(reference.expression);
        if (specifier === undefined)
          flag(file, "has a non-literal import-equals");
        else recordImport(file, specifier);
      },
      TSImportType(node) {
        const specifier = literalSource(node.source);
        if (specifier === undefined)
          flag(file, "has a non-literal import type");
        else recordImport(file, specifier);
      },
      ImportExpression(node) {
        const source = node.source;
        const specifier =
          source.type === "TemplateLiteral" && !source.expressions.length
            ? source.quasis[0]?.value.cooked
            : literalSource(source);
        if (typeof specifier === "string") recordImport(file, specifier);
        else flag(file, "has a non-literal dynamic import");
      },
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" &&
                !callee.computed &&
                callee.property.type === "Identifier"
              ? callee.property.name
              : undefined;
        const isMember = callee.type === "MemberExpression";
        if (name === "getBuiltinModule" && isMember)
          flag(file, "dynamically loads a Node built-in");
        else if (name === "createRequire" && !isMember)
          flag(file, "uses createRequire()");
        else if (name === "require") flag(file, "uses require()");
      },
    }).visit(result.program);
  }
  return violations;
}

function fixture(files: Record<string, string>, check: (core: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "cab-core-boundary-"));
  const core = join(directory, "src", "core");
  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = join(core, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    check(core);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("production core imports stay inside core or use zod and node built-ins", () => {
  const violations = scanCoreGraph(resolve(process.cwd(), "src/core"));
  assert.deepEqual(violations, []);
});

test("core boundary checker accepts core-to-core and allowed imports in every form", () => {
  fixture(
    {
      "index.ts":
        'export { value } from "./helper.js";\nexport * from "./leaf.js";\n',
      "helper.ts": [
        'import { createHash } from "node:crypto";',
        'import { z } from "zod";',
        'import type { Leaf } from "./leaf.js";',
        'import { leaf } from "./leaf.js";',
        'import Equals = require("./leaf.js");',
        'type Imported = import("./leaf.js").Leaf;',
        'void import("./leaf.js");',
        "void import(`./leaf.js`);",
        "export const value: [Leaf, Imported] | unknown[] = [createHash, z, leaf, Equals];",
        "",
      ].join("\n"),
      "leaf.ts": "export const leaf = 'core';\nexport type Leaf = string;\n",
    },
    (core) => assert.deepEqual(scanCoreGraph(core), []),
  );
});

const rejected: { name: string; contents: string; expected: string[] }[] = [
  {
    name: "static external import",
    contents: 'import { z } from "external-runtime-sdk";\n',
    expected: [
      "case.ts imports forbidden external module external-runtime-sdk",
    ],
  },
  {
    name: "type-only external import",
    contents: 'import type { RuntimeApi } from "external-runtime-sdk";\n',
    expected: [
      "case.ts imports forbidden external module external-runtime-sdk",
    ],
  },
  {
    name: "named re-export outside core",
    contents: 'export { plugin } from "../adapters/runtime/plugin.js";\n',
    expected: ["case.ts imports outside core: ../adapters/runtime/plugin.js"],
  },
  {
    name: "export-all external",
    contents: 'export * from "external-runtime-sdk";\n',
    expected: [
      "case.ts imports forbidden external module external-runtime-sdk",
    ],
  },
  {
    name: "relative import escaping core",
    contents: 'import { value } from "../../adapters/runtime/helper.js";\n',
    expected: [
      "case.ts imports outside core: ../../adapters/runtime/helper.js",
    ],
  },
  {
    name: "import-equals require",
    contents: 'import SDK = require("external-runtime-sdk");\n',
    expected: [
      "case.ts imports forbidden external module external-runtime-sdk",
    ],
  },
  {
    name: "import type",
    contents: 'type SDK = import("external-runtime-sdk").RuntimeApi;\n',
    expected: [
      "case.ts imports forbidden external module external-runtime-sdk",
    ],
  },
  {
    name: "literal dynamic import",
    contents: 'void import("external-runtime-sdk");\n',
    expected: [
      "case.ts imports forbidden external module external-runtime-sdk",
    ],
  },
  {
    name: "template dynamic import",
    contents: "void import(`external-runtime-sdk`);\n",
    expected: [
      "case.ts imports forbidden external module external-runtime-sdk",
    ],
  },
  {
    name: "non-literal dynamic import",
    contents: "void import(moduleName);\n",
    expected: ["case.ts has a non-literal dynamic import"],
  },
  {
    name: "template dynamic import with expression",
    contents: `void import(\`./\${moduleName}.js\`);\n`,
    expected: ["case.ts has a non-literal dynamic import"],
  },
  {
    name: "require call",
    contents: 'require("external-runtime-sdk");\n',
    expected: ["case.ts uses require()"],
  },
  {
    name: "module.require call",
    contents: 'module.require("external-runtime-sdk");\n',
    expected: ["case.ts uses require()"],
  },
  {
    name: "createRequire call",
    contents: "createRequire(import.meta.url);\n",
    expected: ["case.ts uses createRequire()"],
  },
  {
    name: "aliased createRequire import",
    contents: 'import { createRequire as loader } from "node:module";\n',
    expected: ["case.ts imports forbidden external module node:module"],
  },
  {
    name: "getBuiltinModule call",
    contents: 'process.getBuiltinModule("module");\n',
    expected: ["case.ts dynamically loads a Node built-in"],
  },
];

for (const { name, contents, expected } of rejected)
  test(`core boundary checker rejects ${name}`, () => {
    fixture({ "case.ts": contents }, (core) =>
      assert.deepEqual(scanCoreGraph(core), expected),
    );
  });

test("core boundary checker reports a file that fails to parse", () => {
  fixture({ "broken.ts": 'import { from "x";\n' }, (core) => {
    const violations = scanCoreGraph(core);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /^broken\.ts failed to parse: /);
  });
});
