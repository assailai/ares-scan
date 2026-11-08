#!/bin/sh
# Upload a mobile build to Ares from any CI, then assess it and gate the build on the verdict.
#
# The same flow as `ares-scan --build`, for a pipeline that cannot run the action or the container
# image. It needs only a POSIX shell, curl 7.76 or newer, jq 1.6 or newer, and sha256sum (or shasum
# on macOS), and checks both versions before it sends anything.
#
#   ARES_URL=https://ares.assailai.com ARES_TARGET_ID=<target id> \
#     sh upload-mobile-build.sh app/build/outputs/apk/release/app-release.apk
#
# Environment:
#   ARES_URL              your Ares instance (required)
#   ARES_API_KEY          an Ares API key, from the CI system's secret store (required)
#   ARES_TARGET_ID        the mobile target this build belongs to (required)
#   ARES_BUILD_NAME       what Ares calls the build (default: the file name)
#   ARES_BUILD_VERSION    a version to record against the build
#   ARES_ANALYSIS         sast, dast, or "sast,dast" (default: both)
#   ARES_FAIL_ON          what fails the build, e.g. "critical>0" or "critical>0,high>=2"
#   ARES_UPLOAD_ONLY=1    upload the build and make it current, but start no assessment
#   ARES_TIMEOUT_MINUTES  how long to wait for the verdict (default 120)
#   ARES_POLL_SECONDS     how often to ask for it (default 30)
#   ARES_PIPELINE_URL     the pipeline run the assessment links back to (default: read from the CI)
# The build path is the one argument, or ARES_BUILD.
#
# The assessment records what it judged, as ares-scan does: the commit, ref, repository and
# pipeline URL, read from the variables GitHub Actions, GitLab CI or Azure Pipelines set. Any the CI
# does not set is left out.
#
# The API key is never put on a command line, where `ps` would show it to every user of a shared
# runner on every request. It is written once to a header file that only this user can read, in a
# private temporary directory, handed to curl as -H @file, and removed when the script exits.
# Every request also has a time limit, so a stalled connection fails the step rather than holding
# it until the CI system kills it.
#
# EXIT CODES, the same contract as ares-scan:
#   0  the gate passed, or no gate is configured, or ARES_UPLOAD_ONLY=1
#   1  the gate failed: findings crossed a rule the customer set
#   2  anything else: refused, could not upload, not authorized, timed out, could not be judged
#
# Progress goes to stderr and results to stdout, so with ARES_UPLOAD_ONLY=1
#   artifact_id=$(sh upload-mobile-build.sh app-release.apk)
# captures the build's id and nothing else.

set -eu

# Every request is bounded. Unbounded, a connection that stalls mid-transfer holds the job until the
# CI system kills it, long past ARES_TIMEOUT_MINUTES, with nothing in the log to say why.
CONNECT_TIMEOUT=15   # seconds to reach Ares or the store at all
API_MAX_TIME=60      # one call to Ares; a status check is also cut short at the end of the budget
UPLOAD_MAX_TIME=1800 # the build to the store: 500 MB at under 300 KB/s still lands
# Failed status checks in a row before the run is given up on, as in ares-scan: a long run on
# somebody else's network meets a few dropped connections, and a sustained outage still ends it.
MAX_POLL_FAILURES=5

log() { printf '%s\n' "$*" >&2; }
fail() {
  log "error: $*"
  exit 2
}

gate_failed=0
tmp=$(mktemp -d) || fail "cannot create a temporary directory"
# shellcheck disable=SC2329 # run by the EXIT trap below, which shellcheck does not follow
finish() {
  status=$?
  rm -rf "$tmp"
  # Only a failed gate may exit 1. Under `set -e` a command that fails ends the script with ITS
  # status, and plenty of tools exit 1 for reasons that have nothing to do with a finding; passed
  # through, a broken pipeline step would read as a security failure. Anything else is 2.
  if [ "$status" -eq 1 ] && [ "$gate_failed" -ne 1 ]; then exit 2; fi
  if [ "$status" -gt 2 ]; then exit 2; fi
}
trap finish EXIT
trap 'exit 2' HUP INT TERM

# --- what to upload, checked before anything is sent ---------------------------------------------

