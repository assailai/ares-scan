#!/usr/bin/env node
"use strict";

// src/api.ts
var AresApiError = class extends Error {
  status;
  constructor({ action, status, detail }) {
    super(`Ares ${status >= 500 ? "could not" : "refused to"} ${action} (${status}): ${detail}`);
    this.name = "AresApiError";
    this.status = status;
  }
};
var AresClient = class {
  baseUrl;
  apiKey;
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }
  async requestUploadUrl({
    fileName,
    artifactKind
  }) {
    return this.request({
      action: "sign the build upload",
      method: "POST",
      path: "/api/v1/artifacts/upload-url",
      body: {
        file_name: fileName,
        artifact_kind: artifactKind,
        // Signed into the policy and handed back among `fields`, so the store records exactly this.
        // A build is opaque bytes to the store whatever its kind; nothing downstream reads it.
        content_type: "application/octet-stream"
      }
    });
  }
  async commitArtifact(body) {
    return this.request({ action: "record the build", method: "POST", path: "/api/v1/artifacts", body });
  }
  async startRun(body) {
    return this.request({ action: "start the assessment", method: "POST", path: "/api/v1/ci/runs", body });
  }
  async getRun(id) {
    return this.request({
      action: "report the assessment's progress",
      method: "GET",
      path: `/api/v1/ci/runs/${encodeURIComponent(id)}`
    });
  }
  /** One call. `action` is what it asks of Ares, in the words an error names it: "record the build". */
  async request({
    action,
    method,
    path,
    body
  }) {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...body === void 0 ? {} : { "Content-Type": "application/json" }
      },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = detailOf(text) ?? (res.statusText || "no reason given");
      throw new AresApiError({ action, status: res.status, detail });
    }
    return JSON.parse(text);
  }
};
function detailOf(body) {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.detail === "string") return parsed.detail;
    if (Array.isArray(parsed.detail)) {
      return parsed.detail.map((e) => typeof e === "object" && e && "msg" in e ? String(e.msg) : String(e)).join("; ");
    }
    return null;
  } catch {
    return body.slice(0, 500) || null;
  }
}

