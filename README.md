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
| 0 | the gate passed, or no gate is configured, or `--no-wait`, or `--upload-only` |
| 1 | the gate failed: findings crossed a rule the customer set |
| 2 | the assessment could not be run or could not be judged, or a build could not be uploaded, did not become current, or is not authorized for assessment |

1 and 2 are deliberately different. A build that goes red because of a real finding and one that
goes red because a key expired need different people, and collapsing them teaches a team to treat
every red as infrastructure noise. Running out of time is 2, never 1.

## Mobile builds (.apk, .aab, .ipa)

Point `build` at the file your pipeline just produced, and name the mobile target it belongs to.
ares-scan then:

1. hashes the file (sha256, streamed, never loaded into memory),
2. asks Ares for a signed upload and sends the build straight to object storage,
3. records it on the target as its **current** build, and prints the package id and version Ares
   recorded (read out of the build itself wherever Ares can), so a build step that produced the
   wrong app is noticed,
4. starts a mobile assessment of **that** build, by its id, and gates on the verdict exactly as it
   does for a web assessment.

The run always names the build this step uploaded, never "whatever is current", so two pipelines
releasing at once cannot be judged on each other's build.

If Ares records the build but does not make it current, which is what an Ares older than ares-scan
1.1.0 does, ares-scan stops with exit 2 and assesses nothing. That includes `upload-only`, whose
whole job is to make the build current, so an older Ares cannot turn it into a success that changed
nothing.

### The API key

Mint it in **Settings > CI/CD** with the **Mobile build pipeline** preset, which grants
`artifacts.manage`, `artifacts.view`, `hunts.manage`, `hunts.view`, `targets.view`,
`findings.view` and `reports.view`, and tick **I own the mobile apps this key will upload** (build attestation). That tick is
what authorizes the builds the key uploads to be assessed. Ares refuses to record a build from a key
minted without it: ares-scan prints Ares's reason and exits 2, with `upload-only` too, and nothing is
recorded or assessed. Mint a key with the attestation ticked.

An older Ares records such a build anyway, unaffirmed. ares-scan then says the build is not
authorized for assessment and exits 2 without starting a run (with `upload-only` it warns and
exits 0).

### GitHub Actions

```yaml
jobs:
  ares-mobile:
    runs-on: ubuntu-latest
    # Above the step's own timeout, so a long assessment reports "still running" rather than
    # being killed by the runner.
    timeout-minutes: 135
    steps:
      - uses: actions/checkout@v5
      - run: ./gradlew assembleRelease
      - uses: assailai/ares-scan@v1
        id: ares
        with:
          api-key: ${{ secrets.ARES_API_KEY }}
          ares-url: https://ares.assailai.com
          target-id: 0b6f1c2e-0000-0000-0000-000000000000
          build: app/build/outputs/apk/release/app-release.apk
          build-version: ${{ github.run_number }}
          fail-on: critical>0,high>0
          timeout-minutes: "120"
```

An iOS build works the same way from a macOS runner: `build: build/App.ipa`. The action reads the
file as the runner's own user, so a file the build step wrote is readable as it is.

| Input | |
|---|---|
| `build` | path to the `.apk`, `.aab` or `.ipa`, relative to the workspace. Requires `target-id`; cannot be combined with `preview-url` |
| `build-name` | what Ares calls the build (default: the file name) |
| `build-version` | a version to record against it; one Ares reads out of the build itself takes precedence |
| `analysis` | `sast`, `dast`, or `sast,dast` (default: Ares's own default for the run) |
| `upload-only` | `true` to upload and make the build current without starting an assessment |

The `artifact-id` output is the uploaded build's id. `profile` may be named beside `target-id`: the
build is then filed under the target, and the profile configures the run.

### GitLab CI, or any CI, with the container

```yaml
ares-mobile:
  stage: test
  image: ghcr.io/assailai/ares-scan:1
  needs: [build-android]          # the job that keeps the .apk as one of its artifacts
  variables:
    ARES_URL: "https://ares.assailai.com"
    ARES_TARGET_ID: "0b6f1c2e-0000-0000-0000-000000000000"
    ARES_BUILD: "app/build/outputs/apk/release/app-release.apk"
    ARES_FAIL_ON: "critical>0,high>0"
    ARES_TIMEOUT_MINUTES: "120"
  timeout: 2h 15m
  script:
    - ares-scan
# ARES_API_KEY comes from a masked, protected CI/CD variable.
```

The image runs as the unprivileged `node` user (uid 1000), so the build must be readable by that
user. GitLab's Docker executor leaves the checkout and downloaded artifacts world-readable, so the
job above works as written. Elsewhere, mount the build's directory read-only and start the
container in it:

```sh
docker run --rm -e ARES_API_KEY \
  -v "$PWD/app/build/outputs/apk/release:/build:ro" -w /build \
  ghcr.io/assailai/ares-scan:1 \
  --ares-url https://ares.assailai.com --target-id 0b6f1c2e-0000-0000-0000-000000000000 \
  --build app-release.apk --fail-on 'critical>0,high>0' --timeout-minutes 120
```

If the file is not world-readable (for example a build written under a restrictive umask),
`chmod a+r` it first, or ares-scan stops with "permission denied" before anything is uploaded.

Every input has an environment variable: `ARES_BUILD`, `ARES_BUILD_NAME`, `ARES_BUILD_VERSION`,
`ARES_ANALYSIS`, `ARES_UPLOAD_ONLY` (and the flags `--build`, `--build-name`, `--build-version`,
`--analysis`, `--upload-only`). Azure DevOps takes the same through `templates/azure-template.yml`
(`build`, `buildName`, `buildVersion`, `analysis`, `uploadOnly`), which mounts the build's
directory into the container for you.

### Without the container

`templates/upload-mobile-build.sh` is the same flow for a pipeline that cannot run the action or
the image. It needs a POSIX shell, curl 7.76 or newer, jq 1.6 or newer, and sha256sum (or shasum).
It checks both versions before it sends anything, naming the one it found, and keeps the same exit
codes:

```sh
ARES_URL=https://ares.assailai.com ARES_TARGET_ID=0b6f1c2e-0000-0000-0000-000000000000 ARES_FAIL_ON="critical>0" \
  sh upload-mobile-build.sh app/build/outputs/apk/release/app-release.apk
```

`ARES_UPLOAD_ONLY=1` uploads without assessing and prints only the build's id on stdout.

- **Provenance.** The assessment records the commit, ref, repository and pipeline URL exactly as
  ares-scan does, read from the variables GitHub Actions, GitLab CI or Azure Pipelines set.
  `ARES_PIPELINE_URL` overrides the pipeline URL; anything the CI does not set is left out.
- **The API key never appears on a command line**, so it does not show in `ps` to other users of a
  shared runner. The script writes it once to a header file that only the job's user can read, in a
  private temporary directory removed when the script exits, and hands curl that file.
- **Every request has a time limit**: a minute for each call to Ares (and never past
  `ARES_TIMEOUT_MINUTES` while waiting for the verdict), 30 minutes for the build itself. A stalled
  connection fails the step instead of holding it until the CI system kills it.

### How long to wait

A mobile assessment analyses the build and then exercises it on a device, which takes longer than a
web assessment. Wait 120 minutes (`timeout-minutes: "120"`), and give the job itself a little more
so the step can report "still running" instead of being killed. Running out of time is exit 2,
never 1.

Zero runtime dependencies: this executes inside a customer's build with their API key, so its
dependency graph is something their security team has to accept.

The source of truth is `apps/ares-cli` in the private ares-v2 repository; this repository is
published from it on release.
