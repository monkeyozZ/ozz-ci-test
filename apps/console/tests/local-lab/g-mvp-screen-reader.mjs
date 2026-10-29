import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import {
  atomicState,
  commandRunner,
  encode,
  hash,
  live,
  newFile,
  privateFile,
  waitFor,
} from '../../../../tests/probes/support/g-mvp-recovery-joint-runtime.mjs';
import {
  readRealState,
  realCaPath,
  realOrigin,
  realPasswordPath,
  realStatePath,
  verifyRealEntryCertificate,
} from './s6-real-support.ts';
import {
  readerCheckNames,
  readerChecksPassed,
  readerDeploymentIdentity,
  readerRecordIds,
  readerServiceIdentity,
  runReaderChecks,
} from './support/g-mvp-screen-reader-checks.mjs';

// A new, coordinated reader session. Importing this module performs no IO.
// prepare observes the OS and compiles the bridge; it never starts an app,
// changes a preference, authenticates, or sends an accessibility/Apple event.
// pnpm exec node apps/console/tests/local-lab/g-mvp-screen-reader.mjs prepare --session NAME
// Use status/run/restore with that same name. Every run consumes one attempt.
// Only an explicitly authorized new run may add --allow-system-consent-once.
// That flag is never accepted by prepare/status/restore or inherited by a run.
// restore uses the retained native bridge and state without requiring the API,
// administrator password, product fixtures, or current product source hashes.
const root = resolve(import.meta.dirname, '../../../..');
const lab = resolve(root, '.local/local-lab');
const owner = 'ozz-g-mvp-screen-reader-v1';
const sessionsRoot = resolve(lab, 'g-mvp-screen-reader');
const nativeSource = resolve(import.meta.dirname, 'support/g-mvp-screen-reader-native.m');
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,79}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const firstVoiceOverCommand = 'move voiceover cursor to keyboard focus';
const consentHelperTimeoutMs = 135000;
const nativePaths = Object.freeze({
  voiceover: '/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOver',
  starter: '/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter',
  quickstart:
    '/System/Library/PrivateFrameworks/ScreenReader.framework/Versions/A/Resources/VoiceOver Quickstart.app/Contents/MacOS/VoiceOver Quickstart',
  settings: '/System/Applications/System Settings.app/Contents/MacOS/System Settings',
});
const mutableNativeActions = new Set([
  'settings-open',
  'settings-reopen',
  'settings-on',
  'settings-off',
  'foreground',
  'scripting-preference',
  'welcome-continue',
  'voiceover',
  'voiceover-consent',
  'terminate',
]);
const restoreWithoutNewIntent = new Set(['foreground', 'scripting-preference', 'terminate']);

function requireValue(value, code) {
  if (!value) throw new Error('SCREEN_READER_' + code);
}
function errorCode(error) {
  if (error?.message === 'GMVP_JOINT_OBSERVATION_TIMEOUT')
    return 'SCREEN_READER_OBSERVATION_TIMEOUT';
  if (error?.message === 'GMVP_JOINT_COMMAND_FAILED') return 'SCREEN_READER_COMMAND_FAILED';
  if (error?.message === 'GMVP_JOINT_COMMAND_EXIT_UNCONFIRMED')
    return 'SCREEN_READER_COMMAND_EXIT_UNCONFIRMED';
  return /^SCREEN_READER_[A-Z0-9_]+$/u.test(error?.message ?? '')
    ? error.message
    : error?.name === 'AbortError'
      ? 'SCREEN_READER_INTERRUPTED'
      : 'SCREEN_READER_UNEXPECTED_FAILURE';
}
export function typedReaderBoolean(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.exists === 'boolean' &&
    (value.exists ? typeof value.value === 'boolean' : value.value === null)
  );
}
export function requireReaderBaseline(snapshot) {
  requireReaderUnlockedDesktop(snapshot);
  requireValue(snapshot?.voiceOverEnabled === false, 'VOICEOVER_ALREADY_ENABLED');
  // Native activation leaves an explicit false key on this host. An existing
  // false baseline permits exact restoration of the measured key's presence.
  requireValue(
    isDeepStrictEqual(snapshot.activationClient, { exists: true, value: false }) &&
      isDeepStrictEqual(snapshot.activationDisk, snapshot.activationClient),
    'EXPLICIT_NATIVE_OFF_BASELINE_REQUIRED',
  );
  requireValue(
    typedReaderBoolean(snapshot.scriptingClient) &&
      isDeepStrictEqual(snapshot.scriptingClient, snapshot.scriptingDisk),
    'SCRIPTING_BASELINE_INCONSISTENT',
  );
  requireValue(
    Array.isArray(snapshot.processes) && snapshot.processes.length === 0,
    'NATIVE_APP_ALREADY_IN_USE',
  );
  requireValue(snapshot.foreground?.pid > 1, 'FOREGROUND_BASELINE_MISSING');
}
export function requireReaderUnlockedDesktop(snapshot) {
  const desktop = snapshot?.desktop;
  requireValue(
    desktop?.source === 'IOConsoleUsers' &&
      desktop.consoleRowsValid === true &&
      desktop.activeConsoleSessions === 1 &&
      desktop.consoleUserMatches === true &&
      desktop.screenLockKnown === true &&
      desktop.screenLocked === false &&
      desktop.foregroundIsLoginwindow === false &&
      desktop.unlocked === true &&
      snapshot.foreground?.pid > 1 &&
      typeof snapshot.foreground.path === 'string' &&
      snapshot.foreground.path !==
        '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow',
    'DESKTOP_LOCKED_OR_UNCONFIRMED',
  );
}
export function readerActivationObserved(snapshot, enabled) {
  return (
    typeof enabled === 'boolean' &&
    snapshot?.voiceOverEnabled === enabled &&
    ['activationClient', 'activationDisk'].every(
      (key) =>
        typedReaderBoolean(snapshot[key]) &&
        snapshot[key].exists === true &&
        snapshot[key].value === enabled,
    )
  );
}

// A durable intent consumes the one submission even when the helper reply is
// lost. Only state observations may follow it; no retry path calls submit.
export async function observeReaderNativeOnce({
  attempted,
  persistIntent,
  submit,
  record,
  observe,
  matches,
  timeoutMs = 12000,
  signal,
}) {
  let fatal, recordingFailure;
  const submission = { priorAttempt: Boolean(attempted) };
  if (!attempted) {
    signal?.throwIfAborted();
    await persistIntent();
    signal?.throwIfAborted();
    try {
      submission.response = await submit();
    } catch (error) {
      submission.error = {
        code: errorCode(error),
        nativeCode: Number.isInteger(error.nativeCode) ? error.nativeCode : null,
        pressAttempted: typeof error.pressAttempted === 'boolean' ? error.pressAttempted : null,
        commandClosed: error.commandClosed === true,
        commandSpawned: typeof error.commandSpawned === 'boolean' ? error.commandSpawned : null,
      };
      // AX reply failures are returned by native as structured uncertainty.
      // A lost transport reply can also have applied, but it must have a
      // confirmed closed helper and cannot hide an identity/permission error.
      if (
        error.pressAttempted === false ||
        error.commandClosed !== true ||
        error.commandSpawned !== true ||
        errorCode(error) !== 'SCREEN_READER_COMMAND_FAILED' ||
        signal?.aborted
      )
        fatal = error;
    }
  }
  try {
    await record(submission);
  } catch (error) {
    recordingFailure = error;
  }
  if (fatal || recordingFailure) {
    await observe();
    throw fatal ?? recordingFailure;
  }
  const observed = await waitFor(observe, matches, { timeoutMs, signal });
  return { submission, observed };
}
export function readerNativeRestored(before, after) {
  return Boolean(
    before &&
    after &&
    after.voiceOverEnabled === false &&
    Array.isArray(after.processes) &&
    after.processes.length === 0 &&
    ['activationClient', 'activationDisk', 'scriptingClient', 'scriptingDisk'].every(
      (key) => typedReaderBoolean(after[key]) && isDeepStrictEqual(before[key], after[key]),
    ),
  );
}
export function validateReaderReceipt(state, receipt, directory) {
  requireValue(
    state &&
      uuid.test(state.lastAttempt) &&
      ['prepare', 'run', 'restore'].includes(state.lastMode) &&
      state.lastReport === resolve(directory, 'attempts', state.lastAttempt, 'report.json') &&
      receipt?.owner === owner &&
      receipt.session === state.session &&
      receipt.id === state.id &&
      receipt.attempt === state.lastAttempt &&
      receipt.mode === state.lastMode &&
      ['passed', 'failed'].includes(receipt.status),
    'FINAL_RECEIPT_IDENTITY_CHANGED',
  );
  return receipt;
}