// src/upload.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var KIND_BY_EXTENSION = [
  [".apk", "android_apk"],
  [".aab", "android_aab"],
  [".ipa", "ios_ipa"]
];
function buildKindOf(path) {
  const name = (0, import_node_path.basename)(path).toLowerCase();
  const match = KIND_BY_EXTENSION.find(([extension]) => name.endsWith(extension));
  if (!match) {
    throw new Error(
      `"${(0, import_node_path.basename)(path)}" is not a build Ares can assess. Point --build at an Android .apk or .aab, or an iOS .ipa.`
    );
  }
  return match[1];
}
async function uploadBuild({ client, build }) {
  const fileName = (0, import_node_path.basename)(build.path);
  const sha256 = await sha256Of(build.path);
  const upload = await client.requestUploadUrl({ fileName, artifactKind: build.kind });
  await postToStorage({ upload, path: build.path, fileName });
  return client.commitArtifact({
    artifact_kind: build.kind,
    name: build.name ?? fileName,
    file_name: fileName,
    s3_bucket: upload.s3_bucket,
    s3_key: upload.s3_key,
    target_id: build.targetId,
    sha256,
    ...build.version ? { version: build.version } : {},
    // Current, because the pipeline that uploaded a build is asking for THAT build to be the one
    // assessed from now on. The run below still names the build by id rather than trusting this,
    // so a second pipeline uploading in the same minute cannot swap what this one is judged on.
    make_current: true
  });
}
async function sha256Of(path) {
  const hash = (0, import_node_crypto.createHash)("sha256");
  try {
    for await (const chunk of (0, import_node_fs.createReadStream)(path)) hash.update(chunk);
  } catch (error) {
    throw unreadable(path, error);
  }
  return hash.digest("hex");
}
async function postToStorage({
  upload,
  path,
  fileName
}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
  let file;
  try {
    file = await (0, import_node_fs.openAsBlob)(path);
  } catch (error) {
    throw unreadable(path, error);
  }
  form.append("file", file, fileName);
  const res = await fetch(upload.url, { method: upload.method, body: form });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `object storage refused the build upload (${res.status}): ${storageErrorOf(text) ?? res.statusText}`
    );
  }
}
function storageErrorOf(body) {
  const code = xmlText(body, "Code");
  const message = xmlText(body, "Message");
  if (code && message) return `${code}: ${message}`;
  if (code || message) return code ?? message;
  return body.trim().slice(0, 500) || null;
}
function xmlText(body, element) {
  const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(body);
  if (!match) return null;
  return match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function unreadable(path, error) {
  const code = error?.code;
  if (code === "ENOENT") {
    return new Error(`there is no build at ${path}. Check the path the build step wrote it to.`);
  }
  if (code === "EISDIR") {
    return new Error(`${path} is a directory. Point --build at the .apk, .aab or .ipa file itself.`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `cannot read the build at ${path}: permission denied. The ares-scan container runs as the "node" user, so the file must be readable by it (world-readable is enough).`
    );
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`cannot read the build at ${path}: ${reason}`);
}

// src/options.ts
var METRICS = /* @__PURE__ */ new Set(["critical", "high", "medium", "low", "info", "total"]);
function parseFailOn(raw) {
  const rules = [];
  for (const piece of raw.split(",")) {
    const token = piece.trim();
    if (!token) continue;
    const match = /^([a-z_]+)\s*(>=|>)\s*(\d+)$/i.exec(token);
    if (!match) {
      throw new Error(
        `cannot read the gate rule "${token}". Write it as metric>threshold, for example "critical>0" or "high>=2", separating several with commas.`
      );
    }
    const metric = match[1].toLowerCase();
    if (!METRICS.has(metric)) {
      throw new Error(
        `"${metric}" is not something a gate can count. Use one of: ${[...METRICS].join(", ")}.`
      );
    }
    rules.push({
      metric,
      comparator: match[2] === ">=" ? "gte" : "gt",
      threshold: Number(match[3])
    });
  }
  return rules;
}
var ANALYSIS_TYPES = ["sast", "dast"];
function parseAnalysis(raw) {
  const picked = [];
  for (const piece of raw.split(",")) {
    const token = piece.trim().toLowerCase();
    if (!token) continue;
    const type = ANALYSIS_TYPES.find((t) => t === token);
    if (!type) {
      throw new Error(
        `"${token}" is not an analysis Ares runs on a build. Use ${ANALYSIS_TYPES.join(", ")}, or both separated by a comma.`
      );
    }
    if (!picked.includes(type)) picked.push(type);
  }
  if (picked.length === 0) {
    throw new Error(`--analysis names nothing to run. Use ${ANALYSIS_TYPES.join(", ")}, or both.`);
  }
  return picked;
}
function readSwitch(name, raw) {
  if (raw === void 0) return false;
  const value = raw.toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`--${name} is on or off: write true or false, not "${raw}"`);
}
function readBuild({
  path,
  pick,
  targetId,
  previewUrl,
  huntType
}) {
  if (!targetId) {
    throw new Error("--build needs --target-id: name the mobile target this build belongs to");
  }
  if (previewUrl) {
    throw new Error(
      "--preview-url assesses a deployed address, and a mobile build has none. Drop it, or assess the build and the deployed environment in two separate steps."
    );
  }
  if (huntType && huntType !== "mobile") {
    throw new Error(
      `--build uploads a mobile build, which is assessed as --hunt-type mobile, not ${huntType}`
    );
  }
  return {
    path,
    kind: buildKindOf(path),
    targetId,
    name: pick("build-name", "ARES_BUILD_NAME"),
    version: pick("build-version", "ARES_BUILD_VERSION")
  };
}
function refuseRunWithoutBuild({
  pick,
  profileId,
  targetId,
  uploadOnly
}) {
  if (!profileId && !targetId) {
    throw new Error("name what to assess: --profile <id>, or --target-id <id>");
  }
  if (profileId && targetId) {
    throw new Error("name either --profile or --target-id, not both");
  }
  if (uploadOnly) {
    throw new Error("--upload-only uploads a build; name the file with --build");
  }
  if (pick("build-name", "ARES_BUILD_NAME") || pick("build-version", "ARES_BUILD_VERSION")) {
    throw new Error(
      "--build-name and --build-version describe an uploaded build; name the file with --build"
    );
  }
}
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== void 0) {
      out[name] = inline;
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[name] = argv[i + 1];
      i += 1;
    } else {
      out[name] = "true";
    }
  }
  return out;
}
function githubInput(name, env) {
  const value = env[`INPUT_${name.toUpperCase()}`];
  return value && value.trim() ? value.trim() : void 0;
}
function envVar(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : void 0;
}
function readOptions(argv, env) {
  const flags = parseArgv(argv);
  const pick = (flag, envName) => flags[flag]?.trim() || githubInput(flag, env) || envVar(envName, env);
  const baseUrl = pick("ares-url", "ARES_URL");
  const apiKey = pick("api-key", "ARES_API_KEY");
  if (!baseUrl) throw new Error("set --ares-url (or ARES_URL) to your Ares instance");
  if (!apiKey) throw new Error("set --api-key (or the ARES_API_KEY secret)");
  const profileId = pick("profile", "ARES_PROFILE_ID");
  const targetId = pick("target-id", "ARES_TARGET_ID");
  const previewUrl = pick("preview-url", "ARES_PREVIEW_URL");
  const failOn = pick("fail-on", "ARES_FAIL_ON");
  const buildPath = pick("build", "ARES_BUILD");
  const uploadOnly = readSwitch("upload-only", pick("upload-only", "ARES_UPLOAD_ONLY"));
  const rawAnalysis = pick("analysis", "ARES_ANALYSIS");
  const analysisTypes = rawAnalysis === void 0 ? void 0 : parseAnalysis(rawAnalysis);
  const requestedHuntType = pick("hunt-type", "ARES_HUNT_TYPE");
  const build = buildPath ? readBuild({ path: buildPath, pick, targetId, previewUrl, huntType: requestedHuntType }) : void 0;
  if (!build) refuseRunWithoutBuild({ pick, profileId, targetId, uploadOnly });
  const huntType = build ? "mobile" : requestedHuntType;
  if (analysisTypes && huntType && huntType !== "mobile") {
    throw new Error(
      `--analysis chooses what a mobile assessment runs, and this is --hunt-type ${huntType}`
    );
  }
  if (uploadOnly && (analysisTypes || failOn)) {
    throw new Error(
      `--upload-only starts no assessment, so ${analysisTypes ? "--analysis" : "--fail-on"} would never apply. Drop one or the other.`
    );
  }
  const timeout = pick("timeout-minutes", "ARES_TIMEOUT_MINUTES");
  const poll2 = pick("poll-seconds", "ARES_POLL_SECONDS");
  return {
    baseUrl,
    apiKey,
    profileId,
    targetId,
    previewUrl,
    huntType,
    intensity: pick("intensity", "ARES_INTENSITY"),
    failOn,
    timeoutMinutes: timeout ? Number(timeout) : void 0,
    pollSeconds: poll2 ? Number(poll2) : 30,
    noWait: (pick("no-wait", "ARES_NO_WAIT") ?? "false") === "true",
    // Provenance. Defaulted from whatever CI this is, so a customer's file does not have to
    // name six variables to get an attributable run.
    commitSha: pick("commit-sha", "GITHUB_SHA") ?? envVar("CI_COMMIT_SHA", env) ?? envVar("BUILD_SOURCEVERSION", env),
    ref: pick("ref", "GITHUB_REF") ?? envVar("CI_COMMIT_REF_NAME", env) ?? envVar("BUILD_SOURCEBRANCH", env),
    repository: pick("repository", "GITHUB_REPOSITORY") ?? envVar("CI_PROJECT_PATH", env) ?? envVar("BUILD_REPOSITORY_NAME", env),
    pipelineUrl: pick("pipeline-url", "ARES_PIPELINE_URL") ?? githubRunUrl(env) ?? envVar("CI_PIPELINE_URL", env),
    build,
    analysisTypes,
    uploadOnly
  };
}
function githubRunUrl(env) {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const run = env.GITHUB_RUN_ID;
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : void 0;
}