build=${1:-${ARES_BUILD:-}}
[ -n "$build" ] || fail "name the build to upload: sh upload-mobile-build.sh path/to/app-release.apk"
[ -n "${ARES_URL:-}" ] || fail "set ARES_URL to your Ares instance"
[ -n "${ARES_API_KEY:-}" ] || fail "set ARES_API_KEY, stored as a secret in your CI system"
# A bearer token is letters, digits and -._~+/= (RFC 6750). Anything else is most likely a space or
# a line break stored with the secret, and a line break would split the header file into two headers.
case $ARES_API_KEY in
  *[!A-Za-z0-9._~+/=-]*) fail "ARES_API_KEY holds a character no API key has (a space or a line break?). Store the key alone, exactly as Ares showed it." ;;
esac
[ -n "${ARES_TARGET_ID:-}" ] || fail "set ARES_TARGET_ID to the mobile target this build belongs to"
for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done

# at_least VERSION MAJOR MINOR: whether a dotted VERSION is MAJOR.MINOR or newer. A version that does
# not read is not new enough, so an unrecognised tool is refused rather than trusted.
at_least() {
  major=${1%%.*}
  minor=${1#*.}
  minor=${minor%%[!0-9]*}
  case $1 in *.*) ;; *) return 1 ;; esac
  case $major in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$minor" ] || return 1
  [ "$major" -gt "$2" ] || { [ "$major" -eq "$2" ] && [ "$minor" -ge "$3" ]; }
}

# Checked up front because an older one fails later and misleadingly: curl before 7.76 stops on
# --fail-with-body as an unknown option, and jq before 1.6 has no IN, so a valid ARES_FAIL_ON would
# be reported as unreadable.
curl_version=$(curl --version 2>/dev/null | sed -n '1s/^curl \([^ ]*\).*/\1/p')
at_least "$curl_version" 7 76 ||
  fail "curl 7.76 or newer is required (for --fail-with-body); found curl ${curl_version:-with no readable version}"
jq_version=$(jq --version 2>/dev/null) || jq_version=""
jq_version=${jq_version#jq-}
at_least "$jq_version" 1 6 ||
  fail "jq 1.6 or newer is required (for IN); found jq ${jq_version:-with no readable version}"

ares=$ARES_URL
while [ "${ares%/}" != "$ares" ]; do ares=${ares%/}; done

file_name=${build##*/}
case $(printf '%s' "$file_name" | tr '[:upper:]' '[:lower:]') in
  *.apk) kind=android_apk ;;
  *.aab) kind=android_aab ;;
  *.ipa) kind=ios_ipa ;;
  *) fail "\"$file_name\" is not a build Ares can assess. Upload an Android .apk or .aab, or an iOS .ipa." ;;
esac
[ -f "$build" ] || fail "there is no build at $build. Check the path the build step wrote it to."
[ -r "$build" ] || fail "cannot read the build at $build: permission denied"

case ${ARES_UPLOAD_ONLY:-0} in
  1 | true) upload_only=1 ;;
  0 | false | "") upload_only=0 ;;
  *) fail "ARES_UPLOAD_ONLY is 1 or 0, not \"$ARES_UPLOAD_ONLY\"" ;;
esac

