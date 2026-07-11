'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWith } = require('../index.js');

// ---- shared fixtures -------------------------------------------------

const EVENT_PAYLOAD = {
  pull_request: {
    number: 42,
    head: { ref: 'feat/my-branch', sha: 'headsha123' },
    base: { ref: 'main' },
    body: 'This PR adds input validation and fixes the retry bug.',
  },
};

function baseEnv(overrides = {}) {
  return Object.assign(
    {
      GITHUB_EVENT_PATH: '/fake/event.json',
      GITHUB_STEP_SUMMARY: '/fake/step-summary.txt',
      GITHUB_REPOSITORY: 'lemahq/lema',
      GITHUB_API_URL: 'https://api.github.com',
      GITHUB_TOKEN: 'ghtoken-abc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token-abc',
      INPUT_API_URL: 'https://verify.example.com',
    },
    overrides,
  );
}

function makeFsStub({ eventPayload = EVENT_PAYLOAD, taskFile = null, files = {} } = {}) {
  const written = {};
  return {
    written,
    readFileSync(p, enc) {
      if (p === '/fake/event.json') return JSON.stringify(eventPayload);
      if (p === '.lema/task.json') {
        if (taskFile === null) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return JSON.stringify(taskFile);
      }
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      const err = new Error(`ENOENT: no such file ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
    appendFileSync(p, data) {
      written[p] = (written[p] || '') + data;
    },
    existsSync(p) {
      if (p === '.lema/task.json') return taskFile !== null;
      return Object.prototype.hasOwnProperty.call(files, p);
    },
  };
}

function makeExecStub({ diff = '', numstat = '' } = {}) {
  const calls = [];
  return {
    calls,
    execFileSync(cmd, args) {
      calls.push([cmd, ...args].join(' '));
      const joined = args.join(' ');
      if (joined.includes('--numstat')) return numstat;
      if (joined.includes('diff')) return diff;
      return '';
    },
  };
}

function makeFetchStub(handlers) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    for (const h of handlers) {
      if (h.match(url, opts)) return h.respond(url, opts);
    }
    throw new Error(`unhandled fetch: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(status, body, extra = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
    ...extra,
  };
}

// ---- RED test: 5xx path ----------------------------------------------

test('5xx from /verify: no comment API call, exit 0, step-summary note', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n', numstat: '1\t1\tx\n' });

  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: () => jsonResponse(500, { error: 'internal' }),
    },
    {
      match: (url) => String(url).includes('/issues/42/comments'),
      respond: () => {
        throw new Error('must not be called: 5xx path posts no comment');
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, false);

  const commentCalls = fetchImpl.calls.filter((c) => String(c.url).includes('/comments'));
  assert.equal(commentCalls.length, 0, 'no GitHub comment API call should happen on 5xx');

  const summary = fs.written['/fake/step-summary.txt'] || '';
  assert.match(summary, /description check: not run \(/);
});

// ---- comment upsert: not duplicated -----------------------------------

test('200 with markdown: PATCHes existing marker comment, does not POST a new one', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  const markdown = '<!-- lema-verify -->\n\n**Description check:** 1 of 1 stated changes found\n\nChecked against: description\n\nlema verify v1 · this repo: 1 / 50 free checks this month\n';

  let postCalls = 0;
  let patchCalls = 0;

  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: () => jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown, summary: {} }),
    },
    {
      match: (url, opts) => String(url).includes('/comments') && (!opts || opts.method === 'GET' || !opts.method),
      respond: () => jsonResponse(200, [
        { id: 999, body: 'some other comment' },
        { id: 1000, body: '<!-- lema-verify -->\n\nold card' },
      ]),
    },
    {
      match: (url, opts) => String(url).includes('/comments/1000') && opts.method === 'PATCH',
      respond: () => {
        patchCalls++;
        return jsonResponse(200, { id: 1000 });
      },
    },
    {
      match: (url, opts) => /\/comments$/.test(String(url)) && opts.method === 'POST',
      respond: () => {
        postCalls++;
        return jsonResponse(201, { id: 1001 });
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, true);
  assert.equal(patchCalls, 1, 'should PATCH the existing marker comment exactly once');
  assert.equal(postCalls, 0, 'should never POST a second marker comment when one exists');

  const summary = fs.written['/fake/step-summary.txt'] || '';
  assert.equal(summary, '**Description check:** 1 of 1 stated changes found\n');
});