// src/report.ts
var import_node_fs2 = require("node:fs");
var TIERS = ["critical", "high", "medium", "low", "info"];
function renderSummary(status) {
  const lines = [];
  lines.push("");
  lines.push(`Ares assessment of ${status.target_name ?? "your application"}`);
  if (status.target_url) {
    lines.push(`  URL       ${status.target_url}${status.url_overridden ? "  (this run only)" : ""}`);
  }
  lines.push(`  Status    ${status.status}`);
  if (status.failure_reason) lines.push(`  Reason    ${status.failure_reason}`);
  lines.push(`  Findings  ${severityLine(status.gate.counts)}`);
  if (status.detected_total !== status.gate.total) {
    lines.push(
      `            ${status.detected_total} detected in total; the gate counted ${status.gate.total} (${status.gate.counted === "open" ? "open only" : "all"}).`
    );
  }
  lines.push(`  Gate      ${status.gate.summary}`);
  lines.push(`  Details   ${status.dashboard_url}`);
  lines.push("");
  return lines.join("\n");
}
function renderBuild(artifact) {
  const lines = [
    `Uploaded ${artifact.name}`,
    `  Build     ${artifact.id}`,
    `  Package   ${artifact.package_id ?? "not read from the build"}`,
    `  Version   ${artifact.version ?? "not recorded"}`,
    `  Affirmed  ${artifact.attack_affirmed ? "yes, authorized for assessment" : "NO, not authorized for assessment"}`,
    ""
  ];
  return lines.join("\n");
}
function severityLine(counts) {
  const parts = TIERS.filter((t) => counts[t] > 0).map((t) => `${counts[t]} ${t}`);
  return parts.length ? parts.join(", ") : "none";
}
function writeGitHubSummary(status, env) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const icon = status.gate.verdict === "passed" || status.gate.verdict === "not_configured" ? "&#9989;" : status.gate.verdict === "inconclusive" ? "&#9888;&#65039;" : "&#10060;";
  const rows = TIERS.map((t) => `| ${t} | ${status.gate.counts[t]} |`).join("\n");
  const body = [
    `## ${icon} Ares security assessment`,
    "",
    status.gate.summary,
    "",
    ...status.target_url ? [`**Assessed:** ${status.target_url}${status.url_overridden ? " _(this run only)_" : ""}`, ""] : [],
    "| Severity | Count |",
    "| --- | --- |",
    rows,
    `| **total** | **${status.gate.total}** |`,
    "",
    `[Open the full assessment](${status.dashboard_url})`,
    ""
  ].join("\n");
  (0, import_node_fs2.appendFileSync)(path, body);
}
function writeGitHubOutputs(status, env) {
  writeGitHubOutput(
    {
      "run-id": status.id,
      verdict: status.gate.verdict,
      "dashboard-url": status.dashboard_url,
      total: String(status.gate.total),
      ...Object.fromEntries(TIERS.map((t) => [`${t}-count`, String(status.gate.counts[t])]))
    },
    env
  );
}
function writeGitHubOutput(outputs, env) {
  const path = env.GITHUB_OUTPUT;
  if (!path) return;
  const body = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join("\n");
  (0, import_node_fs2.appendFileSync)(path, `${body}
`);
}
function annotate(level, message, env) {
  if (env.GITHUB_ACTIONS === "true") {
    process.stdout.write(`::${level}::${message}
`);
    return;
  }
  process.stdout.write(`${level}: ${message}
`);
}