# Refused rather than filtered: dropping a misspelt "dats" would leave a pipeline that believes it
# runs a dynamic assessment on every release and has not run one since the line was written.
analysis=null
if [ -n "${ARES_ANALYSIS:-}" ]; then
  [ "$upload_only" -eq 0 ] || fail "ARES_UPLOAD_ONLY=1 starts no assessment, so ARES_ANALYSIS would never apply"
  analysis=$(jq -nc --arg raw "$ARES_ANALYSIS" '
    [$raw | split(",")[] | gsub("\\s+"; "") | ascii_downcase | select(length > 0)]
    | if length == 0 or any(.[]; . != "sast" and . != "dast") then error("bad") else unique end
  ' 2>/dev/null) || fail "ARES_ANALYSIS is sast, dast, or both separated by a comma, not \"$ARES_ANALYSIS\""
fi

# The same syntax as `ares-scan --fail-on`, and refused rather than dropped when it does not read,
# for the reason ARES_ANALYSIS is: a rule that is never sent is a gate that can never fail.
gate=null
if [ -n "${ARES_FAIL_ON:-}" ]; then
  [ "$upload_only" -eq 0 ] || fail "ARES_UPLOAD_ONLY=1 starts no assessment, so ARES_FAIL_ON would never apply"
  gate=$(jq -nc --arg raw "$ARES_FAIL_ON" '
    {rules: [$raw | split(",")[] | gsub("\\s+"; "") | select(length > 0)
      | (capture("^(?<metric>[A-Za-z_]+)(?<op>>=|>)(?<threshold>[0-9]+)$") // error("bad"))
      | {metric: (.metric | ascii_downcase),
         comparator: (if .op == ">=" then "gte" else "gt" end),
         threshold: (.threshold | tonumber)}]}
    | if (.rules | length) == 0 then error("empty") else . end
    | if any(.rules[]; .metric | IN("critical", "high", "medium", "low", "info", "total") | not)
      then error("metric") else . end
  ' 2>/dev/null) || fail "ARES_FAIL_ON reads like critical>0 or high>=2 (critical, high, medium, low, info or total), separated by commas, not \"$ARES_FAIL_ON\""
fi

timeout_minutes=${ARES_TIMEOUT_MINUTES:-120}
poll_seconds=${ARES_POLL_SECONDS:-30}
case $timeout_minutes in '' | *[!0-9]*) fail "ARES_TIMEOUT_MINUTES is a whole number of minutes" ;; esac
case $poll_seconds in '' | *[!0-9]*) fail "ARES_POLL_SECONDS is a whole number of seconds" ;; esac

# --- helpers ---------------------------------------------------------------------------------------

# The server's own reason out of an error body: FastAPI's {"detail": "..."}, or its list of
# validation errors. A status line alone does not tell anybody what to fix.
detail_of() {
  [ -s "$1" ] || return 0
  jq -r '
    if (.detail | type) == "string" then .detail
    elif (.detail | type) == "array" then [.detail[] | (.msg? // tostring)] | join("; ")
    else empty end
  ' "$1" 2>/dev/null || head -c 500 "$1"
}

# The key, written once where only this user can read it (mktemp has already made the directory
# 0700). printf is a shell builtin, so writing the file puts the key on no command line either.
auth=$tmp/authorization
(umask 077 && printf 'Authorization: Bearer %s\n' "$ARES_API_KEY" >"$auth")

# ares_post ACTION PATH REQUEST_FILE: the response body lands in $tmp/response. ACTION is what the
# call asks of Ares, in the words an error names it ("record the build"). A refusal ends the script
# with 2 and the server's reason. The body travels as a file rather than an argument, so curl never
# reads a value starting with @ as a path.
ares_post() {
  action=$1
  rc=0
  code=$(curl --fail-with-body -sS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$API_MAX_TIME" \
    -X POST "$ares$2" -H @"$auth" -H "Content-Type: application/json" --data-binary "@$3" \
    -o "$tmp/response" -w '%{http_code}') || rc=$?
  # 22 is curl's "the server answered with an error"; any other failure never got an answer.
  case $rc in
    0) ;;
    22)
      reason=$(detail_of "$tmp/response")
      fail "Ares refused to $action ($code): ${reason:-no reason given}"
      ;;
    *) fail "Ares did not answer when asked to $action (curl exited $rc; its error is above)" ;;
  esac
}

# --- upload ----------------------------------------------------------------------------------------

# Hashed from stdin, so the output is the bare digest whatever characters the path holds.
if command -v sha256sum >/dev/null 2>&1; then
  sum=$(sha256sum <"$build") || fail "cannot read the build at $build"
elif command -v shasum >/dev/null 2>&1; then
  sum=$(shasum -a 256 <"$build") || fail "cannot read the build at $build"
else
  fail "sha256sum or shasum is required"
fi
sha256=${sum%% *}
case $sha256 in *[!0-9a-f]* | "") fail "could not compute a sha256 of $build" ;; esac

log "Uploading $build"
jq -n --arg file "$file_name" --arg kind "$kind" \
  '{file_name: $file, artifact_kind: $kind, content_type: "application/octet-stream"}' >"$tmp/request"
ares_post "sign the build upload" /api/v1/artifacts/upload-url "$tmp/request"
cp "$tmp/response" "$tmp/upload"

# Every signed field, then the file LAST: the store ignores whatever follows the file part, so a
# field sent after it is never sent at all. --form-string takes each value literally, where -F
# would read a leading @ or < as a file and a ; as its own syntax. One field per line is safe
# because a signed field never holds a line break, and jq refuses one that does.
jq -r '.fields | to_entries[]
  | if ((.key + .value) | test("[\r\n]")) then error("line break") else "\(.key)=\(.value)" end
' "$tmp/upload" >"$tmp/fields" 2>/dev/null || fail "Ares answered the upload request without usable signed fields"
storage_url=$(jq -r '.url // empty' "$tmp/upload")
[ -n "$storage_url" ] || fail "Ares answered the upload request without an upload address"