test('200 with markdown, no existing marker comment: POSTs exactly once', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  const markdown = '<!-- lema-verify -->\n\n**Description check:** 1 of 1 stated changes found\n\nChecked against: description\n\nlema verify v1 · this repo: 1 / 50 free checks this month\n';

  let postCalls = 0;
  let patchCalls = 0;

  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: () => jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown, summary: {} }),
    },
    {
      match: (url, opts) => String(url).includes('/comments') && (!opts || opts.method === 'GET' || !opts.method),
      respond: () => jsonResponse(200, []),
    },
    {
      match: (url, opts) => /\/comments$/.test(String(url)) && opts.method === 'POST',
      respond: () => {
        postCalls++;
        return jsonResponse(201, { id: 1001 });
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, true);
  assert.equal(postCalls, 1);
  assert.equal(patchCalls, 0);
});

// ---- 900KB cap + numstat manifest --------------------------------------

test('diff over 900KB is truncated, numstat manifest still sent in full', async () => {
  const fs = makeFsStub();

  // Build a diff over the cap made of many hunks so a hunk-boundary cut is
  // possible, plus a numstat manifest listing every file (including ones
  // whose hunks get truncated away) — the manifest must always be sent in
  // full regardless of diff truncation.
  const hunk = (n) => `diff --git a/file${n}.txt b/file${n}.txt\n` + '+'.repeat(2000) + '\n';
  let bigDiff = '';
  const fileCount = 600; // 600 * ~2020 bytes > 900_000
  for (let i = 0; i < fileCount; i++) bigDiff += hunk(i);
  assert.ok(Buffer.byteLength(bigDiff, 'utf8') > 900000, 'fixture diff must exceed the cap');

  let numstatLines = '';
  for (let i = 0; i < fileCount; i++) numstatLines += `1\t0\tfile${i}.txt\n`;

  const exec = makeExecStub({ diff: bigDiff, numstat: numstatLines });

  let sentBody = null;
  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url, opts) => String(url).includes('/verify'),
      respond: (url, opts) => {
        sentBody = JSON.parse(opts.body);
        return jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown: '', summary: {} });
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.ok(sentBody, 'expected a /verify POST body to have been captured');
  assert.ok(
    Buffer.byteLength(sentBody.diff, 'utf8') <= 900000,
    `capped diff must be <= 900000 bytes, got ${Buffer.byteLength(sentBody.diff, 'utf8')}`,
  );
  assert.equal(sentBody.numstat.length, fileCount, 'numstat manifest must list every file, uncapped');
});

// ---- stale-branch task file ignored ------------------------------------

test('.lema/task.json present but branch does not match head ref: ignored, not sent', async () => {
  const fs = makeFsStub({ taskFile: { task: 'implement thing', branch: 'some-other-branch' } });
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  let sentBody = null;
  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url, opts) => String(url).includes('/verify'),
      respond: (url, opts) => {
        sentBody = JSON.parse(opts.body);
        return jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown: '', summary: {} });
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.ok(sentBody, 'expected a /verify POST body to have been captured');
  assert.equal(sentBody.task_file, null, 'stale-branch task file must not be forwarded');
});

test('.lema/task.json present and branch matches head ref: included', async () => {
  const fs = makeFsStub({ taskFile: { task: 'implement thing', branch: 'feat/my-branch' } });
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  let sentBody = null;
  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url, opts) => String(url).includes('/verify'),
      respond: (url, opts) => {
        sentBody = JSON.parse(opts.body);
        return jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown: '', summary: {} });
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(sentBody.task_file, { task: 'implement thing', branch: 'feat/my-branch' });
});

// ---- markdown-less 200: no comment + note ------------------------------

test('200 with empty markdown: no comment posted, step-summary note written', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: () => jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown: '', summary: {} }),
    },
    {
      match: (url) => String(url).includes('/comments'),
      respond: () => {
        throw new Error('must not be called: markdown-less 200 posts no comment');
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, false);
  const summary = fs.written['/fake/step-summary.txt'] || '';
  assert.match(summary, /description check: not run \(/);
});

test('200 with card_state error and no markdown: no comment posted', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: () => jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'error', markdown: '', summary: {} }),
    },
    {
      match: (url) => String(url).includes('/comments'),
      respond: () => {
        throw new Error('must not be called');
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, false);
});

// ---- OIDC env missing ---------------------------------------------------

test('OIDC env missing: step-summary note, exit 0, no fetch calls at all', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub();
  const fetchImpl = makeFetchStub([]);

  const env = baseEnv({
    ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
  });
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  const result = await runWith(env, fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, false);
  assert.equal(fetchImpl.calls.length, 0, 'no network calls should happen when OIDC env is missing');

  const summary = fs.written['/fake/step-summary.txt'] || '';
  assert.match(summary, /description check: not run \(/);
});

// ---- github-token input wiring ------------------------------------------

