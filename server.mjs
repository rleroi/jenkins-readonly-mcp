#!/usr/bin/env node
// Read-only Jenkins MCP server. Only issues HTTP GET requests.
// Env: JENKINS_URL, JENKINS_USER, JENKINS_TOKEN (all required)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL_ENV = process.env.JENKINS_URL;
const USER = process.env.JENKINS_USER;
const TOKEN = process.env.JENKINS_TOKEN;
if (!URL_ENV || !USER || !TOKEN) {
  console.error("JENKINS_URL, JENKINS_USER and JENKINS_TOKEN are required");
  process.exit(1);
}
const BASE = URL_ENV.replace(/\/+$/, "");
const AUTH = "Basic " + Buffer.from(`${USER}:${TOKEN}`).toString("base64");

// "Folder/App/Build/main" -> "/job/Folder/job/App/job/Build/job/main"
// Segments already containing %XX (as returned by list_jobs) are kept as-is.
function jobUrl(path) {
  const segs = String(path || "").split("/").map((s) => s.trim()).filter(Boolean);
  if (segs.some((s) => s === "." || s === "..")) throw new Error("invalid job path");
  return segs.map((s) => "/job/" + (/%[0-9A-Fa-f]{2}/.test(s) ? s : encodeURIComponent(s))).join("");
}

