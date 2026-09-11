#!/usr/bin/env node
"use strict";

// src/api.ts
var AresApiError = class extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.name = "AresApiError";
  }
  status;
  detail;
};
var AresClient = class {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }
  baseUrl;
  apiKey;
  async startRun(body) {
    return this.request("POST", "/api/v1/ci/runs", body);
  }
  async getRun(id) {
    return this.request("GET", `/api/v1/ci/runs/${encodeURIComponent(id)}`);
  }
  async request(method, path, body) {
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
      throw new AresApiError(res.status, detailOf(text) ?? `${res.status} ${res.statusText}`);
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
  if (!profileId && !targetId) {
    throw new Error("name what to assess: --profile <id>, or --target-id <id>");
  }
  if (profileId && targetId) {
    throw new Error("name either --profile or --target-id, not both");
  }
  const timeout = pick("timeout-minutes", "ARES_TIMEOUT_MINUTES");
  const poll2 = pick("poll-seconds", "ARES_POLL_SECONDS");
  return {
    baseUrl,
    apiKey,
    profileId,
    targetId,
    previewUrl: pick("preview-url", "ARES_PREVIEW_URL"),
    huntType: pick("hunt-type", "ARES_HUNT_TYPE"),
    intensity: pick("intensity", "ARES_INTENSITY"),
    failOn: pick("fail-on", "ARES_FAIL_ON"),
    timeoutMinutes: timeout ? Number(timeout) : void 0,
    pollSeconds: poll2 ? Number(poll2) : 30,
    noWait: (pick("no-wait", "ARES_NO_WAIT") ?? "false") === "true",
    // Provenance. Defaulted from whatever CI this is, so a customer's file does not have to
    // name six variables to get an attributable run.
    commitSha: pick("commit-sha", "GITHUB_SHA") ?? envVar("CI_COMMIT_SHA", env) ?? envVar("BUILD_SOURCEVERSION", env),
    ref: pick("ref", "GITHUB_REF") ?? envVar("CI_COMMIT_REF_NAME", env) ?? envVar("BUILD_SOURCEBRANCH", env),
    repository: pick("repository", "GITHUB_REPOSITORY") ?? envVar("CI_PROJECT_PATH", env) ?? envVar("BUILD_REPOSITORY_NAME", env),
    pipelineUrl: pick("pipeline-url", "ARES_PIPELINE_URL") ?? githubRunUrl(env) ?? envVar("CI_PIPELINE_URL", env)
  };
}
function githubRunUrl(env) {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const run = env.GITHUB_RUN_ID;
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : void 0;
}

// src/report.ts
var import_node_fs = require("node:fs");
var TIERS = ["critical", "high", "medium", "low", "info"];
function renderSummary(status) {
  const lines = [];
  lines.push("");
  lines.push(`Ares assessment of ${status.target_name ?? "your application"}`);
  lines.push(`  URL       ${status.target_url}${status.url_overridden ? "  (this run only)" : ""}`);
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
    `**Assessed:** ${status.target_url}${status.url_overridden ? " _(this run only)_" : ""}`,
    "",
    "| Severity | Count |",
    "| --- | --- |",
    rows,
    `| **total** | **${status.gate.total}** |`,
    "",
    `[Open the full assessment](${status.dashboard_url})`,
    ""
  ].join("\n");
  (0, import_node_fs.appendFileSync)(path, body);
}
function writeGitHubOutputs(status, env) {
  const path = env.GITHUB_OUTPUT;
  if (!path) return;
  const outputs = {
    "run-id": status.id,
    verdict: status.gate.verdict,
    "dashboard-url": status.dashboard_url,
    total: String(status.gate.total),
    ...Object.fromEntries(TIERS.map((t) => [`${t}-count`, String(status.gate.counts[t])]))
  };
  const body = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join("\n");
  (0, import_node_fs.appendFileSync)(path, `${body}
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
  const started = await client.startRun(launchBody(options));
  process.stdout.write(
    `Started an Ares assessment of ${started.target_name ?? started.target_id}
  assessing ${started.target_url}${started.url_overridden ? "  (this run only)" : ""}
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
function launchBody(options) {
  const body = {
    ci: {
      commit_sha: options.commitSha ?? null,
      ref: options.ref ?? null,
      repository: options.repository ?? null,
      pipeline_url: options.pipelineUrl ?? null
    }
  };
  if (options.profileId) body.profile_id = options.profileId;
  if (options.targetId) body.target_id = options.targetId;
  if (options.previewUrl) body.target_url_override = options.previewUrl;
  if (options.huntType) body.hunt_type = options.huntType;
  if (options.intensity) body.intensity = options.intensity;
  if (options.failOn) body.gate = { rules: parseFailOn(options.failOn) };
  return body;
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
  if (error instanceof AresApiError) {
    annotate("error", `Ares refused the request (${error.status}): ${error.detail}`, process.env);
  } else {
    annotate("error", error instanceof Error ? error.message : String(error), process.env);
  }
  process.exit(EXIT_ERROR);
});
