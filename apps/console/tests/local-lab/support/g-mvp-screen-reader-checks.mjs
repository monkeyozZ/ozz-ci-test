import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// These are the retained product records used by the 2026-10-26 reader attempt.
// This module has no import-time IO and does not modify the accessibility tree.
export const readerRecordIds = Object.freeze({
  git: '7f089683-1eb7-40cb-bb98-e982b4be1c5b',
  oom: '81c34c92-48dd-4053-9716-0bcf9dc75a21',
});

export const readerCheckNames = Object.freeze([
  'login-username-label',
  'login-empty-password-label',
  'login-native-required-error',
  'project-selected-target',
  'project-target-inheritance-context',
  'project-slug-associated-help',
  'oom-disclosure-summary',
  'failed-deployment-status',
  'build-log-bounded-region',
  'build-log-source',
  'deployment-log-bounded-region',
  'deployment-log-source',
]);

const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');

export function readerServiceIdentity(value) {
  return {
    id: value.id,
    revision: value.revision,
    configRevision: value.configRevision,
    desiredState: value.desiredState,
    configurationState: value.configurationState,
    publishedDeploymentId: value.published?.deploymentId ?? null,
    publishedHash: digest(value.published),
    configurationHash: digest(value.configuration),
    activeTask: value.activeTask ?? null,
  };
}

export function readerDeploymentIdentity(value) {
  return {
    id: value.id,
    serviceId: value.serviceId,
    status: value.status,
    attempt: value.attempt,
    snapshotHash: digest(value.snapshot),
    failureObservationHash: digest(value.failureObservation),
    imageHash: digest(value.resolvedImage),
  };
}

export function readerChecksPassed(checks) {
  return (
    Array.isArray(checks) &&
    checks.length === readerCheckNames.length &&
    readerCheckNames.every(
      (name, index) => checks[index]?.name === name && checks[index]?.status === 'passed',
    )
  );
}

export function readerCheckFailureCode(error) {
  if (error?.name === 'VoiceOverTransportError') return 'SCREEN_READER_VOICEOVER_TRANSPORT_FAILED';
  if (error?.name === 'AbortError') return 'SCREEN_READER_INTERRUPTED';
  return [
    'SCREEN_READER_EXPECTED_MEANING_NOT_SPOKEN',
    'SCREEN_READER_SELECTED_STATE_NOT_SPOKEN',
  ].includes(error?.message)
    ? error.message
    : 'SCREEN_READER_CHECK_ASSERTION_FAILED';
}