set --
while IFS= read -r field; do
  set -- "$@" --form-string "$field"
done <"$tmp/fields"
# curl reads ; and , in a -F file name as its own syntax, so both names are double-quoted with
# \ and " escaped, which is the form curl documents for exactly this.
quoted_path=$(printf '%s' "$build" | sed 's/[\\"]/\\&/g')
quoted_name=$(printf '%s' "$file_name" | sed 's/[\\"]/\\&/g')
set -- "$@" -F "file=@\"$quoted_path\";filename=\"$quoted_name\""

# No Authorization header: the signature is in the form, and the API key is a credential for Ares,
# not for a URL the server handed back.
rc=0
curl --fail-with-body -sS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$UPLOAD_MAX_TIME" \
  -X POST "$storage_url" -o "$tmp/storage" "$@" || rc=$?
if [ "$rc" -eq 22 ]; then
  code=$(sed -n 's:.*<Code>\([^<]*\)</Code>.*:\1:p' "$tmp/storage" 2>/dev/null | head -n 1)
  message=$(sed -n 's:.*<Message>\([^<]*\)</Message>.*:\1:p' "$tmp/storage" 2>/dev/null | head -n 1)
  fail "object storage refused the build upload: ${code:-no code given}${message:+: $message}"
fi
[ "$rc" -eq 0 ] || fail "the build upload to object storage did not finish (curl exited $rc; its error is above)"

# Current, because the pipeline that uploaded a build is asking for THAT build to be the one
# assessed from now on. attack_affirmed is absent on purpose: the server affirms the build when
# the key was minted with build attestation, and refuses a key that tries to attest for itself.
jq -n \
  --arg kind "$kind" \
  --arg name "${ARES_BUILD_NAME:-$file_name}" \
  --arg file "$file_name" \
  --arg target "$ARES_TARGET_ID" \
  --arg sha "$sha256" \
  --arg version "${ARES_BUILD_VERSION:-}" \
  --slurpfile upload "$tmp/upload" \
  '{
    artifact_kind: $kind, name: $name, file_name: $file,
    s3_bucket: $upload[0].s3_bucket, s3_key: $upload[0].s3_key,
    target_id: $target, sha256: $sha, make_current: true
  } + (if $version == "" then {} else {version: $version} end)' >"$tmp/request"
ares_post "record the build" /api/v1/artifacts "$tmp/request"
cp "$tmp/response" "$tmp/artifact"

artifact_id=$(jq -r '.id // empty' "$tmp/artifact")
[ -n "$artifact_id" ] || fail "Ares did not say which build it recorded"
log "Uploaded $(jq -r .name "$tmp/artifact")"
log "  Build     $artifact_id"
log "  Package   $(jq -r '.package_id // "not read from the build"' "$tmp/artifact")"
log "  Version   $(jq -r '.version // "not recorded"' "$tmp/artifact")"

# Checked even with ARES_UPLOAD_ONLY=1, whose whole job is to make the build current: an older Ares
# ignores make_current and still answers 201, so without this the step reports a success that
# promoted nothing. First, because that Ares is the cause, and the unaffirmed build it may also
# return would otherwise be blamed on the key.
if [ "$(jq -r '.in_use == true' "$tmp/artifact")" != "true" ]; then
  fail "Ares recorded the build but did not make it the target's current build, so this Ares is" \
    "probably older than ares-scan 1.1.0. Nothing was assessed."
fi

# A current Ares refuses to record an unaffirmed build at all; this is for an older one that does.
if [ "$(jq -r .attack_affirmed "$tmp/artifact")" != "true" ]; then
  log "warning: The build was uploaded, but it is not authorized for assessment: this API key was" \
    "minted without build attestation. Mint a key with \"I own the mobile apps this key will upload\" ticked in" \
    "Settings > CI/CD, or affirm the build in Ares."
  if [ "$upload_only" -eq 0 ]; then
    log "No assessment was started."
    exit 2
  fi
fi
if [ "$upload_only" -eq 1 ]; then
  printf '%s\n' "$artifact_id"
  exit 0
fi

# --- assess ----------------------------------------------------------------------------------------

# Provenance, from whichever CI this is and in ares-scan's order, so a red build three days later can
# be traced to the commit it judged.
github_run=""
if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
  github_run=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID
fi

