'use strict';

// lema verify — the GitHub Action ("description check").
//
// This file is a deliberately dumb pipe: it contains ZERO judgment logic —
// no thresholds, no label mapping, no rendering beyond posting the server's
// own markdown verbatim. See docs/design/lema-verify/design-lock.md
// ("No judgment logic, rendering, thresholds, or label mapping in the OSS
// Action") and product-spec.md. Every failure path exits 0 — a broken
// verify service must never break anyone's CI.
//
// Wire contract source of truth: apps/api/internal/api/verify.go
// (verifyRequest / verifyResponse). Field names below are mirrored
// byte-for-byte from that file's JSON tags.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SCHEMA_VERSION = 1;
const DIFF_BYTE_CAP = 900000;
const OIDC_AUDIENCE = 'lema-verify';
const UPSERT_MARKER = '<!-- lema-verify -->';
const TASK_FILE_PATH = '.lema/task.json';

// ---- entry point --------------------------------------------------------

async function main() {
  const result = await runWith(process.env, fetch, { execFileSync }, fs);
  process.exitCode = result.exitCode;
}

// ---- core, testable seam ------------------------------------------------
//
// runWith(env, fetchImpl, execImpl, fsImpl) never throws and never sets a
// non-zero exit code: every failure path is caught, produces a step-summary
// note, and returns exitCode: 0. execImpl is an object exposing
// execFileSync(cmd, args) -> string, matching node:child_process's shape
// (so real usage can pass the module directly, since it already has that
// method).
async function runWith(env, fetchImpl, execImpl, fsImpl) {
  const summaryPath = env.GITHUB_STEP_SUMMARY;

  function notRun(reason) {
    writeStepSummaryNote(fsImpl, summaryPath, reason);
    return { exitCode: 0, commentPosted: false, reason };
  }

  try {
    // (0) Required env / inputs.
    const apiUrl = trimTrailingSlash(env.INPUT_API_URL || env['INPUT_API-URL'] || '');
    if (!apiUrl) return notRun('api-url input missing');

    const eventPath = env.GITHUB_EVENT_PATH;
    if (!eventPath) return notRun('GITHUB_EVENT_PATH missing');

    const oidcURL = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const oidcToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!oidcURL || !oidcToken) return notRun('OIDC environment missing (id-token: write permission not granted?)');

    // GitHub does not inject GITHUB_TOKEN as a default env var for an
    // Action's process — it must be wired explicitly as an input. Inputs
    // surface as INPUT_<NAME> (uppercased, hyphens preserved), so the
    // `github-token` input lands in `INPUT_GITHUB-TOKEN`. Falls back to a
    // bare GITHUB_TOKEN env var so unit tests (which set env vars directly,
    // not via the INPUT_* convention) keep working unchanged.
    const githubToken = env['INPUT_GITHUB-TOKEN'] || env.GITHUB_TOKEN;
    if (!githubToken) return notRun('GITHUB_TOKEN missing');

    const githubApiUrl = trimTrailingSlash(env.GITHUB_API_URL || 'https://api.github.com');
    const repoFull = env.GITHUB_REPOSITORY || '';
    if (!repoFull || !repoFull.includes('/')) return notRun('GITHUB_REPOSITORY missing or malformed');

    // (1) Event payload -> PR number / body / base / head.
    let event;
    try {
      event = JSON.parse(fsImpl.readFileSync(eventPath, 'utf8'));
    } catch (err) {
      return notRun('could not read/parse GITHUB_EVENT_PATH');
    }
    const pr = event && event.pull_request;
    if (!pr || typeof pr.number !== 'number') {
      return notRun('event payload has no pull_request');
    }
    const prNumber = pr.number;
    const headRef = pr.head && pr.head.ref ? pr.head.ref : '';
    const headSHA = pr.head && pr.head.sha ? pr.head.sha : '';
    const baseRef = pr.base && pr.base.ref ? pr.base.ref : '';
    const description = typeof pr.body === 'string' ? pr.body : '';

    // (2) git diff --merge-base origin/<base> HEAD, capped at 900_000
    // bytes, plus git diff --numstat (uncapped, full manifest always sent).
    let rawDiff = '';
    let rawNumstat = '';
    try {
      rawDiff = execImpl.execFileSync(
        'git',
        ['diff', '--merge-base', `origin/${baseRef}`, 'HEAD'],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
      );
    } catch (err) {
      return notRun('git diff failed');
    }
    try {
      rawNumstat = execImpl.execFileSync(
        'git',
        ['diff', '--merge-base', `origin/${baseRef}`, 'HEAD', '--numstat'],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
      );
    } catch (err) {
      return notRun('git diff --numstat failed');
    }

    const diff = capDiff(rawDiff, DIFF_BYTE_CAP);
    const numstat = parseNumstat(rawNumstat);

    // (3) .lema/task.json — included only when branch matches head ref
    // exactly.
    const taskFile = readTaskFile(fsImpl, TASK_FILE_PATH, headRef);

    // (4) OIDC: request token with audience=lema-verify.
    let idToken;
    try {
      idToken = await fetchOIDCToken(fetchImpl, oidcURL, oidcToken, OIDC_AUDIENCE);
    } catch (err) {
      return notRun('failed to obtain OIDC token');
    }
    if (!idToken) return notRun('OIDC token request returned no value');

    // (4b) Settles consent (WP5, verify-standalone): the committed
    // `record-decisions: true` line in the calling workflow IS the consent —
    // forwarded faithfully, and only the exact string 'true' reads as yes.
    const recordDecisions = (env['INPUT_RECORD-DECISIONS'] || '') === 'true';

    // (5) POST /verify.
    const body = {
      schema_version: SCHEMA_VERSION,
      pr_number: prNumber,
      intent: { source: 'description', text: description },
      diff,
      numstat,
      task_file: taskFile,
      head_ref: headRef,
      record_decisions: recordDecisions,
    };

    let verifyResp;
    try {
      verifyResp = await postJSON(fetchImpl, `${apiUrl}/verify`, body, {
        Authorization: `Bearer ${idToken}`,
      });
    } catch (err) {
      return notRun('request to verify service failed (network error or timeout)');
    }

    if (!verifyResp || verifyResp.status >= 400) {
      const status = verifyResp ? verifyResp.status : 'no response';
      return notRun(`verify service returned ${status}`);
    }

    let payload;
    try {
      payload = await verifyResp.json();
    } catch (err) {
      return notRun('verify service returned malformed JSON');
    }

    if (!payload || payload.card_state === 'error' || !payload.markdown) {
      return notRun('verify service returned no result');
    }

    const markdown = payload.markdown;

    // (6) Upsert PR comment, write step summary.
    const [owner, repoName] = repoFull.split('/');
    try {
      await upsertComment(fetchImpl, {
        githubApiUrl,
        githubToken,
        owner,
        repo: repoName,
        prNumber,
        marker: UPSERT_MARKER,
        body: markdown,
      });
    } catch (err) {
      // Posting failed after we had a valid card. Still exit 0 (hard rule:
      // ALWAYS exit 0), but this is not the "not run" path — we did have a
      // result, we just couldn't post it. Record a note either way.
      return notRun('failed to post PR comment');
    }

    // (7) Check run (Rung 2): the server's `check` payload is forwarded
    // VERBATIM to the check-runs API — name/title/summary/conclusion and
    // annotations are all server-owned strings (dumb-pipe law; the server
    // even pre-caps annotations at GitHub's per-request limit). Best-effort:
    // a failure here (a fork PR's read-only GITHUB_TOKEN, a workflow missing
    // `checks: write`) notes it in the step summary and NEVER affects the
    // already-posted comment or the exit code.
    let checkPosted = false;
    if (payload.check && typeof payload.check === 'object' && headSHA) {
      try {
        await postCheckRun(fetchImpl, {
          githubApiUrl,
          githubToken,
          owner,
          repo: repoName,
          headSHA,
          check: payload.check,
        });
        checkPosted = true;
      } catch (err) {
        // NOT writeStepSummaryNote: that helper wraps its reason in the
        // "description check: not run (...)" template, which would falsely
        // report a run that DID run and DID comment (review finding on
        // #383). This is a degrade note, not a not-run note.
        appendStepSummaryLine(fsImpl, summaryPath, 'check run not posted (checks: write permission missing?); PR comment posted');
      }
    }

    writeStepSummaryFromMarkdown(fsImpl, summaryPath, markdown);
    return { exitCode: 0, commentPosted: true, checkPosted };
  } catch (err) {
    // Belt-and-braces: any unexpected exception still exits 0.
    return notRun('unexpected error');
  }
}

