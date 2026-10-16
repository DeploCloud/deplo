import { test } from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import ts from "typescript";

const WEIGHT =
  /\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[[0-9]+\])/;
const STRUCTURAL_VARIANTS = new Set(["graphic", "depth === 0"]);

function conditionalWeight(node: ts.Node, source: ts.SourceFile): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isJsxAttribute(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isSourceFile(parent)
    )
      break;
    if (
      ts.isPropertyAssignment(parent) &&
      /^(active|inactive|selected|checked|open|hover|focus|focused|disabled|loading|error|today|pressed)$/.test(
        parent.name.getText(source),
      )
    )
      return true;
    if (
      ts.isConditionalExpression(parent) &&
      !STRUCTURAL_VARIANTS.has(parent.condition.getText(source))
    )
      return true;
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      !STRUCTURAL_VARIANTS.has(parent.left.getText(source))
    )
      return true;
  }
  return false;
}

test("interaction states never change font weight", () => {
  const offenders: string[] = [];
  for (const file of globSync([
    "app/**/*.tsx",
    "components/**/*.tsx",
    "lib/**/*.tsx",
  ])) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function report(node: ts.Node) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      offenders.push(`${file}:${line}`);
    }
    function visit(node: ts.Node) {
      if (ts.isStringLiteralLike(node) && WEIGHT.test(node.text)) {
        const stateVariant = node.text
          .split(/\s+/)
          .some(
            (token) =>
              WEIGHT.test(token) &&
              token.includes(":") &&
              /hover|focus|active|disabled|checked|open|selected|pressed|data-|aria-/.test(
                token,
              ),
          );
        if (stateVariant || conditionalWeight(node, source)) report(node);
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(source) === "fontWeight" &&
        ts.isConditionalExpression(node.initializer)
      )
        report(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(
    offenders,
    [],
    "Put font weight in the base style, never in interaction states.",
  );
});