# By id, never "the target's current build": that pointer is shared by every pipeline building this
# app, so two releases uploading at once would otherwise be judged on each other's build.
jq -n --arg target "$ARES_TARGET_ID" --arg artifact "$artifact_id" \
  --argjson analysis "$analysis" --argjson gate "$gate" \
  --arg commit_sha "${GITHUB_SHA:-${CI_COMMIT_SHA:-${BUILD_SOURCEVERSION:-}}}" \
  --arg ref "${GITHUB_REF:-${CI_COMMIT_REF_NAME:-${BUILD_SOURCEBRANCH:-}}}" \
  --arg repository "${GITHUB_REPOSITORY:-${CI_PROJECT_PATH:-${BUILD_REPOSITORY_NAME:-}}}" \
  --arg pipeline_url "${ARES_PIPELINE_URL:-${github_run:-${CI_PIPELINE_URL:-}}}" \
  '{target_id: $target, hunt_type: "mobile", artifact_id: $artifact,
    ci: ({commit_sha: $commit_sha, ref: $ref, repository: $repository, pipeline_url: $pipeline_url}
      | with_entries(select(.value != "")))}
   + (if $analysis == null then {} else {analysis_types: $analysis} end)
   + (if $gate == null then {} else {gate: $gate} end)' >"$tmp/request"
ares_post "start the assessment" /api/v1/ci/runs "$tmp/request"
cp "$tmp/response" "$tmp/run"

run_id=$(jq -r '.id // empty' "$tmp/run")
dashboard=$(jq -r '.dashboard_url // empty' "$tmp/run")
case $run_id in "" | *[!0-9A-Za-z-]*) fail "Ares did not say which run it started" ;; esac
started_artifact=$(jq -r '.artifact_id // empty' "$tmp/run")
if [ "$started_artifact" != "$artifact_id" ]; then
  fail "Ares started $dashboard but did not confirm it assesses the build just uploaded" \
    "(asked for $artifact_id, got ${started_artifact:-none}). Not judging this build on it."
fi
log "Started an Ares assessment: $dashboard"

# Poll until the run is terminal or the budget runs out. Running out of time is 2, NOT a gate
# failure: an assessment that has not finished is not evidence of a vulnerability. A dropped
# connection or a 5xx is retried, as the CLI does, because a forty-minute run on somebody else's
# network meets a few; a 4xx is permanent (an expired key will not fix itself) and ends it at once.
deadline=$(($(date +%s) + timeout_minutes * 60))
failures=0
terminal=0
last=""
while now=$(date +%s) && [ "$now" -lt "$deadline" ]; do
  # Never longer than what is left, so a status check that stalls near the end cannot outlive it.
  max_time=$((deadline - now))
  [ "$max_time" -le "$API_MAX_TIME" ] || max_time=$API_MAX_TIME
  code=$(curl -sS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$max_time" -o "$tmp/status" \
    -w '%{http_code}' "$ares/api/v1/ci/runs/$run_id" -H @"$auth") || code=000
  case $code in
    2??)
      failures=0
      phase=$(jq -r 'if .current_phase then "\(.status) / \(.current_phase)" else .status end' \
        "$tmp/status" 2>/dev/null) || phase=""
      if [ -n "$phase" ] && [ "$phase" != "$last" ]; then
        log "  $phase"
        last=$phase
      fi
      if [ "$(jq -r .is_terminal "$tmp/status" 2>/dev/null)" = "true" ]; then
        terminal=1
        break
      fi
      ;;
    4??)
      reason=$(detail_of "$tmp/status")
      fail "Ares refused to report the assessment's progress ($code): ${reason:-no reason given}"
      ;;
    *)
      failures=$((failures + 1))
      [ "$failures" -lt "$MAX_POLL_FAILURES" ] ||
        fail "could not read the run's status $failures times in a row (last: HTTP $code)"
      ;;
  esac
  sleep "$poll_seconds"
done

if [ "$terminal" -ne 1 ]; then
  log "warning: The assessment did not finish within $timeout_minutes minutes. It is still running: $dashboard"
  exit 2
fi

# The gate is NOT re-implemented here. The server returns gate.verdict already decided, and this
# switches on it exactly as ares-scan does; a script comparing severity counts itself would be a
# second gate that drifts from the one Ares shows.
verdict=$(jq -r '.gate.verdict // empty' "$tmp/status")
jq -r '.gate.summary // empty' "$tmp/status"
jq -r '.dashboard_url // empty' "$tmp/status"
case $verdict in
  passed | not_configured) exit 0 ;;
  failed)
    gate_failed=1
    exit 1
    ;;
  *)
    log "The assessment could not be judged."
    exit 2
    ;;
esac
