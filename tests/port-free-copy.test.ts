import { test } from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import ts from "typescript";

// A server connects out to Deplo (ADR-0040): no screen, error or API description asks for a port.
const PORT_WORDS = /\b9443\b|firewall|\binbound\b|\boutbound\b/i;

const NOT_COPY = /\.test\.tsx?$|test-helpers\.tsx?$|^lib\/agent\/gen\//;

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    (ts.isCallExpression(parent) &&
      (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
        parent.expression.getText() === "require"))
  );
}

test("no string a person reads asks for a port, a firewall or a direction", () => {
  const offenders: string[] = [];
  for (const file of globSync([
    "app/**/*.{ts,tsx}",
    "components/**/*.{ts,tsx}",
    "lib/**/*.{ts,tsx}",
  ])) {
    if (NOT_COPY.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      const text =
        ts.isStringLiteralLike(node) ||
        ts.isTemplateLiteralToken(node) ||
        ts.isJsxText(node)
          ? node.text
          : null;
      if (text && PORT_WORDS.test(text) && !isModuleSpecifier(node)) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        offenders.push(`${file}:${line}: ${text.trim().slice(0, 80)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, []);
});