async function get(urlPath, { text = false } = {}) {
  const res = await fetch(BASE + urlPath, {
    method: "GET",
    headers: { Authorization: AUTH, Accept: text ? "text/plain" : "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) throw new Error(`Not found: ${urlPath}`);
  if (!res.ok) throw new Error(`Jenkins ${res.status} ${res.statusText} for ${urlPath}`);
  return text ? res.text() : res.json();
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); } catch (e) { return fail(e); }
};

const BUILD_TREE =
  "number,result,building,timestamp,duration,displayName,url,description," +
  "actions[causes[shortDescription],lastBuiltRevision[branch[name]],parameters[name,value],failCount,totalCount,skipCount]," +
  "changeSet[items[author[fullName],msg,commitId]]";

function slimBuild(b) {
  if (!b) return null;
  const actions = b.actions || [];
  const tests = actions.find((a) => a.totalCount !== undefined);
  const causes = actions.flatMap((a) => (a.causes || []).map((c) => c.shortDescription));
  const params = actions.flatMap((a) => a.parameters || []).filter((p) => !/pass|token|secret|key/i.test(p.name));
  return {
    number: b.number,
    result: b.building ? "RUNNING" : b.result,
    started: iso(b.timestamp),
    durationSec: b.duration ? Math.round(b.duration / 1000) : null,
    url: b.url,
    cause: causes[0] || null,
    parameters: params.length ? Object.fromEntries(params.map((p) => [p.name, p.value])) : undefined,
    tests: tests ? { failed: tests.failCount, total: tests.totalCount, skipped: tests.skipCount } : undefined,
    commits: (b.changeSet?.items || []).slice(0, 10).map((c) => `${(c.commitId || "").slice(0, 8)} ${c.author?.fullName}: ${(c.msg || "").split("\n")[0]}`),
  };
}

const server = new McpServer({ name: "jenkins-readonly", version: "0.1.0" });
const pathArg = z.string().describe("Job path with slashes, e.g. 'MyFolder/MyApp/Build/main'");

server.tool(
  "list_jobs",
  "List jobs/folders at a path (empty path = root). Shows last build result per job. Multibranch projects list their branches.",
  { path: z.string().optional().describe("Folder path, e.g. 'MyFolder/MyApp/Build'. Empty = root") },
  wrap(async ({ path }) => {
    const d = await get(`${jobUrl(path)}/api/json?tree=jobs[name,_class,color,lastBuild[number,result,timestamp]]`);
    return (d.jobs || []).map((j) => ({
      name: j.name,
      type: j._class.split(".").pop(),
      status: j.color,
      lastBuild: j.lastBuild ? { number: j.lastBuild.number, result: j.lastBuild.result, at: iso(j.lastBuild.timestamp) } : null,
    }));
  })
);

server.tool(
  "get_latest_builds",
  "Latest N builds of a job (result, duration, cause, commits, test counts).",
  { path: pathArg, limit: z.number().int().min(1).max(50).default(5) },
  wrap(async ({ path, limit }) => {
    const d = await get(`${jobUrl(path)}/api/json?tree=builds[${BUILD_TREE}]{0,${limit}}`);
    return (d.builds || []).map(slimBuild);
  })
);

server.tool(
  "get_failed_builds",
  "Recent failed/unstable/aborted builds of a job (scans the last `scan` builds).",
  {
    path: pathArg,
    limit: z.number().int().min(1).max(30).default(5),
    scan: z.number().int().min(1).max(100).default(30),
    include_aborted: z.boolean().default(false),
  },
  wrap(async ({ path, limit, scan, include_aborted }) => {
    const d = await get(`${jobUrl(path)}/api/json?tree=builds[${BUILD_TREE}]{0,${scan}}`);
    const bad = new Set(["FAILURE", "UNSTABLE", ...(include_aborted ? ["ABORTED"] : [])]);
    return (d.builds || []).filter((b) => !b.building && bad.has(b.result)).slice(0, limit).map(slimBuild);
  })
);

server.tool(
  "get_build",
  "Details for one build. Omit number for lastBuild.",
  { path: pathArg, number: z.number().int().optional() },
  wrap(async ({ path, number }) => {
    const d = await get(`${jobUrl(path)}/${number ?? "lastBuild"}/api/json?tree=${BUILD_TREE}`);
    return slimBuild(d);
  })
);

server.tool(
  "get_test_report",
  "Failed tests of a build (JUnit report): suite, class, test name, error message, stack head. Omit number for lastBuild.",
  {
    path: pathArg,
    number: z.number().int().optional(),
    max_failures: z.number().int().min(1).max(200).default(50),
  },
  wrap(async ({ path, number, max_failures }) => {
    const base = `${jobUrl(path)}/${number ?? "lastBuild"}`;
    let d;
    try {
      d = await get(`${base}/testReport/api/json?tree=failCount,passCount,skipCount,duration,suites[name,cases[className,name,status,duration,errorDetails,errorStackTrace,age]]`);
    } catch (e) {
      if (String(e.message).startsWith("Not found")) return "No test report for this build (job publishes no JUnit results, or build did not reach tests).";
      throw e;
    }
    const failed = [];
    for (const s of d.suites || []) {
      for (const c of s.cases || []) {
        if (c.status === "FAILED" || c.status === "REGRESSION") {
          failed.push({
            suite: s.name,
            class: c.className,
            test: c.name,
            consecutiveFailures: c.age,
            error: (c.errorDetails || "").slice(0, 600),
            stackHead: (c.errorStackTrace || "").split("\n").slice(0, 6).join("\n"),
          });
        }
      }
    }
    return {
      passed: d.passCount, failed: d.failCount, skipped: d.skipCount,
      shown: Math.min(failed.length, max_failures),
      failures: failed.slice(0, max_failures),
    };
  })
);

server.tool(
  "get_console_tail",
  "Last N lines of a build's console log (to see why a build failed). Omit number for lastBuild.",
  { path: pathArg, number: z.number().int().optional(), lines: z.number().int().min(1).max(500).default(100) },
  wrap(async ({ path, number, lines }) => {
    const t = await get(`${jobUrl(path)}/${number ?? "lastBuild"}/consoleText`, { text: true });
    // Mask anything that looks like a credential before returning.
    return t.split("\n").slice(-lines).join("\n")
      .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1****");
  })
);

server.tool(
  "get_build_stages",
  "Pipeline stages of a build with status/duration; shows which stage failed. Omit number for lastBuild.",
  { path: pathArg, number: z.number().int().optional() },
  wrap(async ({ path, number }) => {
    const d = await get(`${jobUrl(path)}/${number ?? "lastBuild"}/wfapi/describe`);
    return {
      status: d.status,
      stages: (d.stages || []).map((s) => ({
        name: s.name, status: s.status, durationSec: Math.round((s.durationMillis || 0) / 1000),
        error: s.error?.message,
      })),
    };
  })
);

server.tool(
  "get_console_failures",
  "Grep a build's console for test/PHPUnit/Pest/Jest failures and errors, with context. Use when the pipeline has no JUnit report (get_test_report empty).",
  {
    path: pathArg,
    number: z.number().int().optional(),
    context: z.number().int().min(0).max(15).default(4).describe("Lines of context after each match"),
    max_matches: z.number().int().min(1).max(60).default(20),
    pattern: z.string().optional().describe("Custom JS regex (case-insensitive) replacing the default"),
  },
  wrap(async ({ path, number, context, max_matches, pattern }) => {
    const t = await get(`${jobUrl(path)}/${number ?? "lastBuild"}/consoleText`, { text: true });
    const lines = t.split("\n");
    const re = new RegExp(
      pattern ||
        "^\\s*(FAIL|FAILED|ERROR)\\b|^\\s*[✘✗⨯]|\\d+\\) .*Test|There (was|were) \\d+ (failure|error)|^Tests:.*(failed|error)|FAILURES!|Fatal error|Exception:|npm ERR!|Error:|✖|Build step .* failed|script returned exit code",
      "i"
    );
    const out = [];
    let skipUntil = -1;
    for (let i = 0; i < lines.length && out.length < max_matches; i++) {
      if (i < skipUntil || !re.test(lines[i])) continue;
      out.push({ line: i + 1, text: lines.slice(i, i + 1 + context).join("\n") });
      skipUntil = i + 1 + context;
    }
    const summary = lines.filter((l) => /^(Tests:|Tests run:|OK \(|FAILURES!|Time:)/.test(l.trim())).slice(-5);
    const masked = JSON.stringify({ totalLines: lines.length, summary, matches: out }, null, 2)
      .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)[^\s",\\]+/gi, "$1****");
    return masked;
  })
);

server.tool(
  "get_deploys",
  "Latest deploy builds for an app folder, per environment. Looks in <app>/{Acceptance,Staging,Production} for every job and reports its latest builds.",
  {
    app_path: z.string().describe("App folder, e.g. 'MyFolder/MyApp'"),
    environments: z.array(z.string()).default(["Acceptance", "Staging", "Production"]),
    limit: z.number().int().min(1).max(10).default(3),
  },
  wrap(async ({ app_path, environments, limit }) => {
    const out = {};
    for (const env of environments) {
      try {
        const d = await get(`${jobUrl(app_path + "/" + env)}/api/json?tree=jobs[name,_class,builds[${BUILD_TREE}]{0,${limit}}]`);
        out[env] = (d.jobs || [])
          .filter((j) => j.builds)
          .map((j) => ({ job: j.name, builds: j.builds.map(slimBuild) }));
      } catch (e) {
        out[env] = `n/a: ${e.message}`;
      }
    }
    return out;
  })
);

server.tool(
  "get_failing_overview",
  "Scan a folder tree for jobs whose last build is failing (red/unstable). Good first call: 'what is broken right now?'",
  {
    path: z.string().default("").describe("Folder to scan, e.g. 'MyFolder/MyApp'"),
    depth: z.number().int().min(1).max(4).default(3),
    include_branches: z.boolean().default(false).describe("Include multibranch branch jobs other than develop/master/acceptance/possible"),
  },
  wrap(async ({ path, depth, include_branches }) => {
    const found = [];
    const main = new Set(["develop", "master", "acceptance", "possible"]);
    async function walk(p, d) {
      const j = await get(`${jobUrl(p)}/api/json?tree=jobs[name,_class,color,lastBuild[number,result,timestamp]]`);
      for (const c of j.jobs || []) {
        const cp = p ? `${p}/${c.name}` : c.name;
        const type = c._class.split(".").pop();
        if (type === "Folder" || type === "WorkflowMultiBranchProject") {
          if (d < depth + (type === "WorkflowMultiBranchProject" ? 1 : 0)) await walk(cp, d + 1);
        } else if (["red", "yellow", "red_anime", "yellow_anime"].includes(c.color)) {
          const isBranch = p.split("/").length >= 1 && /\/Build$/.test(p);
          if (isBranch && !include_branches && !main.has(c.name)) continue;
          found.push({ job: cp, result: c.lastBuild?.result, build: c.lastBuild?.number, at: iso(c.lastBuild?.timestamp) });
        }
      }
    }
    await walk(path, 1);
    return found.length ? found : "Nothing failing in scanned scope.";
  })
);

await server.connect(new StdioServerTransport());
