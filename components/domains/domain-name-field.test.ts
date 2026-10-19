import { test } from "node:test";
import assert from "node:assert/strict";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderHtml } from "react-dom/server";
import { TooltipProvider } from "../ui/tooltip";

const renderToStaticMarkup = (element: ReactNode) =>
  renderHtml(createElement(TooltipProvider, null, element));
import { DomainNameField } from "./domain-name-field";
import { Button } from "../ui/button";

const suggestedDomain = "web-otter-9487cf1e.deplo.site";

test("Generate is available while editing and never submits the form", () => {
  const html = renderToStaticMarkup(
    createElement(DomainNameField, {
      id: "edit-domain",
      value: "existing.example.com",
      onChange() {},
      suggestedDomain,
    }),
  );
  assert.match(html, /type="button"[^>]*>[\s\S]*Generate/);
  assert.match(html, /value="existing.example.com"/);
});

test("Generate replaces only the draft name with an address for the same server", () => {
  let name = "existing.example.com";
  const field = DomainNameField({
    id: "edit-domain",
    value: name,
    suggestedDomain,
    onChange: (value) => {
      name = value;
    },
  });
  let click: (() => void) | undefined;
  function visit(node: ReactNode) {
    Children.forEach(node, (child) => {
      if (
        !isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)
      )
        return;
      if (child.type === Button) click = child.props.onClick;
      visit(child.props.children);
    });
  }
  visit(field);
  assert.ok(click);
  click();
  assert.match(name, /^web-[a-z]+-9487cf1e\.deplo\.site$/);
});

test("Generate is hidden without an IPv4 suggestion and disabled during a save", () => {
  const props = { id: "edit-domain", value: "example.com", onChange() {} };
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(DomainNameField, props)),
    /Generate/,
  );
  const html = renderToStaticMarkup(
    createElement(DomainNameField, {
      ...props,
      suggestedDomain,
      disabled: true,
    }),
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*Generate/);
  assert.match(html, /<input[^>]*disabled=""/);
});