// ---- helpers -------------------------------------------------------------

function trimTrailingSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

// capDiff truncates the raw diff at DIFF_BYTE_CAP bytes. Tries to cut at a
// hunk boundary ("\ndiff --git ") at or before the cap when one exists
// trivially; otherwise a hard byte cap.
function capDiff(raw, capBytes) {
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length <= capBytes) return raw;

  const truncated = buf.subarray(0, capBytes);
  const truncatedStr = truncated.toString('utf8');
  const lastHunk = truncatedStr.lastIndexOf('\ndiff --git ');
  if (lastHunk > 0) {
    return truncatedStr.slice(0, lastHunk + 1);
  }
  return truncatedStr;
}

// parseNumstat parses `git diff --numstat` output into the wire's numstat
// array. Binary files report "-" for adds/dels; represented as 0 (there is
// no judgment call here — the server only sees adds/dels ints per the wire
// contract, so binary changes surface as a zero-line-delta file, still
// present in the manifest via its path).
function parseNumstat(raw) {
  const out = [];
  const lines = String(raw || '').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addsRaw, delsRaw, ...pathParts] = parts;
    const filePath = pathParts.join('\t');
    out.push({
      path: filePath,
      adds: addsRaw === '-' ? 0 : parseInt(addsRaw, 10) || 0,
      dels: delsRaw === '-' ? 0 : parseInt(delsRaw, 10) || 0,
    });
  }
  return out;
}

