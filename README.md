# ares-scan

Run an Ares security assessment from a CI pipeline and fail the build on what it finds.

One implementation, three ways to call it:

| CI | How |
|---|---|
| GitHub Actions | `uses: assailai/ares-scan@v1` |
| GitLab CI, Jenkins, CircleCI, Bitbucket, anything else | the container image |
| Azure DevOps | `templates/azure-template.yml` from this repo |

No CI/CD component is published for GitLab. A component has to live in a project on the same
GitLab instance that runs the pipeline, so one published in our namespace could only ever be
included by customers on gitlab.com and would fail outright on a self-managed instance. The image
works everywhere, so it is what the generated file uses.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the gate passed, or no gate is configured, or `--no-wait` |
| 1 | the gate failed: findings crossed a rule the customer set |
| 2 | the assessment could not be run or could not be judged |

1 and 2 are deliberately different. A build that goes red because of a real finding and one that
goes red because a key expired need different people, and collapsing them teaches a team to treat
every red as infrastructure noise. Running out of time is 2, never 1.

Zero runtime dependencies: this executes inside a customer's build with their API key, so its
dependency graph is something their security team has to accept.

The source of truth is `apps/ares-cli` in the private ares-v2 repository; this repository is
published from it on release.
