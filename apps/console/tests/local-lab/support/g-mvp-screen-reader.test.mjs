import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import {
  boundReaderClose,
  observeReaderNativeOnce,
  readerActivationObserved,
  readerConsentOptIn,
  readerNativeRestored,
  requestReaderConsentOnce,
  requireReaderBaseline,
  requireReaderUnlockedDesktop,
  typedReaderBoolean,
  validateReaderReceipt,
} from '../g-mvp-screen-reader.mjs';
import {
  readerCheckFailureCode,
  readerCheckNames,
  readerChecksPassed,
} from './g-mvp-screen-reader-checks.mjs';

const baseline = () => ({
  voiceOverEnabled: false,
  activationClient: { exists: true, value: false },
  activationDisk: { exists: true, value: false },
  scriptingClient: { exists: false, value: null },
  scriptingDisk: { exists: false, value: null },
  processes: [],
  foreground: {
    pid: 1234,
    uid: 501,
    path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  desktop: {
    source: 'IOConsoleUsers',
    consoleRowsValid: true,
    activeConsoleSessions: 1,
    consoleUserMatches: true,
    screenLockKnown: true,
    screenLocked: false,
    foregroundIsLoginwindow: false,
    unlocked: true,
  },
});

test('a native off baseline requires explicit matching client/disk state and no existing apps', () => {
  assert.doesNotThrow(() => requireReaderBaseline(baseline()));
  for (const patch of [
    { voiceOverEnabled: true },
    { activationClient: { exists: false, value: null } },
    { activationDisk: { exists: true, value: true } },
    { scriptingClient: { exists: true, value: false } },
    { processes: [{ kind: 'voiceover' }] },
    { processes: [{ kind: 'settings' }] },
    { foreground: null },
  ])
    assert.throws(() => requireReaderBaseline({ ...baseline(), ...patch }), /SCREEN_READER_/u);
});

test('typed preferences distinguish an absent key from explicit false', () => {
  for (const value of [
    { exists: false, value: null },
    { exists: true, value: false },
    { exists: true, value: true },
  ])
    assert.equal(typedReaderBoolean(value), true);
  for (const value of [
    { exists: false, value: false },
    { exists: true, value: 0 },
    { exists: true, value: 'false' },
    {},
  ])
    assert.equal(Boolean(typedReaderBoolean(value)), false);
});

test('restoration cannot pass from process exit or a defaults-only observation', () => {
  const before = baseline();
  assert.equal(readerNativeRestored(before, baseline()), true);
  for (const patch of [
    { voiceOverEnabled: true },
    { activationClient: { exists: true, value: true } },
    { activationDisk: { exists: true, value: true } },
    { scriptingClient: { exists: true, value: false } },
    { scriptingDisk: { exists: true, value: false } },
    { processes: [{ kind: 'quickstart' }] },
    { processes: undefined },
  ])
    assert.equal(readerNativeRestored(before, { ...baseline(), ...patch }), false);
  assert.equal(readerNativeRestored(before, undefined), false);
});

test('all twelve distinct ordered checks must pass, including a nonempty result', () => {
  const passed = readerCheckNames.map((name) => ({ name, status: 'passed' }));
  assert.equal(readerChecksPassed(passed), true);
  for (const rows of [
    [],
    passed.slice(1),
    [...passed, passed[0]],
    [...passed].reverse(),
    passed.map((row, index) => (index === 7 ? { ...row, status: 'failed' } : row)),
    passed.map((row, index) => (index === 7 ? passed[0] : row)),
  ])
    assert.equal(readerChecksPassed(rows), false);
});

test('arbitrary error text and codes cannot enter reader check results', () => {
  const error = new Error('SCREEN_READER_SECRET_PASSWORD_FROM_DOM');
  error.code = 'private-dom-value';
  assert.equal(readerCheckFailureCode(error), 'SCREEN_READER_CHECK_ASSERTION_FAILED');
  assert.equal(
    readerCheckFailureCode(new Error('Call log: private rendered page text')),
    'SCREEN_READER_CHECK_ASSERTION_FAILED',
  );
  error.name = 'VoiceOverTransportError';
  assert.equal(readerCheckFailureCode(error), 'SCREEN_READER_VOICEOVER_TRANSPORT_FAILED');
  error.name = 'AbortError';
  assert.equal(readerCheckFailureCode(error), 'SCREEN_READER_INTERRUPTED');
  assert.equal(
    readerCheckFailureCode(new Error('SCREEN_READER_SELECTED_STATE_NOT_SPOKEN')),
    'SCREEN_READER_SELECTED_STATE_NOT_SPOKEN',
  );
});

test('final receipts bind session, identity, attempt, mode and exact path', () => {
  const directory = '/private/reader/example';
  const state = {
    id: '5a9f721f-2d34-4960-9d54-b2bcbf3f7740',
    session: 'example',
    lastAttempt: 'bc42ad95-3ef3-4b0b-a5d8-5c61646eebdd',
    lastMode: 'prepare',
  };
  state.lastReport = resolve(directory, 'attempts', state.lastAttempt, 'report.json');
  const receipt = {
    owner: 'ozz-g-mvp-screen-reader-v1',
    id: state.id,
    session: state.session,
    attempt: state.lastAttempt,
    mode: 'prepare',
    status: 'passed',
  };
  assert.equal(validateReaderReceipt(state, receipt, directory), receipt);
  for (const patch of [
    { owner: 'different-owner' },
    { id: 'different-id' },
    { session: 'different-session' },
    { attempt: 'different-attempt' },
    { mode: 'run' },
    { status: 'running' },
  ])
    assert.throws(
      () => validateReaderReceipt(state, { ...receipt, ...patch }, directory),
      /FINAL_RECEIPT_IDENTITY_CHANGED/u,
    );
  assert.throws(
    () =>
      validateReaderReceipt(
        { ...state, lastReport: '/private/elsewhere/report.json' },
        receipt,
        directory,
      ),
    /FINAL_RECEIPT_IDENTITY_CHANGED/u,
  );
});

test('a hanging browser close cannot indefinitely prevent later process cleanup', async () => {
  const calls = [];
  await assert.rejects(
    boundReaderClose(() => {
      calls.push('close');
      return new Promise(() => {});
    }, 5),
    /SCREEN_READER_BROWSER_CLOSE_TIMEOUT/u,
  );
  calls.push('owned-process-cleanup');
  assert.deepEqual(calls, ['close', 'owned-process-cleanup']);
  assert.equal(await boundReaderClose(async () => 'closed', 20), 'closed');
  await assert.rejects(
    boundReaderClose(async () => {
      throw new Error('known-rejection');
    }, 20),
    /known-rejection/u,
  );
});

test('a locked, unknown, contradictory or loginwindow desktop cannot admit activation', () => {
  for (const desktop of [
    undefined,
    { ...baseline().desktop, unlocked: false },
    { ...baseline().desktop, screenLocked: true },
    { ...baseline().desktop, screenLockKnown: false },
    { ...baseline().desktop, screenLocked: 'false' },
    { ...baseline().desktop, activeConsoleSessions: 0 },
    { ...baseline().desktop, activeConsoleSessions: 2 },
    { ...baseline().desktop, consoleUserMatches: false },
    { ...baseline().desktop, foregroundIsLoginwindow: true },
  ])
    assert.throws(
      () => requireReaderUnlockedDesktop({ ...baseline(), desktop }),
      /DESKTOP_LOCKED_OR_UNCONFIRMED/u,
    );
  assert.throws(
    () =>
      requireReaderUnlockedDesktop({
        ...baseline(),
        foreground: {
          pid: 176,
          path: '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow',
        },
      }),
    /DESKTOP_LOCKED_OR_UNCONFIRMED/u,
  );
});

test('native activation observations require getter, client and disk to agree', () => {
  assert.equal(readerActivationObserved(baseline(), false), true);
  assert.equal(readerActivationObserved(baseline(), true), false);
  for (const patch of [
    { voiceOverEnabled: true },
    { activationClient: { exists: true, value: true } },
    { activationDisk: { exists: false, value: null } },
    { activationDisk: { exists: true, value: 0 } },
  ])
    assert.equal(readerActivationObserved({ ...baseline(), ...patch }, false), false);
});

test('a failed intent write prevents any native submission', async () => {
  let submissions = 0;
  await assert.rejects(
    observeReaderNativeOnce({
      attempted: false,
      persistIntent: async () => {
        throw new Error('intent-write-failed');
      },
      submit: async () => {
        submissions++;
      },
      record: async () => {},
      observe: async () => baseline(),
      matches: (value) => readerActivationObserved(value, false),
    }),
    /intent-write-failed/u,
  );
  assert.equal(submissions, 0);
});

test('an uncertain AX reply can have applied and is never submitted again', async () => {
  let submissions = 0,
    persisted = false;
  const records = [];
  const options = {
    persistIntent: async () => {
      persisted = true;
    },
    submit: async () => {
      submissions++;
      return { pressAttempted: true, pressReplyCode: -25200, pressReplyUncertain: true };
    },
    record: async (value) => records.push(value),
    observe: async () => baseline(),
    matches: (value) => readerActivationObserved(value, false),
  };
  assert.equal(
    (await observeReaderNativeOnce({ ...options, attempted: false })).observed.voiceOverEnabled,
    false,
  );
  await observeReaderNativeOnce({ ...options, attempted: persisted });
  assert.equal(submissions, 1);
  assert.equal(records[0].response.pressReplyUncertain, true);
  assert.equal(records[1].priorAttempt, true);
});

test('a closed real runtime timeout observes asynchronous effect without a second submission', async () => {
  let submissions = 0,
    observations = 0;
  const timeout = Object.assign(new Error('GMVP_JOINT_COMMAND_FAILED'), {
    commandClosed: true,
    commandSpawned: true,
    exitCode: null,
    endingSignal: 'SIGTERM',
    wasInterrupted: true,
  });
  const result = await observeReaderNativeOnce({
    attempted: false,
    persistIntent: async () => {},
    submit: async () => {
      submissions++;
      throw timeout;
    },
    record: async () => {},
    observe: async () => {
      observations++;
      return observations === 1
        ? { ...baseline(), activationClient: { exists: true, value: true } }
        : baseline();
    },
    matches: (value) => readerActivationObserved(value, false),
    timeoutMs: 1000,
  });
  assert.equal(result.submission.error.commandClosed, true);
  assert.equal(submissions, 1);
  assert.equal(observations, 2);
});

test('a timed-out observation leaves the durable submission consumed on the next call', async () => {
  let attempted = false,
    submissions = 0;
  const options = {
    persistIntent: async () => {
      attempted = true;
    },
    submit: async () => {
      submissions++;
      return { pressAttempted: true, pressReplyUncertain: true };
    },
    record: async () => {},
    observe: async () => ({ ready: false }),
    matches: (value) => value.ready,
    timeoutMs: 1,
  };
  await assert.rejects(observeReaderNativeOnce({ ...options, attempted }), /OBSERVATION_TIMEOUT/u);
  await observeReaderNativeOnce({
    ...options,
    attempted,
    observe: async () => ({ ready: true }),
  });
  assert.equal(submissions, 1);
});

test('identity, unclosed helper, failed spawn and persistence errors stay fatal even if state matches', async () => {
  for (const failure of [
    Object.assign(new Error('SCREEN_READER_PROCESS_IDENTITY_CHANGED'), {
      pressAttempted: false,
      commandClosed: true,
      commandSpawned: true,
    }),
    Object.assign(new Error('GMVP_JOINT_COMMAND_FAILED'), {
      commandClosed: false,
      commandSpawned: true,
    }),
    Object.assign(new Error('GMVP_JOINT_COMMAND_FAILED'), {
      commandClosed: true,
      commandSpawned: false,
      wasInterrupted: true,
    }),
  ]) {
    let observations = 0;
    await assert.rejects(
      observeReaderNativeOnce({
        attempted: false,
        persistIntent: async () => {},
        submit: async () => {
          throw failure;
        },
        record: async () => {},
        observe: async () => {
          observations++;
          return baseline();
        },
        matches: () => true,
      }),
      (error) => error === failure,
    );
    assert.equal(observations, 1);
  }
  let observations = 0;
  await assert.rejects(
    observeReaderNativeOnce({
      attempted: false,
      persistIntent: async () => {},
      submit: async () => ({ pressAttempted: true, pressReplyUncertain: true }),
      record: async () => {
        throw new Error('receipt-write-failed');
      },
      observe: async () => {
        observations++;
        return baseline();
      },
      matches: () => true,
    }),
    /receipt-write-failed/u,
  );
  assert.equal(observations, 1);
});

test('actual off with lagging preferences needs observations and zero toggle submissions', async () => {
  let observations = 0,
    submissions = 0,
    intents = 0;
  await observeReaderNativeOnce({
    attempted: true,
    persistIntent: async () => {
      intents++;
    },
    submit: async () => {
      submissions++;
    },
    record: async () => {},
    observe: async () =>
      ++observations === 1
        ? { ...baseline(), activationDisk: { exists: true, value: true } }
        : baseline(),
    matches: (value) => readerActivationObserved(value, false),
    timeoutMs: 1000,
  });
  assert.equal(intents, 0);
  assert.equal(submissions, 0);
  assert.equal(observations, 2);
});

test('an explicitly aborted signal cannot turn a closed transport into success', async () => {
  const abort = new globalThis.AbortController();
  const failure = Object.assign(new Error('GMVP_JOINT_COMMAND_FAILED'), {
    commandClosed: true,
    commandSpawned: true,
    wasInterrupted: true,
  });
  let observations = 0;
  await assert.rejects(
    observeReaderNativeOnce({
      attempted: false,
      persistIntent: async () => {},
      submit: async () => {
        abort.abort();
        throw failure;
      },
      record: async () => {},
      observe: async () => {
        observations++;
        return baseline();
      },
      matches: () => true,
      signal: abort.signal,
    }),
    (error) => error === failure,
  );
  assert.equal(observations, 1);
  let submissions = 0,
    intents = 0;
  await assert.rejects(
    observeReaderNativeOnce({
      attempted: false,
      persistIntent: async () => {
        intents++;
      },
      submit: async () => {
        submissions++;
      },
      record: async () => {},
      observe: async () => baseline(),
      matches: () => true,
      signal: abort.signal,
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(intents, 0);
  assert.equal(submissions, 0);
});

const consentIdentity = {
  pid: 12345,
  uid: 501,
  processGroup: 12345,
  path: '/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOver',
  startToken: '100:1',
  startSeconds: 100,
};
const consentBrowser = {
  ...consentIdentity,
  pid: 12346,
  processGroup: 12346,
  path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};
const consentReply = () => ({
  identity: consentIdentity,
  browser: consentBrowser,
  consentRequestAttempted: true,
  askUserIfNeeded: true,
  eventClass: 'VOAS',
  eventID: 'perC',
  firstCommand: 'move voiceover cursor to keyboard focus',
  eventsSent: 0,
  promptDisplayed: 'unknown',
  permissionStatus: 0,
  permissionGranted: true,
});
function consentFixture() {
  const calls = [],
    records = [];
  let consumed = false;
  return {
    calls,
    records,
    consumed: () => consumed,
    options: {
      allowed: true,
      attempted: false,
      identity: consentIdentity,
      browser: consentBrowser,
      persistIntent: async () => {
        consumed = true;
        calls.push('persist-intent');
      },
      submit: async () => {
        calls.push('submit');
        return consentReply();
      },
      reestablishBrowser: async () => {
        calls.push('revalidate-identities-and-focus');
      },
      record: async (value) => {
        calls.push('record');
        records.push(value);
      },
    },
  };
}

test('system consent is explicit and run-only; other modes and later runs do not inherit it', () => {
  for (const mode of ['prepare', 'status', 'run', 'restore']) {
    assert.equal(readerConsentOptIn(mode), false);
    assert.equal(readerConsentOptIn(mode, false), false);
    for (const value of [1, 'true', null])
      assert.throws(() => readerConsentOptIn(mode, value), /CONSENT_OPT_IN_RUN_ONLY/u);
    if (mode !== 'run')
      assert.throws(() => readerConsentOptIn(mode, true), /CONSENT_OPT_IN_RUN_ONLY/u);
  }
  assert.equal(readerConsentOptIn('run', true), true);
  assert.equal(readerConsentOptIn('run'), false);
});

test('default consent path performs zero persistence, native requests or focus actions', async () => {
  const fixture = consentFixture();
  assert.deepEqual(
    await requestReaderConsentOnce({ ...fixture.options, allowed: false, attempted: true }),
    { status: 'not-requested' },
  );
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.consumed(), false);
});

test('granted consent requires the persisted intent then confirmed identities and browser focus', async () => {
  const fixture = consentFixture();
  await requestReaderConsentOnce(fixture.options);
  assert.deepEqual(fixture.calls, [
    'persist-intent',
    'submit',
    'revalidate-identities-and-focus',
    'record',
  ]);
  assert.equal(fixture.records[0].status, 'granted-and-browser-focused');
  assert.equal(fixture.records[0].helperGroupClosed, true);
  assert.equal(fixture.records[0].response.promptDisplayed, 'unknown');
  await assert.rejects(
    requestReaderConsentOnce({ ...fixture.options, attempted: fixture.consumed() }),
    /CONSENT_REQUEST_ALREADY_USED/u,
  );
  assert.equal(fixture.calls.filter((value) => value === 'submit').length, 1);
});

test('a failed durable consent write prevents the request and is not retried', async () => {
  const fixture = consentFixture();
  await assert.rejects(
    requestReaderConsentOnce({
      ...fixture.options,
      persistIntent: async () => {
        await fixture.options.persistIntent();
        throw new Error('intent-write-failed');
      },
    }),
    /intent-write-failed/u,
  );
  assert.equal(fixture.calls.includes('submit'), false);
  await assert.rejects(
    requestReaderConsentOnce({ ...fixture.options, attempted: fixture.consumed() }),
    /CONSENT_REQUEST_ALREADY_USED/u,
  );
  assert.equal(fixture.calls.includes('submit'), false);
});

test('denial preserves the one request and never reestablishes focus or claims a displayed prompt', async () => {
  const fixture = consentFixture();
  await assert.rejects(
    requestReaderConsentOnce({
      ...fixture.options,
      submit: async () => ({
        ...consentReply(),
        permissionStatus: -1743,
        permissionGranted: false,
      }),
    }),
    /VOICEOVER_CONSENT_NOT_GRANTED/u,
  );
  assert.equal(fixture.calls.includes('revalidate-identities-and-focus'), false);
  assert.equal(fixture.records[0].status, 'failed');
  assert.equal(fixture.records[0].nativeCode, -1743);
  assert.equal(fixture.records[0].response.promptDisplayed, 'unknown');
  await assert.rejects(
    requestReaderConsentOnce({ ...fixture.options, attempted: fixture.consumed() }),
    /CONSENT_REQUEST_ALREADY_USED/u,
  );
});

test('timeout or unconfirmed helper closure cannot resume checks or consume another consent', async () => {
  for (const commandClosed of [true, false]) {
    const fixture = consentFixture();
    const failure = Object.assign(new Error('SCREEN_READER_CONSENT_USER_WAIT_TIMEOUT'), {
      commandClosed,
      consentRequestAttempted: true,
    });
    await assert.rejects(
      requestReaderConsentOnce({
        ...fixture.options,
        submit: async () => {
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(fixture.calls.includes('revalidate-identities-and-focus'), false);
    assert.equal(fixture.records[0].helperGroupClosed, commandClosed);
    assert.equal(fixture.records[0].permissionOutcome, 'unknown');
    assert.equal(fixture.records[0].lateAuthorizationPossible, true);
    await assert.rejects(
      requestReaderConsentOnce({ ...fixture.options, attempted: fixture.consumed() }),
      /CONSENT_REQUEST_ALREADY_USED/u,
    );
  }
});

test('an abort wins over a late noErr response before any focus or reader action', async () => {
  const fixture = consentFixture();
  const abort = new globalThis.AbortController();
  await assert.rejects(
    requestReaderConsentOnce({
      ...fixture.options,
      signal: abort.signal,
      submit: async () => {
        abort.abort();
        return consentReply();
      },
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(fixture.calls.includes('revalidate-identities-and-focus'), false);
  assert.equal(fixture.records[0].status, 'failed');
  assert.equal(fixture.records[0].response.permissionStatus, 0);
  assert.equal(fixture.records[0].permissionOutcome, 'granted');
  await assert.rejects(
    requestReaderConsentOnce({ ...fixture.options, attempted: fixture.consumed() }),
    /CONSENT_REQUEST_ALREADY_USED/u,
  );
});

test('interruption during browser reconstruction or final recording cannot return consent success', async () => {
  for (const boundary of ['reestablishBrowser', 'record']) {
    const fixture = consentFixture();
    const abort = new globalThis.AbortController();
    await assert.rejects(
      requestReaderConsentOnce({
        ...fixture.options,
        signal: abort.signal,
        [boundary]: async (...args) => {
          await fixture.options[boundary](...args);
          abort.abort();
        },
      }),
      (error) => error.name === 'AbortError',
    );
    assert.equal(fixture.consumed(), true);
  }
});

test('a changed PID, event, browser, permission type or focus failure cannot admit reader checks', async () => {
  for (const patch of [
    { identity: { ...consentIdentity, startToken: '100:2' } },
    { browser: { ...consentBrowser, pid: 99999 } },
    { eventID: 'getd' },
    { eventsSent: 1 },
    { permissionStatus: '0' },
    { askUserIfNeeded: false },
  ]) {
    const fixture = consentFixture();
    await assert.rejects(
      requestReaderConsentOnce({
        ...fixture.options,
        submit: async () => ({ ...consentReply(), ...patch }),
      }),
      /CONSENT_RESPONSE_INVALID/u,
    );
    assert.equal(fixture.calls.includes('revalidate-identities-and-focus'), false);
  }
  const fixture = consentFixture();
  await assert.rejects(
    requestReaderConsentOnce({
      ...fixture.options,
      reestablishBrowser: async () => {
        throw new Error('SCREEN_READER_CONSENT_BROWSER_FOCUS_NOT_RESTORED');
      },
    }),
    /CONSENT_BROWSER_FOCUS_NOT_RESTORED/u,
  );
  assert.equal(fixture.records[0].status, 'failed');
});

test('already-aborted consent does not persist an intent or start any request', async () => {
  const fixture = consentFixture();
  const abort = new globalThis.AbortController();
  abort.abort();
  await assert.rejects(
    requestReaderConsentOnce({ ...fixture.options, signal: abort.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.deepEqual(fixture.calls, []);
});
