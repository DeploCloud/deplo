# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `DeploCloud/deplo` (the `origin` remote). Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

The `/wayfinder` skill needs four things this tracker expresses **natively**: a map, child tickets,
blocking edges, and a frontier query. GitHub's sub-issue and issue-dependency APIs cover all four,
so the frontier renders in GitHub's own UI without any body conventions.

Both APIs take an issue's **database id**, not its number — resolve it first:

```sh
ID=$(gh api repos/DeploCloud/deplo/issues/<number> --jq '.id')
```

- **The map** — an issue labelled `wayfinder:map`. Tickets carry `wayfinder:{research,prototype,grilling,task}`.
- **Child tickets** (ticket → map):

  ```sh
  gh api -X POST repos/DeploCloud/deplo/issues/<map>/sub_issues -F sub_issue_id=$ID
  gh api repos/DeploCloud/deplo/issues/<map>/sub_issues --jq '.[] | "\(.number)\t\(.state)\t\(.title)"'
  ```

- **Blocking edges** (`<blocked>` is blocked by `<blocker>`):

  ```sh
  gh api -X POST repos/DeploCloud/deplo/issues/<blocked>/dependencies/blocked_by -F issue_id=$BLOCKER_ID
  gh api repos/DeploCloud/deplo/issues/<n>/dependencies/blocked_by --jq '.[] | "\(.number)\t\(.state)"'
  ```

- **The frontier** — open children with no *open* blockers and no assignee:

  ```sh
  for n in $(gh api repos/DeploCloud/deplo/issues/<map>/sub_issues --jq '.[] | select(.state=="open") | .number'); do
    blocked=$(gh api repos/DeploCloud/deplo/issues/$n/dependencies/blocked_by --jq '[.[] | select(.state=="open")] | length')
    claimed=$(gh api repos/DeploCloud/deplo/issues/$n --jq '.assignees | length')
    [ "$blocked" = 0 ] && [ "$claimed" = 0 ] && gh issue view $n --json number,title --jq '"\(.number)\t\(.title)"'
  done
  ```

- **Claim a ticket** before any work, so concurrent sessions skip it:
  `gh issue edit <number> --add-assignee @me`
- **Resolve**: post the answer as a comment, then `gh issue close <number>`, then append a one-line
  pointer to the map's *Decisions so far*.
