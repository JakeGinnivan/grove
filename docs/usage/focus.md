# Focus: one checkout that runs the app

Worktrees let you work on several branches at once. Running several copies of
the app is a different matter. Some apps can only run once per machine: they
bind fixed ports, share one development database, or run one set of background
workers. Start a second copy and it either fails, or quietly shares state with
the first.

Focus is for those repos. You keep writing code and running tests in as many
worktrees as you like, and the app runs in exactly one place: an extra
worktree, `focus/`, that holds whichever worktree's commit you are testing.

```mermaid
flowchart LR
  subgraph repo["~/_code/my-service"]
    main["main/<br/>origin/main<br/>reference, never runs the app"]
    a["260810-fix-login/<br/>you/fix-login"]
    b["260811-add-metrics/<br/>you/add-metrics"]
    focus["focus/<br/>a commit, detached<br/>runs the app"]
  end
  a -- "grove focus" --> focus
  b -. "grove focus, later" .-> focus
```

- **`main/`** stays a clean reference on the default branch. `grove sync`
  keeps it current, and nothing ever runs from it.
- **Task worktrees** are where code is written and tested.
- **`focus/`** is where the app runs. It is the same directory every time,
  so anything tied to a path (a Docker Compose bind mount, a process manager's
  socket, an editor's run configuration) keeps working when the branch under
  test changes.

## Enable it for a repo

Focus is off until a repo asks for it. Add a `focus` setting to the repo's
[`worktree.json`](worktree-json.md#focus). For a repo whose team does not use
grove, put it in the directory holding `main/`, where it is never committed:

```json
{ "focus": {} }
```

## Focus a worktree

```bash
wt focus                      # inside a worktree: check its HEAD out in focus/
wt focus 260810-fix-login     # or name the worktree
wt focus status               # what is focused, and how far behind it is
wt focus release              # run release hooks; focus/ stays where it is
```

The first `wt focus` creates `focus/`. After that it moves it.

`focus/` is checked out at the worktree's commit, detached, never on its
branch. If two worktrees had the same branch checked out, committing in one
would move the branch under the other, leaving its files out of step with its
HEAD. Detached, `focus/` only ever moves when you run `wt focus`. So commit,
then run `wt focus` again to bring `focus/` up to date; `wt focus status`
says how many commits it is behind.

Only committed work moves across. `focus` refuses a worktree with uncommitted
changes, and refuses to overwrite changes in `focus/` itself (often files the
app regenerated) unless you pass `--discard`.

## Handing over

Running an app usually leaves state behind: database migrations, generated
files, caches. Hooks let a repo prepare `focus/` for the incoming commit and
tidy up after the outgoing one.

```mermaid
sequenceDiagram
  participant A as fix-login
  participant F as focus/
  participant B as add-metrics
  A->>F: grove focus
  Note over F: check out fix-login's commit
  F->>F: activate hooks (install, migrate)
  Note over F: the app runs fix-login
  B->>F: grove focus
  F->>F: release hooks, fix-login's commit still checked out (roll back its migrations)
  Note over F: check out add-metrics' commit
  F->>F: activate hooks
  Note over F: the app runs add-metrics
```

`release` hooks run before the checkout changes, so they run with the outgoing
code: that code knows how to undo what it did. Refocusing the same worktree
runs only `activate`. `wt focus release` runs `release` and leaves `focus/`
where it is, unowned, so the next focus does not repeat setup for nothing.

See [`worktree.json`](worktree-json.md#focus) for the hook settings and the
environment each hook receives.

## Who has it

`wt focus status` names the worktree that owns `focus/`. The record lives in
the repo's shared git directory, so every worktree sees the same answer. `wt
list` tags the focus worktree and its owner, and `wt cleanup` never offers to
remove the focus worktree, even once it is released.