export async function boundReaderClose(action, timeoutMs = 5000) {
  let timer;
  const pending = Promise.resolve().then(action);
  // A timeout must not turn a later Playwright rejection into an unhandled one.
  void pending.catch(() => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error('SCREEN_READER_BROWSER_CLOSE_TIMEOUT')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function safeDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  requireValue(
    info.isDirectory() &&
      info.uid === process.getuid() &&
      !(info.mode & 0o077) &&
      (await realpath(path)) === path,
    'DIRECTORY_UNSAFE',
  );
}

function requestJson(path, { method = 'GET', body, session, ca, signal } = {}) {
  requireValue(path.startsWith('/api/') && !path.includes('://'), 'API_PATH_INVALID');
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((accept, reject) => {
    const request = httpsRequest(
      realOrigin + path,
      {
        method,
        ca,
        rejectUnauthorized: true,
        agent: false,
        signal: globalThis.AbortSignal.any(
          [signal, globalThis.AbortSignal.timeout(10000)].filter(Boolean),
        ),
        headers: {
          origin: realOrigin,
          ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
          ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}),
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024)
            response.destroy(new Error('SCREEN_READER_API_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            accept({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks)),
            });
          } catch {
            reject(new Error('SCREEN_READER_API_RESPONSE_INVALID'));
          }
        });
      },
    );
    request.once('error', reject);
    request.end(raw);
  });
}

export function readerConsentOptIn(mode, value = false) {
  requireValue(typeof value === 'boolean' && (!value || mode === 'run'), 'CONSENT_OPT_IN_RUN_ONLY');
  return value;
}

// The durable intent consumes the request even if the process is interrupted
// before the helper replies. No denial, timeout or later restore retries it.
export async function requestReaderConsentOnce({
  allowed,
  attempted,
  identity,
  browser,
  persistIntent,
  submit,
  reestablishBrowser,
  record,
  signal,
}) {
  requireValue(typeof allowed === 'boolean', 'CONSENT_OPT_IN_REQUIRED');
  if (!allowed) return { status: 'not-requested' };
  signal?.throwIfAborted();
  requireValue(!attempted, 'CONSENT_REQUEST_ALREADY_USED');
  let response;
  try {
    await persistIntent();
    signal?.throwIfAborted();
    response = await submit();
    signal?.throwIfAborted();
    requireValue(
      response?.consentRequestAttempted === true &&
        response.askUserIfNeeded === true &&
        response.eventClass === 'VOAS' &&
        response.eventID === 'perC' &&
        response.firstCommand === firstVoiceOverCommand &&
        response.eventsSent === 0 &&
        response.promptDisplayed === 'unknown' &&
        Number.isInteger(response.permissionStatus) &&
        isDeepStrictEqual(response.identity, identity) &&
        isDeepStrictEqual(response.browser, browser),
      'CONSENT_RESPONSE_INVALID',
    );
    if (response.permissionStatus !== 0 || response.permissionGranted !== true) {
      const error = new Error('SCREEN_READER_VOICEOVER_CONSENT_NOT_GRANTED');
      error.nativeCode = response.permissionStatus;
      throw error;
    }
    // submit resolves only after commandRunner confirms helper/group closure.
    await reestablishBrowser();
    signal?.throwIfAborted();
  } catch (error) {
    await record({
      status: 'failed',
      response: response ?? null,
      helperGroupClosed: response ? true : (error.commandClosed ?? null),
      consentRequestAttempted:
        response?.consentRequestAttempted ?? error.consentRequestAttempted ?? null,
      code: errorCode(error),
      nativeCode: Number.isInteger(error.nativeCode) ? error.nativeCode : null,
      permissionOutcome: response
        ? response.permissionStatus === 0
          ? 'granted'
          : 'not-granted'
        : 'unknown',
      lateAuthorizationPossible: !response,
    });
    throw error;
  }
  await record({
    status: 'granted-and-browser-focused',
    response,
    helperGroupClosed: true,
    browserFocusReestablished: true,
  });
  signal?.throwIfAborted();
  return response;
}

