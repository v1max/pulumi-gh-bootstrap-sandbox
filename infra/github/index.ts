import * as github from "@pulumi/github";
import * as pulumi from "@pulumi/pulumi";

// One stack per repository: the stack name is the repository name.
const config = new pulumi.Config();
const name = pulumi.getStack();

// Gitflow with two long-lived branches:
//   feature/fix/chore -> stg   squash (the PR title becomes the commit)
//   stg -> main                merge commit (release; same SHAs on both branches)
//   hotfix/* -> main           merge commit, then back-merge main -> stg with a merge commit
const production = "main";
const staging = "stg";

// Must match the job name in .github/workflows/conventional-commits.yml.
const requiredCheck = "conventional-commits";
const githubActionsAppId = 15368; // only accept that check when GitHub Actions reports it

const repo = new github.Repository(
  "repository",
  {
    name,
    description: config.get("description"),
    visibility: config.get("visibility") ?? "private",
    autoInit: false, // history starts with our own conventional root commit
    hasIssues: true,
    hasProjects: false,
    hasWiki: false,
    hasDiscussions: false,
    allowSquashMerge: true,
    allowMergeCommit: true,
    allowRebaseMerge: false, // rebase-merge rewrites SHAs and drops signatures
    squashMergeCommitTitle: "PR_TITLE", // the linted PR title becomes the commit subject
    squashMergeCommitMessage: "BLANK",
    mergeCommitTitle: "PR_TITLE",
    mergeCommitMessage: "BLANK",
    allowAutoMerge: true,
    allowUpdateBranch: true,
    deleteBranchOnMerge: true, // never applies to stg/main: default branch + deletion rule
  },
  { protect: true, retainOnDelete: true },
);

// --- Everything below needs `main` to exist on GitHub (bootstrap phase 2). ---

const stg = new github.Branch(
  staging,
  { repository: repo.name, branch: staging, sourceBranch: production },
  { retainOnDelete: true },
);

// stg is the default branch so PRs, clones and Dependabot target it by default.
new github.BranchDefault("default-branch", { repository: repo.name, branch: stg.branch });

new github.WorkflowRepositoryPermissions("workflow-permissions", {
  repository: repo.name,
  defaultWorkflowPermissions: "read",
  canApprovePullRequestReviews: false,
});

const ruleset = (branch: string, allowedMergeMethods: string[]) =>
  new github.RepositoryRuleset(
    branch,
    {
      repository: repo.name,
      name: branch,
      target: "branch",
      enforcement: config.get("rulesetEnforcement") ?? "active", // "disabled" = break-glass via PR
      conditions: { refName: { includes: [`refs/heads/${branch}`], excludes: [] } },
      rules: {
        deletion: true,
        nonFastForward: true,
        requiredSignatures: config.getBoolean("requireSignedCommits") ?? true,
        pullRequest: {
          allowedMergeMethods,
          requiredApprovingReviewCount: config.getNumber("requiredApprovals") ?? 0,
          dismissStaleReviewsOnPush: true,
          requiredReviewThreadResolution: true,
        },
        requiredStatusChecks: {
          // Not strict: after a release main holds a merge commit stg never gets,
          // so "must be up to date" would force a back-merge before every release.
          strictRequiredStatusChecksPolicy: false,
          requiredChecks: [{ context: requiredCheck, integrationId: githubActionsAppId }],
        },
      },
    },
    { dependsOn: [stg] },
  );

ruleset(staging, ["squash", "merge"]); // merge only for main -> stg back-merges
ruleset(production, ["merge"]); // never squash a release: stg and main would diverge

export const url = repo.htmlUrl;
