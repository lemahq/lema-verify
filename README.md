# lema verify — description check

A GitHub Action that checks a PR's diff against its own description (and,
when present, a `.lema/task.json` recorded task) and posts one sticky
comment. It comments; it doesn't block.

Add it to any repo's CI in a few lines (see below). No signup, no stored
secret: the Action authenticates to the lema verify API with GitHub's OIDC
token, which identifies the calling repository.

> **Source of truth.** This Action is extracted verbatim from the `lema`
> monorepo (`.github/actions/lema-verify/`). File changes are made there and
> synced here; open issues/PRs about the Action's behavior against the lema
> monorepo. This repo is the published, installable home (MIT).

This Action is a **dumb pipe**: it collects the diff, the file-change
manifest, and (when eligible) the recorded task file; sends them to the
`lema verify` API; and posts back whatever markdown the server returns,
verbatim. It contains no judgment logic — no thresholds, no label mapping,
no scoring, no rendering beyond posting the server's markdown as-is.

## Workflow snippet

```yaml
name: description check

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  id-token: write
  checks: write

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # PR HEAD, not the merge ref: annotations are posted against the
          # head SHA, so diff line numbers must be head-commit coordinates.
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: lemahq/lema-verify@v1
        with:
          api-url: https://api.lema.sh
          github-token: ${{ github.token }}
```

`id-token: write` is required — the Action authenticates to the lema
verify API using GitHub's OIDC token (audience `lema-verify`), which
identifies the calling repository without any signup or stored secret.
`fetch-depth: 0` is required so the Action can diff against the PR's merge
base. `pull-requests: write` is required so the Action can post/update its
PR comment. `github-token: ${{ github.token }}` must be passed explicitly:
GitHub does not inject `GITHUB_TOKEN` into an Action's environment on its
own, and an action's own metadata cannot default an input from the `github`
context — `${{ github.token }}` is only available in a workflow's expression
context, which is why it is wired here rather than defaulted in the Action.
`checks: write` is optional but recommended: with it, the Action also posts
a check run with inline annotations on the diff lines the card's
"not described" findings point at. The check's conclusion is always
`neutral` — it comments, it doesn't block. Without the permission (or on a
fork PR, where the token is read-only), the Action degrades to comment-only
and notes it in the step summary.

## Comment format

The Action posts (or updates) exactly one PR comment per PR. The comment
body always begins with an HTML marker:

```
<!-- lema-verify -->
```

On every run, the Action looks for an existing comment on the PR whose
body contains this marker (paginating through
`GET /repos/{owner}/{repo}/issues/{number}/comments`). If one is found, it
is updated in place (`PATCH`); otherwise a new comment is posted
(`POST`). The Action never posts a second marker comment on the same PR.

Everything after the marker — the verdict line, any findings (each phrased
as a question, never an accusation), the provenance line ("Checked
against: …"), and the free-tier meter footer — is rendered entirely by the
server. The Action does not compose, threshold, or reformat any of that
text; it posts the `markdown` field from the server's response as-is.

The job's step summary (`$GITHUB_STEP_SUMMARY`) gets the first non-empty
line of that markdown after the marker — a mechanical extraction, not a
composed summary. If the check did not run for any reason (timeout,
non-2xx response, malformed response, empty markdown, missing
environment), the step summary instead gets a fixed note:

```
description check: not run (<reason>)
```

and nothing is posted or updated on the PR. This Action **always exits
0** — a broken or unreachable verify service must never fail anyone's CI.

## `.lema/task.json` schema

lema authors and documents this convention; it is read by the Action, not
required by it. When present, and when its `branch` field matches the
PR's head ref exactly, its contents are sent to the server and the card's
provenance line reads "checked against the recorded task" instead of the
PR description. A stale file (written for a different branch — for
example, left over from a previous branch's work) is ignored, not sent.

```json
{
  "task": "string — the recorded task/intent text",
  "branch": "string — the branch this task file was written for"
}
```

Path: `.lema/task.json`, relative to the repository root.

## What this is (and isn't)

**We claim:** "Checks a PR's diff against its own description and linked
issue — what's stated and found, stated and not found, or in the diff but
not described. It comments; it doesn't block." Provenance is printed on
every card. When a task file is present: "checked against the recorded
task."

**We refuse to claim:** "verified" as an unqualified badge or status ·
"gate" (until strict mode ships its measured bar) · "unrequested change"
(we see the description, not the request) · correctness, safety, or
review ("we are not a reviewer") · authorship ("we never label a PR
agent-authored") · "retention-free" (the provable sentence instead: *we
don't store your code — diffs are processed in memory and discarded when
the check completes; outcome counts and categories are kept; judging runs
on Google Vertex AI under its linked terms*) · "every CI event makes the
judge better" (true only for public and opt-in repos; we say that) · any
precedent language on repos with no record — the precedent block is
absent, because absence of record is not a searched-and-empty result.

**On the edge cases:** vague descriptions render as unverifiable, not as
clean. Oversized diffs disclose what was elided and mark the run
incomplete. API failure posts nothing and says so in the step summary.
Findings dismissed via link are labeled unattributed.

## Not yet

This is the front door to a larger product; the following are named,
gated future work — not shipped, and never implied by the copy above:

- **Strict mode.** No pass/fail gate exists today. A measured, narrow
  gate on `claim_not_found` only, with a dismiss-and-rerun escape hatch,
  is vNext work behind its own precision bar.
- **Precedent.** The card does not cite prior team decisions. On-corpus
  precedent citations (high-threshold, advisory, quote-and-link only,
  absent entirely on repos with no record) ship once the replay eval
  clears its zero-false-`ruled_out` gate — a separate, later rollout.
- **Real-task verification.** `.lema/task.json` today is a convention the
  Action reads if you hand-write or hook-write it yourself. Automated
  writing of this file from inside an agent session (a lema-mcp
  task-writer hook) is vNext, not part of this Action.