test('github-token input (INPUT_GITHUB-TOKEN) is used for the comment API call when set, over a bare GITHUB_TOKEN env var', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  const markdown = '<!-- lema-verify -->\n\n**Description check:** 1 of 1 stated changes found\n\nChecked against: description\n\nlema verify v1 · this repo: 1 / 50 free checks this month\n';

  let sawAuthHeader = null;

  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: () => jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown, summary: {} }),
    },
    {
      match: (url, opts) => String(url).includes('/comments') && (!opts || opts.method === 'GET' || !opts.method),
      respond: (url, opts) => {
        sawAuthHeader = opts.headers.Authorization;
        return jsonResponse(200, []);
      },
    },
    {
      match: (url, opts) => /\/comments$/.test(String(url)) && opts.method === 'POST',
      respond: (url, opts) => {
        sawAuthHeader = opts.headers.Authorization;
        return jsonResponse(201, { id: 1001 });
      },
    },
  ]);

  // A GitHub Action input is surfaced as INPUT_<NAME> uppercased; hyphens
  // in the input name are preserved (not converted to underscores). Set a
  // DIFFERENT value on the bare GITHUB_TOKEN env var to prove the input,
  // not the fallback, wins when both are present.
  const env = baseEnv({
    GITHUB_TOKEN: 'fallback-token-should-not-be-used',
    'INPUT_GITHUB-TOKEN': 'input-token-abc',
  });

  const result = await runWith(env, fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, true);
  assert.equal(sawAuthHeader, 'Bearer input-token-abc', 'the github-token INPUT must be used over the bare GITHUB_TOKEN env var');
});

test('github-token input absent: falls back to bare GITHUB_TOKEN env var (keeps existing tests/usages working)', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  const markdown = '<!-- lema-verify -->\n\n**Description check:** 1 of 1 stated changes found\n\nChecked against: description\n\nlema verify v1 · this repo: 1 / 50 free checks this month\n';

  let sawAuthHeader = null;

  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: () => jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown, summary: {} }),
    },
    {
      match: (url, opts) => String(url).includes('/comments') && (!opts || opts.method === 'GET' || !opts.method),
      respond: (url, opts) => {
        sawAuthHeader = opts.headers.Authorization;
        return jsonResponse(200, []);
      },
    },
    {
      match: (url, opts) => /\/comments$/.test(String(url)) && opts.method === 'POST',
      respond: (url, opts) => {
        sawAuthHeader = opts.headers.Authorization;
        return jsonResponse(201, { id: 1001 });
      },
    },
  ]);

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, true);
  assert.equal(sawAuthHeader, 'Bearer ghtoken-abc', 'must fall back to the bare GITHUB_TOKEN env var when the input is absent');
});

// ---- numstat parsing (unit-level) --------------------------------------

test('parseNumstat parses tab-separated lines including binary (-) markers', () => {
  const { parseNumstat } = require('../index.js');
  const out = parseNumstat('3\t1\tfoo.txt\n-\t-\timage.png\n');
  assert.deepEqual(out, [
    { path: 'foo.txt', adds: 3, dels: 1 },
    { path: 'image.png', adds: 0, dels: 0 },
  ]);
});

test('capDiff leaves small diffs untouched', () => {
  const { capDiff } = require('../index.js');
  const small = 'diff --git a/x b/x\n+hi\n';
  assert.equal(capDiff(small, 900000), small);
});

// ---- check run (Rung 2) -------------------------------------------------

function checkFetchHandlers({ checkPayload, checkRespond }) {
  const markdown = '<!-- lema-verify -->\n\n**Description check:** 1 of 1 stated changes found\n';
  return [
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: () =>
        jsonResponse(200, {
          schema_version: 1,
          run_id: 'r1',
          card_state: 'checked',
          markdown,
          summary: {},
          check: checkPayload,
        }),
    },
    {
      match: (url, opts) => String(url).includes('/comments') && (!opts || opts.method === 'GET' || !opts.method),
      respond: () => jsonResponse(200, []),
    },
    {
      match: (url, opts) => /\/comments$/.test(String(url)) && opts.method === 'POST',
      respond: () => jsonResponse(201, { id: 1001 }),
    },
    {
      match: (url, opts) => String(url).includes('/check-runs') && opts.method === 'POST',
      respond: checkRespond,
    },
  ];
}

const CHECK_PAYLOAD = {
  name: 'lema verify',
  title: '1 of 1 stated changes found',
  summary: 'card body',
  conclusion: 'neutral',
  annotations: [
    { path: 'config.go', start_line: 5, end_line: 5, annotation_level: 'notice', message: 'Not described — renames a config key. Intentional?' },
  ],
};

