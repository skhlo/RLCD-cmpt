# Issue tracker: GitHub

Issues and specs for this repository live in `skhlo/RLCD-cmpt` on GitHub. Use the
`gh` CLI. Pass `--repo skhlo/RLCD-cmpt` explicitly rather than relying on whichever
checkout happens to be the current directory.

## Identity and writes

Before a push or GitHub write, verify the active actor against the execution
host's profile and verify the target's numeric repository ID and exact canonical
path. This repository is `skhlo/RLCD-cmpt`, ID `1376800981`; its old name can
redirect here, so a successful request alone does not prove its target.

For issue or PR bodies and comments, write a local Markdown body file, read and
inspect it, then pass `--body-file`. Read the resulting artifact after the write.
Keep private evaluation evidence and credentials out of public bodies. Ask before
publishing unless the current task already authorizes that delivery.

## Issue operations

- **Read:** fetch both body and comments, not a comments-only view:
  `gh issue view NUMBER --repo skhlo/RLCD-cmpt --json number,title,body,labels,comments,state,url`.
- **List:** `gh issue list --repo skhlo/RLCD-cmpt --state open --json number,title,body,labels,comments`, with the relevant label/state filters.
- **Create:** `gh issue create --repo skhlo/RLCD-cmpt --title "TITLE" --body-file BODY.md`.
- **Comment:** `gh issue comment NUMBER --repo skhlo/RLCD-cmpt --body-file COMMENT.md`.
- **Label:** `gh issue edit NUMBER --repo skhlo/RLCD-cmpt --add-label "LABEL"` or `--remove-label "LABEL"`.
- **Close:** publish an inspected resolution comment first, then use `gh issue close NUMBER --repo skhlo/RLCD-cmpt` and read the issue back.

Use [the triage vocabulary](triage-labels.md). When a skill says to publish to the
tracker, create an issue here. When it says to fetch a ticket, fetch its full body,
comments, labels, and state.

## Pull requests as a triage surface

**PRs as a request surface: no.** External PRs are not feature-request tickets for
triage. Implementation still uses topic branches and pull requests into `main`.
The operator merges; agents never merge or arm auto-merge in this repository.

For PR work, read both the body/comments and the diff:

```sh
gh pr view NUMBER --repo skhlo/RLCD-cmpt --json number,title,body,labels,comments,state,headRefName,baseRefName,url
gh pr diff NUMBER --repo skhlo/RLCD-cmpt
```

PR creation, edits, and comments use inspected body files just like issues. GitHub
shares one number space for issues and PRs; inspect the artifact type rather than
assuming every bare number is an issue.

## Native blocking relationships

GitHub issue dependencies are the canonical, UI-visible blocking edges. Resolve
the blocker's numeric database ID using `gh api repos/skhlo/RLCD-cmpt/issues/NUMBER`;
it is the `id`, not its issue number or GraphQL `node_id`.

Add an edge by POSTing to
`repos/skhlo/RLCD-cmpt/issues/CHILD/dependencies/blocked_by` with
`-F issue_id=BLOCKER_DATABASE_ID`, then read that endpoint back. Issue-body
"Blocked by" links are explanatory; keep them consistent with the native edges.

A ticket is actionable only when every native blocker is closed.
`issue_dependencies_summary.blocked_by` counts open blockers. If the feature is
unavailable, use explicit issue links as the fallback and verify each linked
issue's state before selecting work. A `ready-for-agent` label alone does not
remove a blocker.

## Wayfinding

A wayfinding map is a single issue labeled `wayfinder:map`, with Notes,
Decisions-so-far, and Fog. Create it using an inspected body file. Child tickets
use native GitHub sub-issue relationships and a `wayfinder:TYPE` label
(`research`, `prototype`, `grilling`, or `task`). Create needed wayfinding labels
only as part of an authorized wayfinding task. If sub-issues are unavailable, put
children in a task list on the map and link the map from each child's body.

The frontier is the map's ordered list of open children with no open blockers and
no assignee. Claim the first eligible ticket with
`gh issue edit NUMBER --repo skhlo/RLCD-cmpt --add-assignee @me` before doing its
work. Claiming is the session's first ticket write, after the read-only identity
and scope checks.

Resolve a ticket with an inspected, body-file comment and closure, then add a
concise result pointer to the map through an inspected body-file update. A skill
that forbids parent updates, such as `to-tickets`, takes precedence for that task;
do not create or modify a parent merely to publish independent tickets.