// readTaskFile reads .lema/task.json if present, returning it only when its
// branch equals headRef exactly (server-side wire field: {task, branch}).
function readTaskFile(fsImpl, taskFilePath, headRef) {
  let raw;
  try {
    raw = fsImpl.readFileSync(taskFilePath, 'utf8');
  } catch (err) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed.branch !== 'string' || typeof parsed.task !== 'string') {
    return null;
  }
  if (parsed.branch !== headRef) return null;
  return { task: parsed.task, branch: parsed.branch };
}

async function fetchOIDCToken(fetchImpl, oidcURL, oidcToken, audience) {
  const url = `${oidcURL}${oidcURL.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;
  const resp = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${oidcToken}`, Accept: 'application/json' },
  });
  if (!resp || resp.status >= 400) {
    throw new Error('oidc token request failed');
  }
  const data = await resp.json();
  return data && data.value;
}

async function postJSON(fetchImpl, url, body, extraHeaders) {
  return fetchImpl(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: JSON.stringify(body),
  });
}

// upsertComment lists existing PR comments (paginated), finds one whose
// body contains marker, and PATCHes it; otherwise POSTs a new one. Never
// posts a second marker comment.
async function upsertComment(fetchImpl, { githubApiUrl, githubToken, owner, repo, prNumber, marker, body }) {
  const existing = await findExistingComment(fetchImpl, { githubApiUrl, githubToken, owner, repo, prNumber, marker });

  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  if (existing) {
    const url = `${githubApiUrl}/repos/${owner}/${repo}/issues/comments/${existing.id}`;
    const resp = await fetchImpl(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!resp || resp.status >= 400) throw new Error('PATCH comment failed');
    return;
  }

  const url = `${githubApiUrl}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
  });
  if (!resp || resp.status >= 400) throw new Error('POST comment failed');
}

// postCheckRun POSTs one completed check run against the PR's head SHA. The
// server's check payload supplies every string and the conclusion; the only
// fields composed here are the mechanical ones (head_sha, status). The
// annotations array is included only when non-empty — GitHub rejects an
// empty-but-present list on some API versions, and the server already caps
// its length.
async function postCheckRun(fetchImpl, { githubApiUrl, githubToken, owner, repo, headSHA, check }) {
  const output = { title: check.title, summary: check.summary };
  if (Array.isArray(check.annotations) && check.annotations.length > 0) {
    output.annotations = check.annotations;
  }
  const body = {
    name: check.name,
    head_sha: headSHA,
    status: 'completed',
    conclusion: check.conclusion,
    output,
  };
  const resp = await fetchImpl(`${githubApiUrl}/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp || resp.status >= 400) throw new Error('POST check-run failed');
}

// findExistingComment paginates GET /repos/{owner}/{repo}/issues/{n}/comments
// looking for a comment body containing marker.
async function findExistingComment(fetchImpl, { githubApiUrl, githubToken, owner, repo, prNumber, marker }) {
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
  };
  let page = 1;
  const perPage = 100;
  while (true) {
    const url = `${githubApiUrl}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`;
    const resp = await fetchImpl(url, { method: 'GET', headers });
    if (!resp || resp.status >= 400) throw new Error('GET comments failed');
    const list = await resp.json();
    if (!Array.isArray(list) || list.length === 0) return null;
    const found = list.find((c) => typeof c.body === 'string' && c.body.includes(marker));
    if (found) return found;
    if (list.length < perPage) return null;
    page += 1;
  }
}

// writeStepSummaryNote writes the fixed not-run note (dumb-pipe compliant:
// no composing text from counts).
function writeStepSummaryNote(fsImpl, summaryPath, reason) {
  appendStepSummaryLine(fsImpl, summaryPath, `description check: not run (${reason})`);
}

// appendStepSummaryLine appends one raw line to the step summary — used for
// notes that must NOT claim the check didn't run (e.g. the check-run degrade
// path, where the verify call and the comment both succeeded).
function appendStepSummaryLine(fsImpl, summaryPath, line) {
  if (!summaryPath) return;
  try {
    fsImpl.appendFileSync(summaryPath, `${line}\n`);
  } catch (err) {
    // Nothing more we can do; never throw from a summary write.
  }
}

// writeStepSummaryFromMarkdown extracts the FIRST non-empty line after the
// UPSERT_MARKER line and writes exactly that (mechanical extraction, no
// composing text from counts).
function writeStepSummaryFromMarkdown(fsImpl, summaryPath, markdown) {
  if (!summaryPath) return;
  const lines = String(markdown).split('\n');
  const markerIdx = lines.findIndex((l) => l.trim() === UPSERT_MARKER);
  let line = '';
  if (markerIdx >= 0) {
    for (let i = markerIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() !== '') {
        line = lines[i];
        break;
      }
    }
  }
  try {
    fsImpl.appendFileSync(summaryPath, `${line}\n`);
  } catch (err) {
    // Never throw from a summary write.
  }
}

// ---- module exports / script entry --------------------------------------

module.exports = { runWith, capDiff, parseNumstat, readTaskFile };

if (require.main === module) {
  main();
}