test('check payload present: POSTs the check run verbatim against the head SHA', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  let checkBody = null;
  const fetchImpl = makeFetchStub(
    checkFetchHandlers({
      checkPayload: CHECK_PAYLOAD,
      checkRespond: (url, opts) => {
        checkBody = JSON.parse(opts.body);
        return jsonResponse(201, { id: 7 });
      },
    }),
  );

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, true);
  assert.equal(result.checkPosted, true);
  assert.ok(checkBody, 'check-runs API was not called');
  assert.equal(checkBody.head_sha, 'headsha123');
  assert.equal(checkBody.status, 'completed');
  // Server-owned fields forwarded verbatim — no mapping in the Action.
  assert.equal(checkBody.name, CHECK_PAYLOAD.name);
  assert.equal(checkBody.conclusion, 'neutral');
  assert.equal(checkBody.output.title, CHECK_PAYLOAD.title);
  assert.equal(checkBody.output.summary, CHECK_PAYLOAD.summary);
  assert.deepEqual(checkBody.output.annotations, CHECK_PAYLOAD.annotations);
});

test('check-runs 403 (fork PR / missing checks:write): comment still posted, exit 0, note written', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  const fetchImpl = makeFetchStub(
    checkFetchHandlers({
      checkPayload: CHECK_PAYLOAD,
      checkRespond: () => jsonResponse(403, { message: 'Resource not accessible by integration' }),
    }),
  );

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, true, 'a check-run failure must never take the comment down with it');
  assert.equal(result.checkPosted, false);

  const summary = fs.written['/fake/step-summary.txt'] || '';
  assert.match(summary, /check run not posted/);
  // The degrade note must never claim the check didn't run — the verify
  // call and the comment both succeeded.
  assert.doesNotMatch(summary, /not run \(/);
});

test('no check payload (older server): no check-runs call at all', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  const fetchImpl = makeFetchStub(
    checkFetchHandlers({
      checkPayload: undefined,
      checkRespond: () => {
        throw new Error('must not be called without a check payload');
      },
    }),
  );

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.commentPosted, true);
  assert.equal(result.checkPosted, false);
  const checkCalls = fetchImpl.calls.filter((c) => String(c.url).includes('/check-runs'));
  assert.equal(checkCalls.length, 0);
});

test('empty annotations list: check run posted without an annotations field', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });

  let checkBody = null;
  const fetchImpl = makeFetchStub(
    checkFetchHandlers({
      checkPayload: Object.assign({}, CHECK_PAYLOAD, { annotations: [] }),
      checkRespond: (url, opts) => {
        checkBody = JSON.parse(opts.body);
        return jsonResponse(201, { id: 8 });
      },
    }),
  );

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.checkPosted, true);
  assert.ok(checkBody);
  assert.equal('annotations' in checkBody.output, false, 'empty annotations must be omitted, not sent as []');
});

// ---- record-decisions consent input (WP5, verify-standalone) -----------
// The committed workflow line IS the settles consent; the Action's only job
// is to forward it faithfully. Anything other than exactly 'true' — absent,
// 'false', or garbage — must NOT read as consent.

function captureVerifyBody() {
  let captured = { body: null };
  const fetchImpl = makeFetchStub([
    {
      match: (url) => String(url).includes('oidc.example'),
      respond: () => jsonResponse(200, { value: 'fake-oidc-jwt' }),
    },
    {
      match: (url) => String(url).includes('/verify'),
      respond: (url, opts) => {
        captured.body = JSON.parse(opts.body);
        return jsonResponse(200, { schema_version: 1, run_id: 'r1', card_state: 'checked', markdown: '', summary: {} });
      },
    },
  ]);
  return { captured, fetchImpl };
}

test("record-decisions input 'true': record_decisions=true forwarded", async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });
  const { captured, fetchImpl } = captureVerifyBody();

  const result = await runWith(baseEnv({ 'INPUT_RECORD-DECISIONS': 'true' }), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.ok(captured.body, 'expected a /verify POST body');
  assert.equal(captured.body.record_decisions, true);
});

test('record-decisions input absent: no consent forwarded', async () => {
  const fs = makeFsStub();
  const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });
  const { captured, fetchImpl } = captureVerifyBody();

  const result = await runWith(baseEnv(), fetchImpl, exec, fs);

  assert.equal(result.exitCode, 0);
  assert.ok(captured.body, 'expected a /verify POST body');
  assert.notEqual(captured.body.record_decisions, true, 'absent input must never read as consent');
});

test("record-decisions input 'false' or garbage: no consent forwarded", async () => {
  for (const value of ['false', 'True ', 'yes', '1']) {
    const fs = makeFsStub();
    const exec = makeExecStub({ diff: 'diff --git a/x b/x\n+hi\n', numstat: '1\t0\tx\n' });
    const { captured, fetchImpl } = captureVerifyBody();

    const result = await runWith(baseEnv({ 'INPUT_RECORD-DECISIONS': value }), fetchImpl, exec, fs);

    assert.equal(result.exitCode, 0);
    assert.ok(captured.body, `expected a /verify POST body for ${JSON.stringify(value)}`);
    assert.notEqual(captured.body.record_decisions, true, `input ${JSON.stringify(value)} must never read as consent`);
  }
});
