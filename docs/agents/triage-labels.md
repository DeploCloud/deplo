# Triage labels

**Verified against `gh label list --repo DeploCloud/deplo` on 16 Sep 2026.** A label that is not
on this list does not exist, and `gh issue create --label <it>` fails the whole command - the
issue is not created. Re-run that command before trusting this file; labels are edited on GitHub,
not here.

| Label                             | Use it for                                                    |
| --------------------------------- | ------------------------------------------------------------- |
| `bug`                             | Something is broken. The default for a defect report.         |
| `enhancement`                     | A feature or a change in behaviour. The default for a PRD.    |
| `documentation`                   | The manual (`DeploCloud/docs`) or the agent-facing docs.      |
| `question`                        | Needs an answer from the owner before it is actionable.       |
| `duplicate`, `invalid`, `wontfix` | Closing reasons.                                              |
| `good first issue`, `help wanted` | Outside contributors. The owner sets these, not an agent.     |
| `dependencies`                    | Dependabot's own bumps. Don't apply it by hand.               |
| `wayfinder:map`                   | The map issue the `/wayfinder` skill hangs its tickets off.   |
| `wayfinder:research`              | AFK - read primary sources, leave a cited summary.            |
| `wayfinder:prototype`             | AFK - build a cheap throwaway artifact to react to.           |
| `wayfinder:grilling`              | HITL - resolve by grilling the human, one question at a time. |
| `wayfinder:task`                  | Manual work that unblocks a decision.                         |

## What a skill asks for, and what to type instead

Skills written against a generic tracker speak of triage _roles_. This repo has no label for most
of them, so map the role onto state that exists here rather than inventing a label:

| Role a skill names | Here                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| `needs-triage`     | Open, unlabelled. Nothing to apply.                                          |
| `needs-info`       | Comment the question and leave it open; add `question` if it is the blocker. |
| `ready-for-agent`  | Open, unassigned, `bug` or `enhancement`, body says what "done" is.          |
| `ready-for-human`  | Assign it to the owner (`gh issue edit <n> --add-assignee`).                 |
| `wontfix`          | `wontfix`, and close it.                                                     |

Need a label that genuinely does not exist? Ask the owner first, then
`gh label create <name> --description "..." --color <hex>`, then add the row above. A label
created mid-task and never explained is how a tracker rots.