export async function runScreenReader(mode, session, { allowSystemConsentOnce = false } = {}) {
  requireValue(
    ['prepare', 'status', 'run', 'restore'].includes(mode) && sessionPattern.test(session),
    'USAGE_INVALID',
  );
  const consentAllowed = readerConsentOptIn(mode, allowSystemConsentOnce);
  requireValue(
    process.platform === 'darwin' && process.versions.node.split('.')[0] === '24',
    'NODE_24_MACOS_REQUIRED',
  );
  process.umask(0o077);
  const directory = resolve(sessionsRoot, session);
  const statePath = resolve(directory, 'state.json');
  let state, loadedDigest;
  try {
    const bytes = await privateFile(statePath, 16 * 1024 * 1024);
    state = JSON.parse(bytes);
    loadedDigest = hash(bytes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  requireValue(
    !state ||
      (state.formatVersion === 1 &&
        state.owner === owner &&
        state.session === session &&
        uuid.test(state.id)),
    'STATE_IDENTITY_CHANGED',
  );
  const publicState = () =>
    state
      ? {
          owner,
          session,
          id: state.id,
          status: state.status,
          preparedAt: state.preparedAt ?? null,
          runAttempt: state.runAttempt ?? null,
          restorationRequired: state.restorationRequired ?? false,
          lastReport: state.lastReport ?? null,
        }
      : { owner, session, status: 'not-prepared' };
  async function finalReceipt() {
    requireValue(
      state?.lastReport === resolve(directory, 'attempts', state.lastAttempt ?? '', 'report.json'),
      'FINAL_RECEIPT_PATH_CHANGED',
    );
    return validateReaderReceipt(
      state,
      JSON.parse(await privateFile(state.lastReport, 16 * 1024 * 1024)),
      directory,
    );
  }
  const statusOf = (receipt) =>
    receipt.status !== 'passed'
      ? 'failed'
      : receipt.mode === 'prepare'
        ? 'prepared'
        : receipt.mode === 'restore'
          ? 'restored'
          : 'completed';
  if (mode === 'status') {
    const result = publicState();
    if (['prepared', 'finished'].includes(state?.status)) {
      try {
        result.status = statusOf(await finalReceipt());
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        result.status = 'awaiting-final-report';
      }
    }
    console.log(JSON.stringify(result));
    return result;
  }
  requireValue(
    mode === 'prepare' ? !state : mode === 'run' ? state?.preparedAt : state,
    'PREPARE_NEW_SESSION_REQUIRED',
  );
  requireValue(mode !== 'run' || !state.runAttempt, 'RUN_ATTEMPT_ALREADY_USED');
  await safeDirectory(directory);
  const attempt = randomUUID(),
    attemptDirectory = resolve(directory, 'attempts', attempt);
  await safeDirectory(attemptDirectory);
  const events = await open(resolve(attemptDirectory, 'events.jsonl'), 'wx', 0o600);
  const abort = new globalThis.AbortController();
  const interrupt = () => abort.abort(new Error('SCREEN_READER_INTERRUPTED'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const originNs = process.hrtime.bigint();
  const report = {
    formatVersion: 1,
    owner,
    session,
    attempt,
    mode,
    startedAt: new Date().toISOString(),
    status: 'running',
    nativeActivationMethod: 'verified-settings-switch',
    checks: [],
    phrases: [],
    nativeActions: [],
    systemConsentOptIn: consentAllowed,
    requestAudit: {
      authenticationAttempts: 0,
      blockedWrites: [],
      blockedForeignRequests: [],
      apiFailures: [],
      pageErrors: 0,
    },
    limits: [
      'One local macOS VoiceOver session. Twelve selected product meanings are observed through actual PID-addressed last-phrase events; this is not a complete WCAG audit.',
      'Native helper compilation and descriptor self-tests do not prove that VoiceOver has accepted an event. Actual success requires nonempty phrases during this run.',
      'The current local HTTPS entry uses the retained local CA. Browser trust is limited to the dedicated test context; production Secure Cookie is not claimed.',
      'The private browser profile, authentication session and all attempts are retained. No deployment, build, infrastructure operation or product configuration change is performed.',
      'Restoration checks the actual VoiceOver getter, persisted activation key, defaults client, scripting preference, owned processes and prior foreground. Unrelated OS preference keys are outside this receipt.',
      'Explicit automation consent may persist in macOS TCC. Its request count does not prove a dialog was displayed. Restoration neither rolls back TCC nor proves an unattributed system dialog has closed.',
    ],
  };
  let stateTail = Promise.resolve(),
    eventTail = Promise.resolve();
  let restoring = mode === 'restore',
    admitted = false,
    stage = 'initialize';
  let context, browser, anonymous, auth, ca, failure, restorationFailure;
  const locks = [],
    secrets = [],
    browserClosures = new Set();
  const stamp = () => ({
    at: new Date().toISOString(),
    elapsedNanoseconds: (process.hrtime.bigint() - originNs).toString(),
  });
  const event = (kind, details = {}) => {
    const row = { ...stamp(), kind, ...details };
    eventTail = eventTail
      .catch(() => {})
      .then(async () => {
        try {
          await events.writeFile(JSON.stringify(row) + '\n');
          await events.sync();
        } catch (error) {
          report.evidencePersistenceFailed = true;
          if (!restoring) throw error;
        }
      });
    return eventTail;
  };
  const save = () => {
    const copy = globalThis.structuredClone(state);
    stateTail = stateTail.catch(() => {}).then(() => atomicState(statePath, copy));
    return stateTail;
  };
  async function saveCleanup() {
    try {
      await save();
    } catch {
      report.evidencePersistenceFailed = true;
    }
  }
  const { command: rawCommand, assertClosed } = commandRunner({
    root,
    signal: abort.signal,
    event,
  });
  async function phase(value) {
    stage = value;
    await event('stage', { stage });
    console.log(JSON.stringify({ session, attempt, stage }));
  }
  async function acquire(path) {
    await safeDirectory(dirname(path));
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST' || mode !== 'restore') throw error;
      const old = JSON.parse(await privateFile(path));
      requireValue(
        old.owner === owner && old.session === session && !live(old.pid),
        'WINDOW_LOCK_HELD',
      );
      await rename(path, path + '.retained-' + randomUUID());
      handle = await open(path, 'wx', 0o600);
    }
    const info = await handle.stat();
    locks.push({ path, handle, inode: info.ino, device: info.dev });
    await handle.writeFile(encode({ owner, session, attempt, pid: process.pid }));
    await handle.sync();
  }
  async function diskFloor() {
    const disk = await statfs(root),
      available = disk.bavail * disk.bsize;
    report.minimumAvailableDiskBytes = Math.min(
      report.minimumAvailableDiskBytes ?? Infinity,
      available,
    );
    requireValue(available >= 8 * 1024 ** 3, 'DISK_RESERVE_REQUIRED');
  }
  async function verifyNativeBinary() {
    requireValue(
      state.nativeBinary === resolve(directory, 'native-bridge'),
      'NATIVE_BINARY_PATH_CHANGED',
    );
    requireValue(
      hash(await privateFile(state.nativeBinary, 32 * 1024 * 1024)) === state.nativeBinarySha256,
      'NATIVE_BINARY_CHANGED',
    );
  }
  async function command(label, binary, args, options = {}) {
    if (!options.mutation) return rawCommand(label, binary, args, options);
    requireValue(
      options.mutation === 'compile'
        ? binary === '/usr/bin/clang' && args.at(-1) === state.nativeBinary
        : binary === state.nativeBinary && args.at(-1) === state.id,
      'MUTATION_COMMAND_INVALID',
    );
    const record = {
      label,
      action: options.mutation,
      binary,
      tail: args.join(' '),
      attempt,
      ...stamp(),
    };
    (state.commands ??= []).push(record);
    try {
      await save();
    } catch (error) {
      if (!options.cleanup || !restoreWithoutNewIntent.has(options.mutation)) throw error;
      report.evidencePersistenceFailed = true;
      return rawCommand(label, binary, args, options);
    }
    let closed = false;
    try {
      const output = await rawCommand(label, binary, args, {
        ...options,
        onSpawn: async (pid) => {
          record.pid = pid;
          record.processGroup = pid;
          await save();
          if (live(pid)) {
            try {
              record.processStart = await rawCommand(
                'reader-command-start',
                '/bin/ps',
                ['-p', String(pid), '-o', 'lstart='],
                { cleanup: true, timeoutMs: 5000 },
              );
            } catch (error) {
              if (live(pid)) throw error;
            }
            await save();
          }
        },
      });
      closed = true;
      return output;
    } catch (error) {
      closed = error.commandClosed === true;
      error.commandSpawned = Number.isInteger(record.pid);
      throw error;
    } finally {
      if (closed) {
        record.closedAt = new Date().toISOString();
        if (restoring) await saveCleanup();
        else await save();
      }
    }
  }
  async function native(action, request = {}, cleanup = restoring) {
    try {
      await verifyNativeBinary();
    } catch (error) {
      error.commandSpawned = false;
      error.pressAttempted = false;
      throw error;
    }
    const options = {
      input: JSON.stringify(request),
      timeoutMs:
        action === 'voiceover-consent'
          ? consentHelperTimeoutMs
          : action === 'voiceover'
            ? 15000
            : 20000,
      cleanup,
      ...(mutableNativeActions.has(action) ? { mutation: action } : {}),
    };
    let output;
    try {
      output = await command(
        'native-' + action,
        state.nativeBinary,
        ['--action', action, '--session', state.id],
        options,
      );
    } catch (error) {
      try {
        const result = JSON.parse(error.privateStdout ?? '');
        if (result.ok === false && /^SCREEN_READER_[A-Z0-9_]+$/u.test(result.code)) {
          const rejected = new Error(result.code);
          rejected.nativeCode = result.nativeCode;
          rejected.pressAttempted = result.pressAttempted;
          rejected.consentRequestAttempted = result.consentRequestAttempted;
          rejected.commandClosed = error.commandClosed === true;
          rejected.commandSpawned = error.commandSpawned === true;
          throw rejected;
        }
      } catch (decoded) {
        if (/^SCREEN_READER_[A-Z0-9_]+$/u.test(decoded.message ?? '')) throw decoded;
      }
      throw error;
    }
    const result = JSON.parse(output);
    requireValue(result.ok === true && result.result, 'NATIVE_RESPONSE_INVALID');
    return result.result;
  }
  async function preference(domain, key) {
    let type;
    try {
      type = await rawCommand('preference-type', '/usr/bin/defaults', ['read-type', domain, key], {
        cleanup: restoring,
        timeoutMs: 5000,
      });
    } catch (error) {
      if (
        error.exitCode === 1 &&
        !error.wasInterrupted &&
        /does not exist/u.test(error.privateStderr ?? '')
      )
        return { exists: false, value: null };
      throw error;
    }
    requireValue(/boolean/iu.test(type), 'PREFERENCE_NOT_BOOLEAN');
    const value = await rawCommand('preference-value', '/usr/bin/defaults', ['read', domain, key], {
      cleanup: restoring,
      timeoutMs: 5000,
    });
    requireValue(['0', '1'].includes(value), 'PREFERENCE_VALUE_INVALID');
    return { exists: true, value: value === '1' };
  }
  async function snapshot() {
    const observed = await native('observe');
    return {
      ...observed,
      activationClient: await preference('com.apple.universalaccess', 'voiceOverOnOffKey'),
      scriptingClient: await preference('com.apple.VoiceOver4', 'SCREnableAppleScript'),
    };
  }
  async function identity(pid) {
    return (await native('identity', { pid })).identity;
  }
  async function quiesceCommands() {
    assertClosed();
    for (const record of state.commands ?? []) {
      if (record.closedAt) continue;
      requireValue(
        record.action === 'compile'
          ? record.binary === '/usr/bin/clang' &&
              record.tail?.endsWith('-o ' + state.nativeBinary) &&
              record.tail.includes(nativeSource)
          : record.binary === state.nativeBinary && record.tail?.endsWith('--session ' + state.id),
        'COMMAND_INTENT_CHANGED',
      );
      const rows = (
        await rawCommand(
          'find-interrupted-reader-command',
          '/bin/ps',
          ['-axo', 'pid=,pgid=,command='],
          { cleanup: true, timeoutMs: 5000 },
        )
      )
        .split('\n')
        .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line))
        .filter(Boolean)
        .map((match) => ({ pid: Number(match[1]), group: Number(match[2]), command: match[3] }));
      const matches = rows.filter((row) => row.command.endsWith(record.binary + ' ' + record.tail));
      requireValue(matches.length <= 1, 'COMMAND_PROCESS_AMBIGUOUS');
      if (matches.length) {
        const match = matches[0];
        const start = await rawCommand(
          'interrupted-reader-start',
          '/bin/ps',
          ['-p', String(match.pid), '-o', 'lstart='],
          { cleanup: true, timeoutMs: 5000 },
        );
        const cwd = await rawCommand(
          'interrupted-reader-cwd',
          '/usr/sbin/lsof',
          ['-a', '-p', String(match.pid), '-d', 'cwd', '-Fn'],
          { cleanup: true, timeoutMs: 5000 },
        );
        requireValue(
          match.pid === match.group &&
            cwd.split('\n').includes('n' + root) &&
            (!record.pid || record.pid === match.pid) &&
            (!record.processStart || record.processStart === start),
          'COMMAND_PROCESS_CHANGED',
        );
        const alive = () => {
          try {
            process.kill(-match.group, 0);
            return true;
          } catch (error) {
            if (error.code === 'ESRCH') return false;
            throw error;
          }
        };
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          if (!alive()) break;
          if (live(match.pid))
            requireValue(
              (await rawCommand(
                'reader-command-recheck',
                '/bin/ps',
                ['-p', String(match.pid), '-o', 'lstart='],
                { cleanup: true, timeoutMs: 5000 },
              )) === start,
              'COMMAND_PROCESS_CHANGED',
            );
          try {
            process.kill(-match.group, signal);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
          try {
            await waitFor(alive, (value) => !value, { timeoutMs: 5000 });
          } catch {
            /* Escalate only this verified group. */
          }
        }
        requireValue(!alive(), 'COMMAND_GROUP_STILL_RUNNING');
      } else {
        requireValue(
          !live(record.pid) &&
            (!record.processGroup || !rows.some((row) => row.group === record.processGroup)),
          'ORPHANED_COMMAND_REQUIRES_REVIEW',
        );
      }
      record.closedAt = new Date().toISOString();
      record.interrupted = true;
      await saveCleanup();
    }
  }
  function inLaunchWindow(processIdentity, intent) {
    const seconds = Date.parse(intent?.at ?? '') / 1000;
    return (
      Number.isFinite(seconds) &&
      processIdentity.startSeconds >= Math.floor(seconds) - 1 &&
      processIdentity.startSeconds <= seconds + 30
    );
  }
  async function rememberProcesses(observed, cleanup = false) {
    for (const row of observed.processes) {
      try {
        requireValue(
          nativePaths[row.kind] === row.identity.path && row.identity.uid === process.getuid(),
          'NATIVE_PROCESS_PATH_CHANGED',
        );
        const existing = (state.ownedApplications ?? []).find((saved) =>
          isDeepStrictEqual(saved.identity, row.identity),
        );
        if (existing) continue;
        const intents =
          row.kind === 'settings'
            ? [state.settingsIntent, ...(state.settingsReopenIntents ?? [])]
            : [state.voiceOverIntent, state.welcomeIntent].filter(
                (intent) =>
                  intent?.submission?.error?.pressAttempted !== false &&
                  intent?.submission?.error?.commandSpawned !== false &&
                  intent?.submission?.response?.pressAttempted !== false,
              );
        requireValue(
          intents.some((intent) => inLaunchWindow(row.identity, intent)),
          'UNOWNED_NATIVE_PROCESS',
        );
        (state.ownedApplications ??= []).push({
          ...row,
          observedAt: new Date().toISOString(),
          basis:
            'absent at baseline and exact executable started within the recorded launch window',
        });
        if (row.kind === 'settings') state.settingsIdentity = row.identity;
        if (cleanup) await saveCleanup();
        else await save();
      } catch (error) {
        if (!cleanup) throw error;
        (report.cleanupIdentityFailures ??= []).push({
          kind: row.kind,
          pid: row.identity?.pid ?? null,
          code: errorCode(error),
        });
      }
    }
  }
  const ownedApplication = (row) =>
    (state.ownedApplications ?? []).some(
      (saved) => saved.kind === row.kind && isDeepStrictEqual(saved.identity, row.identity),
    );
  async function waitForSettings(purpose) {
    return waitFor(
      async () => {
        const observed = await snapshot();
        await rememberProcesses(observed, restoring);
        const settings = observed.processes.filter((row) => row.kind === 'settings');
        requireValue(settings.length <= 1, 'SETTINGS_PROCESS_AMBIGUOUS');
        if (!settings.length) return null;
        requireValue(ownedApplication(settings[0]), 'SETTINGS_PROCESS_NOT_OWNED');
        try {
          return {
            identity: settings[0].identity,
            control: await native('settings-read', { identity: settings[0].identity }),
          };
        } catch (error) {
          const readCode = errorCode(error);
          if (
            [
              'SCREEN_READER_SETTINGS_WINDOW_NOT_READY',
              'SCREEN_READER_VOICEOVER_PANE_UNCONFIRMED',
            ].includes(readCode) &&
            !(state.settingsNavigationIntents ?? []).some(
              (intent) =>
                intent.purpose === purpose &&
                isDeepStrictEqual(intent.identity, settings[0].identity),
            )
          ) {
            const intent = { ...stamp(), attempt, purpose, identity: settings[0].identity };
            (state.settingsNavigationIntents ??= []).push(intent);
            await save();
            try {
              intent.response = await native('settings-reopen', { identity: settings[0].identity });
            } catch (reopenError) {
              intent.error = {
                code: errorCode(reopenError),
                nativeCode: reopenError.nativeCode ?? null,
              };
              if (
                ![
                  'SCREEN_READER_SETTINGS_REOPEN_EVENT_FAILED',
                  'SCREEN_READER_SETTINGS_REOPEN_REPLY_FAILED',
                ].includes(intent.error.code) &&
                !(
                  intent.error.code === 'SCREEN_READER_COMMAND_FAILED' &&
                  reopenError.commandClosed === true
                )
              )
                throw reopenError;
            }
            report.nativeActions.push({ action: 'settings-reopen', ...intent });
            await save();
          }
          if (
            [
              'SCREEN_READER_SETTINGS_WINDOW_NOT_READY',
              'SCREEN_READER_VOICEOVER_SWITCH_NOT_UNIQUE',
              'SCREEN_READER_VOICEOVER_PANE_UNCONFIRMED',
              'SCREEN_READER_ACCESSIBILITY_READ_FAILED',
            ].includes(error.message)
          ) {
            (report.settingsReadFailures ??= []).push({ ...stamp(), purpose, code: readCode });
            return null;
          }
          throw error;
        }
      },
      Boolean,
      { timeoutMs: 15000, signal: restoring ? undefined : abort.signal },
    );
  }
  async function ensureSettingsForRestore() {
    const observed = await snapshot();
    await rememberProcesses(observed, true);
    const settings = observed.processes.filter((row) => row.kind === 'settings');
    requireValue(settings.length <= 1, 'SETTINGS_PROCESS_AMBIGUOUS');
    if (!settings.length) {
      (state.settingsReopenIntents ??= []).push(stamp());
      await save();
      await native('settings-open');
    }
    return waitForSettings('restore');
  }
  async function locateBrowser(cleanup = false) {
    if (!state.browserIntent) return null;
    requireValue(state.profile === resolve(directory, 'chrome-profile'), 'BROWSER_PROFILE_CHANGED');
    const rows = (
      await rawCommand('find-owned-reader-browser', '/bin/ps', ['-axo', 'pid=,command='], {
        cleanup,
        timeoutMs: 5000,
      })
    )
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.+)$/u.exec(line))
      .filter(Boolean)
      .filter(
        (match) =>
          match[2].startsWith(chromePath + ' ') &&
          match[2].split(/\s+/u).includes('--user-data-dir=' + state.profile),
      );
    requireValue(rows.length <= 1, 'BROWSER_PROCESS_AMBIGUOUS');
    if (!rows.length) {
      requireValue(!live(state.browserIdentity?.pid), 'BROWSER_IDENTITY_CHANGED');
      return null;
    }
    const current = await identity(Number(rows[0][1]));
    requireValue(
      current?.path === chromePath &&
        current.uid === process.getuid() &&
        current.processGroup === current.pid &&
        (!state.browserIdentity || isDeepStrictEqual(current, state.browserIdentity)),
      'BROWSER_IDENTITY_CHANGED',
    );
    state.browserIdentity = current;
    state.browserProcessGroup = current.processGroup;
    if (cleanup) await saveCleanup();
    else await save();
    return current;
  }
  async function terminateOwned(expected) {
    const current = await identity(expected.pid);
    if (!current) return;
    requireValue(isDeepStrictEqual(current, expected), 'OWNED_PROCESS_CHANGED');
    for (const signal of ['TERM', 'KILL']) {
      const fresh = await identity(expected.pid);
      if (!fresh) return;
      requireValue(isDeepStrictEqual(fresh, expected), 'OWNED_PROCESS_CHANGED');
      await native('terminate', { identity: expected, signal });
      try {
        await waitFor(
          () => identity(expected.pid),
          (value) => !value,
          { timeoutMs: signal === 'TERM' ? 8000 : 5000 },
        );
        return;
      } catch {
        /* Revalidate the same PID/start token before escalation. */
      }
    }
    requireValue(!(await identity(expected.pid)), 'OWNED_PROCESS_STILL_RUNNING');
  }
  function browserGroupClosed() {
    if (!state.browserProcessGroup) return true;
    requireValue(state.browserProcessGroup === state.browserIdentity?.pid, 'BROWSER_GROUP_CHANGED');
    try {
      process.kill(-state.browserProcessGroup, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  }
  async function restoreResources() {
    restoring = true;
    await phase('restore-native-state');
    const failures = [];
    const attemptCleanup = async (name, action) => {
      try {
        await action();
      } catch (error) {
        failures.push({ name, code: errorCode(error), nativeCode: error.nativeCode ?? null });
      }
    };
    // A consent helper must have ended before any restoration or window
    // observation. An unconfirmed group leaves recovery explicitly incomplete.
    if (state.automationConsentIntent) {
      await quiesceCommands();
      if (state.automationConsentIntent.submission?.status !== 'granted-and-browser-focused')
        await observeConsentWindows('after-helper-before-native-restoration');
    } else await attemptCleanup('pending-command-closure', quiesceCommands);
    if (state.runBaseline && state.restorationRequired) {
      await attemptCleanup('native-off', async () => {
        const observed = await snapshot();
        await rememberProcesses(observed, true);
        if (!readerActivationObserved(observed, false)) {
          // Actual off with lagging preference propagation needs observation,
          // never a UI toggle. A retained off intent is also observation-only.
          const observeOnly = Boolean(state.nativeOffIntent) || observed.voiceOverEnabled === false;
          const settings = observeOnly ? null : await ensureSettingsForRestore();
          await observeReaderNativeOnce({
            attempted: observeOnly,
            persistIntent: async () => {
              state.nativeOffIntent = { ...stamp(), attempt, identity: settings.identity };
              await save();
            },
            submit: () => native('settings-off', { identity: settings.identity }),
            record: async (submission) => {
              report.nativeActions.push({ action: 'settings-off', ...submission });
              if (state.nativeOffIntent && !submission.priorAttempt)
                state.nativeOffIntent.submission = submission;
              await save();
            },
            observe: snapshot,
            matches: (value) => readerActivationObserved(value, false),
          });
        }
      });
      await attemptCleanup('reader-process-observation', async () => {
        const observed = await snapshot();
        await rememberProcesses(observed, true);
        for (const row of observed.processes.filter(
          (value) => value.kind !== 'settings' && ownedApplication(value),
        ))
          await attemptCleanup('exit-' + row.kind + '-' + row.identity.pid, () =>
            terminateOwned(row.identity),
          );
      });
      await attemptCleanup('scripting-preference-restoration', async () => {
        if (state.scriptingIntent) {
          await native('scripting-preference', { desired: state.runBaseline.scriptingClient });
          await waitFor(
            snapshot,
            (value) =>
              isDeepStrictEqual(value.scriptingClient, state.runBaseline.scriptingClient) &&
              isDeepStrictEqual(value.scriptingDisk, state.runBaseline.scriptingDisk),
            { timeoutMs: 12000 },
          );
        }
      });
    }
    const closeContext = async (value, label) => {
      if (!value) return;
      const record = { label, settled: false };
      browserClosures.add(record);
      const pending = Promise.resolve()
        .then(() => value.close())
        .finally(() => {
          record.settled = true;
        });
      await boundReaderClose(() => pending);
    };
    await attemptCleanup('anonymous-context-close', () => closeContext(anonymous, 'anonymous'));
    await attemptCleanup('persistent-context-close', () => closeContext(context, 'persistent'));
    await attemptCleanup('dedicated-browser-exit', async () => {
      const current = await locateBrowser(true);
      if (current) await terminateOwned(current);
      requireValue(!(await locateBrowser(true)), 'BROWSER_STILL_RUNNING');
      // A later restore never guesses ownership of a leaderless process group.
      // Wait for normal Chromium descendant closure and fail if it is unconfirmed.
      await waitFor(browserGroupClosed, Boolean, { timeoutMs: 8000 });
      await waitFor(() => [...browserClosures].every((record) => record.settled), Boolean, {
        timeoutMs: 5000,
      });
      context = undefined;
      anonymous = undefined;
      browser = undefined;
    });
    await attemptCleanup('settings-process-exit', async () => {
      const observed = await snapshot();
      await rememberProcesses(observed, true);
      for (const row of observed.processes.filter(
        (value) => value.kind === 'settings' && ownedApplication(value),
      ))
        await attemptCleanup('exit-settings-' + row.identity.pid, () =>
          terminateOwned(row.identity),
        );
    });
    await attemptCleanup('foreground-restoration', async () => {
      if (!state.runBaseline?.foreground) return;
      requireValue(
        isDeepStrictEqual(
          await identity(state.runBaseline.foreground.pid),
          state.runBaseline.foreground,
        ),
        'ORIGINAL_FOREGROUND_CHANGED',
      );
      await native('foreground', { identity: state.runBaseline.foreground });
    });
    await attemptCleanup('final-native-state', async () => {
      if (!state.runBaseline) return;
      const first = await snapshot();
      await delay(700);
      const second = await snapshot();
      report.restoration = {
        before: state.runBaseline,
        first,
        after: second,
        observedTwice: true,
        failures,
      };
      requireValue(
        readerNativeRestored(state.runBaseline, first) &&
          readerNativeRestored(state.runBaseline, second),
        'NATIVE_STATE_NOT_RESTORED',
      );
      requireValue(
        isDeepStrictEqual(second.foreground, state.runBaseline.foreground),
        'FOREGROUND_NOT_RESTORED',
      );
      requireValue(!(await locateBrowser(true)), 'BROWSER_STILL_RUNNING');
      requireValue(browserGroupClosed(), 'BROWSER_DESCENDANTS_STILL_RUNNING');
      requireValue(
        [...browserClosures].every((record) => record.settled),
        'BROWSER_HANDLES_UNCONFIRMED',
      );
      assertClosed();
      requireValue(
        !report.cleanupIdentityFailures?.length && failures.length === 0,
        'CLEANUP_REQUIRES_REVIEW',
      );
      state.restorationRequired = false;
      state.restoredAt = new Date().toISOString();
      await saveCleanup();
    });
    report.restoration ??= { failures };
    report.restoration.failures = failures;
    report.restoration.complete = failures.length === 0 && state.restorationRequired === false;
    if (failures.length) throw new Error('SCREEN_READER_RESTORATION_INCOMPLETE');
  }
  async function verifyInputs() {
    for (const [path, expected] of Object.entries(state.protectedHashes ?? {}))
      requireValue(hash(await readFile(path)) === expected, 'PROTECTED_INPUT_CHANGED');
  }
  async function api(path) {
    const response = await requestJson('/api' + path, { ca, session: auth, signal: abort.signal });
    requireValue(response.status === 200 && response.body?.data, 'READ_ONLY_API_FAILED');
    return response.body.data;
  }
  async function identities(serviceIds) {
    const services = [],
      deployments = [];
    for (const id of serviceIds) services.push(readerServiceIdentity(await api('/services/' + id)));
    for (const id of Object.values(readerRecordIds))
      deployments.push(readerDeploymentIdentity(await api('/deployments/' + id)));
    return { services, deployments };
  }
  function guardContext(target) {
    target.on('page', (page) => {
      page.on('pageerror', () => report.requestAudit.pageErrors++);
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (
          url.origin === realOrigin &&
          url.pathname.startsWith('/api/') &&
          response.status() >= 400 &&
          !(url.pathname === '/api/auth/me' && response.status() === 401)
        )
          report.requestAudit.apiFailures.push({ path: url.pathname, status: response.status() });
      });
    });
    return target.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol)) {
        if (url.origin !== realOrigin) {
          report.requestAudit.blockedForeignRequests.push({
            method: request.method(),
            origin: url.origin,
          });
          return route.abort('blockedbyclient');
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          report.requestAudit.blockedWrites.push({ method: request.method(), path: url.pathname });
          return route.abort('blockedbyclient');
        }
      }
      return route.continue();
    });
  }
  async function assertPageSafe(page) {
    requireValue(new URL(page.url()).origin === realOrigin, 'PAGE_ORIGIN_CHANGED');
    const body = await page.locator('body').innerText();
    requireValue(
      secrets.every((secret) => !secret || !body.includes(secret)) &&
        !/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(body),
      'PRIVATE_VALUE_RENDERED',
    );
  }
  async function capture(name, request, page) {
    try {
      abort.signal.throwIfAborted();
      await diskFloor();
      await assertPageSafe(page);
      await native('foreground', { identity: state.browserIdentity });
      const result = await native('voiceover', {
        ...request,
        identity: state.voiceOverIdentity,
        browser: state.browserIdentity,
      });
      await assertPageSafe(page);
      requireValue(
        result.pidAddressed === true &&
          isDeepStrictEqual(result.identity, state.voiceOverIdentity) &&
          typeof result.phrase === 'string' &&
          result.phrase.length > 0,
        'REAL_PHRASE_REQUIRED',
      );
      requireValue(
        secrets.every((secret) => !secret || !result.phrase.includes(secret)) &&
          !/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(result.phrase),
        'PRIVATE_VALUE_SPOKEN',
      );
      report.phrases.push({ name, ...result, page: page.url(), request });
      await event('phrase-captured', {
        name,
        phraseSha256: hash(result.phrase),
        browserPid: state.browserIdentity.pid,
        voiceOverPid: state.voiceOverIdentity.pid,
      });
      await newFile(
        resolve(attemptDirectory, 'phrase-' + randomUUID() + '.json'),
        encode(report.phrases.at(-1)),
      );
      return result.phrase;
    } catch (cause) {
      const error = new Error(errorCode(cause));
      error.name = 'VoiceOverTransportError';
      error.nativeCode = cause.nativeCode;
      throw error;
    }
  }
  async function observeConsentWindows(stageName) {
    const intent = state.automationConsentIntent;
    if (!intent) return;
    let observation;
    try {
      observation = await native('consent-windows', {}, true);
    } catch (error) {
      observation = { status: 'unavailable', code: errorCode(error) };
    }
    (intent.windowObservations ??= []).push({ ...stamp(), stage: stageName, observation });
    // CG metadata does not correlate a window with a particular TCC request.
    intent.dialogClosure = 'unknown';
    report.automationConsent = intent;
    if (restoring) await saveCleanup();
    else await save();
  }
  async function prepare() {
    await phase('prepare-read-only');
    await diskFloor();
    state.nativeBinary = resolve(directory, 'native-bridge');
    state.profile = resolve(directory, 'chrome-profile');
    await safeDirectory(state.profile);
    await command(
      'compile-reader-native-bridge',
      '/usr/bin/clang',
      [
        '-fobjc-arc',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-deprecated-declarations',
        '-framework',
        'AppKit',
        '-framework',
        'ApplicationServices',
        '-framework',
        'IOKit',
        nativeSource,
        '-o',
        state.nativeBinary,
      ],
      { timeoutMs: 60000, mutation: 'compile' },
    );
    state.nativeBinarySha256 = hash(await privateFile(state.nativeBinary, 32 * 1024 * 1024));
    const descriptor = await native('self-test');
    requireValue(
      descriptor.status === 'passed' &&
        descriptor.eventsSent === 0 &&
        descriptor.consentRequests === 0 &&
        descriptor.osStateObserved === false &&
        descriptor.osStateChanged === false,
      'NATIVE_DESCRIPTOR_TEST_FAILED',
    );
    report.descriptorSelfTest = descriptor;
    state.preparedNative = await snapshot();
    report.preparation = {
      nativeBaseline: state.preparedNative,
      noAppStarted: true,
      noAuthentication: true,
      noPreferenceChanged: true,
      noAutomationConsentRequested: true,
    };
    requireReaderBaseline(state.preparedNative);
    requireValue(state.preparedNative.accessibilityTrusted, 'ACCESSIBILITY_NOT_AUTHORIZED');
    report.certificate = await verifyRealEntryCertificate();
    const product = await readRealState();
    state.clusterId = product.resources.cluster;
    state.productStateId = product.id;
    const code = [
      resolve(import.meta.dirname, 'g-mvp-screen-reader.mjs'),
      nativeSource,
      resolve(import.meta.dirname, 'support/g-mvp-screen-reader-checks.mjs'),
      resolve(import.meta.dirname, 's6-real-support.ts'),
      resolve(root, 'tests/probes/support/g-mvp-recovery-joint-runtime.mjs'),
      '/System/Library/CoreServices/VoiceOver.app/Contents/Resources/VoiceOver.sdef',
      realCaPath,
      realStatePath,
      realPasswordPath,
    ];
    state.protectedHashes = {};
    for (const path of code) state.protectedHashes[path] = hash(await readFile(path));
    state.preparedAt = new Date().toISOString();
    state.status = 'prepared';
    state.restorationRequired = false;
    await save();
  }
  async function run() {
    state.runAttempt = attempt;
    state.status = 'running';
    await save();
    await phase('run-preflight');
    await diskFloor();
    await verifyInputs();
    ca = await readFile(realCaPath);
    report.certificate = await verifyRealEntryCertificate();
    const health = await requestJson('/api/health/ready', { ca, signal: abort.signal });
    requireValue(
      health.status === 200 && health.body?.mode === 'read_write',
      'ORIGINAL_API_NOT_WRITABLE',
    );
    state.runBaseline = await snapshot();
    requireReaderBaseline(state.runBaseline);
    requireValue(
      ['activationClient', 'activationDisk', 'scriptingClient', 'scriptingDisk'].every((key) =>
        isDeepStrictEqual(state.runBaseline[key], state.preparedNative[key]),
      ),
      'PREPARED_NATIVE_BASELINE_CHANGED',
    );
    requireValue(state.runBaseline.accessibilityTrusted, 'ACCESSIBILITY_NOT_AUTHORIZED');
    state.restorationRequired = true;
    state.ownedApplications = [];
    state.settingsIntent = stamp();
    await save();
    await phase('verify-native-restoration-control');
    await native('settings-open');
    const settings = await waitForSettings('baseline');
    requireValue(
      settings.control.switch.value === false && settings.control.voiceOverEnabled === false,
      'RESTORATION_CONTROL_NOT_OFF',
    );
    state.restorationControl = settings;
    await save();
    await phase('dedicated-browser-and-one-authentication');
    state.browserIntent = stamp();
    await save();
    const { chromium, expect } = await import('@playwright/test');
    context = await chromium.launchPersistentContext(state.profile, {
      channel: 'chrome',
      headless: false,
      baseURL: realOrigin,
      viewport: { width: 1440, height: 1000 },
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      colorScheme: 'light',
      args: ['--force-renderer-accessibility'],
    });
    browser = context.browser();
    requireValue(browser, 'DEDICATED_BROWSER_MISSING');
    await guardContext(context);
    const cdp = await browser.newBrowserCDPSession();
    const processes = await cdp.send('SystemInfo.getProcessInfo');
    await cdp.detach();
    const pid = processes.processInfo.find((row) => row.type === 'browser')?.id;
    requireValue(Number.isInteger(pid), 'BROWSER_PID_MISSING');
    const reportedIdentity = await identity(pid);
    requireValue(
      isDeepStrictEqual(await locateBrowser(), reportedIdentity),
      'BROWSER_OWNERSHIP_NOT_CONFIRMED',
    );
    report.browser = {
      identity: state.browserIdentity,
      version: browser.version(),
      profile: state.profile,
      trace: false,
      video: false,
      screenshots: false,
    };
    const password = (await privateFile(realPasswordPath)).toString('utf8').trim();
    secrets.push(password);
    state.authenticationIntent = stamp();
    state.authenticationAttempts = 1;
    report.requestAudit.authenticationAttempts = 1;
    await save();
    const login = await requestJson('/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password },
      ca,
      signal: abort.signal,
    });
    const cookie = login.headers['set-cookie']?.find((value) => value.startsWith('ozz_session='));
    requireValue(
      login.status === 200 &&
        cookie &&
        /;\s*HttpOnly(?:;|$)/iu.test(cookie) &&
        /;\s*SameSite=Strict(?:;|$)/iu.test(cookie) &&
        typeof login.body?.data?.csrfToken === 'string',
      'NEW_AUTHENTICATION_FAILED',
    );
    auth = { cookie: cookie.split(';')[0], csrf: login.body.data.csrfToken };
    secrets.push(auth.cookie, auth.cookie.slice('ozz_session='.length), auth.csrf);
    state.authenticationFile = resolve(directory, 'auth-session.json');
    await newFile(
      state.authenticationFile,
      encode({
        owner,
        session: state.session,
        id: state.id,
        origin: realOrigin,
        createdAt: new Date().toISOString(),
        ...auth,
      }),
    );
    state.authenticationReceipt = {
      attempts: 1,
      sessionSha256: hash(auth.cookie),
      csrfSha256: hash(auth.csrf),
      accepted: true,
    };
    await save();
    const me = await api('/auth/me');
    requireValue(
      me.user?.username === 'admin' && me.csrfToken === auth.csrf,
      'NEW_SESSION_NOT_VERIFIED',
    );
    await context.addCookies([
      {
        name: 'ozz_session',
        value: auth.cookie.slice('ozz_session='.length),
        domain: '127.0.0.1',
        path: '/api',
        httpOnly: true,
        secure: /;\s*Secure(?:;|$)/iu.test(cookie),
        sameSite: 'Strict',
      },
    ]);
    const deployments = [];
    for (const id of Object.values(readerRecordIds))
      deployments.push(await api('/deployments/' + id));
    requireValue(
      deployments[0].snapshot?.version === 3 && deployments[0].snapshot?.source?.kind === 'github',
      'RETAINED_GIT_RECORD_CHANGED',
    );
    requireValue(
      deployments[1].status === 'failed' &&
        deployments[1].failureObservation?.pods?.some((pod) =>
          pod.containers?.some((container) => container.oomKilled),
        ),
      'RETAINED_OOM_RECORD_CHANGED',
    );
    const serviceIds = [...new Set(deployments.map((row) => row.serviceId))];
    report.beforeIdentity = await identities(serviceIds);
    anonymous = await browser.newContext({
      baseURL: realOrigin,
      viewport: { width: 1440, height: 1000 },
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
    });
    await guardContext(anonymous);
    const landing = await context.newPage();
    await landing.goto('/');
    await landing.bringToFront();
    const activationSettings = await waitForSettings('activation');
    requireValue(activationSettings.control.switch.value === false, 'RESTORATION_CONTROL_NOT_OFF');
    await native('foreground', { identity: state.browserIdentity });
    await phase('one-native-voiceover-activation');
    state.scriptingIntent = { ...stamp(), before: state.runBaseline.scriptingClient };
    await save();
    await native('scripting-preference', { desired: { exists: true, value: true } });
    await waitFor(
      snapshot,
      (value) => value.scriptingClient?.value === true && value.scriptingDisk?.value === true,
      { timeoutMs: 10000, signal: abort.signal },
    );
    requireReaderUnlockedDesktop(await snapshot());
    await observeReaderNativeOnce({
      attempted: Boolean(state.voiceOverIntent),
      persistIntent: async () => {
        state.voiceOverIntent = {
          ...stamp(),
          attempt,
          method: 'verified-settings-switch',
          identity: activationSettings.identity,
        };
        state.activationRequests = 1;
        await save();
      },
      submit: () =>
        native('settings-on', {
          browser: state.browserIdentity,
          identity: activationSettings.identity,
        }),
      record: async (submission) => {
        state.voiceOverIntent.submission = submission;
        report.nativeActions.push({ action: 'settings-on', ...submission });
        await save();
      },
      observe: snapshot,
      matches: (value) => readerActivationObserved(value, true),
      signal: abort.signal,
    });
    let stableIdentity, stableSince;
    await waitFor(
      async () => {
        const observed = await snapshot();
        await rememberProcesses(observed);
        const voices = observed.processes.filter((row) => row.kind === 'voiceover');
        const welcome = observed.processes.filter((row) => row.kind === 'quickstart');
        requireValue(voices.length <= 1 && welcome.length <= 1, 'READER_STARTUP_AMBIGUOUS');
        if (welcome.length && !state.welcomeIntent) {
          let control;
          try {
            control = await native('welcome-read', { identity: welcome[0].identity });
          } catch (error) {
            if (
              [
                'SCREEN_READER_WELCOME_WINDOW_NOT_UNIQUE',
                'SCREEN_READER_ACCESSIBILITY_READ_FAILED',
              ].includes(error.message)
            )
              return false;
            throw error;
          }
          await observeReaderNativeOnce({
            attempted: false,
            persistIntent: async () => {
              state.welcomeIntent = { ...stamp(), attempt, identity: welcome[0].identity, control };
              await save();
            },
            submit: () =>
              native('welcome-continue', {
                identity: welcome[0].identity,
                windowTitle: control.windowTitle,
                button: control.button,
                method: control.method,
                welcomeEvidence: control.welcomeEvidence,
              }),
            record: async (submission) => {
              state.welcomeIntent.submission = submission;
              report.nativeActions.push({ action: 'welcome-continue', ...submission });
              await save();
            },
            observe: async () => {
              const current = await snapshot();
              await rememberProcesses(current);
              return current;
            },
            matches: (value) =>
              readerActivationObserved(value, true) &&
              value.processes.filter((row) => row.kind === 'voiceover').length === 1 &&
              !value.processes.some(
                (row) =>
                  row.kind === 'quickstart' && isDeepStrictEqual(row.identity, welcome[0].identity),
              ),
            signal: abort.signal,
          });
        }
        if (!observed.voiceOverEnabled || voices.length !== 1) {
          stableIdentity = undefined;
          stableSince = undefined;
          return false;
        }
        if (!isDeepStrictEqual(stableIdentity, voices[0].identity)) {
          stableIdentity = voices[0].identity;
          stableSince = process.hrtime.bigint();
          return false;
        }
        return process.hrtime.bigint() - stableSince >= 1_000_000_000n;
      },
      Boolean,
      { timeoutMs: 20000, signal: abort.signal },
    );
    state.voiceOverIdentity = stableIdentity;
    await save();
    if (consentAllowed) {
      await phase('one-explicit-system-consent-request');
      const consentBrowser = state.browserIdentity;
      const requireConsentIdentities = async () => {
        abort.signal.throwIfAborted();
        requireValue(
          (state.ownedApplications ?? []).some(
            (row) => row.kind === 'voiceover' && isDeepStrictEqual(row.identity, stableIdentity),
          ) &&
            isDeepStrictEqual(await identity(stableIdentity.pid), stableIdentity) &&
            isDeepStrictEqual(await identity(consentBrowser.pid), consentBrowser),
          'CONSENT_PROCESS_IDENTITY_CHANGED',
        );
      };
      await requireConsentIdentities();
      await landing.bringToFront();
      await native('foreground', { identity: consentBrowser });
      requireValue(
        await landing.evaluate(() => globalThis.document.hasFocus()),
        'CONSENT_BROWSER_FOCUS_NOT_READY',
      );
      await requireConsentIdentities();
      await requestReaderConsentOnce({
        allowed: consentAllowed,
        attempted: Boolean(state.automationConsentIntent),
        identity: stableIdentity,
        browser: consentBrowser,
        signal: abort.signal,
        persistIntent: async () => {
          requireValue(!state.automationConsentIntent, 'CONSENT_REQUEST_ALREADY_USED');
          state.automationConsentIntent = {
            ...stamp(),
            id: randomUUID(),
            attempt,
            identity: stableIdentity,
            browser: consentBrowser,
            eventClass: 'VOAS',
            eventID: 'perC',
            firstCommand: firstVoiceOverCommand,
            requestBudgetConsumed: true,
            nativeWaitSeconds: 120,
            helperTimeoutMs: consentHelperTimeoutMs,
            promptDisplayed: 'unknown',
            dialogClosure: 'unknown',
            tccAuthorizationMayPersist: true,
          };
          report.automationConsent = state.automationConsentIntent;
          await save();
          await observeConsentWindows('before-request');
        },
        submit: () =>
          native('voiceover-consent', {
            allowSystemConsentOnce: true,
            intentId: state.automationConsentIntent.id,
            identity: stableIdentity,
            browser: consentBrowser,
            firstCommand: firstVoiceOverCommand,
          }),
        reestablishBrowser: async () => {
          await requireConsentIdentities();
          await observeConsentWindows('after-helper-before-browser-focus');
          await landing.bringToFront();
          abort.signal.throwIfAborted();
          await native('foreground', { identity: consentBrowser });
          requireValue(
            await landing.evaluate(() => globalThis.document.hasFocus()),
            'CONSENT_BROWSER_FOCUS_NOT_RESTORED',
          );
          await requireConsentIdentities();
        },
        record: async (submission) => {
          if (state.automationConsentIntent) {
            state.automationConsentIntent.submission = { ...stamp(), ...submission };
            report.automationConsent = state.automationConsentIntent;
            await save();
          }
        },
      });
    }
    abort.signal.throwIfAborted();
    await phase('twelve-real-voiceover-checks');
    await runReaderChecks({
      context,
      anonymous,
      clusterId: state.clusterId,
      expect,
      capture,
      checks: report.checks,
      checkpoint: async () => {
        await event('reader-check', report.checks.at(-1));
        abort.signal.throwIfAborted();
      },
    });
    report.afterIdentity = await identities(serviceIds);
    requireValue(
      isDeepStrictEqual(report.beforeIdentity, report.afterIdentity),
      'PRODUCT_IDENTITIES_CHANGED',
    );
    report.identityPreserved = true;
    requireValue(
      readerChecksPassed(report.checks) && report.phrases.length >= readerCheckNames.length,
      'SCREEN_READER_CHECKS_INCOMPLETE',
    );
    requireValue(
      report.requestAudit.blockedWrites.length === 0 &&
        report.requestAudit.blockedForeignRequests.length === 0 &&
        report.requestAudit.apiFailures.length === 0 &&
        report.requestAudit.pageErrors === 0,
      'PAGE_REQUEST_AUDIT_FAILED',
    );
    await verifyInputs();
    await diskFloor();
    report.authentication = state.authenticationReceipt;
    report.productScreenReaderPassed = true;
  }

  try {
    for (const path of [
      statePath + '.lock',
      resolve(sessionsRoot, 'window.lock'),
      resolve(lab, 'g-mvp-ui-final.lock'),
      resolve(lab, 'g-mvp-recovery-joint-timing/window.lock'),
      resolve(lab, 'g-mvp-recovery/state.json.lock'),
      resolve(lab, 's6-product/state.json.lock'),
      resolve(lab, 's6-webhook/state.json.lock'),
      resolve(lab, 's6-builder-faults/state.json.lock'),
      resolve(lab, 'g-mvp-workload-faults/probe.lock'),
    ])
      await acquire(path);
    if (state)
      requireValue(
        hash(await privateFile(statePath, 16 * 1024 * 1024)) === loadedDigest,
        'STATE_CHANGED_BEFORE_LOCK',
      );
    else {
      try {
        await lstat(statePath);
        throw new Error('SCREEN_READER_STATE_CHANGED_BEFORE_LOCK');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    admitted = true;
    if (state) report.id = state.id;
    if (mode === 'run') {
      const receipt = await finalReceipt();
      requireValue(
        receipt.mode === 'prepare' &&
          receipt.status === 'passed' &&
          receipt.closure?.eventsClosed &&
          receipt.closure.failures?.length === 0,
        'PASSED_PREPARE_RECEIPT_REQUIRED',
      );
    }
    if (state) await newFile(resolve(attemptDirectory, 'state-before.json'), encode(state));
    state ??= {
      formatVersion: 1,
      owner,
      session,
      id: randomUUID(),
      status: 'preparing',
      restorationRequired: false,
    };
    report.id = state.id;
    if (mode === 'prepare') {
      await save();
      await prepare();
    } else if (mode === 'run') await run();
    else {
      if (state.restorationRequired) {
        requireValue(state.runBaseline, 'RESTORATION_BASELINE_MISSING');
        await verifyNativeBinary();
        await restoreResources();
      } else {
        // An interrupted prepare can retain compiler commands and window locks,
        // while having made no native change. Close only those owned commands.
        await quiesceCommands();
        report.restoration = {
          complete: true,
          nativeChangePreviouslyRequired: false,
          failures: [],
        };
      }
      report.resumedAcrossProcesses = true;
      report.productScreenReaderPassed = false;
    }
  } catch (error) {
    failure = { stage, code: errorCode(error), nativeCode: error.nativeCode ?? null };
  } finally {
    if (admitted && mode === 'run' && state?.restorationRequired) {
      try {
        await restoreResources();
      } catch (error) {
        restorationFailure = {
          code: errorCode(error),
          retry: `pnpm exec node apps/console/tests/local-lab/g-mvp-screen-reader.mjs restore --session ${session}`,
        };
      }
    }
    try {
      assertClosed();
    } catch (error) {
      restorationFailure ??= { code: errorCode(error) };
    }
    report.failure = failure ?? null;
    report.restorationFailure = restorationFailure ?? null;
    if (state?.automationConsentIntent) {
      report.automationConsent = state.automationConsentIntent;
      report.consentInteractionUnconfirmed =
        state.automationConsentIntent.submission?.status !== 'granted-and-browser-focused';
      if (report.restoration)
        report.restoration.scope =
          'Native VoiceOver/preferences/owned processes/prior foreground; excludes TCC and system-dialog closure.';
    }
    report.nativeRestorationComplete = report.restoration?.complete ?? null;
    report.restorationComplete = report.consentInteractionUnconfirmed
      ? false
      : report.nativeRestorationComplete;
    report.completedAt = new Date().toISOString();
    report.status =
      failure ||
      restorationFailure ||
      report.evidencePersistenceFailed ||
      report.consentInteractionUnconfirmed ||
      (mode === 'run' &&
        (!report.productScreenReaderPassed ||
          !report.restoration?.complete ||
          state?.restorationRequired))
        ? 'failed'
        : 'passed';
    if (admitted && state) {
      state.status = mode === 'prepare' && report.status === 'passed' ? 'prepared' : 'finished';
      state.lastAttempt = attempt;
      state.lastMode = mode;
      state.lastReport = resolve(attemptDirectory, 'report.json');
      report.protectedHashes = state.protectedHashes;
      report.nativeBinarySha256 = state.nativeBinarySha256;
      report.result = publicState();
      try {
        await save();
      } catch {
        report.statePersistenceFailed = true;
        report.status = 'failed';
      }
    }
    report.closure = { eventsClosed: false, releasedLocks: [], failures: [] };
    try {
      await eventTail.catch(() => {});
      await events.close();
      report.closure.eventsClosed = true;
    } catch {
      report.status = 'failed';
      report.closure.failures.push({ code: 'EVENTS_CLOSE_FAILED' });
    }
    for (const lock of locks.reverse()) {
      try {
        await lock.handle.close();
        const current = await lstat(lock.path);
        requireValue(
          current.ino === lock.inode &&
            current.dev === lock.device &&
            current.uid === process.getuid(),
          'LOCK_IDENTITY_CHANGED',
        );
        await unlink(lock.path);
        report.closure.releasedLocks.push(lock.path);
      } catch {
        report.status = 'failed';
        report.closure.failures.push({ path: lock.path, code: 'LOCK_RELEASE_FAILED' });
      }
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (report.result) report.result.status = statusOf(report);
    await newFile(resolve(attemptDirectory, 'report.json'), encode(report));
    console.log(
      JSON.stringify({
        status: report.status,
        mode,
        session,
        report: resolve(attemptDirectory, 'report.json'),
        checks: report.checks.map(({ name, status }) => ({ name, status })),
        restorationComplete: report.restorationComplete,
        nativeRestorationComplete: report.nativeRestorationComplete,
        consentDialogClosure: report.automationConsent?.dialogClosure ?? null,
        consentInteractionUnconfirmed: report.consentInteractionUnconfirmed ?? false,
      }),
    );
  }
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        session: { type: 'string' },
        'allow-system-consent-once': { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    requireValue(positionals.length === 1 && typeof values.session === 'string', 'USAGE_INVALID');
    await runScreenReader(positionals[0], values.session, {
      allowSystemConsentOnce: values['allow-system-consent-once'],
    });
  } catch (error) {
    console.error(JSON.stringify({ code: errorCode(error) }));
    process.exitCode = 1;
  }
}