// src/index.ts
var MAX_CONSECUTIVE_POLL_FAILURES = 5;
var EXIT_OK = 0;
var EXIT_GATE_FAILED = 1;
var EXIT_ERROR = 2;
async function main() {
  const env = process.env;
  const options = readOptions(process.argv.slice(2), env);
  const client = new AresClient(options.baseUrl, options.apiKey);
  let artifact;
  if (options.build) {
    process.stdout.write(`Uploading ${options.build.path}
`);
    artifact = await uploadBuild({ client, build: options.build });
    process.stdout.write(renderBuild(artifact));
    writeGitHubOutput({ "artifact-id": artifact.id }, env);
    const stop = exitAfterUpload({ artifact, uploadOnly: options.uploadOnly, env });
    if (stop !== void 0) return stop;
  }
  const started = await client.startRun(launchBody(options, artifact));
  if (artifact && started.artifact_id !== artifact.id) {
    annotate(
      "error",
      `Ares started ${started.dashboard_url} but did not confirm it assesses the build this pipeline uploaded (asked for ${artifact.id}, got ${started.artifact_id ?? "none"}). Not judging this build on it.`,
      env
    );
    return EXIT_ERROR;
  }
  process.stdout.write(
    `Started an Ares assessment of ${started.target_name ?? started.target_id}
  assessing ${subjectOf(started, artifact)}
  ${started.dashboard_url}
`
  );
  if (options.noWait) {
    process.stdout.write("Not waiting for the result (--no-wait).\n");
    return EXIT_OK;
  }
  const budgetMinutes = options.timeoutMinutes ?? started.timeout_minutes;
  const status = await poll(client, started.id, options.pollSeconds, budgetMinutes);
  if (status === null) {
    annotate(
      "warning",
      `The assessment did not finish within ${budgetMinutes} minutes. It is still running: ${started.dashboard_url}`,
      env
    );
    return EXIT_ERROR;
  }
  process.stdout.write(renderSummary(status));
  writeGitHubSummary(status, env);
  writeGitHubOutputs(status, env);
  switch (status.gate.verdict) {
    case "passed":
    case "not_configured":
      return EXIT_OK;
    case "failed":
      annotate("error", status.gate.summary, env);
      return EXIT_GATE_FAILED;
    default:
      annotate("warning", status.gate.summary, env);
      return EXIT_ERROR;
  }
}
var BUILD_NOT_AFFIRMED = 'The build was uploaded, but it is not authorized for assessment: this API key was minted without build attestation. Mint a key with "I own the mobile apps this key will upload" ticked in Settings > CI/CD, or affirm the build in Ares.';
var BUILD_NOT_CURRENT = "Ares recorded the build but did not make it the target's current build, so this Ares is probably older than ares-scan 1.1.0. Nothing was assessed.";
function exitAfterUpload({
  artifact,
  uploadOnly,
  env
}) {
  if (!artifact.in_use) {
    annotate("error", BUILD_NOT_CURRENT, env);
    return EXIT_ERROR;
  }
  if (!artifact.attack_affirmed && !uploadOnly) {
    annotate("error", `${BUILD_NOT_AFFIRMED} No assessment was started.`, env);
    return EXIT_ERROR;
  }
  if (!artifact.attack_affirmed) annotate("warning", BUILD_NOT_AFFIRMED, env);
  if (!uploadOnly) return void 0;
  process.stdout.write("Uploaded only; no assessment was started (--upload-only).\n");
  return EXIT_OK;
}
function launchBody(options, artifact) {
  const body = {
    ci: {
      commit_sha: options.commitSha ?? null,
      ref: options.ref ?? null,
      repository: options.repository ?? null,
      pipeline_url: options.pipelineUrl ?? null
    }
  };
  if (options.profileId) body.profile_id = options.profileId;
  else if (options.targetId) body.target_id = options.targetId;
  if (options.previewUrl) body.target_url_override = options.previewUrl;
  if (options.huntType) body.hunt_type = options.huntType;
  if (options.intensity) body.intensity = options.intensity;
  if (options.failOn) body.gate = { rules: parseFailOn(options.failOn) };
  if (artifact) body.artifact_id = artifact.id;
  if (options.analysisTypes) body.analysis_types = options.analysisTypes;
  return body;
}
function subjectOf(started, artifact) {
  if (artifact) return `the build uploaded above, ${artifact.name} (${artifact.id})`;
  return `${started.target_url}${started.url_overridden ? "  (this run only)" : ""}`;
}
async function poll(client, id, pollSeconds, budgetMinutes) {
  const deadline = Date.now() + budgetMinutes * 6e4;
  let last = "";
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await client.getRun(id);
      consecutiveFailures = 0;
    } catch (error) {
      if (error instanceof AresApiError && error.status < 500) throw error;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
      await sleep(pollSeconds * 1e3);
      continue;
    }
    const phase = status.current_phase ? `${status.status} / ${status.current_phase}` : status.status;
    if (phase !== last) {
      process.stdout.write(`  ${phase}
`);
      last = phase;
    }
    if (status.is_terminal) return status;
    await sleep(pollSeconds * 1e3);
  }
  return null;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
main().then((code) => process.exit(code)).catch((error) => {
  annotate("error", error instanceof Error ? error.message : String(error), process.env);
  process.exit(EXIT_ERROR);
});