/** Every assertion consumes real VoiceOver last-phrase output supplied by capture. */
export async function runReaderChecks({
  context,
  anonymous,
  clusterId,
  expect,
  capture,
  checkpoint,
  checks,
}) {
  async function action(name, request, page) {
    return capture(name, request, page);
  }
  async function focused(name, locator, page) {
    await page.bringToFront();
    await locator.focus();
    await expect(locator).toBeFocused();
    const moved = await action(
      name + ':focus',
      { kind: 'command', command: 'move voiceover cursor to keyboard focus' },
      page,
    );
    const described = await action(
      name + ':description',
      { kind: 'command', command: 'describe item with keyboard focus' },
      page,
    );
    return moved + '\n' + described;
  }
  async function adjacent(name, direction, page, matches, limit = 8) {
    const phrases = [];
    for (let index = 0; index < limit; index++) {
      const phrase = await action(`${name}:${index + 1}`, { kind: 'move', direction }, page);
      phrases.push(phrase);
      if (matches.test(phrase)) break;
    }
    return phrases.join('\n');
  }
  async function check(name, operation, matches) {
    assert.equal(readerCheckNames[checks.length], name, 'SCREEN_READER_CHECK_ORDER_CHANGED');
    try {
      const phrase = await operation();
      assert(matches.test(phrase), 'SCREEN_READER_EXPECTED_MEANING_NOT_SPOKEN');
      checks.push({ name, status: 'passed' });
    } catch (error) {
      checks.push({ name, status: 'failed', code: readerCheckFailureCode(error) });
      await checkpoint();
      if (error.name === 'VoiceOverTransportError' || error.name === 'AbortError') throw error;
      return;
    }
    await checkpoint();
  }
  const login = await anonymous.newPage();
  login.setDefaultTimeout(12000);
  try {
    await login.goto('/login');
    await login.bringToFront();
    await check(
      'login-username-label',
      () => focused('login-username', login.getByLabel('管理员账号', { exact: true }), login),
      /管理员账号/,
    );
    await check(
      'login-empty-password-label',
      () => focused('login-password-empty', login.getByLabel('密码', { exact: true }), login),
      /密码/,
    );
    await check(
      'login-native-required-error',
      async () => {
        await login.getByRole('button', { name: '登录工作台', exact: true }).click();
        const field = login.getByLabel('管理员账号', { exact: true });
        const validity = await field.evaluate((element) => ({
          empty: element.value === '',
          valid: element.validity.valid,
          missing: element.validity.valueMissing,
        }));
        assert.deepEqual(validity, { empty: true, valid: false, missing: true });
        const automatic = await action('login-required:automatic', { kind: 'last' }, login);
        return automatic + '\n' + (await focused('login-invalid-username', field, login));
      },
      /请输入|请填写|fill out|invalid|无效|invalid entry/i,
    );
  } finally {
    await login.close();
  }
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.bringToFront();
  await page.goto('/projects/new?clusterId=' + clusterId);
  await check(
    'project-selected-target',
    async () => {
      const selected = page.locator(`input[type="radio"][value="${clusterId}"]`);
      await expect(selected).toBeChecked();
      const phrase = await focused('project-selected-target', selected, page);
      assert(/selected|已选|选定|选中/i.test(phrase), 'SCREEN_READER_SELECTED_STATE_NOT_SPOKEN');
      return phrase;
    },
    /radio|单选/i,
  );
  await check(
    'project-target-inheritance-context',
    () => adjacent('project-target-context', 'right', page, /项目创建后固定使用/),
    /项目创建后固定使用/,
  );
  await check(
    'project-slug-associated-help',
    () => focused('project-slug-help', page.getByLabel('项目标识', { exact: true }), page),
    /小写字母、数字与连字符/,
  );
  await page.goto('/deployments/' + readerRecordIds.oom);
  await check(
    'oom-disclosure-summary',
    () =>
      focused(
        'oom-disclosure',
        page.locator('[data-deployment-failure-observation] summary'),
        page,
      ),
    /容器内存不足/,
  );
  await check(
    'failed-deployment-status',
    async () => {
      await focused(
        'failed-task-breadcrumb',
        page.getByRole('navigation', { name: '面包屑' }).getByRole('link').last(),
        page,
      );
      return adjacent('failed-task-state', 'right', page, /失败/, 10);
    },
    /失败/,
  );
  await page.goto('/deployments/' + readerRecordIds.git);
  await check(
    'build-log-bounded-region',
    () =>
      focused(
        'build-log-region',
        page.getByRole('region', { name: '构建与推送日志，可滚动', exact: true }),
        page,
      ),
    /构建与推送日志，可滚动/,
  );
  await check(
    'build-log-source',
    async () => {
      await focused(
        'build-log-refresh',
        page.getByRole('button', { name: '刷新构建日志', exact: true }),
        page,
      );
      return adjacent('build-log-source', 'left', page, /来源：独立 Builder/);
    },
    /来源：独立 Builder/,
  );
  await check(
    'deployment-log-bounded-region',
    () =>
      focused(
        'deployment-log-region',
        page.getByRole('region', { name: '部署执行日志，可滚动', exact: true }),
        page,
      ),
    /部署执行日志，可滚动/,
  );
  await check(
    'deployment-log-source',
    async () => {
      await focused(
        'deployment-log-refresh',
        page.getByRole('button', { name: '刷新部署日志', exact: true }),
        page,
      );
      return adjacent('deployment-log-source', 'left', page, /来源：平台阶段事件/);
    },
    /来源：平台阶段事件/,
  );
}
