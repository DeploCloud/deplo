import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { ChoiceCard } from "@/components/shared/choice-card";
import { Button } from "@/components/ui/button";
import { MoveOutCard } from "@/components/deplo-move/move-out-card";
import {
  SourceStep,
  type MoveContext,
  type SourcePick,
  type SourceView,
} from "./source-step";

const move: MoveContext = {
  source: null,
  activeTargetId: null,
  readiness: { ready: true, reason: null },
  openOutbound: false,
};

function setup(context = move) {
  let view: SourceView = "sources";
  let picked: SourcePick | undefined;
  const render = () =>
    SourceStep({
      move: context,
      view,
      onViewChange: (next) => {
        view = next;
      },
      onPick: (next) => {
        picked = next;
      },
    });
  function elements<T>(type: ReactElement<T>["type"]): ReactElement<T>[] {
    const found: ReactElement<T>[] = [];
    function visit(node: ReactNode) {
      Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode }>(child)) return;
        if (child.type === type) found.push(child as ReactElement<T>);
        visit(child.props.children);
      });
    }
    visit(render());
    return found;
  }
  const cards = () => elements<Parameters<typeof ChoiceCard>[0]>(ChoiceCard);
  return {
    render,
    cards,
    view: () => view,
    picked: () => picked,
    choose(title: string) {
      const card = cards().find((item) => item.props.title === title);
      assert.ok(card, title);
      assert.ok(!card.props.disabled, title);
      card.props.onSelect();
    },
    back() {
      const button = elements<{ children?: ReactNode; onClick: () => void }>(
        Button,
      ).find((item) => item.props.children === "Back");
      assert.ok(button);
      button.props.onClick();
    },
    outbound: () => elements<Parameters<typeof MoveOutCard>[0]>(MoveOutCard),
  };
}

test("start offers exactly Between Deplo and Dokploy or Coolify", () => {
  const flow = setup();
  assert.deepEqual(
    flow.cards().map((card) => card.props.title),
    ["Between Deplo", "Dokploy or Coolify"],
  );
  flow.choose("Dokploy or Coolify");
  assert.equal(flow.picked(), "panel");
});

test("incoming asks scope after direction and preserves both import paths", () => {
  const flow = setup();
  flow.choose("Between Deplo");
  assert.equal(flow.view(), "direction");
  assert.equal(flow.picked(), undefined);
  flow.choose("Another Deplo to this Deplo");
  assert.equal(flow.render().props.title, "What comes over?");
  flow.choose("Everything");
  assert.equal(flow.picked(), "deplo-move");
  flow.choose("Only some teams");
  assert.equal(flow.picked(), "deplo-teams");
  flow.back();
  assert.equal(flow.view(), "direction");
  flow.back();
  assert.equal(flow.view(), "sources");
});

test("outgoing opens code generation and Back returns to direction", () => {
  const flow = setup();
  flow.choose("Between Deplo");
  flow.choose("This Deplo to another Deplo");
  assert.equal(flow.view(), "out");
  assert.equal(flow.picked(), undefined);
  assert.equal(flow.outbound().length, 1);
  assert.equal(flow.outbound()[0].props.initial, move.source);
  flow.back();
  assert.equal(flow.view(), "direction");
});

test("a nonempty destination blocks a whole move but still allows selected teams", () => {
  const flow = setup({
    ...move,
    readiness: { ready: false, reason: "This Deplo already has apps." },
  });
  flow.choose("Between Deplo");
  flow.choose("Another Deplo to this Deplo");
  const whole = flow.cards().find((card) => card.props.title === "Everything");
  assert.equal(whole?.props.disabled, true);
  assert.equal(whole?.props.disabledNote, "This Deplo already has apps.");
  flow.choose("Only some teams");
  assert.equal(flow.picked(), "deplo-teams");
});

test("an incoming move blocks new flows on every selection screen", () => {
  for (const view of ["sources", "direction", "deplo"] as const) {
    const element = SourceStep({
      move: { ...move, activeTargetId: "move-active" },
      view,
      onViewChange() {},
      onPick() {},
    });
    function visit(node: ReactNode) {
      Children.forEach(node, (child) => {
        if (
          !isValidElement<{ children?: ReactNode; disabled?: boolean }>(child)
        )
          return;
        if (child.type === ChoiceCard) assert.equal(child.props.disabled, true);
        visit(child.props.children);
      });
    }
    visit(element);
  }
});
