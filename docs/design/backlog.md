# Backlog

## P2: Git workspace manager can mistake tags for branches

`GitWorkspaceManager` currently validates `defaultBranch` and `devBranch` with a generic ref check. A tag named the same as the configured `devBranch` can satisfy that check even when the local branch does not exist. In that case, `git checkout <devBranch>` can leave the repo on detached `HEAD` while Loom reports workspace preparation as successful.

Repro shape:

- Create a repo with `main`.
- Add a tag named `dev`.
- Do not create a local `dev` branch.
- Run `prepareWorkspace` with `devBranch: "dev"`.
- The result can be `success`, while `git rev-parse --abbrev-ref HEAD` returns `HEAD`.

Suggested fix:

- Use branch-specific checks for local branches, such as `refs/heads/${branch}`.
- Use remote-specific checks for remote refs, such as `refs/remotes/origin/${branch}`.
- After checkout, verify the current branch equals `project.devBranch`.
- Add a regression test covering a `dev` tag with no local `dev` branch.
