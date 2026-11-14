import * as github from "@pulumi/github";
import * as pulumi from "@pulumi/pulumi";

// One stack per repository: the stack name is the repository name.
const config = new pulumi.Config();
const name = pulumi.getStack();
const visibility = config.get("visibility") ?? "private";
const requireSignedCommits = config.getBoolean("requireSignedCommits") ?? true;
const enforcement = config.get("rulesetEnforcement") ?? "active"; // flip to "disabled" as a break-glass, via code review

// Gitflow: features land on `stg` (squash), releases promote `stg` -> `main` (merge commit).
const production = "main";
const staging = "stg";

// Required status check; must match the job name in .github/workflows/conventional-commits.yml.
const requiredCheck = "conventional-commits";
const githubActionsAppId = 15368; // only accept the check when it comes from GitHub Actions

const repo = new github.Repository(
  "repository",
  {
    name,
    description: config.get("description"),
    visibility,
    autoInit: false, // history starts with our own conventional root commit, not GitHub's "Initial commit"
    hasIssues: true,
    hasProjects: false,
    hasWiki: false,
    hasDiscussions: false,
    allowSquashMerge: true, // feature -> stg
    allowMergeCommit: true, // stg -> main
    allowRebaseMerge: false,
    squashMergeCommitTitle: "PR_TITLE", // the (linted) PR title becomes the commit message
    squashMergeCommitMessage: "PR_BODY",
    mergeCommitTitle: "PR_TITLE",
    mergeCommitMessage: "PR_BODY",
    allowAutoMerge: true,
    allowUpdateBranch: true,
    deleteBranchOnMerge: true,
    archiveOnDestroy: true,
  },
  { protect: true },
);

// Phase 2 of the bootstrap: everything below needs `main` to exist on GitHub.
const stg = new github.Branch(
  staging,
  { repository: repo.name, branch: staging, sourceBranch: production },
  { protect: true },
);

new github.BranchDefault("default-branch", { repository: repo.name, branch: stg.branch });

new github.WorkflowRepositoryPermissions("workflow-permissions", {
  repository: repo.name,
  defaultWorkflowPermissions: "read",
  canApprovePullRequestReviews: false,
});

const protectedBranch = (branch: string, mergeMethod: "squash" | "merge") =>
  new github.RepositoryRuleset(branch, {
    repository: repo.name,
    name: branch,
    target: "branch",
    enforcement,
    conditions: { refName: { includes: [`refs/heads/${branch}`], excludes: [] } },
    rules: {
      deletion: true,
      nonFastForward: true,
      requiredLinearHistory: mergeMethod === "squash",
      requiredSignatures: requireSignedCommits,
      pullRequest: {
        allowedMergeMethods: [mergeMethod],
        requiredApprovingReviewCount: config.getNumber("requiredApprovals") ?? 0,
        dismissStaleReviewsOnPush: true,
        requiredReviewThreadResolution: true,
      },
      requiredStatusChecks: {
        // Not strict: after a release `main` holds merge commits that `stg` never gets,
        // so "require branch to be up to date" would force pointless back-merges.
        strictRequiredStatusChecksPolicy: false,
        requiredChecks: [{ context: requiredCheck, integrationId: githubActionsAppId }],
      },
    },
  }, { dependsOn: [stg] });

protectedBranch(staging, "squash");
protectedBranch(production, "merge");

export const url = repo.htmlUrl;
export const cloneUrl = repo.httpCloneUrl;
