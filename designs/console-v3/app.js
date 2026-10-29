(() => {
  'use strict';

  const app = document.querySelector('#app');
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const uid = (prefix = 'item') => prefix + '-' + Math.random().toString(36).slice(2, 9);
  const now = () => new Date().toISOString();
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未观察';
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 46);
  const checked = (value) => value ? ' checked' : '';
  const selected = (value) => value ? ' selected' : '';
  const disabled = (value) => value ? ' disabled' : '';
  const symbols = {
    projects: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
    settings: '<path d="m9 3-1 3-3 1-2 4 2 3 1 4 4 2 3-1 4 1 3-4-1-3 1-4-3-3-3 1-2-3z"/><circle cx="11.5" cy="11.5" r="3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
    arrow: '<path d="M3 12h18m-7-7 7 7-7 7"/>',
    search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
    git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10M6 15c8 0 12-2 12-7"/>',
    image: '<path d="m12 3 9 5-9 5-9-5 9-5zM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
    log: '<path d="m4 5 5 5-5 5M12 17h8"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
    refresh: '<path d="M20 8a8.5 8.5 0 0 0-14-3L3 8m0-5v5h5M4 16a8.5 8.5 0 0 0 14 3l3-3m0 5v-5h-5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18"/>',
    disk: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18M7 17h.01M11 17h.01"/>',
    usage: '<path d="M3 21h18M5 17V9h4v8M10 17V4h4v13M15 17v-6h4v6"/>',
    key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    play: '<path d="m6 3 15 9-15 9z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    link: '<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2-2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 1)"/>',
    file: '<path d="M14 2H5v20h14V7zM14 2v6h5M8 12h8M8 16h8"/>',
    logout: '<path d="M9 3H3v18h6M9 12h12m-5-5 5 5-5 5"/>',
  };
  const icon = (name, css = '') => '<svg class="' + css + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (symbols[name] || symbols.image) + '</svg>';
  const statusNames = { running: '运行中', stopped: '已停止', draft: '未部署', deploying: '部署中', failed: '失败', queued: '排队中', succeeded: '成功', cancelled: '已取消', cancelling: '取消待确认', unknown: '待确认', stale: '观察已过期', ready: '已就绪', bound: '已绑定', unverified: '未验证', offline: '已失联', active: '有效', expired: '已到期', retained: '已保留', partial: '部分应用', disabled: '已停用', pending: '等待中', missing: '未配置', degraded: '降级', paused: '已暂停' };
  const badge = (value, label) => '<span class="status ' + esc(value) + '"><i></i>' + esc(label || statusNames[value] || value) + '</span>';
  const button = (label, action, opts = {}) => '<button type="' + (opts.type || 'button') + '" class="btn ' + (opts.primary ? 'primary ' : '') + (opts.danger ? 'danger ' : '') + (opts.small ? 'small ' : '') + (opts.subtle ? 'subtle ' : '') + '" data-action="' + action + '"' + (opts.id ? ' data-id="' + esc(opts.id) + '"' : '') + (opts.attrs || '') + disabled(opts.disabled) + '>' + (opts.icon ? icon(opts.icon) : '') + label + '</button>';
  const linkButton = (label, href, symbol = '') => '<a class="btn" href="' + esc(href) + '">' + (symbol ? icon(symbol) : '') + label + '</a>';
  const empty = (title, detail, action = '') => '<div class="empty-state">' + icon('layers') + '<h3>' + title + '</h3><p>' + detail + '</p>' + action + '</div>';
  const notice = (text, tone = 'info') => '<div class="notice ' + tone + '">' + icon(tone === 'error' ? 'alert' : 'info') + '<span>' + text + '</span></div>';
  const formError = (text) => text ? '<p class="form-error" role="alert">' + icon('alert') + esc(text) + '</p>' : '';
  function field(label, key, value = '', opts = {}) {
    const attrs = ' id="' + esc(key) + '" name="' + esc(key) + '" data-bind="' + esc(key) + '"';
    return '<div class="field"><label for="' + esc(key) + '">' + label + '</label>' +
      (opts.textarea ? '<textarea' + attrs + (opts.rows ? ' rows="' + opts.rows + '"' : '') + ' placeholder="' + esc(opts.placeholder || '') + '">' + esc(value) + '</textarea>' :
        '<input' + attrs + ' type="' + (opts.type || 'text') + '" value="' + esc(value) + '" placeholder="' + esc(opts.placeholder || '') + '"' + (opts.required ? ' required' : '') + (opts.min !== undefined ? ' min="' + opts.min + '"' : '') + (opts.max !== undefined ? ' max="' + opts.max + '"' : '') + (opts.readonly ? ' readonly' : '') + ' autocomplete="off" />') +
      (opts.hint ? '<small class="hint">' + opts.hint + '</small>' : '') + '</div>';
  }
  function selectField(label, key, value, choices, hint = '') {
    return '<div class="field"><label for="' + key + '">' + label + '</label><select id="' + key + '" name="' + key + '" data-bind="' + key + '">' + choices.map((item) => '<option value="' + esc(item.value ?? item[0]) + '"' + selected((item.value ?? item[0]) === value) + '>' + esc(item.label ?? item[1]) + '</option>').join('') + '</select>' + (hint ? '<small class="hint">' + hint + '</small>' : '') + '</div>';
  }
  const disclosure = (title, body, open = false, description = '') => '<details class="config-group"' + (open ? ' open' : '') + '><summary>' + icon('chevron') + '<span>' + title + (description ? '<small>' + description + '</small>' : '') + '</span></summary><div class="config-group-body">' + body + '</div></details>';
  const keyValues = (rows) => '<dl class="key-values">' + rows.map(([label, value]) => '<dt>' + label + '</dt><dd>' + value + '</dd>').join('') + '</dl>';
  const sourceIcon = (source) => ({ git: 'git', database: 'database', template: 'layers', image: 'image' })[source] || 'image';
  const sourceLabel = (source) => ({ git: 'GitHub', image: 'Docker 镜像', template: '应用模板', database: '数据库' })[source] || source;
  const templates = [
    { id: 'docker', name: 'Docker', description: '填写公共或私有 OCI 镜像', category: 'application', image: '', port: '8080', version: '1.0.0', resources: ['100', '128', '500', '256'] },
    { id: 'node-example', name: 'Node.js 示例', description: '官方预构建运行时与固定 HTTP 示例', category: 'application', image: 'node:24.22.1-alpine3.24', imageVersion: '24.22.1', port: '8080', version: '1.0.0', digest: 'sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53', resources: ['100', '64', '500', '128'] },
    { id: 'static-example', name: '静态站点示例', description: '官方 Nginx 预构建镜像欢迎页面', category: 'application', image: 'nginx:1.28.3-alpine3.23', imageVersion: '1.28.3', port: '80', version: '1.0.0', digest: 'sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236', resources: ['25', '32', '250', '64'] },
    { id: 'postgresql', name: 'PostgreSQL', description: '关系数据库 · 私有网络 · 4 GiB 数据卷', category: 'database', image: 'postgres:17.11-bookworm', imageVersion: '17.11', port: '5432', version: '1.0.0', digest: 'sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27', storage: '4', resources: ['100', '256', '1000', '768'] },
    { id: 'redis', name: 'Redis', description: '认证与 AOF everysec · 1 GiB 数据卷', category: 'database', image: 'redis:7.4.11-bookworm', imageVersion: '7.4.11', port: '6379', version: '1.0.0', digest: 'sha256:44960b3100c48159a66d28c18b0588c193492e25f7551d60e51dd464fc3eca5b', storage: '1', resources: ['100', '64', '500', '256'] },
  ];
  const defaultConfig = (extra = {}) => ({
    name: '', slug: '', source: 'image', image: '', repository: 'demo/personal-blog', branch: 'main', dockerfile: 'Dockerfile',
    context: '.', gitConnection: 'git-main', registry: 'registry-main', builder: 'builder-main', imageName: 'demo/app', architecture: 'amd64',
    credentialId: '', privateImage: false, port: '8080', portName: 'http', targetPort: '8080', expose: 'http', ports: [],
    type: 'web', replicas: '1', cpu: '500', memory: '256', requestCpu: '100', requestMemory: '128',
    command: '', args: '', readinessType: 'http', readinessPath: '/', readinessDelay: '5', readinessTimeout: '3', readinessFailures: '3',
    startupType: 'none', startupPath: '/', startupDelay: '0', startupTimeout: '3', startupFailures: '30',
    variables: [], mounts: [], connections: [], description: '', autoDeploy: true, buildArgs: '', buildSecrets: '',
    templateId: '', template: '', version: '', imageVersion: '', imageDigest: '', storage: '4', databaseName: 'app', username: 'app', redisDatabase: '0', ...extra,
  });
  const sampleTime = '2026-10-29T07:32:00.000Z';
  function serviceSeed(idValue, config, extra = {}) {
    const draft = defaultConfig(config);
    return { id: idValue, environmentId: 'blog-production', draft, publishedSnapshot: clone(draft), revision: 3, publishedRevision: 3, status: 'running', desiredState: 'running', configurationState: 'consistent', createdAt: '2026-10-20T05:13:00.000Z', observedAt: sampleTime, cpuMilli: 42, memoryMiB: 118, podId: idValue + '-7d956f4c8b-q2k6r', container: 'main', restarts: 0, pendingCommits: [], ...extra };
  }
  const web = serviceSeed('blog-web', { name: 'web', slug: 'web', source: 'git', image: 'ghcr.io/demo/personal-blog@sha256:8a35c4d', repository: 'demo/personal-blog', port: '3000', targetPort: '3000', variables: [{ key: 'NODE_ENV', value: 'production', mode: 'plain' }, { key: 'LOG_LEVEL', value: 'info', mode: 'plain' }], connections: [{ databaseId: 'db-postgres', variable: 'DATABASE_URL' }] });
  const apiService = serviceSeed('blog-api', { name: 'api', slug: 'api', image: 'ghcr.io/demo/blog-api:2.3.1', port: '8080', targetPort: '8080', type: 'web' }, { revision: 4, publishedRevision: 3, pendingCommits: [] });
  apiService.draft.image = 'ghcr.io/demo/blog-api:2.4.0';
  const postgres = serviceSeed('blog-postgres', { name: 'postgres', slug: 'postgres', source: 'database', image: 'postgres:17.11-bookworm', imageVersion: '17.11', imageDigest: templates.find((t) => t.id === 'postgresql').digest, templateId: 'postgresql', template: 'postgresql', version: '1.0.0', storage: '4', port: '5432', targetPort: '5432', portName: 'tcp', expose: 'private', type: 'database', cpu: '1000', memory: '768', requestMemory: '256', readinessType: 'tcp', mounts: [{ volumeId: 'vol-postgres', path: '/var/lib/postgresql/data', readOnly: false }] }, { revision: 1, publishedRevision: 1, databaseId: 'db-postgres', cpuMilli: 18, memoryMiB: 86 });
  const worker = serviceSeed('blog-worker', { name: 'worker', slug: 'worker', image: 'ghcr.io/demo/blog-worker:1.2.0', type: 'worker', port: '', expose: 'private', readinessType: 'none' }, { status: 'stopped', desiredState: 'stopped', cpuMilli: null, memoryMiB: null });
  let storedTheme = 'light';
  try { storedTheme = localStorage.getItem('ozz-v3-prototype-theme') || 'light'; } catch {}
  const state = {
    projects: [
      { id: 'blog', name: '个人博客', slug: 'personal-blog', description: '博客、API 和它们的数据', targetId: 'cluster-tokyo', clusterId: 'cluster-tokyo', revision: 1, lastEnvironmentId: 'blog-production', environments: [{ id: 'blog-production', name: '生产', slug: 'production', description: '默认环境' }], services: [web, apiService, postgres, worker] },
      { id: 'toolbox', name: '我的工具箱', slug: 'my-tools', description: '一些轻量的小工具', targetId: 'cluster-hongkong', clusterId: 'cluster-hongkong', revision: 1, lastEnvironmentId: 'toolbox-production', environments: [{ id: 'toolbox-production', name: '生产', slug: 'production' }], services: [] },
    ],
    clusters: [
      { id: 'cluster-tokyo', name: 'Tokyo-01', location: '东京', region: '东京', status: 'ready', connectionStatus: 'ready', nodeCount: 1, cpu: 4, memory: 8, observedAt: sampleTime, serverId: 'server-tokyo', endpoint: 'https://tokyo.example.test:6443', suffix: 'tokyo', capabilities: { ingress: true, storage: true, metrics: true, certificate: true } },
      { id: 'cluster-hongkong', name: 'HongKong-01', location: '香港', region: '香港', status: 'ready', connectionStatus: 'ready', nodeCount: 1, cpu: 2, memory: 4, observedAt: sampleTime, serverId: 'server-hk', endpoint: 'https://hk.example.test:6443', suffix: 'hk', capabilities: { ingress: true, storage: true, metrics: true, certificate: true } },
    ],
    servers: [
      { id: 'server-tokyo', name: 'Tokyo-01', address: '192.0.2.10', host: '192.0.2.10', region: '东京', location: '东京', port: 22, sshPort: 22, user: 'deploy', sshUser: 'deploy', credentialId: 'cred-ssh', clusterId: 'cluster-tokyo', status: 'ready', fingerprint: 'SHA256:DEMO-tokyo-host-fingerprint', verified: true, cpu: 4, memory: 8, disk: 80 },
      { id: 'server-hk', name: 'HongKong-01', address: '192.0.2.20', host: '192.0.2.20', region: '香港', location: '香港', port: 22, sshPort: 22, user: 'deploy', sshUser: 'deploy', credentialId: 'cred-ssh', clusterId: 'cluster-hongkong', status: 'ready', verified: true, cpu: 2, memory: 4, disk: 40 },
    ],
    volumes: [
      { id: 'vol-postgres', name: 'postgres-data', projectId: 'blog', environmentId: 'blog-production', serviceId: 'blog-postgres', capacity: 4, sizeGiB: 4, storageClass: 'local-path', status: 'bound', node: 'tokyo-01', path: '/var/lib/postgresql/data', references: ['blog-postgres'], actualReferences: ['blog-postgres'], actualObservedAt: sampleTime, retained: false, protected: true, databaseId: 'db-postgres', maintenance: null, records: [], observedAt: sampleTime },
      { id: 'vol-archive', name: 'archive-data', projectId: 'blog', environmentId: 'blog-production', serviceId: null, capacity: 5, sizeGiB: 5, storageClass: 'local-path', status: 'bound', node: 'tokyo-01', path: '/data', references: [], actualReferences: [], actualObservedAt: sampleTime, retained: true, protected: false, maintenance: null, records: [], observedAt: sampleTime },
    ],
    databases: [{ id: 'db-postgres', name: 'postgres', kind: 'postgresql', engine: 'PostgreSQL', version: '17.11', projectId: 'blog', environmentId: 'blog-production', serviceId: 'blog-postgres', volumeId: 'vol-postgres', credentialId: 'cred-db', username: 'app', databaseName: 'app', port: 5432, host: 'postgres.blog-production.svc.cluster.local', consumers: ['blog-web'], status: 'ready', identity: 'db-cluster-demo-021' }],
    domains: [{ id: 'dom-web', hostname: 'blog.tokyo.ozz.test', projectId: 'blog', environmentId: 'blog-production', serviceId: 'blog-web', portName: 'http', port: 3000, status: 'ready', dns: 'ready', route: 'ready', tls: 'ready', certificate: 'production', expiresAt: '2027-01-15', observedAt: sampleTime, target: '192.0.2.10' }],
    credentials: [
      { id: 'cred-ssh', name: '部署服务器', kind: 'ssh', status: 'active', expiresAt: '2027-10-01', references: 2 },
      { id: 'cred-git', name: 'GitHub 演示授权', kind: 'git', status: 'active', expiresAt: '2027-01-01', references: 1 },
      { id: 'cred-registry', name: 'GHCR 推送凭证', kind: 'registry', status: 'active', expiresAt: '2027-01-01', references: 1 },
      { id: 'cred-registry-pull', name: 'GHCR 拉取凭证', kind: 'registry', status: 'active', expiresAt: '2027-01-01', references: 1 },
      { id: 'cred-shared-token', name: '应用共享令牌 · 演示', kind: 'generic', status: 'active', references: 0 },
      { id: 'cred-db', name: 'postgres · 初始化凭证', kind: 'database', status: 'active', references: 1 },
      { id: 'cred-builder', name: 'Builder mTLS', kind: 'builder', status: 'active', references: 1 },
    ],
    integrations: [
      { id: 'git-main', kind: 'github', name: 'GitHub', status: 'ready', credentialId: 'cred-git', account: 'demo', endpoint: 'https://api.github.com', webhook: true },
      { id: 'registry-main', kind: 'registry', name: 'GitHub Container Registry', status: 'ready', endpoint: 'ghcr.io', credentialId: 'cred-registry', pullCredentialId: 'cred-registry-pull' },
      { id: 'builder-main', kind: 'builder', name: 'Linux Builder', status: 'ready', endpoint: 'https://builder.example.test:8443', credentialId: 'cred-builder', instanceId: 'builder-demo-01', platform: 'amd64', enabled: true },
    ],
    tasks: [], gitEvents: [], planningRuns: [],
    worker: { status: 'ready', heartbeat: sampleTime, queued: 0, pending: 0, redis: 'ready' },
    platform: { suffix: 'ozz.test', email: 'admin@example.test', theme: storedTheme },
    theme: storedTheme, readOnly: false, signedIn: true, modal: null, search: '', targetSearch: '',
    projectDraft: { id: uid('project'), name: '', slug: '', description: '', targetId: 'cluster-tokyo', dirty: false, createdId: null },
    creationDrafts: {}, serviceEdits: {}, logViews: {}, taskLogViews: {}, mobileOpen: false, scenario: 'normal', taskTimers: new Map(), pendingAction: null,
    errors: {}, composing: false, compositionEndedAt: 0, commandIndex: 0, lastFocus: null,
  };
  function taskSeed(idValue, service, status, revision, name) {
    return { id: idValue, kind: 'deployment', type: 'deploy', name, serviceId: service.id, projectId: 'blog', environmentId: 'blog-production', targetId: 'cluster-tokyo', status, createdAt: sampleTime, finishedAt: sampleTime, revision, source: service.draft.source, commit: service.draft.source === 'git' ? '8a35c4d' : '', image: service.publishedSnapshot.image, digest: 'sha256:' + '8a35c4d'.padEnd(64, 'a'), snapshot: clone(service.publishedSnapshot), stages: [{ name: '准备发布', status: 'succeeded' }, { name: service.draft.source === 'git' ? '构建与推送' : '解析镜像', status: 'succeeded' }, { name: '应用配置', status: status === 'failed' ? 'failed' : 'succeeded' }, { name: '等待实例就绪', status: status === 'failed' ? 'pending' : 'succeeded' }], logs: ['[演示] 已固定配置快照与镜像版本。', '[演示] 目标 Tokyo-01 / blog-production。', status === 'failed' ? '[演示] 新镜像健康检查失败；原已发布版本继续运行。' : '[演示] 目标实例 1/1 已就绪。'], error: status === 'failed' ? '新版本未通过健康检查，原已发布实例仍在运行。' : '', result: status === 'succeeded' ? '发布完成，目标实例已就绪。' : '' };
  }
  state.tasks.push(taskSeed('deploy-web-3', web, 'succeeded', 3, 'web · 发布 #3'), taskSeed('deploy-api-4', apiService, 'failed', 4, 'api · 发布 #4'), taskSeed('deploy-api-3', apiService, 'succeeded', 3, 'api · 发布 #3'), taskSeed('deploy-postgres-1', postgres, 'succeeded', 1, 'postgres · 首次发布'));
  state.tasks.find((t) => t.id === 'deploy-api-4').snapshot = clone(apiService.draft);
  state.tasks.find((t) => t.id === 'deploy-api-4').image = apiService.draft.image;
  web.lastTaskId = 'deploy-web-3'; apiService.lastTaskId = 'deploy-api-4'; postgres.lastTaskId = 'deploy-postgres-1';
  state.gitEvents.push({ id: 'event-1', repository: 'demo/personal-blog', branch: 'main', commit: '8a35c4d', projectId: 'blog', serviceId: 'blog-web', status: 'succeeded', outcome: '已发布', taskId: 'deploy-web-3', createdAt: sampleTime }, { id: 'event-2', repository: 'demo/personal-blog', branch: 'feature/docs', commit: '02b9d6f', projectId: 'blog', serviceId: 'blog-web', status: 'ignored', outcome: '非跟踪分支，未创建发布', createdAt: sampleTime });

  const allServices = () => state.projects.flatMap((p) => p.services.map((s) => ({ ...s, project: p, projectId: p.id })));
  const findService = (idValue) => { for (const p of state.projects) { const s = p.services.find((value) => value.id === idValue); if (s) return { project: p, service: s }; } return null; };
  const targetFor = (project) => state.clusters.find((item) => item.id === (project.targetId || project.clusterId)) || { name: '部署位置已移除', status: 'missing', location: '', id: project.targetId };
  const projectUrl = (project, tail = '', envId = project.lastEnvironmentId) => '#/project/' + project.id + tail + '?env=' + encodeURIComponent(envId || '');
  const serviceUrl = (project, service, tab = 'status') => projectUrl(project, '/service/' + service.id, service.environmentId) + '&tab=' + tab;
  const currentServices = (ctx) => ctx.project.services.filter((s) => s.environmentId === ctx.environment?.id);
  const sourceReference = (config) => config.source === 'git' ? config.repository + ' · ' + config.branch : config.image || (templates.find((t) => t.id === config.templateId)?.name || '尚未配置');
  const hasChanges = (s) => !s.publishedSnapshot || JSON.stringify(s.draft) !== JSON.stringify(s.publishedSnapshot);
  const dirtyEdit = (s) => state.serviceEdits[s.id] && JSON.stringify(state.serviceEdits[s.id]) !== JSON.stringify(s.draft);
  const serviceEdit = (s) => state.serviceEdits[s.id] || (state.serviceEdits[s.id] = clone(s.draft));
  const projectListKey = 'ozzV3ProjectList';
  const storedList = history.state?.[projectListKey];
  let projectList = { query: typeof storedList?.query === 'string' ? storedList.query : '', scroll: Number.isFinite(storedList?.scroll) ? Math.max(0, storedList.scroll) : 0 };
  let renderedHash = location.hash || '#/projects';
  let renderedModal = null;
  const copyStates = new Map();
  const isProjectList = (hash) => /^#\/projects(?:\?|$)/.test(hash || '#/projects');
  function rememberProjectList() {
    if (isProjectList(location.hash)) projectList = { query: new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '', scroll: window.scrollY };
    history.replaceState({ ...(history.state || {}), [projectListKey]: projectList }, '', location.href);
  }
  function projectListUrl() {
    return '#/projects' + (projectList.query ? '?q=' + encodeURIComponent(projectList.query) : '');
  }
  function updateProjectSearch(value) {
    state.search = value;
    projectList = { query: value, scroll: 0 };
    history.replaceState({ ...(history.state || {}), [projectListKey]: projectList }, '', projectListUrl());
    renderedHash = location.hash;
    render();
  }
  function captureFocus() {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    if (element.id) return { selector: '#' + CSS.escape(element.id), index: 0 };
    const attribute = element.hasAttribute('data-action') ? 'data-action' : element.hasAttribute('href') ? 'href' : null;
    if (!attribute) return null;
    let selector = element.tagName.toLowerCase() + '[' + attribute + '="' + CSS.escape(element.getAttribute(attribute)) + '"]';
    for (const name of ['data-id', 'data-source', 'data-prefix']) if (element.hasAttribute(name)) selector += '[' + name + '="' + CSS.escape(element.getAttribute(name)) + '"]';
    return { selector, index: [...document.querySelectorAll(selector)].indexOf(element) };
  }
  function restoreFocus(descriptor, owner = null) {
    requestAnimationFrame(() => {
      if (state.modal !== owner) return;
      const target = descriptor && [...document.querySelectorAll(descriptor.selector)].filter((node) => node.getClientRects().length)[Math.max(0, descriptor.index)];
      const fallback = owner ? document.querySelector('.dialog') : document.querySelector('main h1');
      if (target instanceof HTMLElement && !target.matches(':disabled')) target.focus({ preventScroll: true });
      else if (fallback instanceof HTMLElement) { fallback.tabIndex = -1; fallback.focus({ preventScroll: true }); }
    });
  }
  function focusModal(modal = state.modal) {
    const step = modal?.step;
    requestAnimationFrame(() => {
      if (state.modal !== modal || modal?.step !== step) return;
      const dialog = document.querySelector('.dialog');
      // An explicit field selection made before this frame owns the focus.
      // Do not redirect its next keystroke to the initial field.
      if (dialog?.contains(document.activeElement)) return;
      const selectors = modal?.type === 'source' && ['review', 'save-unknown'].includes(modal.step)
        ? '#creation-step-title'
        : '[autofocus], .modal-body input:not([type="hidden"]):not([readonly]):not(:disabled), .modal-body textarea:not(:disabled), #repo-search, [data-command-item], .modal-actions button:not(:disabled), .dialog-close:not(:disabled)';
      const target = selectors.split(',').flatMap((selector) => [...(dialog?.querySelectorAll(selector.trim()) || [])]).find((node) => node.getClientRects().length);
      if (target) target.focus({ preventScroll: true });
      else if (dialog) { dialog.tabIndex = -1; dialog.focus({ preventScroll: true }); }
    });
  }
  function interactionLock() {
    if (!state.signedIn) return '';
    if (state.pendingAction) return state.pendingAction.label + '，请稍候。';
    if (state.projectDraft.uncertain) return '请先确认原项目创建结果，再继续。';
    if (state.modal?.type === 'source' && state.modal.draft.saveUnknown) return '请先确认原服务保存结果，再继续。';
    return '';
  }
  function demoRequest(action, label, callback) {
    if (state.pendingAction) return;
    const owner = state.modal;
    const request = { action, label, hash: location.hash };
    state.pendingAction = request;
    const finish = () => {
      if (state.pendingAction !== request) return;
      state.pendingAction = null;
      if (!state.signedIn || state.modal !== owner || location.hash !== request.hash) return render();
      callback();
      render();
    };
    if (state.scenario === 'slow-response') { render(); setTimeout(finish, 700); }
    else finish();
  }

  function context() {
    const raw = location.hash.slice(1) || '/projects';
    const [path, query = ''] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(query);
    if (parts[0] === 'new-project' || (parts[0] === 'projects' && parts[1] === 'new')) return { kind: 'new-project', params };
    if (parts[0] !== 'project') {
      const aliases = { deployments: 'activity', operations: 'activity', services: 'resources', volumes: 'resources', databases: 'resources', domains: 'resources', infrastructure: 'servers' };
      const result = { kind: aliases[parts[0]] || parts[0] || 'projects', id: parts[1], params };
      if (aliases[parts[0]] === 'resources' && !params.has('type')) params.set('type', parts[0]);
      if (['volume', 'database', 'domain', 'task'].includes(result.kind) && result.id) {
        const collections = { volume: state.volumes, database: state.databases, domain: state.domains, task: state.tasks };
        const resource = collections[result.kind].find((item) => item.id === result.id);
        result.resource = resource;
        if (resource?.projectId) { result.project = state.projects.find((p) => p.id === resource.projectId); result.environment = result.project?.environments.find((e) => e.id === resource.environmentId); }
        if (result.kind === 'task' && resource?.serviceId) result.service = result.project?.services.find((s) => s.id === resource.serviceId && s.environmentId === result.environment?.id);
      }
      if (params.has('project')) {
        result.project = state.projects.find((p) => p.id === params.get('project'));
        result.environment = result.project?.environments.find((e) => e.id === (params.get('env') || result.project.lastEnvironmentId));
      }
      return result;
    }
    const project = state.projects.find((p) => p.id === parts[1]);
    if (!project) return { kind: 'missing', message: '这个项目不在当前演示数据中。', params };
    let kind = parts[2] || 'project';
    if (kind === 'settings') kind = 'project-settings';
    if (kind === 'integrations') kind = 'project-integrations';
    const service = parts[2] === 'service' ? project.services.find((s) => s.id === parts[3]) : null;
    if (parts[2] === 'service' && !service) return { kind: 'missing', project, message: '这个服务已经移除，保留的数据仍可在项目资源中找到。', params };
    const environmentId = params.has('env') ? params.get('env') : service?.environmentId || project.lastEnvironmentId;
    const environment = project.environments.find((env) => env.id === environmentId || env.slug === environmentId);
    if (!environment || (service && service.environmentId !== environment.id)) return { kind: 'invalid-environment', project, message: '链接中的环境与当前项目或服务不匹配。请明确选择环境。', params };
    return { kind, project, service, environment, params, id: service?.id || project.id };
  }
  function unsaved() {
    const ctx = context();
    return Boolean(ctx.service && dirtyEdit(ctx.service)) || Boolean(ctx.kind === 'new-project' && state.projectDraft.dirty);
  }
  function creationChanged(modal = state.modal) {
    if (modal?.type !== 'source') return false;
    if (modal.draft.createdServiceId) return JSON.stringify(normalizedConfig(modal.draft)) !== modal.draft.savedSignature;
    return [modal.draft, ...Object.values(modal.draft.sourceDrafts || {})].some((draft) => draft.dirty);
  }
  function goto(hash, force = false) {
    const lock = interactionLock();
    if (lock) { notify(lock); return; }
    const requested = hash.startsWith('#') ? hash : '#' + (hash.startsWith('/') ? hash : '/' + hash);
    const sameContext = requested.split('?')[0] === location.hash.split('?')[0] && new URLSearchParams(requested.split('?')[1] || '').get('env') === context().params.get('env');
    if (!force && (creationChanged() || (!sameContext && unsaved()))) {
      const creation = state.modal?.type === 'source' ? state.modal : null;
      confirm({ title: '离开当前编辑？', description: '尚未保存的修改会丢失。', confirmText: '放弃修改并离开', onConfirm() {
        const ctx = context(); if (ctx.service && !sameContext) delete state.serviceEdits[ctx.service.id]; state.projectDraft.dirty = false; if (creation) delete state.creationDrafts[creation.draft.key]; goto(hash, true);
      } });
      return;
    }
    rememberProjectList();
    closeModal(false); state.mobileOpen = false; state.errors = {};
    let value = requested;
    if (value === '#/projects' && !force && !isProjectList(location.hash)) value = projectListUrl();
    if (location.hash === value) render(); else location.hash = value;
  }
  function notify(message) {
    const node = document.querySelector('#toast'); node.textContent = message; node.hidden = false;
    clearTimeout(notify.timer); notify.timer = setTimeout(() => { node.hidden = true; }, 2800);
  }
  function openModal(options) {
    const lock = interactionLock();
    if (lock) { notify(lock); return; }
    const triggerFocus = captureFocus();
    const rootFocus = state.modal?.rootFocus || triggerFocus;
    if (state.modal?.type === 'logs') cancelLogRead(state.logViews[state.modal.serviceId]);
    clearCopyFeedback();
    state.lastFocus = rootFocus;
    state.modal = { type: 'custom', triggerFocus, rootFocus, route: location.hash, ...options }; state.errors = {}; state.commandIndex = 0;
    if (state.modal.type === 'logs') readLogs(findService(state.modal.serviceId)?.service, false, false);
    render(); focusModal();
  }
  function closeModal(redraw = true) {
    const lock = interactionLock();
    if (lock) { notify(lock); return; }
    const modal = state.modal;
    const focus = modal?.rootFocus || state.lastFocus;
    if (redraw && modal?.type === 'confirm' && modal.parent) {
      state.modal = modal.parent; state.errors = {}; render(); modal.onCancel?.(); restoreFocus(modal.triggerFocus, modal.parent); return;
    }
    if (redraw && modal?.beforeClose?.() === false) return;
    if (redraw && creationChanged(modal)) {
      confirm({ title: '放弃未保存的输入？', description: modal.draft.createdServiceId ? '已保存的服务仍保留在项目列表中。本次未保存的输入会清空，再次添加服务会开始新的会话。' : '本次各来源中尚未保存的输入会清空。再次添加服务会从选择来源开始。', confirmText: '放弃输入并关闭', onConfirm() { delete state.creationDrafts[modal.draft.key]; } });
      return;
    }
    if (modal?.type === 'logs') cancelLogRead(state.logViews[modal.serviceId]);
    if (modal?.type === 'source') delete state.creationDrafts[modal.draft.key];
    clearCopyFeedback();
    state.modal = null; state.errors = {};
    modal?.onClosed?.();
    if (redraw) { render(); restoreFocus(focus); }
  }
  function confirm(options) {
    openModal({ type: 'confirm', input: '', parent: state.modal, ...options });
  }
  function finishTask(task, onSuccess) {
    if (task.status === 'cancelled' || task.status === 'cancelling') {
      task.status = 'cancelled'; task.finishedAt = now(); task.logs.push('[演示] 执行器已确认取消，已发生的远端效果保留。'); render(); return;
    }
    if (task.outcome === 'unknown') { task.status = 'unknown'; task.logs.push('[演示] 目标当前失联，结果待确认。'); render(); return; }
    const failed = task.outcome === 'failed';
    task.status = failed ? 'failed' : 'succeeded'; task.finishedAt = now();
    task.stages.forEach((stage, index) => { stage.status = failed && index === task.stages.length - 1 ? 'failed' : 'succeeded'; });
    task.logs.push(failed ? '[演示] 本次执行失败，原记录保留。修正后可创建独立重试任务。' : '[演示] 执行完成，已更新本次目标的观察。');
    task.result = failed ? '执行失败，查看错误与原输入后重试。' : task.result || '执行完成。';
    for (const event of state.gitEvents.filter((item) => item.taskId === task.id)) { event.status = task.status; event.outcome = failed ? '自动发布失败，原事件与部署记录保留' : '自动发布完成'; }
    if (!failed && onSuccess) onSuccess(task);
    if (failed && task.onFailure) task.onFailure(task);
    render();
  }
  function addTask(input, onSuccess) {
    const task = {
      id: uid(input.kind === 'deployment' ? 'deploy' : 'op'), kind: 'operation', type: 'diagnostic', name: '资源操作',
      status: 'queued', createdAt: now(), stages: [{ name: '排队', status: 'running' }, { name: '执行', status: 'pending' }, { name: '验证结果', status: 'pending' }],
      logs: ['[演示] 请求已保存，等待执行器。'], outcome: state.scenario === 'task-failure' ? 'failed' : state.scenario === 'offline' ? 'unknown' : 'succeeded',
      ...input,
    };
    task._onSuccess = onSuccess; state.tasks.unshift(task);
    if (state.scenario === 'task-failure') state.scenario = 'normal';
    const timer1 = setTimeout(() => {
      if (task.status !== 'queued') return;
      task.status = 'running'; task.stages[0].status = 'succeeded'; if (task.stages[1]) task.stages[1].status = 'running'; task.logs.push('[演示] 执行器已开始处理固定目标。'); render();
    }, 420);
    const timer2 = setTimeout(() => finishTask(task, onSuccess), 1100);
    state.taskTimers.set(task.id, [timer1, timer2]);
    render(); return task;
  }
  function theme(value) {
    state.theme = value;
    const resolved = value === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
    document.documentElement.dataset.theme = resolved;
    try { localStorage.setItem('ozz-v3-prototype-theme', value); } catch {}
  }
  function sidebar(ctx) {
    const project = ctx.project;
    const projectShell = project && ctx.environment;
    const account = '<button class="account-button" data-action="account"><span class="avatar">M</span><span><strong>个人工作区</strong><small>演示管理员</small></span>' + icon('more') + '</button>';
    if (projectShell) return '<aside class="sidebar project-sidebar"><a class="back-projects" href="#/projects">' + icon('back') + '项目</a><div class="project-identity"><h2>' + esc(project.name) + '</h2><a class="deployment-location" href="#/cluster/' + targetFor(project).id + '">' + icon('server') + esc(targetFor(project).name) + '<i class="live-dot ' + esc(targetFor(project).status) + '"></i></a>' + (project.environments.length > 1 ? '<select id="environment-switch" data-action="environment-switch" aria-label="切换环境">' + project.environments.map((e) => '<option value="' + e.id + '"' + selected(e.id === ctx.environment.id) + '>' + esc(e.name) + ' · ' + esc(e.slug) + '</option>').join('') + '</select>' : '') + '</div><nav class="project-tools"><a href="' + projectUrl(project, '/settings', ctx.environment.id) + '" class="nav-link' + (ctx.kind === 'project-settings' ? ' active' : '') + '">' + icon('settings') + '项目设置</a><a href="' + projectUrl(project, '/integrations', ctx.environment.id) + '" class="nav-link' + (ctx.kind === 'project-integrations' ? ' active' : '') + '">' + icon('link') + '整合</a><button class="nav-link new-service" id="add-service" data-action="add-service">' + icon('plus') + '新建服务</button></nav><div class="nav-label-line"><span>服务</span><a href="#/resources?project=' + project.id + '&env=' + ctx.environment.id + '" title="项目资源">' + icon('layers') + '</a></div><nav class="service-nav">' + currentServices(ctx).map((s) => '<a class="service-nav-item' + (ctx.service?.id === s.id ? ' active' : '') + '" href="' + serviceUrl(project, s) + '">' + icon(sourceIcon(s.draft.source)) + '<span>' + esc(s.draft.name) + '</span><i class="live-dot ' + esc(s.status) + '"></i></a>').join('') + (currentServices(ctx).length ? '' : '<p class="sidebar-hint">添加的服务会显示在这里。</p>') + '</nav><div class="sidebar-footer"><a class="nav-link resource-link" href="#/resources?project=' + project.id + '&env=' + ctx.environment.id + '">' + icon('disk') + '项目资源</a><span class="object-id">Project ID <code>' + esc(project.id) + '</code></span>' + account + '</div></aside>';
    return '<aside class="sidebar"><a class="brand" href="#/projects"><span class="brand-mark">o</span>Ozz</a><div class="workspace-label">个人工作区</div><nav class="global-nav">' + [['projects', 'projects', '项目'], ['servers', 'server', '服务器'], ['settings', 'settings', '设置']].map(([kind, symbol, name]) => '<a class="nav-link' + (ctx.kind === kind || kind === 'projects' && ctx.kind === 'new-project' || kind === 'servers' && ['server', 'cluster'].includes(ctx.kind) ? ' active' : '') + '" href="#/' + kind + '">' + icon(symbol) + name + '</a>').join('') + '</nav><div class="sidebar-footer"><a class="nav-link" href="#/planning">' + icon('layers') + '产品规划 <small>P1 / P2</small></a>' + account + '</div></aside>';
  }
  function topbar(ctx) {
    return '<header class="topbar"><button class="icon-btn mobile-menu" data-action="toggle-menu" aria-label="打开导航">' + icon('menu') + '</button><div class="topbar-context">' + (ctx.project ? esc(ctx.project.name) : '个人工作区') + '</div><div class="topbar-actions"><button class="search-trigger" data-action="command-search">' + icon('search') + '<span>搜索项目与服务</span><kbd>⌘ K</kbd></button><a class="icon-btn activity-trigger" href="#/activity" aria-label="活动与任务">' + icon('clock') + (state.tasks.some((t) => ['queued', 'running'].includes(t.status)) ? '<i></i>' : '') + '</a><button class="prototype-marker" data-action="demo-options" title="演示场景与能力边界">' + icon('layers') + '<span>交互原型 · 演示数据</span></button><button class="icon-btn" data-action="toggle-theme" aria-label="切换外观">' + icon('sun') + '</button></div></header>';
  }
  function render(opts = {}) {
    const ctx = context();
    if (ctx.kind === 'projects') {
      state.search = ctx.params.get('q') || '';
      if (projectList.query !== state.search) projectList = { query: state.search, scroll: 0 };
    }
    if (ctx.project && ctx.environment) ctx.project.lastEnvironmentId = ctx.environment.id;
    if (ctx.kind === 'project' && currentServices(ctx).length) {
      const first = currentServices(ctx).find((s) => s.id === ctx.project.lastServiceId) || currentServices(ctx)[0];
      history.replaceState({ ...(history.state || {}), [projectListKey]: projectList }, '', serviceUrl(ctx.project, first)); return render(opts);
    }
    if (ctx.service) ctx.project.lastServiceId = ctx.service.id;
    const restoreManagedInputs = window.OzzManagement?.preserveInputs?.();
    const active = document.activeElement;
    const keep = { id: active?.id, name: active?.getAttribute('data-mg-field'), start: active?.selectionStart, end: active?.selectionEnd };
    const scrollTop = document.querySelector('.modal-body')?.scrollTop || 0;
    const logScroll = document.querySelector('.log-modal-body .log-output')?.scrollTop;
    const taskLogScroll = document.querySelector('.task-log-output')?.scrollTop;
    const taskLogId = document.querySelector('.task-log-output')?.dataset.taskId;
    const openDetails = new Set([...document.querySelectorAll('.config-group[open]')].map((node) => node.querySelector('summary > span')?.firstChild?.textContent));
    app.className = (state.mobileOpen ? 'drawer-open ' : '') + (ctx.project && ctx.environment ? 'project-shell' : '');
    const managed = window.OzzManagement?.render(ctx);
    app.innerHTML = (!state.signedIn ? '' : sidebar(ctx)) + (state.mobileOpen ? '<button class="drawer-backdrop" data-action="toggle-menu" aria-label="关闭导航"></button>' : '') + '<div class="workspace' + (!state.signedIn ? ' logged-out' : '') + '">' + topbar(ctx) + (state.readOnly ? notice('平台正在恢复核验，当前只读。可以查看资源、日志与原任务。<a href="#/activity">查看平台状态</a>', 'warning') : '') + (!state.signedIn ? loginPage() : managed || renderPage(ctx)) + '</div>' + (state.modal ? modalHTML(ctx) : '');
    document.title = (ctx.service?.draft.name || ctx.project?.name || '项目') + ' · Ozz 交互原型';
    document.body.classList.toggle('modal-open', Boolean(state.modal));
    if (state.modal && state.modal !== renderedModal) document.querySelector('.modal-layer')?.setAttribute('data-enter', '');
    renderedModal = state.modal;
    renderedHash = location.hash || '#/projects';
    restoreManagedInputs?.();
    decorateCopies();
    if (ctx.kind === 'new-project' && state.projectDraft.uncertain) document.querySelectorAll('main form input, main form select, main form textarea').forEach((node) => { node.disabled = true; });
    if (state.pendingAction) {
      const scope = document.querySelector(state.modal ? '.dialog' : 'main');
      scope?.setAttribute('aria-busy', 'true');
      const action = { 'create-project': 'submit-project', 'source-review': 'source-review-submit', 'deploy-review': 'confirm-deploy', confirm: 'confirm-submit', 'service-config': 'save-config-submit' }[state.pendingAction.action] || state.pendingAction.action;
      const trigger = scope?.querySelector('[data-action="' + action + '"]') || scope?.querySelector('[data-form="' + state.pendingAction.action + '"] button[type="submit"]') || (state.pendingAction.action === 'service-config' ? scope?.querySelector('[data-action="save-config"]') : null);
      const width = trigger?.getBoundingClientRect().width;
      scope?.querySelectorAll('button, input, select, textarea').forEach((node) => { node.disabled = true; });
      scope?.querySelectorAll('a[href]').forEach((node) => { node.setAttribute('aria-disabled', 'true'); node.tabIndex = -1; });
      if (trigger) { trigger.style.minWidth = width + 'px'; trigger.innerHTML = icon('refresh', 'pending-icon') + esc(state.pendingAction.label); trigger.setAttribute('aria-busy', 'true'); }
    }
    document.querySelectorAll('.config-group').forEach((node) => { if (openDetails.has(node.querySelector('summary > span')?.firstChild?.textContent)) node.open = true; });
    if (keep.id) {
      const el = document.getElementById(keep.id);
      if (el) { el.focus({ preventScroll: true }); try { if (keep.start !== null) el.setSelectionRange(keep.start, keep.end); } catch {} }
    }
    if (document.querySelector('.modal-body')) document.querySelector('.modal-body').scrollTop = scrollTop;
    if (logScroll !== undefined && document.querySelector('.log-modal-body .log-output')) {
      const log = document.querySelector('.log-modal-body .log-output'); const settings = state.logViews[state.modal?.serviceId];
      log.scrollTop = settings?.follow && !settings?.paused ? log.scrollHeight : logScroll;
    }
    if (document.querySelector('.task-log-output')) {
      const log = document.querySelector('.task-log-output'); const settings = state.taskLogViews[log.dataset.taskId];
      log.scrollTop = settings?.follow && !settings?.paused ? log.scrollHeight : (taskLogId === log.dataset.taskId ? taskLogScroll : settings?.scrollTop) || 0;
    }
    if (opts.focusHeading) document.querySelector('h1')?.focus({ preventScroll: true });
  }
  function renderPage(ctx) {
    if (ctx.kind === 'projects') return projectsPage();
    if (ctx.kind === 'new-project') return createProjectPage();
    if (ctx.kind === 'project') return projectEmptyPage(ctx);
    if (ctx.kind === 'service') return servicePage(ctx);
    if (ctx.kind === 'missing' || ctx.kind === 'invalid-environment') return '<main class="content narrow"><h1>' + (ctx.kind === 'invalid-environment' ? '请选择正确的环境' : '页面无法打开') + '</h1>' + notice(esc(ctx.message), 'warning') + (ctx.project ? '<div class="stack">' + ctx.project.environments.map((e) => linkButton(esc(e.name), projectUrl(ctx.project, '', e.id))).join('') + linkButton('查看保留资源', '#/resources?project=' + ctx.project.id) + '</div>' : linkButton('返回项目', '#/projects')) + '</main>';
    return '<main class="content"><h1>功能入口</h1>' + notice('此管理模块正在装配。项目服务工作区已可体验。') + linkButton('返回项目', '#/projects') + '</main>';
  }

  function projectsPage() {
    const filtered = state.scenario === 'empty' ? [] : state.projects.filter((p) => (p.name + ' ' + p.slug).toLowerCase().includes(state.search.toLowerCase()));
    return '<main class="content projects-content"><div class="page-heading"><div><h1 tabindex="-1">项目</h1><p>应用、数据库和部署，都从这里开始。</p></div>' + linkButton(icon('plus') + '创建项目', '#/projects/new') + '</div><div class="toolbar"><label class="search-field">' + icon('search') + '<input id="project-search" data-action="project-search" value="' + esc(state.search) + '" placeholder="搜索项目" aria-label="搜索项目"></label><a class="text-link" href="#/resources">所有资源' + icon('arrow') + '</a></div>' + (state.scenario === 'page-error' ? notice('项目列表刷新失败。下面保留上次成功载入的项目。' + button('重新加载', 'clear-scenario', { small: true }), 'error') : '') + (filtered.length ? '<div class="project-list">' + filtered.map((p) => '<a class="project-list-row" href="' + projectUrl(p) + '"><span class="project-avatar">' + esc(p.name.slice(0, 1)) + '</span><div class="project-list-main"><strong>' + esc(p.name) + '</strong><small>' + (p.services.length ? p.services.length + ' 个服务' : '尚未添加服务') + (p.environments.length > 1 ? ' · ' + p.environments.length + ' 个环境' : '') + '</small></div><div class="project-service-names">' + p.services.slice(0, 3).map((s) => '<span>' + icon(sourceIcon(s.draft.source)) + esc(s.draft.name) + '</span>').join('') + '</div><div class="project-target"><span>' + esc(targetFor(p).name) + '</span><small>' + esc(targetFor(p).location) + ' · ' + esc(statusNames[targetFor(p).status]) + '</small></div>' + icon('chevron') + '</a>').join('') + '</div>' : empty(state.search ? '没有匹配的项目' : '创建第一个项目', state.search ? '试试其他名称，或清空搜索。' : '先选择部署位置，再添加应用或数据库。', state.search ? button('清空搜索', 'clear-search') : linkButton('创建项目', '#/projects/new'))) + '<div class="list-footer"><span>' + filtered.length + ' 个项目</span><a href="#/activity">查看最近活动' + icon('arrow') + '</a></div></main>';
  }
  function createProjectPage() {
    const draft = state.projectDraft;
    const requestedTarget = context().params.get('target');
    if (requestedTarget && !draft.dirty && state.clusters.some((t) => t.id === requestedTarget)) draft.targetId = requestedTarget;
    const targets = state.clusters.filter((t) => (t.name + t.location).toLowerCase().includes(state.targetSearch.toLowerCase()));
    return '<main class="content narrow create-project-content"><a class="page-back" href="#/projects">' + icon('back') + '项目</a><h1 tabindex="-1">创建项目</h1><p class="page-intro">选择项目的部署位置，稍后添加第一个服务。</p><form data-form="create-project" novalidate>' + formError(state.modal ? '' : state.errors.form) + '<section class="form-section"><div class="section-heading"><h2>部署位置</h2><a class="text-link" href="#/server/new?returnTo=create-project">' + icon('plus') + '接入服务器</a></div><p class="section-hint">同一个项目的服务使用相同的集群。</p><div class="target-choices">' + targets.map((target) => '<label class="target-option' + (draft.targetId === target.id ? ' selected' : '') + '"><input type="radio" name="target" data-bind="project.targetId" value="' + target.id + '"' + checked(draft.targetId === target.id) + '><span class="target-symbol">' + icon('server') + '</span><span class="target-label"><strong>' + esc(target.name) + '</strong><small>' + esc(target.location) + ' · ' + (target.nodeCount || 1) + ' 个节点 · ' + (target.cpu || '未知') + ' vCPU / ' + (target.memory || '未知') + ' GB</small></span>' + badge(target.status) + '</label>').join('') + (targets.length ? '' : empty('尚无部署位置', '接入服务器或导入已有集群后返回这里。', linkButton('导入集群', '#/cluster/new?returnTo=create-project'))) + '</div>' + (targetFor({ targetId: draft.targetId }).status !== 'ready' ? notice('当前目标尚未验证。可以保存项目，首次部署前需要验证连接。', 'warning') : '') + '</section><section class="form-section">' + field('项目名称 <span class="optional">可选</span>', 'project.name', draft.name, { placeholder: '例如：我的博客', hint: '留空会生成一个名称，之后可以修改。' }) + disclosure('更多设置', field('项目标识', 'project.slug', draft.slug, { placeholder: '自动生成', hint: '用于资源命名，创建后保持稳定。' }) + field('描述', 'project.description', draft.description, { textarea: true, placeholder: '这个项目用来做什么？' })) + '</section><div class="form-footer"><a class="btn subtle" href="#/projects">取消</a>' + button(draft.createdId ? '确认已创建项目' : '创建项目', 'submit-project', { type: 'submit', primary: true, disabled: state.readOnly || !targets.length }) + '</div></form></main>';
  }
  function projectEmptyPage(ctx) {
    return '<main class="content project-empty"><div class="empty-illustration">' + icon('image') + '<span>+</span>' + icon('database') + '</div><h1>' + esc(ctx.project.name) + '</h1><p>项目已准备好，添加一个服务开始部署。</p>' + button('新建服务', 'add-service', { primary: true, icon: 'plus', disabled: state.readOnly }) + '<div class="empty-source-labels"><span>' + icon('git') + 'GitHub</span><span>' + icon('image') + 'Docker</span><span>' + icon('database') + '数据库</span></div><a class="text-link" href="' + projectUrl(ctx.project, '/settings') + '">项目设置</a></main>';
  }
  function creationDraft(ctx) {
    const key = ctx.project.id + '/' + ctx.environment.id;
    return state.creationDrafts[key] || (state.creationDrafts[key] = { ...defaultConfig(), key, fallback: uid('service'), createdServiceId: null, newVolumeEnabled: false, newVolumeName: '', newVolumeSize: '5', newVolumePath: '/data', registryUsername: '', selectedSource: '', dirty: false });
  }
  function openSource(ctx) {
    if (!ctx.project || !ctx.environment) return;
    const draft = creationDraft(ctx);
    openModal({ type: 'source', step: draft.saveUnknown ? 'save-unknown' : draft.createdServiceId ? 'config' : 'sources', title: '新建服务', projectId: ctx.project.id, environmentId: ctx.environment.id, draft });
  }
  function sourceContext(modal = state.modal) {
    const project = state.projects.find((p) => p.id === modal.projectId);
    const environment = project?.environments.find((e) => e.id === modal.environmentId);
    return { project, environment };
  }
  function selectCreationSource(source, defaults = {}) {
    const draft = state.modal.draft;
    if (draft.selectedSource === source) return draft;
    const saved = draft.sourceDrafts || {};
    if (draft.selectedSource) { const current = { ...draft }; delete current.sourceDrafts; saved[draft.selectedSource] = clone(current); }
    const next = saved[source] || { ...defaultConfig(defaults), key: draft.key, fallback: uid('service'), createdServiceId: null, newVolumeEnabled: false, newVolumeName: '', newVolumeSize: '5', newVolumePath: '/data', selectedSource: source, dirty: false };
    for (const key of Object.keys(draft)) delete draft[key];
    Object.assign(draft, next, { sourceDrafts: saved, selectedSource: source });
    return draft;
  }
  function sourceStep(step) {
    state.modal.step = step; state.errors = {}; state.commandIndex = 0; render();
    const body = document.querySelector('.modal-body'); if (body) body.scrollTop = 0;
    focusModal();
  }
  function chooseSource(source) {
    if (source === 'application' || source === 'database-menu') return sourceStep(source);
    selectCreationSource(source, { source });
    sourceStep(source === 'git' ? 'repositories' : 'config');
  }
  function chooseTemplate(templateId) {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    const database = template.category === 'database';
    selectCreationSource(templateId, {
      source: database ? 'database' : 'template', templateId, template: templateId, version: template.version,
      name: templateId === 'postgresql' ? 'postgres' : templateId === 'docker' ? '' : template.id,
      image: template.image, imageVersion: template.imageVersion || '', imageDigest: template.digest || '', storage: template.storage || '4',
      port: template.port, targetPort: template.port, portName: database ? 'tcp' : 'http', type: database ? 'database' : 'web', expose: database ? 'private' : 'http',
      requestCpu: template.resources[0], requestMemory: template.resources[1], cpu: template.resources[2], memory: template.resources[3],
      readinessType: database ? 'tcp' : 'http', readinessDelay: '0', readinessTimeout: '2', startupType: database ? 'tcp' : 'http', startupTimeout: '2', startupFailures: database ? '60' : '24',
      command: templateId === 'node-example' ? '["node"]' : '',
      args: templateId === 'node-example' ? JSON.stringify(['-e', "require('node:http').createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify({message:'Hello from Ozz',runtime:process.version}));}).listen(8080,'0.0.0.0');"]) : templateId === 'redis' ? '["redis-server","/run/ozz/database/redis.conf"]' : '',
      username: templateId === 'redis' ? 'default' : 'app', databaseName: templateId === 'redis' ? '' : 'app',
    });
    sourceStep('config');
  }
  function sourcePanel() {
    const modal = state.modal; const draft = modal.draft; const ctx = sourceContext();
    if (modal.step === 'sources') return '<div class="command-heading"><span class="command-breadcrumb">添加服务</span><span>选择服务来源…</span></div><div class="command-list">' + [
      ['git', 'git', 'GitHub 仓库', '连接仓库，通过 Dockerfile 构建'],
      ['image', 'image', 'Docker 容器镜像', '使用公共或私有镜像'],
      ['application', 'layers', '应用模板', 'Docker、Node.js 示例、静态网站'],
      ['database-menu', 'database', '数据库', 'PostgreSQL、Redis'],
    ].map(([source, symbol, label, detail], index) => '<button class="command-item" data-command-item data-action="choose-source" data-source="' + source + '" data-index="' + index + '"><span class="command-icon">' + icon(symbol) + '</span><span><strong>' + label + '</strong><small>' + detail + '</small></span>' + icon('chevron') + '</button>').join('') + '</div><div class="command-context">' + icon('server') + esc(targetFor(ctx.project).name) + (ctx.project.environments.length > 1 ? ' · ' + esc(ctx.environment.name) : '') + '</div>' + commandFooter();
    if (modal.step === 'application' || modal.step === 'database-menu') {
      const category = modal.step === 'application' ? 'application' : 'database';
      return commandTitle(category === 'database' ? '数据库' : '应用模板') + '<div class="command-list">' + templates.filter((t) => t.category === category).map((template, i) => '<button class="command-item" data-command-item data-action="choose-template" data-id="' + template.id + '" data-index="' + i + '"><span class="command-icon ' + template.id + '">' + icon(category === 'database' ? 'database' : 'layers') + '</span><span><strong>' + template.name + '</strong><small>' + template.description + '</small></span><span class="template-version">' + template.version + '</span>' + icon('chevron') + '</button>').join('') + '</div><div class="command-context">内置模板 · 固定版本 · ' + (category === 'database' ? '仅私有网络，默认单实例' : '示例模板使用预构建镜像') + '</div>' + commandFooter();
    }
    if (modal.step === 'repositories') {
      const integration = state.integrations.find((i) => i.kind === 'github' && i.status === 'ready');
      return commandTitle('GitHub 仓库') + (!integration || state.scenario === 'integration-missing' ? '<div class="modal-body">' + empty('先连接 GitHub', '使用已保存的授权读取仓库和分支。', linkButton('管理 GitHub 连接', '#/settings?tab=integrations')) + '</div>' : '<div class="command-search">' + icon('search') + '<input id="repo-search" data-bind="create.repoSearch" value="' + esc(draft.repoSearch || '') + '" placeholder="搜索授权仓库" /></div><div class="command-list">' + ['demo/personal-blog', 'demo/notes', 'demo/api-worker'].filter((name) => name.includes(draft.repoSearch || '')).map((name, i) => '<button class="command-item" data-command-item data-index="' + i + '" data-action="choose-repository" data-id="' + name + '">' + icon('git') + '<span><strong>' + name + '</strong><small>main · Dockerfile · 已授权</small></span>' + icon('chevron') + '</button>').join('') + '</div><div class="command-context"><a class="text-link" href="#/settings?tab=integrations">管理授权与构建连接</a></div>') + commandFooter();
    }
    if (modal.step === 'save-unknown') return commandTitle('确认服务保存结果') + '<div class="modal-body">' + notice('保存请求已受理，但响应未能确认。原请求与输入已固定；先核对是否已保存，不会再次创建服务。', 'warning') + keyValues([['请求中的服务', esc(draft.name)], ['固定请求 / 服务 ID', '<code>' + esc(draft.fallback) + '</code>'], ['部署', '尚未创建部署任务']]) + formError(state.errors.form) + '</div><div class="modal-actions"><span class="hint">确认保存结果后可继续或稍后部署。</span>' + button('确认已保存服务', 'source-confirm-saved', { primary: true }) + '</div>';
    if (modal.step === 'review') return commandTitle('核对部署配置') + '<div class="modal-body">' + formError(state.errors.form) + notice('服务草稿已保存 · r' + draft.savedRevision + '。确认后才会创建部署任务；也可以稍后部署。') + configurationSummary(draft, ctx.project) + '<p class="hint">此演示只更新原型中的服务与任务，不连接真实仓库或服务器。</p></div><div class="modal-actions">' + button('返回修改', 'source-config') + button('稍后部署', 'create-draft') + button('确认发布', 'create-deploy', { primary: true, disabled: state.readOnly || targetFor(ctx.project).status !== 'ready' }) + '</div>';
    const database = draft.source === 'database';
    const template = templates.find((t) => t.id === draft.templateId);
    const title = database ? '部署 ' + template.name : draft.source === 'git' ? '部署 GitHub 仓库' : draft.source === 'template' ? '部署 ' + template.name : '部署 Docker 镜像';
    return commandTitle(title) + '<form data-form="source-review" novalidate><div class="modal-body creation-body">' + formError(state.errors.form) +
      (draft.source === 'git' ? '<div class="source-repository">' + icon('git') + '<strong>' + esc(draft.repository) + '</strong>' + button('更换', 'choose-git-repository', { small: true, subtle: true }) + '</div><div class="two-fields">' + selectField('分支', 'create.branch', draft.branch, [['main', 'main'], ['release', 'release'], ['develop', 'develop']]) + field('Dockerfile', 'create.dockerfile', draft.dockerfile, { placeholder: 'Dockerfile', required: true }) + '</div>' :
        database ? '<div class="source-repository"><span class="database-logo">' + icon('database') + '</span><div><strong>' + template.name + ' ' + template.imageVersion + '</strong><small>模板 ' + template.version + ' · 单实例 · 私有网络</small></div></div><div class="two-fields">' + field('固定镜像', 'create.image', draft.image, { readonly: true, hint: '镜像已固定 digest。主版本升级使用独立维护流程。' }) + field('数据卷容量 / GiB', 'create.storage', draft.storage, { type: 'number', min: 1, max: 1024, hint: 'local-path 申请容量不代表硬配额。' }) + '</div>' + (template.id === 'postgresql' ? '<div class="two-fields">' + field('数据库名称', 'create.databaseName', draft.databaseName) + field('用户名', 'create.username', draft.username) + '</div>' : field('数据库编号', 'create.redisDatabase', draft.redisDatabase, { type: 'number', min: 0, max: 15, hint: '认证开启，AOF 每秒同步；可能丢失最近约一秒的数据。' })) :
        field('容器镜像 <span class="required">*</span>', 'create.image', draft.image, { placeholder: '例如 nginx:1.28.3-alpine3.23', required: true, readonly: Boolean(template?.digest), hint: template?.digest ? '模板 ' + template.version + ' · 镜像 ' + template.imageVersion + '，已固定 digest。' : '指定镜像仓库与版本。发布时会固定镜像 digest。' }) + (draft.source === 'template' && template.id !== 'docker' ? notice(template.id === 'node-example' ? '官方 Node.js 预构建运行时与固定示例程序，不需要源码构建。' : '使用官方 Nginx 镜像内的欢迎页面，不需要源码构建。') : '') + '<div class="two-fields">' + field('服务端口', 'create.port', draft.port, { type: 'number', min: 1, max: 65535, hint: '请与容器实际监听端口一致，例如 Nginx 使用 80。' }) + selectField('拉取凭证', 'create.credentialId', draft.credentialId, [['', '公共镜像，无需凭证'], ...state.credentials.filter((c) => c.kind === 'registry').map((c) => [c.id, c.name])], '<a href="#/settings?tab=credentials" class="text-link">添加凭证</a>') + '</div>') +
      configurationGroups(draft, 'create', ctx, true) + '<p class="hint creation-save-hint">' + (draft.createdServiceId ? '保存到同一个服务草稿，再核对并部署。关闭后仍可从服务继续。' : '下一步先保存为服务草稿，再核对并部署；保存本身不会启动应用。') + '</p>' +
      '</div><div class="modal-actions"><span class="modal-target">' + icon('server') + esc(targetFor(ctx.project).name) + '</span>' + button(draft.createdServiceId ? '取消修改' : '取消', 'source-cancel') + button('核对部署配置', 'source-review-submit', { type: 'submit', primary: true, disabled: state.readOnly }) + '</div></form>';
  }
  function commandTitle(title) {
    const locked = Boolean(interactionLock());
    return '<div class="command-heading"><button class="command-back" data-action="source-back" aria-label="返回上一层"' + disabled(locked) + '>' + icon('back') + '</button><strong id="creation-step-title" tabindex="-1">' + title + '</strong><button class="dialog-close icon-btn" data-action="close-modal" aria-label="关闭"' + disabled(locked) + '>' + icon('close') + '</button></div>';
  }
  function commandFooter() {
    return '<div class="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 确认</span><span><kbd>Esc</kbd> 返回</span></div>';
  }
  function variablesEditor(config, prefix = 'config') {
    return '<div class="variables-toolbar"><span>' + config.variables.length + ' 个变量</span><div>' + button('导入 .env', 'import-env', { small: true, icon: 'file', attrs: ' data-prefix="' + prefix + '"' }) + button('添加变量', 'variable-add', { small: true, icon: 'plus', attrs: ' data-prefix="' + prefix + '"' }) + '</div></div>' +
      (config.variables.length ? '<div class="variable-table"><div class="variable-labels"><span>变量名</span><span>值类型</span><span>值或凭证引用</span><span></span></div>' + config.variables.map((row, i) => '<div class="variable-row">' + field('<span class="sr-only">变量名</span>', prefix + '.variables.' + i + '.key', row.key, { placeholder: 'VARIABLE_NAME' }) + selectField('<span class="sr-only">值类型</span>', prefix + '.variables.' + i + '.mode', row.mode, [['plain', '普通值'], ['secret', '秘密值'], ['reference', '凭证引用']]) + (row.mode === 'reference' ? selectField('<span class="sr-only">凭证引用</span>', prefix + '.variables.' + i + '.value', row.value, [['', '选择凭证'], ...state.credentials.filter((c) => c.kind === 'generic').map((c) => [c.id, c.name])]) : field('<span class="sr-only">变量值</span>', prefix + '.variables.' + i + '.value', row.value, { type: row.mode === 'secret' ? 'password' : 'text', placeholder: row.mode === 'secret' ? '仅输入演示值' : 'value' })) + '<button type="button" class="icon-btn danger" data-action="variable-remove" data-index="' + i + '" data-prefix="' + prefix + '" aria-label="删除变量">' + icon('trash') + '</button></div>').join('') + '</div>' : '<p class="inline-empty">尚无变量，可以逐项添加，或粘贴 .env 内容批量录入。</p>');
  }
  function configurationGroups(config, prefix, ctx, creating = false) {
    const protectedDb = config.type === 'database';
    const scopeVolumes = state.volumes.filter((v) => v.projectId === ctx.project.id && v.environmentId === ctx.environment.id);
    const git = config.source === 'git';
    return disclosure('服务信息', '<div class="two-fields">' + field('服务名称' + (creating ? ' <span class="optional">可选</span>' : ''), prefix + '.name', config.name, { placeholder: creating ? '自动生成，可稍后修改' : '' }) + field('资源标识', prefix + '.slug', config.slug, { placeholder: '自动生成', readonly: !creating || Boolean(config.createdServiceId) }) + '</div>' + field('描述', prefix + '.description', config.description, { textarea: true }) + selectField('服务类型', prefix + '.type', config.type, protectedDb ? [['database', '数据库']] : [['web', 'Web 应用'], ['worker', '后台进程']]), !creating, config.name || '自动命名') +
      (git ? disclosure('构建设置', '<div class="two-fields">' + selectField('构建执行器', prefix + '.builder', config.builder, state.integrations.filter((i) => i.kind === 'builder').map((i) => [i.id, i.name])) + selectField('镜像仓库', prefix + '.registry', config.registry, state.integrations.filter((i) => i.kind === 'registry').map((i) => [i.id, i.name])) + field('镜像名称', prefix + '.imageName', config.imageName) + selectField('目标架构', prefix + '.architecture', config.architecture, [['amd64', 'amd64'], ['arm64', 'arm64']]) + field('构建上下文', prefix + '.context', config.context) + field('构建参数', prefix + '.buildArgs', config.buildArgs, { placeholder: 'NODE_ENV=production' }) + '</div>' + field('构建秘密引用', prefix + '.buildSecrets', config.buildSecrets, { hint: '使用已保存凭证的引用，不填写真实秘密。' }) + '<label class="checkbox-label"><input type="checkbox" data-bind="' + prefix + '.autoDeploy"' + checked(config.autoDeploy) + '> 跟踪分支有新提交时自动发布</label><p class="hint">服务停止后，新提交只进入待发布列表。</p>', false, 'Dockerfile · ' + config.architecture) : '') +
      disclosure('环境变量', variablesEditor(config, prefix), false, config.variables.length + ' 个变量') +
      disclosure('端口', '<div class="two-fields">' + (creating && !git && !protectedDb ? '' : field('服务端口', prefix + '.port', config.port, { type: 'number', min: 1, max: 65535, readonly: protectedDb, hint: config.type === 'worker' ? '后台进程可以不开放端口。' : '与应用实际监听的端口一致。' })) + field('容器内部端口', prefix + '.targetPort', config.targetPort, { type: 'number', min: 1, max: 65535 }) + field('端口名称', prefix + '.portName', config.portName) + selectField('端口用途', prefix + '.expose', config.expose, protectedDb ? [['private', '仅私有网络']] : [['http', 'HTTP / HTTPS'], ['private', '仅私有网络']]) + '</div><div class="additional-ports">' + (config.ports || []).map((port, i) => '<div class="port-row">' + field('名称', prefix + '.ports.' + i + '.name', port.name) + field('端口', prefix + '.ports.' + i + '.port', port.port, { type: 'number', min: 1, max: 65535 }) + selectField('用途', prefix + '.ports.' + i + '.expose', port.expose, [['private', '私有'], ['http', 'HTTP']]) + button('移除', 'port-remove', { small: true, attrs: ' data-prefix="' + prefix + '" data-index="' + i + '"' }) + '</div>').join('') + '</div>' + button('添加端口', 'port-add', { small: true, icon: 'plus', attrs: ' data-prefix="' + prefix + '"' }), false, config.port ? config.port + ' · ' + (config.expose === 'http' ? 'HTTP' : '私有') : '不开放端口') +
      disclosure('持久化存储', protectedDb ? notice('模板为数据创建独立持久卷。删除服务时保留数据，数据库只运行一个写入实例。') : '<div class="mount-list">' + (config.mounts || []).map((mount, i) => '<div class="mount-form-row">' + selectField('数据卷', prefix + '.mounts.' + i + '.volumeId', mount.volumeId, [['', '选择当前环境的卷'], ...scopeVolumes.map((v) => [v.id, v.name])]) + field('挂载路径', prefix + '.mounts.' + i + '.path', mount.path, { placeholder: '/data' }) + '<label class="checkbox-label"><input type="checkbox" data-bind="' + prefix + '.mounts.' + i + '.readOnly"' + checked(mount.readOnly) + '> 只读</label>' + button('移除', 'mount-remove', { small: true, attrs: ' data-prefix="' + prefix + '" data-index="' + i + '"' }) + '</div>').join('') + '</div>' + button('挂载已有卷', 'mount-add', { small: true, icon: 'plus', attrs: ' data-prefix="' + prefix + '"' }) + (creating ? '<label class="checkbox-label mt-16"><input type="checkbox" data-bind="create.newVolumeEnabled"' + checked(config.newVolumeEnabled) + '> 创建一个新的数据卷</label>' + (config.newVolumeEnabled ? '<div class="three-fields">' + field('卷名称', 'create.newVolumeName', config.newVolumeName, { placeholder: '自动生成' }) + field('容量 / GiB', 'create.newVolumeSize', config.newVolumeSize, { type: 'number', min: 1 }) + field('挂载路径', 'create.newVolumePath', config.newVolumePath) + '</div>' : '') : '<p class="hint"><a class="text-link" href="#/resources?type=volumes&project=' + ctx.project.id + '&env=' + ctx.environment.id + '">管理当前环境的数据卷</a></p>'), false, protectedDb ? (config.storage || '10') + ' GiB 数据卷' : (config.mounts || []).length + ' 个挂载') +
      disclosure('启动命令与资源', '<div class="two-fields">' + field('启动命令', prefix + '.command', config.command, { placeholder: '["node"]', hint: 'JSON 数组；留空使用镜像默认命令。' }) + field('启动参数', prefix + '.args', config.args, { placeholder: '["server.js"]' }) + field('副本数', prefix + '.replicas', config.replicas, { type: 'number', min: 1, max: protectedDb ? 1 : 10, readonly: protectedDb }) + '</div><div class="resource-form-head">资源请求</div><div class="two-fields">' + field('CPU / millicores', prefix + '.requestCpu', config.requestCpu, { type: 'number', min: 1 }) + field('内存 / MiB', prefix + '.requestMemory', config.requestMemory, { type: 'number', min: 16 }) + '</div><div class="resource-form-head">资源上限</div><div class="two-fields">' + field('CPU / millicores', prefix + '.cpu', config.cpu, { type: 'number', min: 1 }) + field('内存 / MiB', prefix + '.memory', config.memory, { type: 'number', min: 16 }) + '</div>', false, config.replicas + ' 副本 · ' + config.cpu + 'm / ' + config.memory + ' MiB') +
      disclosure('健康检查', ['readiness', 'startup'].map((probe) => '<div class="probe-section"><h3>' + (probe === 'readiness' ? '就绪检查' : '启动检查') + '</h3><div class="two-fields">' + selectField('检查方式', prefix + '.' + probe + 'Type', config[probe + 'Type'], [['none', '不配置'], ['http', 'HTTP'], ['tcp', 'TCP']]) + (config[probe + 'Type'] === 'http' ? field('HTTP 路径', prefix + '.' + probe + 'Path', config[probe + 'Path']) : '') + '</div>' + (config[probe + 'Type'] !== 'none' ? '<div class="three-fields">' + field('初始延迟 / 秒', prefix + '.' + probe + 'Delay', config[probe + 'Delay'], { type: 'number', min: 0 }) + field('超时 / 秒', prefix + '.' + probe + 'Timeout', config[probe + 'Timeout'], { type: 'number', min: 1 }) + field('失败阈值', prefix + '.' + probe + 'Failures', config[probe + 'Failures'], { type: 'number', min: 1 }) + '</div><p class="hint">检查服务的具名端口，发布以新版本实例健康为准。</p>' : '') + '</div>').join(''), false, config.readinessType === 'none' ? '尚未配置' : config.readinessType.toUpperCase());
  }
  function configurationSummary(config, project) {
    const vars = config.variables.map((v) => v.key + (v.mode === 'plain' ? '=' + v.value : '=••••••••')).join('\n');
    return '<div class="review-summary"><div class="review-service-title">' + icon(sourceIcon(config.source)) + '<h2>' + esc(config.name || '自动命名') + '</h2></div>' + keyValues([
      ['来源', '<span class="mono">' + esc(sourceReference(config)) + '</span>'],
      ...(config.templateId ? [['模板版本', esc(config.templateId + ' / ' + config.version)]] : []),
      ...(config.imageDigest ? [['固定镜像摘要', '<code>' + esc(config.imageDigest) + '</code>']] : []),
      ['部署位置', esc(targetFor(project).name)],
      ['运行方式', (config.type === 'database' ? '数据库' : config.type === 'worker' ? '后台进程' : 'Web 应用') + ' · ' + esc(config.replicas) + ' 副本'],
      ['端口', esc(config.port || '不开放') + (config.port ? ' · ' + (config.expose === 'http' ? 'HTTP' : '私有网络') : '')],
      ['资源', esc(config.requestCpu) + 'm / ' + esc(config.requestMemory) + ' MiB 请求；' + esc(config.cpu) + 'm / ' + esc(config.memory) + ' MiB 上限'],
      ['健康检查', config.readinessType === 'none' ? '未配置' : esc(config.readinessType.toUpperCase() + (config.readinessType === 'http' ? ' ' + config.readinessPath : ''))],
      ['持久化', config.type === 'database' ? esc(config.storage || '10') + ' GiB 独立数据卷' : (config.mounts || []).length + ' 个已有挂载' + (config.newVolumeEnabled ? ' + 新建 ' + esc(config.newVolumeSize) + ' GiB 卷' : '')],
      ['环境变量', vars ? '<pre class="inline-code">' + esc(vars) + '</pre>' : '无'],
    ]) + '</div>';
  }

  function servicePage(ctx) {
    const s = ctx.service; const d = s.draft;
    const aliases = { overview: 'status', configuration: 'settings', source: 'settings', deployments: 'status', logs: 'status', network: 'network', storage: 'storage', usage: 'usage', variables: 'variables' };
    const requested = ctx.params.get('tab') || 'status';
    const tab = aliases[requested] || (['status', 'variables', 'usage', 'network', 'storage', 'settings'].includes(requested) ? requested : 'status');
    const activeTask = state.tasks.find((t) => t.serviceId === s.id && ['queued', 'running', 'cancelling', 'unknown'].includes(t.status));
    const tabs = [['status', 'info', '服务状态'], ['variables', 'key', '环境变量'], ['usage', 'usage', '用量'], ['network', 'globe', '网络'], ['storage', 'disk', '硬盘'], ['settings', 'settings', '设置']];
    return '<main class="content service-content"><div class="service-heading"><div class="service-heading-main"><span class="service-heading-icon ' + esc(d.source) + '">' + icon(sourceIcon(d.source)) + '</span><div><h1 tabindex="-1">' + esc(d.name) + '</h1><p class="service-created">创建于 ' + date(s.createdAt) + '</p><button class="copy-id" data-action="copy" data-copy="' + esc(s.id) + '"><code>' + esc(s.id) + '</code>' + icon('copy') + '</button></div></div><div class="service-heading-actions">' + (hasChanges(s) ? '<span class="draft-label"><i></i> 有待发布修改</span>' : '') + button('部署', 'review-deploy', { primary: true, icon: 'play', disabled: state.readOnly || Boolean(activeTask) }) + '<details class="more-menu"><summary class="icon-btn" aria-label="更多服务操作">' + icon('more') + '</summary><div>' + button(s.status === 'stopped' ? '恢复原已发布版本' : '停止服务', s.status === 'stopped' ? 'service-resume' : 'service-stop', { icon: s.status === 'stopped' ? 'play' : 'stop', disabled: state.readOnly || !s.publishedSnapshot || Boolean(activeTask) }) + button('删除服务', 'service-delete', { danger: true, icon: 'trash', disabled: state.readOnly || Boolean(activeTask) }) + '</div></details></div></div>' +
      '<nav class="service-tabs" aria-label="服务详情">' + tabs.map(([idValue, symbol, label]) => '<a class="' + (tab === idValue ? 'active' : '') + '" href="' + serviceUrl(ctx.project, s, idValue) + '">' + icon(symbol) + '<span>' + label + '</span>' + (idValue === 'variables' && dirtyEdit(s) ? '<i class="unsaved-dot"></i>' : '') + '</a>').join('') + '</nav>' +
      (state.scenario === 'page-error' ? notice('刷新服务失败。当前显示最后一次成功观察，运行状态需要重新确认。' + button('重新加载', 'clear-scenario', { small: true }), 'error') : '') +
      (activeTask ? '<div class="active-task-bar">' + badge(activeTask.status) + '<span>' + esc(activeTask.name) + '</span>' + button('查看任务', 'task-detail', { small: true, id: activeTask.id }) + '</div>' : '') +
      (tab === 'status' ? statusPage(ctx) : tab === 'variables' ? variablesPage(ctx) : tab === 'usage' ? usagePage(ctx) : tab === 'network' ? networkPage(ctx) : tab === 'storage' ? storagePage(ctx) : serviceSettingsPage(ctx)) +
      '</main>';
  }
  function statusPage(ctx) {
    const s = ctx.service; const published = s.publishedSnapshot; const latest = state.tasks.find((t) => t.id === s.lastTaskId);
    const observation = state.scenario === 'offline' ? 'unknown' : s.status;
    const domains = state.domains.filter((d) => d.serviceId === s.id);
    return '<section class="runtime-card"><div class="runtime-main"><div class="runtime-heading"><h2>' + esc(statusNames[observation]) + '</h2><i class="live-dot ' + observation + '"></i>' + button(s.status === 'running' ? (s.publishedSnapshot?.replicas || '1') + '/' + (s.publishedSnapshot?.replicas || '1') + ' 实例' + icon('down') : '查看实例' + icon('down'), 'instances', { subtle: true, small: true }) + '</div><p class="observation-time">' + (s.status === 'draft' ? '保存配置后，等待首次发布' : '最近观察 ' + date(s.observedAt)) + '</p><dl class="runtime-source"><dt>Source</dt><dd>' + icon(sourceIcon(s.draft.source)) + '<button data-action="show-source" class="source-link mono">' + esc(published ? sourceReference(published) : sourceReference(s.draft)) + '</button></dd><dt>Server</dt><dd><a href="#/cluster/' + targetFor(ctx.project).id + '">' + icon('server') + esc(targetFor(ctx.project).name) + '</a></dd><dt>配置</dt><dd>' + (published ? '已发布 r' + s.publishedRevision : '尚未发布') + (hasChanges(s) ? '<span class="pending-config">草稿 r' + s.revision + ' 待发布</span>' : '') + '</dd></dl><div class="runtime-actions">' + button(s.status === 'stopped' ? '恢复原已发布版本' : '重新启动', s.status === 'stopped' ? 'service-resume' : 'service-restart', { icon: 'refresh', disabled: state.readOnly || !published || state.tasks.some((t) => t.serviceId === s.id && ['queued', 'running'].includes(t.status)) }) + (s.status === 'stopped' ? '<small>使用上次发布的配置，保留当前草稿</small>' : '') + '</div></div><div class="runtime-details"><div class="instance-identity"><span>' + icon('server') + '当前实例</span>' + badge(observation) + '</div>' + keyValues([
      ['Pod', '<button class="mono text-link" data-action="instances">' + esc(s.status === 'stopped' || s.status === 'draft' ? '暂无运行实例' : s.podId) + '</button>'],
      ['Node', esc(targetFor(ctx.project).name.toLowerCase())],
      ['内存', observation === 'running' ? s.memoryMiB + ' MiB / ' + (published?.memory || s.draft.memory) + ' MiB' : '未知'],
      ['CPU', observation === 'running' ? s.cpuMilli + 'm / ' + (published?.cpu || s.draft.cpu) + 'm' : '未知'],
      ['重启', String(s.restarts || 0) + ' 次'],
    ]) + '</div></section>' +
      (latest?.status === 'failed' ? notice('最近一次部署失败。' + esc(latest.error || '检查任务输出后重试。') + button('查看失败记录', 'task-detail', { small: true, id: latest.id }), 'error') : '') +
      (s.configurationState === 'partial' ? notice('远端只应用了部分配置。重新部署前需要复核并确认修复意图。', 'warning') : '') +
      '<div class="service-shortcuts"><section class="domain-shortcut"><div class="shortcut-head"><span>域名</span><a href="' + serviceUrl(ctx.project, s, 'network') + '">管理 ' + icon('chevron') + '</a></div>' + (domains.length ? domains.map((domain) => '<a class="domain-shortcut-row" href="#/domain/' + domain.id + '"><strong>' + esc(domain.hostname) + '</strong>' + badge(domain.status, domain.status === 'ready' ? '已配置' : undefined) + icon('external') + '</a>').join('') : '<div class="domain-shortcut-row"><span class="muted">' + (s.draft.type === 'database' ? '数据库默认使用私有网络' : '尚未分配域名') + '</span><a class="text-link" href="' + serviceUrl(ctx.project, s, 'network') + '">' + (s.draft.type === 'database' ? '查看连接' : '分配域名') + '</a></div>') + '</section><button class="shortcut-button" data-action="open-logs">' + icon('log') + '<span>日志</span><small>实例与容器输出</small></button><button class="shortcut-button" data-action="deployment-history">' + icon('clock') + '<span>部署记录</span><small>历史、阶段与重试</small></button></div>' +
      (s.pendingCommits.length ? '<section class="pending-commits section"><div class="section-heading"><h2>待发布提交</h2>' + button(s.status === 'stopped' ? '部署并启动' : '核对最新提交', 'review-deploy', { small: true, primary: true, disabled: state.readOnly }) + '</div>' + s.pendingCommits.map((commit) => '<div class="commit-row">' + icon('git') + '<code>' + esc(commit.sha) + '</code><span>' + esc(commit.message) + '</span><small>' + esc(commit.branch) + '</small></div>').join('') + '<p class="hint">停止期间的提交保留在这里，恢复原版本不会消费它们。</p></section>' : '') +
      '<section class="section"><div class="section-heading"><h2>最近部署</h2>' + button('全部记录', 'deployment-history', { subtle: true, small: true }) + '</div>' + deploymentTable(state.tasks.filter((t) => t.kind === 'deployment' && t.serviceId === s.id).slice(0, 4)) + '</section>' +
      '<section class="section events-section"><div class="section-heading"><h2>最近事件</h2>' + button('重新观察', 'refresh-runtime', { small: true, icon: 'refresh' }) + '</div>' + (state.scenario === 'offline' ? notice('部署位置失联。保留最后一次观察，不将服务显示为已停止。', 'warning') : '<div class="event-row"><span class="event-dot"></span><span>' + (s.status === 'stopped' ? '已按用户意图将副本缩减为 0，配置与数据卷保留。' : s.status === 'draft' ? '已保存服务草稿，尚未创建运行实例。' : '目标配置与实例观察一致，' + s.podId + ' 已就绪。') + '</span><time>' + date(s.observedAt) + '</time></div>') + '</section><div class="planning-link">' + icon('layers') + '<span>文件管理、容器终端与历史回滚在产品规划中。</span>' + button('查看规划', 'planning-service', { subtle: true, small: true }) + '</div>';
  }
  function deploymentTable(tasks) {
    if (!tasks.length) return empty('还没有部署记录', '保存配置后，点击部署来创建第一次发布。');
    return '<div class="table-scroll"><table class="data-table deployment-table"><thead><tr><th>部署</th><th>状态</th><th>来源</th><th>配置</th><th>时间</th><th></th></tr></thead><tbody>' + tasks.map((task) => '<tr><td><button class="text-link" data-action="task-detail" data-id="' + task.id + '">' + esc(task.name) + '</button>' + (task.attemptOf ? '<small class="block muted">重试自 ' + esc(task.attemptOf) + '</small>' : '') + '</td><td>' + badge(task.status) + '</td><td class="mono truncate">' + esc(task.commit || task.image || task.snapshot?.image || '固定配置') + '</td><td>r' + (task.revision || '1') + '</td><td>' + date(task.createdAt) + '</td><td><button class="icon-btn" data-action="task-detail" data-id="' + task.id + '" aria-label="查看部署详情">' + icon('chevron') + '</button></td></tr>').join('') + '</tbody></table></div>';
  }
  function variablesPage(ctx) {
    const s = ctx.service; const edit = serviceEdit(s);
    return '<section class="variables-page"><div class="section-heading"><div><h2>环境变量</h2><p class="section-hint">修改保存为草稿，发布后进入运行实例。</p></div>' + button('保存草稿', 'save-config', { primary: true, disabled: state.readOnly || !dirtyEdit(s) }) + '</div>' + formError(state.modal ? '' : state.errors.form) + (dirtyEdit(s) ? '<div class="unsaved-bar"><span>有尚未保存的修改</span>' + button('放弃修改', 'discard-config', { small: true, subtle: true }) + '</div>' : '') + variablesEditor(edit) + '<div class="variable-footer">' + notice('秘密值在界面中隐藏。当前为演示，请勿输入真实凭证。') + '</div><section class="section"><div class="section-heading"><h2>数据库连接注入</h2><a class="text-link" href="' + serviceUrl(ctx.project, s, 'storage') + '">管理连接' + icon('arrow') + '</a></div>' + (s.draft.connections.length ? s.draft.connections.map((connection) => { const db = state.databases.find((v) => v.id === connection.databaseId); return '<div class="connection-row">' + icon('database') + '<strong>' + esc(connection.variable) + '</strong><span>来自 ' + esc(db?.name || '已失效数据库') + '</span><span class="mono">' + esc(db?.host || '待重新绑定') + '</span></div>'; }).join('') : '<p class="inline-empty">连接同一环境的数据库后，在这里查看自动注入的变量。</p>') + '</section><div class="planning-link"><span>通用服务引用与配置文件属于规划功能。</span>' + button('预览变量引用', 'plan', { small: true, subtle: true, id: 'F26' }) + button('预览配置文件', 'plan', { small: true, subtle: true, id: 'F27' }) + '</div></section>';
  }
  function usagePage(ctx) {
    const s = ctx.service; const valid = s.status === 'running' && state.scenario !== 'offline';
    const cpuLimit = Number(s.publishedSnapshot?.cpu || s.draft.cpu); const memoryLimit = Number(s.publishedSnapshot?.memory || s.draft.memory);
    return '<section class="section usage-page"><div class="section-heading"><div><h2>当前资源用量</h2><p class="section-hint">实例采样于 ' + date(s.observedAt) + '</p></div>' + button('刷新', 'refresh-runtime', { small: true, icon: 'refresh' }) + '</div>' + (!valid ? notice('当前没有可用的实例采样。资源请求与上限仍保留，使用量显示为未知。', 'warning') : '') + '<div class="usage-grid">' + [
      ['CPU', valid ? s.cpuMilli + 'm' : '未知', cpuLimit + 'm', valid ? s.cpuMilli / cpuLimit * 100 : 0, 'usage'],
      ['内存', valid ? s.memoryMiB + ' MiB' : '未知', memoryLimit + ' MiB', valid ? s.memoryMiB / memoryLimit * 100 : 0, 'server'],
    ].map(([label, value, limit, percent, symbol]) => '<section class="usage-panel"><div class="usage-panel-head">' + icon(symbol) + '<h3>' + label + '</h3></div><div class="usage-value">' + value + '<small>/ ' + limit + ' 上限</small></div><div class="usage-meter"><span style="width:' + Math.min(100, percent) + '%"></span></div><p>' + (valid ? percent.toFixed(1) + '% 已使用' : '没有采样') + '</p></section>').join('') + '</div><div class="table-scroll"><table class="data-table"><thead><tr><th>实例</th><th>节点</th><th>请求</th><th>上限</th><th>状态</th></tr></thead><tbody><tr><td class="mono">' + esc(valid ? s.podId : '无可用实例') + '</td><td>' + esc(targetFor(ctx.project).name) + '</td><td>' + esc(s.draft.requestCpu) + 'm / ' + esc(s.draft.requestMemory) + ' MiB</td><td>' + cpuLimit + 'm / ' + memoryLimit + ' MiB</td><td>' + badge(valid ? 'running' : s.status === 'stopped' ? 'stopped' : 'unknown') + '</td></tr></tbody></table></div><section class="section history-metrics"><div><h2>历史资源趋势</h2><p>当前版本提供即时采样。历史曲线需要接入独立的指标存储。</p><span class="plan-tag">P1 · 规划演示</span></div>' + button('预览历史指标', 'plan', { id: 'F36', icon: 'usage' }) + '</section></section>';
  }
  function networkPage(ctx) {
    const s = ctx.service; const domains = state.domains.filter((d) => d.serviceId === s.id);
    const privateAddress = (s.draft.slug || s.id) + '.' + ctx.environment.id + '.svc.cluster.local';
    return '<section class="section"><div class="section-heading"><div><h2>域名</h2><p class="section-hint">默认域名绑定已发布的 HTTP 端口。</p></div>' + button('分配域名', 'domain-add', { primary: true, icon: 'plus', disabled: state.readOnly || !s.publishedSnapshot || s.publishedSnapshot.expose !== 'http' }) + '</div>' + (domains.length ? '<div class="domain-list">' + domains.map((domain) => '<div class="domain-row"><div class="domain-row-name">' + icon('globe') + '<a href="#/domain/' + domain.id + '">' + esc(domain.hostname) + '</a><small>HTTP → ' + esc(domain.portName || 'http') + ':' + domain.port + '</small></div><div class="network-states"><span>DNS ' + badge(domain.dns) + '</span><span>路由 ' + badge(domain.route) + '</span><span>TLS ' + badge(domain.tls) + '</span></div><div class="row-actions">' + button('检查', 'domain-check', { small: true, id: domain.id }) + button('管理', 'domain-detail', { small: true, id: domain.id }) + '</div></div>').join('') + '</div>' : empty(s.publishedSnapshot?.expose === 'http' ? '为服务分配一个域名' : '暂无公开 HTTP 端口', s.publishedSnapshot ? '在服务设置中配置 HTTP 端口，发布后即可分配默认域名。' : '先发布服务，再为已发布的 HTTP 端口分配域名。', s.publishedSnapshot?.expose === 'http' ? button('分配默认域名', 'domain-add', { icon: 'plus', disabled: state.readOnly }) : '<a class="text-link" href="' + serviceUrl(ctx.project, s, 'settings') + '">查看端口配置</a>')) + '</section><section class="section"><div class="section-heading"><h2>私有网络</h2></div><div class="private-network-row"><span class="private-network-icon">' + icon('lock') + '</span><div><strong>内部地址</strong><button class="copy-line" data-action="copy" data-copy="' + esc(privateAddress) + '"><code>' + esc(privateAddress) + '</code>' + icon('copy') + '</button><p class="hint">数据库连接只允许在同一环境中自动注入。当前地址不代表已验证网络隔离。</p></div><span class="pill">' + esc(s.publishedSnapshot?.port || s.draft.port || '无端口') + '</span></div></section><section class="section"><div class="section-heading"><h2>部署入口</h2><a class="text-link" href="#/cluster/' + targetFor(ctx.project).id + '">管理集群入口' + icon('arrow') + '</a></div>' + keyValues([['部署位置', esc(targetFor(ctx.project).name)], ['平台后缀', esc(state.platform.suffix)], ['入口目标', esc(targetFor(ctx.project).entryAddress || '尚未配置')], ['证书', 'cert-manager · 先验证 staging，再申请 production']]) + '</section><div class="planning-link"><span>自定义域名、Cloudflare 自动 DNS 与公网 TCP</span><span class="plan-tag">P1</span>' + button('域名规划', 'plan', { small: true, subtle: true, id: 'F33' }) + button('TCP 规划', 'plan', { small: true, subtle: true, id: 'F34' }) + '</div>';
  }
  function storagePage(ctx) {
    const s = ctx.service; const config = s.draft;
    const mounts = config.mounts || [];
    const database = state.databases.find((d) => d.serviceId === s.id);
    const environmentVolumes = state.volumes.filter((v) => v.projectId === ctx.project.id && v.environmentId === ctx.environment.id);
    return '<section class="section"><div class="section-heading"><div><h2>持久化数据</h2><p class="section-hint">数据独立于服务保留。挂载修改保存为草稿，部署后生效。</p></div><div class="row-actions">' + button('创建数据卷', 'volume-create', { small: true, icon: 'plus', disabled: state.readOnly }) + button('挂载数据卷', 'mount-dialog', { primary: true, disabled: state.readOnly || Boolean(database) }) + '</div></div>' + (mounts.length ? '<div class="table-scroll"><table class="data-table"><thead><tr><th>数据卷</th><th>挂载路径</th><th>容量</th><th>模式</th><th>状态</th><th></th></tr></thead><tbody>' + mounts.map((mount, index) => { const v = state.volumes.find((value) => value.id === mount.volumeId); const published = (s.publishedSnapshot?.mounts || []).some((m) => m.volumeId === mount.volumeId && m.path === mount.path); return '<tr><td><a class="text-link" href="#/volume/' + mount.volumeId + '">' + icon('disk') + esc(v?.name || '卷已失效') + '</a>' + (v?.protected ? '<small class="block muted">数据库身份保护</small>' : '') + '</td><td class="mono">' + esc(mount.path) + '</td><td>' + (v?.capacity || '未知') + ' GiB</td><td>' + (mount.readOnly ? '只读' : '单写入') + '</td><td>' + badge(published ? 'bound' : 'pending', published ? '已发布挂载' : '待发布') + '</td><td>' + button('编辑', 'mount-dialog', { small: true, attrs: ' data-index="' + index + '"', disabled: Boolean(database) || state.readOnly }) + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty('还没有挂载数据卷', '把需要持久保存的文件放到数据卷中，容器重新创建后仍会保留。', button(environmentVolumes.length ? '选择已有数据卷' : '创建数据卷', environmentVolumes.length ? 'mount-dialog' : 'volume-create', { icon: 'plus', disabled: state.readOnly }))) +
      '<div class="list-footer"><a href="#/resources?type=volumes&project=' + ctx.project.id + '&env=' + ctx.environment.id + '">查看当前环境的全部卷与保留数据' + icon('arrow') + '</a><span>' + environmentVolumes.length + ' 个卷</span></div></section>' +
      (database ? '<section class="section"><div class="section-heading"><h2>' + esc(database.engine) + ' 数据身份</h2><a class="text-link" href="#/database/' + database.id + '">数据库详情' + icon('arrow') + '</a></div>' + keyValues([['数据库', esc(database.databaseName || 'app')], ['版本', esc(database.version)], ['私有端点', '<code>' + esc(database.host) + ':' + database.port + '</code>'], ['初始化凭证', '<a class="text-link" href="#/settings?tab=credentials">' + esc(database.credentialId) + '</a> · 仅显示引用'], ['数据身份', '<code>' + esc(database.identity || database.id) + '</code>'], ['使用此数据库', database.consumers.map((idValue) => { const target = findService(idValue); return target ? '<a class="text-link" href="' + serviceUrl(target.project, target.service) + '">' + esc(target.service.draft.name) + '</a>' : esc(idValue); }).join('、') || '尚无应用连接']]) + '<div class="section-actions">' + linkButton('手工备份与恢复记录', '#/volume/' + database.volumeId + '?tab=manual', 'file') + button('预览自动备份', 'plan', { id: 'F35' }) + '</div></section>' :
        '<section class="section"><div class="section-heading"><div><h2>数据库连接</h2><p class="section-hint">从当前环境选择数据库，发布后自动注入连接变量。</p></div>' + button('添加连接', 'connection-dialog', { icon: 'plus', disabled: state.readOnly }) + '</div>' + (config.connections.length ? '<div class="connection-list">' + config.connections.map((connection, index) => { const db = state.databases.find((value) => value.id === connection.databaseId); return '<div class="connection-row">' + icon('database') + '<a class="text-link" href="#/database/' + connection.databaseId + '">' + esc(db?.name || '失效引用') + '</a><span class="mono">' + esc(connection.variable) + '</span><span class="muted">' + ((s.publishedSnapshot?.connections || []).some((value) => value.databaseId === connection.databaseId && value.variable === connection.variable) ? '已发布' : '待发布') + '</span>' + button('编辑', 'connection-dialog', { small: true, attrs: ' data-index="' + index + '"' }) + button('移除', 'connection-remove', { small: true, danger: true, attrs: ' data-index="' + index + '"', disabled: state.readOnly }) + '</div>'; }).join('') + '</div>' : '<p class="inline-empty">还没有数据库连接。添加 PostgreSQL 或 Redis 后可在这里选择。</p>') + '</section>');
  }
  function serviceSettingsPage(ctx) {
    const s = ctx.service; const edit = serviceEdit(s);
    return '<section class="settings-content"><form data-form="service-config" novalidate><div class="section-heading"><div><h2>服务配置</h2><p class="section-hint">已保存 r' + s.revision + (s.publishedSnapshot ? ' · 运行配置 r' + s.publishedRevision : ' · 尚未发布') + '</p></div><div class="row-actions">' + button('载入最新', 'reload-config', { small: true, icon: 'refresh' }) + button('保存草稿', 'save-config-submit', { type: 'submit', primary: true, disabled: state.readOnly || !dirtyEdit(s) }) + '</div></div>' + formError(state.modal ? '' : state.errors.form) + (dirtyEdit(s) ? '<div class="unsaved-bar"><span>有尚未保存的修改</span>' + button('放弃修改', 'discard-config', { small: true, subtle: true }) + '</div>' : '') +
      '<div class="source-settings"><div class="section-heading"><h3>' + sourceLabel(edit.source) + '</h3><span class="pill">来源</span></div>' + (edit.source === 'git' ? '<div class="two-fields">' + field('GitHub 仓库', 'config.repository', edit.repository) + field('分支', 'config.branch', edit.branch) + field('Dockerfile', 'config.dockerfile', edit.dockerfile) + '</div><div class="row-actions">' + button('检查最新提交', 'check-commits', { small: true, icon: 'git' }) + button('Git 事件', 'git-events', { small: true, icon: 'clock' }) + '</div>' : field('容器镜像', 'config.image', edit.image, { readonly: edit.type === 'database', hint: edit.type === 'database' ? '已初始化的数据库镜像和身份受保护，主版本升级使用独立维护流程。' : '更新镜像后保存为草稿，部署时固定 digest。' }) + (edit.type !== 'database' ? selectField('拉取凭证', 'config.credentialId', edit.credentialId, [['', '公共镜像'], ...state.credentials.filter((c) => c.kind === 'registry').map((c) => [c.id, c.name])]) : '')) + '</div>' +
      configurationGroups(edit, 'config', ctx, false) + '<div class="form-footer">' + button('放弃修改', 'discard-config') + button('保存草稿', 'save-config-submit', { type: 'submit', primary: true, disabled: state.readOnly || !dirtyEdit(s) }) + '</div></form><section class="section danger-zone"><div><h2>运行与删除</h2><p>停止服务保留配置与数据。删除服务时，数据卷也会独立保留。</p></div><div class="danger-action-row"><div><strong>' + (s.status === 'stopped' ? '恢复服务' : '停止服务') + '</strong><p>' + (s.status === 'stopped' ? '恢复原已发布配置，不采用当前草稿和新提交。' : '将运行副本缩减为零。') + '</p></div>' + button(s.status === 'stopped' ? '恢复原版本' : '停止服务', s.status === 'stopped' ? 'service-resume' : 'service-stop', { disabled: state.readOnly || !s.publishedSnapshot }) + '</div><div class="danger-action-row"><div><strong>删除服务</strong><p>先核对依赖与保留的数据卷，再执行清理。</p></div>' + button('删除服务', 'service-delete', { danger: true, disabled: state.readOnly }) + '</div></section></section>';
  }
  function seedLogLines(s) {
    return [
        '2026-10-29T15:32:00.102Z INFO  [演示] starting ' + s.draft.name + ' with published configuration r' + s.publishedRevision,
        '2026-10-29T15:32:00.128Z INFO  [演示] environment loaded; sensitive values omitted',
        '2026-10-29T15:32:00.245Z INFO  [演示] listening on 0.0.0.0:' + (s.publishedSnapshot?.port || 'internal'),
        '2026-10-29T15:32:01.101Z INFO  [演示] readiness probe passed',
        '2026-10-29T15:32:05.457Z INFO  [演示] GET /health 200 2ms',
        '2026-10-29T15:32:08.781Z INFO  [演示] GET /api/posts 200 12ms',
        '2026-10-29T15:32:13.344Z WARN  [演示] cache miss; request completed using the database',
        '2026-10-29T15:32:13.356Z INFO  [演示] database connection reused, query completed in 8ms',
        '2026-10-29T15:32:15.101Z INFO  [演示] GET /health 200 2ms',
    ];
  }
  function logsFor(s) {
    return state.logViews[s.id] || (state.logViews[s.id] = { pod: s.podId, container: 'main', previous: false, tail: '200', follow: true, paused: false, wrap: false, query: '', buffer: [], unread: 0, connection: 'idle', message: '', generation: 0, timer: null });
  }
  function cancelLogRead(view) {
    if (!view) return;
    clearTimeout(view.timer); view.timer = null; view.generation += 1;
  }
  function readLogs(service, refresh = false, redraw = true) {
    if (!service) return;
    const view = logsFor(service);
    cancelLogRead(view);
    const request = view.generation;
    const deferred = state.scenario === 'slow-response';
    view.connection = 'connecting'; view.message = '';
    const finish = () => {
      if (view.generation !== request || state.modal?.type !== 'logs' || state.modal.serviceId !== service.id) return;
      view.timer = null;
      if (state.scenario === 'offline') {
        view.connection = 'disconnected'; view.message = '日志连接中断。已载入的输出仍保留，恢复连接后可重新读取。';
      } else if (view.pod !== service.podId) {
        view.connection = 'unavailable'; view.message = '所选实例已不可用。请选择当前实例，再重新读取日志。';
      } else if (!service.observedAt || ['unknown', 'stale', 'offline'].includes(service.status)) {
        view.connection = 'unavailable'; view.message = '尚未确认当前运行实例。请先检查运行观察，期望停止不代表实例已停止。';
      } else if (service.status === 'stopped' && !view.previous) {
        view.connection = 'unavailable'; view.message = '最近观察为已停止，没有当前运行日志。可查看保留的 previous 演示输出。';
      } else {
        const lines = view.buffer.length ? view.buffer : seedLogLines(service);
        view.buffer = state.scenario === 'empty' ? [] : lines.slice(-Number(view.tail));
        if (refresh && state.scenario !== 'empty') view.buffer.push(now() + ' INFO  [演示] 已重新读取所选实例的日志尾部');
        if (view.buffer.length > 1000) view.buffer = view.buffer.slice(-1000);
        view.connection = view.follow && !view.previous ? 'receiving' : 'ended';
        view.message = ''; view.unread = 0;
      }
      if (redraw || deferred) render();
    };
    if (deferred) { view.timer = setTimeout(finish, 700); if (redraw) render(); }
    else finish();
  }
  function visibleLogLines(service) {
    const view = logsFor(service);
    return view.buffer.map((line) => (view.previous ? '[previous] ' : '') + (view.container === 'init' ? '[init] ' : '') + line).filter((line) => line.toLowerCase().includes(view.query.toLowerCase()));
  }
  function taskLogsFor(task) {
    const count = (task.logs || []).length;
    const view = state.taskLogViews[task.id] || (state.taskLogViews[task.id] = { query: '', group: 'all', follow: true, paused: false, unread: 0, length: count, scrollTop: 0 });
    if ((view.paused || !view.follow) && count > view.length) view.unread += count - view.length;
    view.length = count;
    return view;
  }
  function visibleTaskLogLines(task) {
    const view = taskLogsFor(task);
    return (task.logs || []).filter((line) => (view.group === 'build' ? /构建|build|推送/i.test(line) : view.group === 'runtime' ? !/构建|build|推送/i.test(line) : true) && line.toLowerCase().includes(view.query.toLowerCase()));
  }
  function logsPanel(s) {
    const view = logsFor(s);
    const lines = visibleLogLines(s);
    const connection = { idle: ['pending', '尚未读取'], connecting: ['pending', '连接中'], receiving: ['running', '接收中'], ended: ['paused', '读取结束'], disconnected: ['offline', '连接中断'], unavailable: ['unknown', '实例未确认'] }[view.connection];
    const unavailablePod = view.pod !== s.podId ? view.pod : 'gone-pod';
    return '<div class="log-dialog-header"><div><h2>' + esc(s.draft.name) + ' 的运行日志</h2><p class="hint">仅本次浏览器中的演示输出，最多保留 1000 行</p></div>' + badge(connection[0], connection[1]) + '</div><div class="log-controls"><label>实例<select id="log-pod" data-log="pod"><option value="' + esc(s.podId) + '"' + selected(view.pod === s.podId) + '>' + esc(s.podId) + '</option><option value="' + esc(unavailablePod) + '"' + selected(view.pod === unavailablePod) + '>旧实例 · 已删除</option></select></label><label>容器<select id="log-container" data-log="container"><option value="main">main</option><option value="init"' + selected(view.container === 'init') + '>init</option></select></label><label>尾部行数<select id="log-tail" data-log="tail">' + ['100', '200', '500', '1000'].map((v) => '<option value="' + v + '"' + selected(view.tail === v) + '>' + v + '</option>').join('') + '</select></label><label class="checkbox-label"><input type="checkbox" data-log="previous"' + checked(view.previous) + '> previous</label></div><div class="log-toolbar"><label class="search-field">' + icon('search') + '<input id="log-search" data-log="query" value="' + esc(view.query) + '" placeholder="筛选当前缓冲" /></label><div class="row-actions">' + button(view.follow ? '停止跟随' : '持续跟随', 'log-follow', { small: true, icon: view.follow ? 'stop' : 'play' }) + button(view.connection === 'connecting' ? '正在连接…' : '读取尾部', 'log-refresh', { small: true, icon: 'refresh', disabled: view.connection === 'connecting' }) + button('换行', 'log-wrap', { small: true, attrs: ' aria-pressed="' + view.wrap + '"' }) + button(view.query ? '复制筛选结果' : '复制缓冲', 'log-copy', { small: true, icon: 'copy', disabled: !lines.length }) + '</div></div>' +
      (view.message ? notice(esc(view.message), 'warning') : view.connection === 'connecting' ? notice('正在连接所选日志来源，已载入的输出暂时保留。') : '') +
      '<div class="log-output' + (view.wrap ? ' wrap' : '') + '" tabindex="0" aria-label="容器日志">' + (lines.length ? lines.map((line, index) => '<div class="log-line' + (line.includes('WARN') ? ' warn' : '') + '"><span class="line-number">' + (index + 1) + '</span><code>' + esc(line) + '</code></div>').join('') : '<div class="log-empty">' + (view.query ? '当前缓冲没有匹配的行。调整筛选或清空关键字。' : '当前缓冲还没有输出。读取尾部或继续跟随。') + '</div>') + '</div><div class="log-bottom"><span>' + lines.length + ' 行 · ' + (view.query ? '仅筛选当前缓冲' : '有界输出') + '</span>' + (view.paused || !view.follow || view.unread ? button('回到底部' + (view.unread ? ' · ' + view.unread + ' 条新输出' : ''), 'log-bottom', { small: true, primary: true }) : '<span>自动滚动至新输出</span>') + button('历史检索与下载', 'plan', { small: true, subtle: true, id: 'F37' }) + '</div>';
  }
  function taskLogPanel(task, group = 'all') {
    const view = taskLogsFor(task); view.group = group; const lines = visibleTaskLogLines(task);
    return '<div class="task-log"><div class="log-section-title">执行输出 <span>仅演示数据</span></div><div class="log-toolbar task-log-toolbar"><label class="search-field">' + icon('search') + '<input id="task-log-query" data-task-log="query" data-task-id="' + esc(task.id) + '" value="' + esc(view.query) + '" placeholder="筛选已载入输出" aria-label="筛选已载入任务输出" /></label><div class="row-actions">' + button(view.follow ? '暂停自动滚动' : '跟随新输出', 'task-log-follow', { small: true, id: task.id }) + button(view.query ? '复制筛选结果' : '复制输出', 'task-log-copy', { small: true, icon: 'copy', id: task.id, disabled: !lines.length }) + '</div></div>' +
      '<div class="log-output task-log-output" id="task-log-output-' + esc(task.id) + '" data-task-id="' + esc(task.id) + '" tabindex="0" aria-label="已载入任务输出">' + (lines.length ? lines.map((line, index) => '<div class="log-line' + (line.includes('WARN') ? ' warn' : line.includes('ERROR') ? ' error' : '') + '"><span class="line-number">' + (index + 1) + '</span><code>' + esc(line) + '</code></div>').join('') : '<p class="log-empty">' + (view.query ? '已载入输出中没有匹配结果。' : '任务尚未记录输出。') + '</p>') + '</div><div class="log-bottom"><span>' + lines.length + ' 行 · 仅已载入输出</span>' + (view.paused || !view.follow || view.unread ? button('回到底部' + (view.unread ? ' · ' + view.unread + ' 条新输出' : ''), 'task-log-bottom', { small: true, id: task.id }) : '<span>自动滚动至新输出</span>') + '</div></div>';
  }
  function taskPanel(task) {
    const related = findService(task.serviceId);
    return '<div class="task-summary"><div><span class="eyebrow">' + (task.kind === 'deployment' ? '部署记录' : '资源操作') + '</span><h2>' + esc(task.name) + '</h2><p class="mono muted">' + esc(task.id) + '</p></div>' + badge(task.status) + '</div>' + (task.error ? notice(esc(task.error), 'error') : '') + (task.status === 'unknown' ? notice('当前结果无法确认。原任务仍保留，请先确认结果，不要重复创建服务。', 'warning') : '') +
      '<div class="task-timeline">' + task.stages.map((stage, index) => '<div class="task-stage ' + stage.status + '"><span>' + (stage.status === 'succeeded' ? icon('check') : stage.status === 'failed' ? icon('close') : index + 1) + '</span><div><strong>' + esc(stage.name) + '</strong><small>' + esc(statusNames[stage.status] || stage.status) + '</small></div></div>').join('') + '</div>' +
      taskLogPanel(task) +
      disclosure('固定发布快照', task.snapshot ? keyValues([['服务', esc(related?.service.draft.name || task.serviceId || '资源操作')], ['环境', esc(task.environmentId || '全局')], ['配置', 'r' + (task.revision || '1')], ['镜像', '<span class="mono">' + esc(task.image || task.snapshot.image || '不适用') + '</span>'], ['Digest', '<span class="mono">' + esc(task.digest || '未解析') + '</span>'], ['Commit', '<code>' + esc(task.commit || '镜像来源不适用') + '</code>'], ['持久卷快照', esc((task.snapshot.mounts || []).map((m) => m.volumeId + ' → ' + m.path).join('；') || '无挂载')]]) : keyValues([['目标', esc(task.targetId || task.serviceId || '平台')], ['创建时间', date(task.createdAt)], ['重试来源', esc(task.attemptOf || '首次执行')]])) +
      (task.result ? '<p class="task-result">' + esc(task.result) + '</p>' : '') +
      '<div class="modal-actions"><a class="text-link" href="#/task/' + task.id + '">完整任务详情' + icon('external') + '</a>' +
      (['queued', 'running', 'cancelling'].includes(task.status) ? button(task.status === 'cancelling' ? '等待取消确认' : '请求取消', 'task-cancel', { id: task.id, disabled: task.status === 'cancelling' || state.readOnly }) : '') +
      (['failed', 'cancelled'].includes(task.status) ? button('创建重试任务', 'task-retry', { id: task.id, icon: 'refresh', primary: true, disabled: state.readOnly }) : '') +
      (task.status === 'unknown' ? button('重新确认结果', 'task-reconcile', { id: task.id, primary: true, disabled: state.readOnly }) : '') +
      (task.kind === 'deployment' && task.status === 'succeeded' ? button('预览历史镜像回滚', 'plan', { id: 'F31', attrs: ' data-task="' + task.id + '"' }) : '') + '</div>';
  }

  const planDefinitions = {
    F26: { name: '变量引用与依赖', intro: '从同一环境的服务输出创建变量引用，检查阶段、依赖和秘密传播。', fields: [['provider', '提供方服务', 'service'], ['variable', '变量名', 'text', 'DATABASE_URL'], ['output', '输出键', 'text', 'connection.url'], ['phase', '使用阶段', 'select', [['runtime', '运行时'], ['build', '构建时']]]], stages: ['检查提供方与引用环', '保存引用草稿', '等待提供方就绪'], result: '引用草稿已生成，消费者需要单独发布。' },
    F27: { name: '配置文件', intro: '配置文件与卷挂载共同参与发布，内容不会直接写入运行实例。', fields: [['path', '容器内路径', 'text', '/app/config/settings.json'], ['mode', '文件来源', 'select', [['text', '普通文本'], ['secret', '秘密引用']]], ['content', '文件内容 / 引用', 'textarea', '{ "logLevel": "info" }'], ['permission', '文件权限', 'text', '0644']], stages: ['检查路径与卷冲突', '生成文件差异', '保存待发布文件'], result: '文件已进入规划草稿，尚未应用到容器。' },
    F28: { name: '组合模板', intro: '固定模板版本，分别跟踪每个服务和声明的依赖。', fields: [['repository', '模板仓库', 'text', 'demo/full-stack-template'], ['version', '版本', 'text', '1.0.0'], ['name', '应用前缀', 'text', 'notes'], ['components', '组件', 'select', [['app-db', 'Web + Worker + PostgreSQL'], ['api-cache', 'API + Redis']]]], stages: ['校验模板与依赖', '创建组件草稿', '逐组件检查结果'], result: '组件规划已创建，各服务保存独立结果与依赖。' },
    F29: { name: 'Monorepo 触发规则', intro: '只构建受本次变更影响的服务，共享目录仍能触发关联服务。', fields: [['context', '构建目录', 'text', 'apps/web'], ['dockerfile', 'Dockerfile 路径', 'text', 'apps/web/Dockerfile'], ['watch', '监听路径', 'textarea', 'apps/web/**\npackages/shared/**'], ['changed', '测试变更路径', 'text', 'packages/shared/utils.ts']], stages: ['校验仓库内路径', '匹配变更规则', '生成构建决定'], result: '已生成命中与跳过报告，尚未修改实际 Webhook 策略。' },
    F30: { name: '自动构建计划', intro: '识别项目与锁文件，复核后再构建；不支持的项目回到 Dockerfile。', fields: [['projectType', '示例项目', 'select', [['node', 'Node.js / pnpm'], ['static', '静态网站 / npm'], ['unsupported', '未支持的项目']]], ['buildCommand', '构建命令', 'text', 'pnpm build'], ['startCommand', '启动命令', 'text', 'pnpm start'], ['output', '输出目录', 'text', 'dist']], stages: ['识别项目与锁文件', '生成构建计划', '模拟外部 Builder'], result: '构建计划已生成，需要复核镜像产物后发布。' },
    F31: { name: '历史镜像回滚', intro: '选用历史成功镜像和当前可信配置，创建一条新发布记录。不会回滚数据库内容。', fields: [['history', '历史成功版本', 'history'], ['reason', '回滚说明', 'text', '恢复经过验证的镜像'], ['start', '服务停止时允许启动', 'checkbox', false]], stages: ['核对历史 digest', '组合当前可信配置', '模拟新回滚发布'], result: '新的回滚演示记录已生成，原发布历史、草稿和数据保持独立。' },
    F32: { name: '容器终端', intro: '终端绑定明确的 Pod 与容器，连接失败不修改服务状态。', fields: [['container', '容器', 'select', [['main', 'main'], ['init', 'init']]], ['command', '命令', 'text', '/bin/sh'], ['timeout', '空闲超时 / 分钟', 'number', '10']], stages: ['核对实例与权限', '建立演示会话', '记录会话结束'], result: '演示会话已结束。未执行真实容器命令。' },
    F33: { name: '自定义域名与 DNS', intro: '检查域名所有权与记录冲突，再分别验证 DNS、路由和证书。', fields: [['hostname', '自定义域名', 'text', 'app.example.test'], ['dnsMode', 'DNS 管理', 'select', [['manual', '手工配置'], ['cloudflare', 'Cloudflare API']]], ['record', '入口目标', 'text', '192.0.2.10'], ['proxy', 'Cloudflare 代理', 'checkbox', false]], stages: ['核对域名与记录', '验证 DNS 和路由', '观察证书结果'], result: '域名规划已生成，真实 DNS 与 TLS 未发生改变。' },
    F34: { name: '公网 TCP', intro: '分配明确的公网端口并检查冲突，数据库不会自动暴露到公网。', fields: [['publicPort', '公网端口', 'number', '15432'], ['internalPort', '容器端口', 'number', '5432'], ['sourceRange', '允许来源', 'text', '203.0.113.0/24'], ['ack', '我已核对公网暴露范围', 'checkbox', false]], stages: ['检查端口冲突', '生成入口与防火墙计划', '验证规划端点'], result: '公网入口计划已保存，没有开放真实端口。' },
    F35: { name: '自动备份与新目标恢复', intro: '从离机备份恢复到独立的新卷，数据验证和生产切流分别确认。', fields: [['backup', '备份记录', 'select', [['backup-demo-01', '演示备份 · SHA256 已核对']]], ['targetProject', '目标项目', 'project'], ['newVolume', '新目标卷名称', 'text', 'postgres-restored'], ['schedule', '备份计划', 'select', [['daily', '每天 03:00'], ['manual', '仅手工触发']]], ['destination', '离机存储', 'text', 's3://demo-backups/ozz']], stages: ['检查备份与新目标', '模拟恢复数据', '等待独立业务验证'], result: '候选恢复演示已完成，仍需业务数据验证；尚未切换生产连接。' },
    F36: { name: '历史资源指标', intro: '历史指标需要独立采集与存储，采样缺口保持可见。', fields: [['provider', '指标提供方', 'select', [['prometheus', 'Prometheus 演示连接'], ['none', '尚未配置']]], ['range', '查看范围', 'select', [['1h', '最近 1 小时'], ['24h', '最近 24 小时'], ['7d', '最近 7 天']]], ['retention', '保留天数', 'number', '7']], stages: ['确认采集能力', '查询选定时间范围', '呈现采样与缺口'], result: '返回演示时间序列，缺失采样不会补成零。' },
    F37: { name: '历史日志检索与下载', intro: '查询集中保存的日志，范围与下载结果固定在当前服务和时间段。', fields: [['provider', '日志存储', 'select', [['loki', 'Loki 演示连接'], ['none', '尚未配置']]], ['query', '检索关键字', 'text', 'request'], ['range', '时间范围', 'select', [['1h', '最近 1 小时'], ['24h', '最近 24 小时']]], ['limit', '最多返回行数', 'number', '1000']], stages: ['确认来源与范围', '执行有界检索', '生成导出内容'], result: '已准备选定范围的演示导出，当前实例日志与集中历史分开。' },
    F38: { name: '告警规则与通知', intro: '告警合并、恢复和通知投递分别记录，投递失败不改写原事件。', fields: [['metric', '告警来源', 'select', [['memory', '内存阈值'], ['deploy', '部署失败'], ['certificate', '证书失效']]], ['threshold', '阈值 / %', 'number', '85'], ['duration', '持续时间 / 分钟', 'number', '5'], ['cooldown', '冷却时间 / 分钟', 'number', '15'], ['destination', '通知目标', 'text', 'https://hooks.example.test/ozz']], stages: ['校验规则范围', '触发并合并演示事件', '独立跟踪通知结果'], result: '告警演示已记录，通知结果与触发事件独立保存。' },
    F39: { name: '项目配置导入与复制', intro: '复制配置时重新分配资源身份与引用，不复制秘密、数据或运行状态。', fields: [['mode', '操作', 'select', [['copy', '复制为新项目'], ['export', '导出声明配置'], ['import', '导入现有项目']]], ['targetProject', '目标项目 / 目标集群参考', 'project'], ['name', '新项目名称', 'text', '博客副本'], ['schema', 'Schema 版本', 'text', '1.0'], ['policy', '冲突策略', 'select', [['reject', '遇到冲突停止'], ['replace', '显式覆盖选定草稿']]]], stages: ['校验 schema 与来源', '重映射身份和依赖', '保存配置演示结果'], result: '配置规划已生成，新身份与凭证占位已分配，数据未复制。' },
    F40: { name: '环境差异与配置复制', intro: '同项目环境共享 Cluster，目标引用必须重新绑定；网络隔离按实际能力验证。', fields: [['targetEnvironment', '目标环境', 'environment'], ['scope', '复制范围', 'select', [['config', '非敏感运行配置'], ['variables', '普通变量'], ['all', '配置与变量']]], ['policy', '冲突处理', 'select', [['reject', '拒绝覆盖'], ['replace', '确认覆盖目标草稿']]], ['network', '网络隔离能力', 'select', [['unknown', '尚未验证'], ['supported', '支持 NetworkPolicy 的演示集群']]]], stages: ['比较两份配置', '重新绑定目标引用', '生成隔离能力报告'], result: '环境配置差异已生成，复制不包含源数据或生产秘密。' },
    F41: { name: '节点维护', intro: '维护不改变项目绑定的 Cluster，不默认强制排空或搬移本地卷。', fields: [['operation', '维护操作', 'select', [['join', '加入现有集群'], ['cordon', '停止调度'], ['drain', '排空节点'], ['uncordon', '恢复调度'], ['remove', '移除节点']]], ['server', '服务器', 'server'], ['pdb', 'PDB / 本地卷检查', 'select', [['clear', '无阻断的演示目标'], ['blocked', '存在本地卷 / PDB 阻断']]]], stages: ['预览工作负载影响', '执行独立维护任务', '重新观察节点'], result: '维护演示结束，节点与调度状态分别记录，项目目标保持不变。' },
    F42: { name: '用户 CLI 与 API Token', intro: 'CLI 使用平台 API 和明确的项目环境上下文，不需要 Kubernetes 管理凭证。', fields: [['name', 'Token 名称', 'text', '本地开发'], ['scope', '作用域', 'select', [['read', '只读'], ['deploy', '发布与服务操作']]], ['expires', '有效天数', 'number', '30'], ['command', 'CLI 操作', 'select', [['status', '查询状态'], ['logs', '读取日志'], ['deploy', '创建发布']]]], stages: ['确定上下文与权限', '生成一次性演示 Token', '显示 CLI 示例'], result: '仅生成演示 Token 与命令，不具备真实 API 访问权限。' },
    F43: { name: '服务文件管理', intro: '容器临时文件、PVC 与声明式配置的持久性不同。', fields: [['source', '文件来源', 'select', [['pvc', '持久卷'], ['container', '容器临时文件'], ['config', '声明式配置']]], ['path', '文件路径', 'text', '/data/demo.txt'], ['operation', '操作', 'select', [['read', '读取'], ['write', '编辑'], ['download', '下载演示内容']]], ['content', '演示文件内容', 'textarea', 'Hello from Ozz prototype.']], stages: ['核对路径与权限', '应用演示文件操作', '记录文件来源与结果'], result: '文件操作仅作用于本次规划数据，未访问容器或宿主机。' },
    F44: { name: '主机 Web SSH', intro: '使用已登记的服务器和受控维护会话，浏览器不获取私钥。', fields: [['server', '目标服务器', 'server'], ['fingerprint', '核对指纹', 'text', 'SHA256:DEMO-host-fingerprint'], ['ack', '已核对目标与演示指纹', 'checkbox', false], ['timeout', '空闲超时 / 分钟', 'number', '10']], stages: ['核对服务器与指纹', '建立维护演示会话', '记录会话关闭'], result: '维护会话演示已结束，未连接真实 SSH。' },
    F45: { name: 'AI 助手与知识库', intro: '诊断必须引用明确来源，建议先复核，AI 对话不会替代部署任务。', fields: [['mode', '用途', 'select', [['diagnose', '诊断当前服务日志'], ['deploy', '生成部署计划'], ['knowledge', '导入文档并问答']]], ['prompt', '问题 / 文档内容', 'textarea', '分析最近的健康检查失败，给出证据和建议。'], ['provider', '提供方', 'select', [['demo', '本地演示结果'], ['none', '未配置模型']]]], stages: ['固定日志或文档来源', '生成有来源的演示建议', '等待人工复核'], result: '建议尚未执行；证据、来源与未知项已保留。' },
    F46: { name: 'PR 预览环境', intro: '预览环境继承项目目标，未信任的 PR 不接收生产秘密。', fields: [['pr', 'Pull request 编号', 'number', '42'], ['ttl', '存活时间 / 小时', 'number', '24'], ['cpu', 'CPU 配额 / millicores', 'number', '1000'], ['memory', '内存配额 / MiB', 'number', '1024'], ['trusted', '来源已受信任', 'checkbox', false]], stages: ['检查来源、TTL 与配额', '创建独立预览规划', '记录观察与回收计划'], result: '预览环境计划已生成，旧环境与生产数据保持独立。' },
    F47: { name: '本地源码上传', intro: '上传、外部构建和发布是三个阶段；先检查归档与排除规则。', fields: [['archive', '演示归档名称', 'text', 'app-source.tar.gz'], ['size', '归档大小 / MiB', 'number', '12'], ['exclude', '排除规则', 'textarea', '.env\n.git\nnode_modules\n*.pem'], ['checksum', 'SHA256', 'text', 'a'.repeat(64)]], stages: ['检查归档与排除项', '模拟有界上传', '准备独立构建输入'], result: '源码上传演示完成，尚未构建或部署。' },
    F48: { name: '迁移与数据库维护', intro: '迁移、密码轮换、主版本升级分别计划，候选验证完成后才能明确切流。', fields: [['operation', '操作', 'select', [['migrate', '迁移到新目标项目'], ['rotate', '轮换数据库凭证'], ['upgrade', '应用数据库主版本升级']]], ['targetProject', '目标项目', 'project'], ['backup', '已验证备份', 'text', 'backup-demo-01'], ['candidate', '独立候选服务 / 卷', 'text', 'postgres-candidate'], ['version', '候选目标版本（规划参数）', 'text', '18']], stages: ['核对备份与目标身份', '模拟候选维护', '等待数据验证与切流'], result: '候选结果已记录，尚未切换生产连接；源库、源卷与回退路径保留。' },
    F49: { name: '高级路由与 IP 规则', intro: '先测试匹配和管理入口影响，再生成可撤回的变更。', fields: [['path', '匹配路径', 'text', '/api/*'], ['sourceRange', '来源 IP 范围', 'text', '203.0.113.0/24'], ['priority', '优先级', 'number', '10'], ['action', '匹配动作', 'select', [['allow', '允许'], ['deny', '拒绝']]], ['testPath', '测试请求路径', 'text', '/api/posts']], stages: ['检查规则与管理入口', '测试请求匹配', '生成可撤回计划'], result: '路由草稿已生成，没有应用真实网关规则。' },
    F50: { name: '无状态自动扩缩容', intro: '只对无状态服务规划 HPA，数据库与本地卷服务不自动增加写入副本。', fields: [['service', '目标服务', 'service'], ['min', '最小副本', 'number', '1'], ['max', '最大副本', 'number', '3'], ['target', '目标 CPU / %', 'number', '70'], ['metrics', '指标能力', 'select', [['ready', '已配置演示指标'], ['missing', '指标不可用']]]], stages: ['检查无状态与指标', '校验配额和副本范围', '生成扩缩容计划'], result: 'HPA 规划已生成，未扩缩真实运行实例。' },
  };
  function planningOptions(type, ctx) {
    if (type === 'project') return state.projects.map((p) => [p.id, p.name + ' · ' + targetFor(p).name]);
    if (type === 'server') return state.servers.map((s) => [s.id, s.name]);
    if (type === 'environment') return (ctx.project?.environments || []).map((e) => [e.id, e.name + ' · ' + e.slug]);
    if (type === 'service') return allServices().filter((s) => !ctx.project || s.projectId === ctx.project.id && s.environmentId === ctx.environment?.id).map((s) => [s.id, s.draft.name]);
    if (type === 'history') return state.tasks.filter((t) => t.kind === 'deployment' && t.status === 'succeeded' && (!ctx.service || t.serviceId === ctx.service.id)).map((t) => [t.id, t.name + ' · r' + t.revision]);
    return [];
  }
  function openPlan(featureId, ctx = context()) {
    const definition = planDefinitions[featureId];
    if (!definition) return;
    const resolved = ctx.project ? ctx : context(); const parameters = {};
    for (const [key, , type, initial] of definition.fields) {
      const options = ['project', 'service', 'environment', 'server', 'history'].includes(type) ? planningOptions(type, resolved) : type === 'select' ? initial : null;
      parameters[key] = options ? options.find(([value]) => type === 'environment' ? value !== resolved.environment?.id : type === 'project' ? value !== resolved.project?.id : type === 'service' && featureId === 'F26' ? value !== resolved.service?.id : true)?.[0] || options[0]?.[0] || '' : initial;
    }
    openModal({ type: 'plan', featureId, definition, planContext: resolved, parameters, step: 'configure', wide: true });
  }
  function planFields(modal) {
    return modal.definition.fields.map(([key, label, type, initial]) => {
      const options = ['project', 'service', 'environment', 'server', 'history'].includes(type) ? planningOptions(type, modal.planContext) : type === 'select' ? initial : null;
      if (type === 'checkbox') return '<label class="checkbox-label"><input type="checkbox" data-bind="plan.' + key + '"' + checked(modal.parameters[key]) + '> ' + label + '</label>';
      return options ? selectField(label, 'plan.' + key, modal.parameters[key], options.length ? options : [['', '尚无可用选项']]) : field(label, 'plan.' + key, modal.parameters[key], { type: type === 'number' ? 'number' : 'text', textarea: type === 'textarea', min: type === 'number' ? 1 : undefined });
    }).join('');
  }
  function validatePlan(modal) {
    const p = modal.parameters, feature = modal.featureId, ctx = modal.planContext;
    for (const [key, label, type] of modal.definition.fields) if (type !== 'checkbox' && !String(p[key] || '').trim()) return '请填写或选择“' + label + '”。';
    for (const [key, label, type] of modal.definition.fields) if (type === 'number' && (!Number.isFinite(Number(p[key])) || Number(p[key]) <= 0)) return label + '需要大于 0。';
    if (p.ack !== undefined && !p.ack) return '请先核对本次目标与影响范围。';
    if (['F27', 'F43', 'F49'].includes(feature) && !p.path.startsWith('/')) return '路径必须以 / 开头。';
    if (feature === 'F26' && p.provider === ctx.service?.id) return '服务不能引用自己，请选择同一环境的其他提供方。';
    if (feature === 'F29' && (p.context.includes('..') || p.dockerfile.includes('..'))) return '构建路径必须位于仓库中，不能使用上级目录。';
    if (feature === 'F30' && p.projectType === 'unsupported') return '示例项目尚不能自动识别，请使用 Dockerfile 流程。';
    if (feature === 'F31' && (ctx.service?.draft.type === 'database' || ctx.service?.configurationState === 'partial')) return '数据库主版本或不可信配置不适用普通镜像回滚，请先使用独立维护流程。';
    if (feature === 'F33' && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(p.hostname)) return '请填写有效域名，不要包含协议或路径。';
    if (feature === 'F34' && (Number(p.publicPort) > 65535 || Number(p.internalPort) > 65535)) return '端口必须在 1 到 65535 之间。';
    if (['F36', 'F37', 'F45'].includes(feature) && p.provider === 'none') return '尚未配置对应提供方，不能查询或生成真实结果。请选择演示连接继续预览。';
    if (feature === 'F39' && p.schema !== '1.0') return '当前演示只接受 schema 1.0，请检查声明配置版本。';
    if (feature === 'F40' && p.targetEnvironment === ctx.environment?.id) return '请选择与来源不同的目标环境；可以先在项目设置中新增环境。';
    if (feature === 'F41' && p.pdb === 'blocked' && ['drain', 'remove'].includes(p.operation)) return '本地卷或 PDB 阻止本次维护。请先处理影响，不会自动 force。';
    if (feature === 'F47' && (!/^[a-f0-9]{64}$/i.test(p.checksum) || Number(p.size) > 100)) return '归档需小于等于 100 MiB，并提供完整的 64 位 SHA256。';
    if (feature === 'F48' && p.operation === 'migrate' && p.targetProject === ctx.project?.id) return '跨目标迁移需要选择独立的目标项目，来源项目仍保留。';
    if (feature === 'F49' && p.action === 'deny' && ['/*', '/'].includes(p.path)) return '此规则会影响管理入口，请缩小匹配范围。';
    if (feature === 'F50') {
      const service = findService(p.service)?.service;
      if (service?.draft.type === 'database' || service?.draft.mounts.length) return '数据库或挂有本地卷的服务不能通过此规划自动增加写入副本。';
      if (Number(p.min) > Number(p.max) || Number(p.max) > 10 || Number(p.target) > 100) return '请核对副本上下限（1–10）与 CPU 目标（1–100）。';
      if (p.metrics === 'missing') return '指标不可用，保留扩缩容规划，不宣称可以自动扩容。';
    }
    return '';
  }
  function planPanel() {
    const modal = state.modal, definition = modal.definition;
    const phase = Number(modal.featureId.slice(1)) >= 43 ? 'P2' : 'P1';
    const heading = '<div class="plan-heading"><span class="plan-tag">' + phase + ' · 规划演示</span><h2>' + definition.name + '</h2><p>' + definition.intro + '</p></div><div class="plan-steps"><span class="' + (modal.step === 'configure' ? 'active' : '') + '">填写参数</span>' + icon('chevron') + '<span class="' + (modal.step === 'preview' ? 'active' : '') + '">核对影响</span>' + icon('chevron') + '<span class="' + (['running', 'result'].includes(modal.step) ? 'active' : '') + '">演示结果</span></div>';
    if (modal.step === 'configure') return heading + '<form data-form="plan-preview" novalidate><div class="modal-body">' + formError(state.errors.form) + '<div class="two-fields plan-fields">' + planFields(modal) + '</div></div><div class="modal-actions">' + button('取消', 'close-modal') + button('预览影响', 'plan-preview', { primary: true, type: 'submit' }) + '</div></form>';
    if (modal.step === 'preview') return heading + '<div class="modal-body">' + keyValues(modal.definition.fields.map(([key, label, type]) => [label, esc(type === 'checkbox' ? modal.parameters[key] ? '已确认' : '否' : modal.parameters[key])])) + notice('这项能力尚未接入当前产品 API。下一步只生成独立的规划演示记录。', 'warning') + (modal.featureId === 'F40' ? notice('同一项目环境共享 Cluster，引用会按目标重新绑定，源数据库数据不会复制。') : '') + '</div><div class="modal-actions">' + button('返回修改', 'plan-edit') + button('运行演示', 'plan-run', { primary: true }) + '</div>';
    const run = state.planningRuns.find((value) => value.id === modal.runId);
    return heading + '<div class="modal-body"><div class="task-summary"><div><strong>' + esc(run.id) + '</strong><p class="hint">' + date(run.createdAt) + (run.attemptOf ? ' · 重试自 ' + esc(run.attemptOf) : '') + '</p></div>' + badge(run.status) + '</div><div class="task-timeline">' + definition.stages.map((name, index) => '<div class="task-stage ' + (run.status === 'succeeded' ? 'succeeded' : run.status === 'failed' && index === 2 ? 'failed' : index === 0 ? 'succeeded' : 'pending') + '"><span>' + (run.status === 'succeeded' ? icon('check') : index + 1) + '</span><div><strong>' + name + '</strong><small>' + (run.status === 'running' ? '正在演示' : run.status === 'failed' && index === 2 ? '本次失败' : run.status === 'succeeded' ? '演示已完成' : '保留输入') + '</small></div></div>').join('') + '</div>' +
      (run.status === 'succeeded' ? '<div class="plan-result">' + notice(definition.result) + planResultDetails(run, modal) + '</div>' : run.status === 'failed' ? notice('本次规划演示在最后阶段失败，已保存参数与已有结果。重试会产生独立记录。', 'error') : '<p class="muted">正在运行本地状态演示…</p>') +
      (modal.featureId === 'F28' ? '<div class="component-results">' + (run.parameters.components === 'api-cache' ? ['API', 'Redis'] : ['Web', 'Worker', 'PostgreSQL']).map((name, index) => '<div>' + icon(['Redis', 'PostgreSQL'].includes(name) ? 'database' : 'image') + '<strong>' + esc(run.parameters.name) + '-' + name.toLowerCase() + '</strong>' + badge(run.status === 'failed' && index === 1 ? 'failed' : run.status === 'running' ? 'pending' : 'succeeded', run.status === 'failed' && index === 1 ? '失败，等待重试' : run.status === 'running' ? '待确认' : '演示草稿已创建') + '</div>').join('') + '</div>' : '') +
      '</div><div class="modal-actions">' + (run.status === 'failed' ? button('创建独立重试', 'plan-retry', { primary: true }) : button('修改参数', 'plan-edit')) + button('关闭预览', 'close-modal') + '</div>';
  }
  function planResultDetails(run, modal) {
    const p = run.parameters;
    if (modal.featureId === 'F29') return keyValues([['变更路径', esc(p.changed)], ['匹配结果', p.changed.startsWith(p.context) || p.changed.startsWith('packages/shared') ? '命中监听规则，将构建当前服务' : '与当前服务无关，本次跳过']]);
    if (modal.featureId === 'F36') return '<div class="sample-series"><span>15:00<br><strong>42m</strong></span><span>15:05<br><strong>58m</strong></span><span class="muted">15:10<br><strong>缺失</strong></span><span>15:15<br><strong>46m</strong></span></div><p class="hint">上方是固定演示采样，不是当前服务的实时历史。</p>';
    if (modal.featureId === 'F37') return '<pre class="inline-code">[演示] 15:32 request completed 200 12ms\n[演示] 15:33 request completed 200 8ms</pre>' + button('复制本次演示导出', 'copy', { small: true, attrs: ' data-copy="[演示] 15:32 request completed 200 12ms&#10;[演示] 15:33 request completed 200 8ms"' });
    if (modal.featureId === 'F42') return '<pre class="inline-code">ozz --project ' + esc(modal.planContext.project?.slug || 'personal-blog') + ' --environment ' + esc(modal.planContext.environment?.slug || 'production') + ' ' + esc(p.command) + '\nToken: demo_only_•••••••• (不可用于真实 API)</pre>';
    if (modal.featureId === 'F45') return '<div class="evidence-result"><h3>演示建议与证据</h3><p>检查应用实际监听端口与 readiness 路径是否一致，再复核新版本日志。</p><small>来源：本次服务演示日志，15:32，配置 r' + (modal.planContext.service?.revision || 1) + '。未执行部署、重启或配置写入。</small></div>';
    if (modal.featureId === 'F35' || modal.featureId === 'F48') return '<div class="validation-checks"><label><input type="checkbox" data-bind="plan.verifySchema"' + checked(modal.parameters.verifySchema) + '> 已核对结构与版本</label><label><input type="checkbox" data-bind="plan.verifyData"' + checked(modal.parameters.verifyData) + '> 已核对数据范围与完整性</label><label><input type="checkbox" data-bind="plan.verifyApp"' + checked(modal.parameters.verifyApp) + '> 已完成独立应用读写验证</label></div>' + button('记录演示验证', 'plan-validate-data', { small: true, disabled: !modal.parameters.verifySchema || !modal.parameters.verifyData || !modal.parameters.verifyApp }) + (run.validated ? notice('演示业务验证已登记。生产连接尚未切换，源数据与回退路径保留。') : '');
    if (modal.featureId === 'F32' || modal.featureId === 'F44') return '<pre class="inline-code">[演示会话] connected to selected target\n$ whoami\napp-demo\n[演示会话] closed; no real commands executed</pre>';
    return keyValues([['规划记录', esc(run.id)], ['作用范围', esc(modal.planContext.project?.name || '个人工作区')], ['参数快照', esc(Object.keys(p).length + ' 个参数已固定')], ['真实资源变更', '无，独立规划演示']]);
  }

  function loginPage() {
    return '<main class="login-page"><div class="login-brand"><span class="brand-mark">o</span>Ozz</div><h1>登录工作区</h1><p class="muted">交互原型，使用任意非空演示账号和密码。</p><form data-form="login" novalidate>' + formError(state.modal ? '' : state.errors.form) + field('管理员账号', 'login.username', state.login?.username || '', { placeholder: 'demo' }) + field('演示密码', 'login.password', state.login?.password || '', { type: state.login?.show ? 'text' : 'password', placeholder: '不要输入真实密码' }) + '<label class="checkbox-label"><input type="checkbox" data-bind="login.show"' + checked(state.login?.show) + '> 显示密码</label>' + button('登录', 'login-submit', { type: 'submit', primary: true }) + '</form><button class="text-link" data-action="initialization-guide">首次初始化说明</button></main>';
  }
  function modalHTML(ctx) {
    const modal = state.modal; let content = ''; let title = modal.title || '';
    const source = modal.type === 'source';
    if (source) content = sourcePanel();
    else if (modal.type === 'plan') content = planPanel();
    else if (modal.type === 'logs') { const found = findService(modal.serviceId); content = found ? '<div class="modal-body log-modal-body">' + logsPanel(found.service) + '</div>' : empty('服务已经移除', '关闭此面板并查看保留的数据。'); }
    else if (modal.type === 'task') { const task = state.tasks.find((t) => t.id === modal.taskId); content = task ? '<div class="modal-body">' + taskPanel(task) + '</div>' : empty('记录不存在', '返回活动列表重新选择。'); }
    else if (modal.type === 'history') {
      const tasks = state.tasks.filter((t) => t.kind === 'deployment' && t.serviceId === modal.serviceId && (!modal.filter || t.status === modal.filter));
      const page = modal.page || 0;
      content = '<div class="modal-body"><div class="toolbar"><select id="history-filter" data-action="history-filter"><option value="">全部状态</option>' + ['succeeded', 'failed', 'queued', 'cancelled'].map((status) => '<option value="' + status + '"' + selected(modal.filter === status) + '>' + statusNames[status] + '</option>').join('') + '</select><span class="muted">' + tasks.length + ' 条记录</span></div>' + deploymentTable(tasks.slice(page * 5, page * 5 + 5)) + '<div class="pagination">' + button('上一页', 'history-prev', { small: true, disabled: page === 0 }) + '<span>第 ' + (page + 1) + ' 页</span>' + button('下一页', 'history-next', { small: true, disabled: (page + 1) * 5 >= tasks.length }) + '</div></div>';
    } else if (modal.type === 'review') {
      const found = findService(modal.serviceId); const s = found?.service;
      content = !s ? empty('服务已移除', '请返回项目。') : '<form data-form="deploy-review" novalidate><div class="modal-body">' + formError(state.errors.form) + '<div class="review-version"><span>已发布 r' + (s.publishedRevision || '—') + '</span>' + icon('arrow') + '<strong>本次草稿 r' + s.revision + '</strong></div>' + configurationSummary(modal.snapshot, found.project) + '<div class="diff-section"><h3>本次变更</h3>' + configurationDiff(s.publishedSnapshot, modal.snapshot) + '</div>' +
        (s.pendingCommits.length ? notice('本次采用待发布提交 ' + esc(s.pendingCommits[0].sha) + '，来源 ' + esc(s.draft.repository) + '。') : '') +
        (s.status === 'stopped' ? '<label class="checkbox-label confirmation-check"><input type="checkbox" data-bind="modal.start"' + checked(modal.start) + '> 部署本次配置，并明确启动已停止的服务</label>' : '') +
        (s.configurationState === 'partial' ? '<label class="checkbox-label confirmation-check"><input type="checkbox" data-bind="modal.repair"' + checked(modal.repair) + '> 已核对部分应用状态，按本次快照修复</label>' : '') +
        notice('发布固定配置、镜像与数据挂载快照。任务受理后，可以持续查看执行阶段。') + '</div><div class="modal-actions">' + button('返回配置', 'review-edit') + button('确认部署', 'confirm-deploy', { type: 'submit', primary: true, disabled: state.readOnly }) + '</div></form>';
    } else if (modal.type === 'confirm') content = '<form data-form="confirm" novalidate><div class="modal-body"><p>' + esc(modal.description || '') + '</p>' + (modal.details || '') + (modal.requireName ? field('输入 ' + esc(modal.requireName) + ' 以确认', 'modal.input', modal.input || '') : '') + formError(state.errors.form) + '</div><div class="modal-actions">' + button('取消', 'close-modal') + button(modal.confirmText || '确认', 'confirm-submit', { type: 'submit', danger: Boolean(modal.requireName), primary: !modal.requireName }) + '</div></form>';
    else if (modal.type === 'import-env') content = '<form data-form="env-parse" novalidate><div class="modal-body"><p class="section-hint">每行一个 KEY=value。先解析并核对，再添加到当前草稿。</p>' + field('.env 内容', 'modal.text', modal.text || '', { textarea: true, rows: 7, placeholder: 'NODE_ENV=production\nLOG_LEVEL=info' }) + formError(state.errors.form) + (modal.parsed ? '<div class="env-preview"><h3>已解析 ' + modal.parsed.length + ' 个变量</h3><ul>' + modal.parsed.map((row) => '<li><code>' + esc(row.key) + '</code><span>' + esc(modal.protect ? '••••••••' : row.value) + '</span></li>').join('') + '</ul></div>' : '') + '<label class="checkbox-label"><input type="checkbox" data-bind="modal.protect"' + checked(modal.protect) + '> 将本次值标记为秘密</label></div><div class="modal-actions">' + button('取消并清空', 'import-cancel') + button('解析内容', 'env-parse-submit', { type: 'submit' }) + button('添加到草稿', 'env-apply', { primary: true, disabled: !modal.parsed?.length }) + '</div></form>';
    else if (modal.type === 'domain-create') content = '<form data-form="domain-create" novalidate><div class="modal-body">' + formError(state.errors.form) + field('域名前缀', 'modal.hostname', modal.hostname || '', { placeholder: '例如 blog' }) + '<p class="hint">完整域名：' + esc((modal.hostname || '服务名称') + '.' + (targetFor(ctx.project).suffix || 'cluster') + '.' + state.platform.suffix) + '</p>' + selectField('已发布 HTTP 端口', 'modal.portName', modal.portName, [[ctx.service.publishedSnapshot?.portName || 'http', (ctx.service.publishedSnapshot?.portName || 'http') + ' · ' + ctx.service.publishedSnapshot?.port]]) + notice('DNS、路由、证书会分别检查。分配受理不等于 HTTPS 已可用。') + '</div><div class="modal-actions">' + button('取消', 'close-modal') + button('分配并检查', 'domain-create-submit', { type: 'submit', primary: true }) + '</div></form>';
    else if (modal.type === 'mount') content = '<form data-form="mount-save" novalidate><div class="modal-body">' + formError(state.errors.form) + selectField('当前环境的数据卷', 'modal.volumeId', modal.volumeId, [['', '请选择'], ...state.volumes.filter((v) => v.projectId === ctx.project.id && v.environmentId === ctx.environment.id).map((v) => [v.id, v.name + ' · ' + v.capacity + ' GiB'])]) + field('挂载路径', 'modal.path', modal.path || '/data') + '<label class="checkbox-label"><input type="checkbox" data-bind="modal.readOnly"' + checked(modal.readOnly) + '> 只读挂载</label>' + notice('保存后进入服务草稿，需要部署后才能观察实际挂载。') + '</div><div class="modal-actions">' + (modal.index !== undefined ? button('卸载草稿', 'mount-unmount', { danger: true }) : button('取消', 'close-modal')) + button('保存挂载草稿', 'mount-save-submit', { type: 'submit', primary: true }) + '</div></form>';
    else if (modal.type === 'volume-create') content = '<form data-form="volume-create" novalidate><div class="modal-body">' + formError(state.errors.form) + field('数据卷名称', 'modal.name', modal.name || '') + '<div class="two-fields">' + field('申请容量 / GiB', 'modal.size', modal.size || '5', { type: 'number', min: 1, max: 1024 }) + selectField('StorageClass', 'modal.storageClass', 'local-path', [['local-path', 'local-path']]) + '</div>' + notice('卷属于当前项目与环境，删除服务时可独立保留。local-path 不承诺硬配额或自动跨节点迁移。') + '</div><div class="modal-actions">' + button('取消', 'close-modal') + button('创建数据卷', 'volume-create-submit', { type: 'submit', primary: true }) + '</div></form>';
    else if (modal.type === 'connection') content = '<form data-form="connection-save" novalidate><div class="modal-body">' + formError(state.errors.form) + selectField('同环境数据库', 'modal.databaseId', modal.databaseId, [['', '选择数据库'], ...state.databases.filter((d) => d.projectId === ctx.project.id && d.environmentId === ctx.environment.id && d.serviceId !== ctx.service.id).map((d) => [d.id, d.name + ' · ' + d.engine])]) + field('注入变量名', 'modal.variable', modal.variable || 'DATABASE_URL') + '<div class="connection-preview">' + (modal.databaseId ? keyValues([['引用', esc(modal.databaseId)], ['注入方式', '运行时私有连接，秘密值不回显'], ['生效时间', '保存为草稿，下一次部署后生效']]) : notice('当前环境没有可用数据库时，先通过“新建服务 → 数据库”添加。')) + '</div></div><div class="modal-actions">' + button('取消', 'close-modal') + button('保存连接草稿', 'connection-save-submit', { type: 'submit', primary: true }) + '</div></form>';
    else if (modal.type === 'search') content = commandSearchPanel();
    else if (modal.type === 'demo') content = demoPanel(ctx);
    else content = '<div class="modal-body">' + (typeof modal.body === 'function' ? modal.body(ctx) : modal.body || '') + '</div>' + (modal.footer ? '<div class="modal-actions">' + modal.footer + '</div>' : '');
    const wide = modal.wide || ['logs', 'history', 'task', 'review', 'plan'].includes(modal.type);
    return '<div class="modal-layer"><button class="modal-backdrop" data-action="close-modal" aria-label="关闭面板"></button><section class="dialog' + (wide ? ' wide' : '') + (source ? ' command-dialog' : '') + (modal.type === 'logs' ? ' logs-dialog' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(title || modal.definition?.name || '服务操作') + '">' + (!source ? '<div class="dialog-title"><h2>' + esc(title) + '</h2><button class="dialog-close icon-btn" data-action="close-modal" aria-label="关闭">' + icon('close') + '</button></div>' : '') + content + '<div class="dialog-demo-mark">交互原型 · 演示数据 · 不连接真实资源</div></section></div>';
  }
  function configurationDiff(before, after) {
    if (!before) return '<div class="diff-row added"><span>+</span><strong>首次发布</strong><span>创建新的运行实例与配置</span></div>';
    const labels = { image: '镜像', port: '端口', cpu: 'CPU 上限', memory: '内存上限', command: '启动命令', replicas: '副本数', variables: '环境变量', mounts: '卷挂载', connections: '数据库连接', branch: 'Git 分支', dockerfile: 'Dockerfile', readinessPath: '就绪检查路径', autoDeploy: '自动发布' };
    const changed = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]) && !['dirty', 'fallback', 'createdServiceId', 'key', 'selectedSource'].includes(key));
    return changed.length ? changed.map((key) => '<div class="diff-row"><strong>' + esc(labels[key] || key) + '</strong><span>' + (Array.isArray(before[key]) ? before[key].length + ' 项' : esc(before[key] ?? '未设置')) + '</span>' + icon('arrow') + '<span>' + (Array.isArray(after[key]) ? after[key].length + ' 项' : esc(after[key])) + '</span></div>').join('') : '<p class="inline-empty">配置与上次发布一致，将以相同配置创建新的发布记录。</p>';
  }
  function commandSearchPanel() {
    const query = (state.modal.query || '').toLowerCase();
    const results = [
      ...state.projects.map((p) => ({ title: p.name, detail: '项目 · ' + targetFor(p).name, url: projectUrl(p), icon: 'projects' })),
      ...allServices().map((s) => ({ title: s.draft.name, detail: s.project.name + ' · ' + s.environmentId, url: serviceUrl(s.project, s), icon: sourceIcon(s.draft.source) })),
      { title: '所有资源', detail: '服务、数据库、域名和保留卷', url: '#/resources', icon: 'layers' },
      { title: '活动与任务', detail: '部署、操作和 Git 事件', url: '#/activity', icon: 'clock' },
      { title: '服务器', detail: '服务器与集群', url: '#/servers', icon: 'server' },
      { title: '设置与凭证', detail: '连接、凭证、外观和平台入口', url: '#/settings', icon: 'settings' },
    ].filter((r) => (r.title + r.detail).toLowerCase().includes(query));
    return '<div class="command-search">' + icon('search') + '<input id="command-query" data-bind="modal.query" value="' + esc(state.modal.query || '') + '" placeholder="搜索项目、服务或功能…" autofocus /></div><div class="command-list">' + results.map((r, i) => '<a class="command-item" href="' + esc(r.url) + '" data-command-item data-index="' + i + '">' + icon(r.icon) + '<span><strong>' + esc(r.title) + '</strong><small>' + esc(r.detail) + '</small></span>' + icon('arrow') + '</a>').join('') + (results.length ? '' : '<p class="inline-empty">没有匹配结果，试试其他名称。</p>') + '</div>' + commandFooter();
  }
  function demoPanel(ctx) {
    return '<div class="modal-body"><p>这些选项只改变本地演示状态，不访问 API 或外部资源。</p><div class="scenario-list">' + [['normal', '正常流程', '正常保存与任务结果'], ['slow-response', '慢响应演示', '本地模拟受理与连接等待，不访问 API'], ['task-failure', '下一次任务失败', '原记录保留，可以重试'], ['offline', '目标失联 / 结果未知', '保留上次观察和原请求'], ['conflict', '保存时版本冲突', '保留本地编辑，载入最新'], ['page-error', '页面刷新失败', '保留上次数据'], ['empty', '当前列表 / 日志为空', '体验引导与恢复入口'], ['integration-missing', 'Git 连接未配置', '查看授权前置流程']].map(([value, label, detail]) => '<label class="scenario-option"><input type="radio" name="scenario" data-action="demo-scenario" value="' + value + '"' + checked(state.scenario === value) + '><span><strong>' + label + '</strong><small>' + detail + '</small></span></label>').join('') + '</div><label class="checkbox-label"><input type="checkbox" data-action="readonly-toggle"' + checked(state.readOnly) + '> 平台恢复只读模式</label>' + (ctx.service?.draft.source === 'git' ? '<div class="section-actions">' + button('模拟 main 新提交', 'demo-git-push') + button('模拟无效签名', 'demo-git-reject') + '</div>' : '') + '<div class="section-actions">' + button('模拟会话到期', 'demo-expired') + button('恢复正常场景', 'clear-scenario') + '</div><div class="theme-options">' + selectField('界面外观', 'theme', state.theme, [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]) + '</div><a class="text-link" href="#/planning">查看 P1 / P2 规划与能力边界</a></div>';
  }

  function setPath(object, path, value) {
    const parts = path.split('.'); let current = object;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined) current[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }
  function configForPrefix(prefix) {
    if (prefix === 'create') return state.modal?.type === 'source' ? state.modal.draft : state.modal?.parent?.draft;
    const ctx = context(); return ctx.service ? serviceEdit(ctx.service) : null;
  }
  function showError(message, fieldKey) {
    state.errors.form = message; render();
    const target = fieldKey ? document.getElementById(fieldKey) : document.querySelector(state.modal ? '.dialog .form-error' : '.form-error');
    if (target) { let ancestor = target.parentElement; while (ancestor) { if (ancestor.tagName === 'DETAILS') ancestor.open = true; ancestor = ancestor.parentElement; } target.scrollIntoView({ block: 'nearest' }); target.focus?.(); }
    return false;
  }
  function normalizedConfig(value) {
    const keys = Object.keys(defaultConfig());
    const result = {};
    for (const key of keys) result[key] = clone(value[key] === undefined ? defaultConfig()[key] : value[key]);
    result.name = result.name.trim(); result.slug = result.slug || slug(result.name) || value.fallback || uid('service');
    result.port = String(result.port || ''); result.targetPort = String(result.targetPort || result.port);
    return result;
  }
  function validateConfig(config, ctx, prefix) {
    const fail = (message, name) => ({ message, key: prefix + '.' + name });
    if (!config.name.trim()) return fail('请填写服务名称。', 'name');
    if (config.source === 'git') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository)) return fail('选择有效的 GitHub 仓库，例如 demo/app。', 'repository');
      if (!config.branch.trim() || !config.dockerfile.trim() || config.dockerfile.includes('..') || config.context.includes('..')) return fail('请填写仓库内的分支、Dockerfile 与构建上下文。', 'dockerfile');
      if (!state.integrations.some((i) => i.id === config.builder && i.status === 'ready') || !state.integrations.some((i) => i.id === config.registry && i.status === 'ready')) return fail('构建器或镜像仓库尚未配置，请先在全局设置中验证连接。', 'builder');
    } else if (!config.image.trim() || /\s|https?:\/\//i.test(config.image)) return fail('填写容器镜像名称与版本，不要包含 HTTP 协议或空格。', 'image');
    if (config.type !== 'worker' && (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535)) return fail('服务端口需要在 1 到 65535 之间。', 'port');
    if (config.port && (!Number.isInteger(Number(config.targetPort)) || Number(config.targetPort) < 1 || Number(config.targetPort) > 65535)) return fail('容器内部端口需要在 1 到 65535 之间。', 'targetPort');
    if (!/^[a-z][a-z0-9-]*$/.test(config.portName || 'http')) return fail('端口名称需要以小写字母开头，只能包含字母、数字和连字符。', 'portName');
    for (const fieldName of ['cpu', 'memory', 'requestCpu', 'requestMemory', 'replicas']) if (!Number.isFinite(Number(config[fieldName])) || Number(config[fieldName]) < 1) return fail('资源与副本数必须为正数。', fieldName);
    if (Number(config.requestCpu) > Number(config.cpu)) return fail('CPU 请求不能大于 CPU 上限。', 'requestCpu');
    if (Number(config.requestMemory) > Number(config.memory)) return fail('内存请求不能大于内存上限。', 'requestMemory');
    if (config.type === 'database' && Number(config.replicas) !== 1) return fail('数据库保持单个写入实例。', 'replicas');
    if (config.type === 'database' && (!Number.isFinite(Number(config.storage)) || Number(config.storage) < 1 || Number(config.storage) > 1024)) return fail('数据卷申请容量需要在 1 到 1024 GiB 之间。', 'storage');
    if (config.templateId === 'postgresql') for (const key of ['username', 'databaseName']) if (!/^[a-z][a-z0-9_]{0,62}$/.test(config[key]) || config[key].startsWith('pg_')) return fail('使用小写字母开头的名称，仅包含字母、数字和下划线；不能以 pg_ 开头。', key);
    if (config.templateId === 'redis' && (!Number.isInteger(Number(config.redisDatabase)) || Number(config.redisDatabase) < 0 || Number(config.redisDatabase) > 15)) return fail('Redis 数据库编号需要在 0 到 15 之间。', 'redisDatabase');
    for (const name of ['command', 'args']) if (config[name]) { try { const value = JSON.parse(config[name]); if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(); } catch { return fail('启动命令和参数使用字符串 JSON 数组，例如 ["node","server.js"]。', name); } }
    const names = new Set();
    for (let i = 0; i < config.variables.length; i++) {
      const variable = config.variables[i];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.key)) return fail('变量名只能包含字母、数字和下划线，不能以数字开头。', 'variables.' + i + '.key');
      if (names.has(variable.key)) return fail('变量 ' + variable.key + ' 重复，请使用唯一名称。', 'variables.' + i + '.key');
      names.add(variable.key);
      if (variable.mode === 'reference' && !state.credentials.some((c) => c.id === variable.value && c.kind === 'generic')) return fail('请选择有效的通用凭证引用。', 'variables.' + i + '.value');
    }
    if (config.variables.length > 128) return fail('最多保留 128 个变量，请减少本次导入。', 'variables');
    const portNames = new Set([config.portName]);
    for (let i = 0; i < config.ports.length; i++) {
      const port = config.ports[i];
      if (!/^[a-z][a-z0-9-]*$/.test(port.name) || portNames.has(port.name)) return fail('每个端口需要唯一的有效名称。', 'ports.' + i + '.name');
      if (Number(port.port) < 1 || Number(port.port) > 65535 || !Number.isInteger(Number(port.port))) return fail('附加端口需要在 1 到 65535 之间。', 'ports.' + i + '.port');
      portNames.add(port.name);
    }
    for (const probe of ['readiness', 'startup']) {
      if (config[probe + 'Type'] === 'http' && !config[probe + 'Path'].startsWith('/')) return fail('HTTP 检查路径必须以 / 开头。', probe + 'Path');
      if (config[probe + 'Type'] !== 'none' && (Number(config[probe + 'Timeout']) < 1 || Number(config[probe + 'Failures']) < 1 || Number(config[probe + 'Delay']) < 0)) return fail('请核对健康检查的延迟、超时和失败阈值。', probe + 'Timeout');
    }
    for (let i = 0; i < config.mounts.length; i++) {
      const mount = config.mounts[i]; const volume = state.volumes.find((v) => v.id === mount.volumeId);
      if (!volume || volume.projectId !== ctx.project.id || volume.environmentId !== ctx.environment.id) return fail('数据卷必须属于当前项目和环境。', 'mounts.' + i + '.volumeId');
      if (!mount.path.startsWith('/') || mount.path === '/') return fail('挂载路径需要是容器内的绝对目录，不能覆盖根目录。', 'mounts.' + i + '.path');
      if (!mount.readOnly && allServices().some((s) => s.id !== ctx.service?.id && [...s.draft.mounts, ...(s.publishedSnapshot?.mounts || [])].some((m) => m.volumeId === mount.volumeId && !m.readOnly))) return fail('该卷已有其他写入服务，不能新增并发写入挂载。', 'mounts.' + i + '.volumeId');
    }
    return null;
  }
  function createProject() {
    if (state.readOnly) return showError('平台处于只读恢复模式，当前不能创建项目。');
    const draft = state.projectDraft;
    if (draft.createdId) { const existing = state.projects.find((p) => p.id === draft.createdId); if (existing) return demoRequest('create-project', '正在确认项目…', () => enterCreatedProject(existing)); }
    const target = state.clusters.find((t) => t.id === draft.targetId);
    if (!target) return showError('请选择一个已登记的部署位置。', 'project.targetId');
    const name = draft.name.trim() || '新项目 ' + draft.id.slice(-4);
    const generatedSlug = slug(name);
    const resourceSlug = draft.slug.trim() || (/^[a-z]/.test(generatedSlug) ? generatedSlug : draft.id);
    if (!/^[a-z][a-z0-9-]*$/.test(resourceSlug)) return showError('项目标识需以小写字母开头，使用字母、数字或连字符。', 'project.slug');
    if (state.projects.some((p) => p.name === name || p.slug === resourceSlug)) return showError('这个项目名称或标识已经存在，请修改后继续。', 'project.name');
    if (state.scenario === 'conflict') return showError('目标登记在另一处发生变化。已保留输入，请恢复正常场景后重试。');
    const environment = { id: draft.id + '-production', name: '生产', slug: 'production', description: '默认环境' };
    const project = { id: draft.id, name, slug: resourceSlug, description: draft.description, targetId: target.id, clusterId: target.id, revision: 1, environments: [environment], lastEnvironmentId: environment.id, services: [] };
    demoRequest('create-project', '正在创建项目…', () => {
      state.projects.unshift(project); draft.createdId = project.id; draft.dirty = false;
      if (state.scenario === 'offline') { draft.uncertain = true; return showError('创建请求已受理，但响应未能确认。点击“确认已创建项目”继续，不会重复创建。'); }
      enterCreatedProject(project);
    });
  }
  function enterCreatedProject(project) {
    state.projectDraft.uncertain = false; state.projectDraft.dirty = false;
    goto(projectUrl(project), true); openSource({ project, environment: project.environments[0] });
    state.projectDraft = { id: uid('project'), name: '', slug: '', description: '', targetId: state.clusters[0]?.id, dirty: false, createdId: null };
  }
  function saveServiceConfig() {
    const ctx = context(); if (!ctx.service) return;
    if (state.readOnly) return showError('平台当前只读，编辑内容暂未保存。');
    const edit = serviceEdit(ctx.service); const problem = validateConfig(edit, ctx, 'config');
    if (problem) return showError(problem.message, problem.key);
    if (state.scenario === 'conflict') return showError('服务已被另一处修改。已保留本地编辑，选择“载入最新”后重新核对。');
    const next = normalizedConfig(edit);
    demoRequest('service-config', '正在保存草稿…', () => {
      ctx.service.draft = next; ctx.service.revision += 1; state.serviceEdits[ctx.service.id] = clone(next);
      syncReferences(); state.errors = {}; render(); notify('草稿已保存，部署后生效。');
    });
  }
  function syncReferences() {
    for (const db of state.databases) {
      const declared = allServices().filter((s) => [...s.draft.connections, ...(s.publishedSnapshot?.connections || [])].some((c) => c.databaseId === db.id)).map((s) => s.id);
      const inFlight = state.tasks.filter((t) => ['queued', 'running', 'unknown', 'cancelling'].includes(t.status) && t.serviceId && (t.snapshot?.connections || []).some((c) => c.databaseId === db.id)).map((t) => t.serviceId);
      db.consumers = [...new Set([...declared, ...inFlight])];
    }
    for (const volume of state.volumes) {
      const declared = allServices().filter((s) => [...s.draft.mounts, ...(s.publishedSnapshot?.mounts || [])].some((mount) => mount.volumeId === volume.id)).map((s) => s.id);
      const inFlight = state.tasks.filter((t) => ['queued', 'running', 'unknown', 'cancelling'].includes(t.status) && t.serviceId && (t.snapshot?.mounts || []).some((m) => m.volumeId === volume.id)).map((t) => t.serviceId);
      volume.references = [...new Set([...declared, ...inFlight, ...(volume.actualReferences || [])])];
      if (!volume.references.length && !volume.serviceId) volume.retained = true;
    }
  }
  function saveCreationDraft() {
    const modal = state.modal; const draft = modal.draft; const ctx = sourceContext();
    if (state.readOnly) { showError('平台当前只读，暂时不能保存服务。'); return null; }
    let service = ctx.project.services.find((s) => s.id === draft.createdServiceId);
    if (ctx.project.services.some((s) => s.id !== service?.id && s.environmentId === ctx.environment.id && (s.draft.name === draft.name || s.draft.slug === draft.slug))) { showError('当前环境已有同名服务，请返回修改名称。'); return null; }
    const config = normalizedConfig(draft);
    if (!service) {
      service = serviceSeed(draft.fallback, config, { environmentId: ctx.environment.id, status: 'draft', desiredState: 'running', publishedSnapshot: null, revision: 1, publishedRevision: null, createdAt: now(), observedAt: null, cpuMilli: 0, memoryMiB: 0 });
      service.publishedSnapshot = null; ctx.project.services.push(service); draft.createdServiceId = service.id;
      if (config.type === 'database') {
        const volumeId = uid('vol'); const databaseId = uid('db'); const credentialId = uid('cred-db');
        const path = config.templateId === 'redis' ? '/data' : '/var/lib/postgresql/data';
        state.volumes.push({ id: volumeId, name: config.name + '-data', projectId: ctx.project.id, environmentId: ctx.environment.id, serviceId: service.id, capacity: Number(config.storage), sizeGiB: Number(config.storage), storageClass: 'local-path', status: 'pending', node: null, path, references: [service.id], actualReferences: [], retained: false, protected: true, databaseId, records: [], maintenance: null });
        const database = { id: databaseId, name: config.name, kind: config.templateId, engine: config.templateId === 'redis' ? 'Redis' : 'PostgreSQL', version: config.imageVersion, templateVersion: config.version, projectId: ctx.project.id, environmentId: ctx.environment.id, serviceId: service.id, volumeId, credentialId, username: config.username, databaseName: config.databaseName, redisDatabase: config.redisDatabase, port: Number(config.port), host: config.slug + '.' + ctx.environment.id + '.svc.cluster.local', consumers: [], status: 'pending', identity: uid('database-identity') };
        state.databases.push(database); state.credentials.push({ id: credentialId, name: config.name + ' · 初始化凭证', kind: 'database', status: 'active', references: 1 });
        service.draft.mounts = [{ volumeId, path, readOnly: false }]; service.databaseId = databaseId;
      } else if (draft.newVolumeEnabled) {
        const volumeId = uid('vol'); const path = draft.newVolumePath || '/data';
        state.volumes.push({ id: volumeId, name: draft.newVolumeName || config.name + '-data', projectId: ctx.project.id, environmentId: ctx.environment.id, serviceId: service.id, capacity: Number(draft.newVolumeSize), sizeGiB: Number(draft.newVolumeSize), storageClass: 'local-path', status: 'pending', node: null, path, references: [service.id], actualReferences: [], retained: false, protected: false, records: [], maintenance: null });
        service.draft.mounts.push({ volumeId, path, readOnly: false });
      }
    } else if (JSON.stringify(config) !== JSON.stringify(service.draft)) {
      service.draft = config; service.revision += 1;
      const database = state.databases.find((db) => db.serviceId === service.id);
      if (database && !service.publishedSnapshot) {
        Object.assign(database, { name: config.name, username: config.username, databaseName: config.databaseName, redisDatabase: config.redisDatabase });
        const volume = state.volumes.find((v) => v.id === database.volumeId);
        if (volume && !volume.pv) volume.capacity = volume.sizeGiB = Number(config.storage);
      }
    }
    Object.assign(draft, clone(service.draft), { savedRevision: service.revision, savedSignature: JSON.stringify(service.draft), newVolumeEnabled: false });
    syncReferences(); history.replaceState({ ...(history.state || {}), [projectListKey]: projectList }, '', serviceUrl(ctx.project, service));
    modal.route = location.hash;
    return service;
  }
  function createService(deploy) {
    const modal = state.modal; const draft = modal.draft; const ctx = sourceContext();
    const service = ctx.project.services.find((s) => s.id === draft.createdServiceId);
    if (!service) return showError('服务保存结果尚未确认，请先核对原保存请求。');
    if (deploy && (service.revision !== draft.savedRevision || JSON.stringify(service.draft) !== draft.savedSignature)) return showError('已保存的服务草稿发生变化，请返回修改后重新保存与核对。');
    delete state.creationDrafts[draft.key]; closeModal(false); goto(serviceUrl(ctx.project, service), true);
    if (deploy) publishService(ctx.project, service, clone(service.draft), service.revision);
    else { render(); notify('服务草稿已保存，尚未部署。'); }
  }
  function openReview(ctx) {
    if (state.readOnly) return notify('平台当前只读，可以查看原任务和配置。');
    if (blockForMaintenance(ctx.service, ctx.service.draft)) return;
    if (dirtyEdit(ctx.service)) return confirm({ title: '先保存当前修改？', description: '部署只使用已保存的服务草稿。保存成功后，请再次核对部署配置。', confirmText: '保存草稿', onConfirm: saveServiceConfig });
    if (state.tasks.some((t) => t.serviceId === ctx.service.id && ['queued', 'running', 'unknown', 'cancelling'].includes(t.status))) return notify('这个服务还有未结束的任务，请先查看原任务。');
    openModal({ type: 'review', title: '核对部署配置', serviceId: ctx.service.id, snapshot: clone(ctx.service.draft), revision: ctx.service.revision, signature: JSON.stringify(ctx.service.draft), start: false, repair: false });
  }
  function publishService(project, service, snapshot, revision, extra = {}) {
    if (state.readOnly || targetFor(project).status !== 'ready') { notify('当前只读或部署位置尚未就绪，提交已保留，尚未创建发布任务。'); return null; }
    if (state.tasks.some((task) => task.serviceId === service.id && ['queued', 'running', 'unknown', 'cancelling'].includes(task.status))) { notify('服务还有未结束的任务，本次提交保留在待发布列表。'); return null; }
    if (blockForMaintenance(service, snapshot)) return null;
    const oldStatus = service.status; service.status = 'deploying';
    const task = addTask({
      kind: 'deployment', type: 'deploy', name: service.draft.name + ' · 发布 #' + revision, projectId: project.id, environmentId: service.environmentId, serviceId: service.id, targetId: project.targetId, snapshot: clone(snapshot), revision,
      image: snapshot.image, source: snapshot.source, commit: service.pendingCommits[0]?.sha || (snapshot.source === 'git' ? uid('commit').slice(-7) : ''),
      digest: snapshot.imageDigest || 'sha256:' + (slug(snapshot.image || snapshot.repository).replace(/[^a-f0-9]/g, '') || 'a1b2').padEnd(64, 'a').slice(0, 64),
      stages: [{ name: '准备与固定输入', status: 'running' }, { name: snapshot.source === 'git' ? '构建与推送镜像' : '解析与校验镜像', status: 'pending' }, { name: '应用运行配置', status: 'pending' }, { name: '等待目标实例就绪', status: 'pending' }],
      onFailure() { service.status = service.publishedSnapshot ? oldStatus === 'deploying' ? 'running' : oldStatus : 'failed'; },
      ...extra,
    }, (record) => applyPublished(service, record.snapshot, record.revision, record));
    service.lastTaskId = task.id; render(); return task;
  }
  function applyPublished(service, snapshot, revision, task) {
    for (const volume of state.volumes) { const mounted = (snapshot.mounts || []).some((m) => m.volumeId === volume.id); const observed = (volume.actualReferences || []).includes(service.id); if (!mounted && !observed) continue; volume.actualReferences = (volume.actualReferences || []).filter((id) => id !== service.id); if (mounted) volume.actualReferences.push(service.id); volume.actualObservedAt = now(); }
    service.publishedSnapshot = clone(snapshot); service.publishedRevision = revision; service.status = 'running'; service.desiredState = 'running'; service.configurationState = 'consistent'; service.observedAt = now(); service.cpuMilli = 35; service.memoryMiB = 94; service.podId = service.id + '-' + uid('pod').slice(-7);
    if (task.commit) service.pendingCommits = service.pendingCommits.filter((c) => c.sha !== task.commit);
    for (const mount of snapshot.mounts || []) { const volume = state.volumes.find((v) => v.id === mount.volumeId); if (volume) { volume.status = 'bound'; volume.pvc ||= 'pvc-demo-' + volume.id; volume.pv ||= 'pv-demo-' + volume.id; volume.node ||= targetFor(findService(service.id).project).name; volume.observedAt = now(); } }
    const db = state.databases.find((d) => d.serviceId === service.id); if (db) db.status = 'ready';
    syncReferences(); task.result = '本次目标实例已就绪，已发布 r' + revision + '。';
  }
  function blockForMaintenance(service, snapshot = service?.draft) {
    if (!service) return false;
    const configs = [service.draft, service.publishedSnapshot, snapshot].filter(Boolean);
    const volumeIds = configs.flatMap((config) => (config.mounts || []).map((mount) => mount.volumeId));
    for (const database of state.databases) if (database.serviceId === service.id || configs.some((config) => (config.connections || []).some((connection) => connection.databaseId === database.id))) volumeIds.push(database.volumeId);
    const locked = state.volumes.find((volume) => volume.maintenance && (volumeIds.includes(volume.id) || volume.serviceId === service.id || (volume.actualReferences || []).includes(service.id)));
    if (!locked) return false;
    openModal({ title: '数据卷正在维护', body: notice(esc(locked.name) + ' 的维护尚未退出。请先核对原维护任务、helper 和实际挂载，再继续部署或运行操作。', 'warning') + '<a class="btn primary" href="#/volume/' + locked.id + '?tab=maintenance">查看维护状态</a>' });
    return true;
  }
  function serviceOperation(type) {
    const ctx = context(); const service = ctx.service;
    if (!service || state.readOnly) return;
    if (blockForMaintenance(service)) return;
    if (state.tasks.some((t) => t.serviceId === service.id && ['queued', 'running', 'unknown', 'cancelling'].includes(t.status))) return notify('请先等待或确认当前服务任务。');
    if (!service.publishedSnapshot || ['partial', 'unknown'].includes(service.configurationState)) return showError('没有可信的完整已发布快照。请先复核并部署配置。');
    const labels = { restart: '重新启动', stop: '停止服务', resume: '恢复原已发布版本' };
    const descriptions = { restart: '重新启动已发布的配置 r' + service.publishedRevision + '。当前草稿不会发布。', stop: '运行副本缩减为零，保留服务配置、数据卷、域名和部署历史。', resume: '恢复配置 r' + service.publishedRevision + ' 和原镜像产物，不重新构建，不采用草稿，也不消费待发布提交。' };
    confirm({ title: labels[type] + ' · ' + service.draft.name, description: descriptions[type], confirmText: labels[type], onConfirm() {
      if (blockForMaintenance(service)) return;
      addTask({ type, name: service.draft.name + ' · ' + labels[type], projectId: ctx.project.id, environmentId: service.environmentId, serviceId: service.id, targetId: ctx.project.targetId, snapshot: clone(service.publishedSnapshot), revision: service.publishedRevision }, (task) => {
        service.status = type === 'stop' ? 'stopped' : 'running'; service.desiredState = service.status; service.observedAt = now();
        for (const volume of state.volumes) { const mounted = (service.publishedSnapshot?.mounts || []).some((m) => m.volumeId === volume.id); const observed = (volume.actualReferences || []).includes(service.id); if (!mounted && !observed) continue; volume.actualReferences = (volume.actualReferences || []).filter((id) => id !== service.id); if (type !== 'stop' && mounted) volume.actualReferences.push(service.id); volume.actualObservedAt = now(); }
        syncReferences();
        if (type === 'restart') service.restarts += 1;
        if (type !== 'stop') { service.cpuMilli = 38; service.memoryMiB = 106; }
        task.result = type === 'resume' ? '已恢复原已发布版本，草稿和待发布提交保留。' : type === 'stop' ? '服务已停止，数据与历史保留。' : '已按原已发布配置重启。';
      });
    } });
  }
  function deleteService(ctx) {
    const service = ctx.service;
    if (state.readOnly) return;
    if (blockForMaintenance(service)) return;
    const db = state.databases.find((d) => d.serviceId === service.id);
    if (db?.consumers.length) return openModal({ title: '暂时不能删除 ' + service.draft.name, body: notice('还有应用引用这个数据库。先移除引用并发布相关服务，再重新核对。', 'warning') + '<ul class="plain-list">' + db.consumers.map((idValue) => { const found = findService(idValue); return '<li>' + (found ? '<a class="text-link" href="' + serviceUrl(found.project, found.service, 'storage') + '">' + esc(found.service.draft.name) + ' · 数据库连接</a>' : esc(idValue)) + '</li>'; }).join('') + '</ul>' });
    const volumes = state.volumes.filter((v) => v.serviceId === service.id || v.references.includes(service.id));
    confirm({ title: '删除服务', description: '将清理 ' + service.draft.name + ' 的运行资源与域名绑定。下列持久卷和数据身份会独立保留。', requireName: service.draft.name, confirmText: '删除并保留数据', details: volumes.length ? '<div class="retained-volumes">' + volumes.map((v) => '<p>' + icon('disk') + esc(v.name) + ' · ' + v.capacity + ' GiB · 保留</p>').join('') + '</div>' : '<p class="hint">此服务没有持久卷。</p>', onConfirm() {
      if (blockForMaintenance(service)) return;
      const task = addTask({ type: 'delete', name: service.draft.name + ' · 删除服务', serviceId: service.id, projectId: ctx.project.id, environmentId: service.environmentId, targetId: ctx.project.targetId }, (record) => {
        ctx.project.services = ctx.project.services.filter((s) => s.id !== service.id);
        state.domains = state.domains.filter((d) => d.serviceId !== service.id);
        for (const volume of volumes) { volume.retained = true; volume.serviceId = null; volume.references = volume.references.filter((idValue) => idValue !== service.id); volume.actualReferences = (volume.actualReferences || []).filter((idValue) => idValue !== service.id); volume.actualObservedAt = now(); }
        if (db) { db.serviceId = null; db.status = 'retained'; }
        delete state.serviceEdits[service.id]; syncReferences(); record.result = '服务运行资源已清理，' + volumes.length + ' 个持久卷已保留。';
        goto('#/resources?type=volumes&project=' + ctx.project.id + '&env=' + ctx.environment.id, true);
      });
      openModal({ type: 'task', title: '删除任务', taskId: task.id, wide: true });
    } });
  }
  function cancelTask(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || !['queued', 'running'].includes(task.status) || state.readOnly) return;
    confirm({ title: '请求取消任务？', description: '取消需要等待执行器确认。已发生的远端变更会保留，不能立即当作执行已经结束。', confirmText: '请求取消', onConfirm() {
      task.status = 'cancelling'; task.logs.push('[演示] 已记录取消请求，等待执行器确认。'); render();
      setTimeout(() => { task.status = 'cancelled'; task.finishedAt = now(); task.logs.push('[演示] 执行器已确认结束。'); const s = findService(task.serviceId)?.service; if (s?.status === 'deploying') s.status = s.publishedSnapshot ? 'running' : 'draft'; render(); }, 500);
      openModal({ type: 'task', title: '任务详情', taskId: task.id, wide: true });
    } });
  }
  function retryTask(taskId) {
    const previous = state.tasks.find((t) => t.id === taskId); if (!previous || !['failed', 'cancelled'].includes(previous.status) || state.readOnly) return;
    const resourceId = previous.resourceId || previous.serviceId || previous.targetId;
    const pending = state.tasks.find((task) => task.id !== previous.id && ['queued', 'running', 'unknown', 'cancelling'].includes(task.status) && (task.resourceId || task.serviceId || task.targetId) === resourceId);
    if (pending) { openModal({ type: 'task', title: '请先确认当前对象的任务', taskId: pending.id, wide: true }); return; }
    const found = findService(previous.serviceId);
    if (found && state.tasks.some((t) => t.serviceId === previous.serviceId && ['queued', 'running', 'unknown', 'cancelling'].includes(t.status))) return notify('当前服务已有未结束任务，请先查看原任务。');
    if (found && previous.kind === 'deployment' && found.service.publishedRevision > previous.revision) return notify('已有更新的发布，旧任务不能直接覆盖它。请从当前草稿重新复核。');
    const { id: oldId, createdAt, finishedAt, status, _onSuccess, logs, stages, outcome, ...input } = previous;
    let task;
    if (previous.kind === 'deployment' && found) task = publishService(found.project, found.service, previous.snapshot, previous.revision, { attemptOf: previous.id, name: found.service.draft.name + ' · 重试发布', commit: previous.commit, digest: previous.digest });
    else task = addTask({ ...input, attemptOf: previous.id, name: previous.name + ' · 重试' }, _onSuccess);
    if (!task) return;
    openModal({ type: 'task', title: '独立重试任务', taskId: task.id, wide: true });
  }

  function handleAction(name, el) {
    const ctx = context(); const modal = state.modal; const s = ctx.service;
    const lock = interactionLock();
    if (name !== 'demo-expired' && (state.pendingAction || (lock && !['source-confirm-saved', 'submit-project'].includes(name)))) { notify(lock); if (state.modal) focusModal(); return; }
    if (name.startsWith('mg:')) return window.OzzManagement?.action(name, el, ctx);
    if (name === 'toggle-menu') { state.mobileOpen = !state.mobileOpen; render(); }
    else if (name === 'toggle-theme') { theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); render(); }
    else if (name === 'command-search') openModal({ type: 'search', title: '快速导航', query: '' });
    else if (name === 'demo-options') openModal({ type: 'demo', title: '演示场景' });
    else if (name === 'clear-scenario') { state.scenario = 'normal'; state.readOnly = false; state.errors = {}; closeModal(); }
    else if (name === 'clear-search') updateProjectSearch('');
    else if (name === 'close-modal') closeModal();
    else if (name === 'add-service') openSource(ctx);
    else if (name === 'choose-source') chooseSource(el.dataset.source);
    else if (name === 'choose-template') chooseTemplate(el.dataset.id);
    else if (name === 'choose-repository') { if (modal.draft.repository !== el.dataset.id || !modal.draft.name) modal.draft.name = el.dataset.id.split('/').pop(); modal.draft.repository = el.dataset.id; modal.draft.source = 'git'; sourceStep('config'); }
    else if (name === 'choose-git-repository') sourceStep('repositories');
    else if (name === 'source-back') {
      if (modal.step === 'sources') closeModal();
      else if (modal.step === 'save-unknown') closeModal();
      else if (modal.step === 'config' && modal.draft.createdServiceId) createService(false);
      else sourceStep(modal.step === 'review' ? 'config' : modal.step === 'config' ? modal.draft.source === 'git' ? 'repositories' : modal.draft.source === 'database' ? 'database-menu' : modal.draft.source === 'template' ? 'application' : 'sources' : 'sources');
    } else if (name === 'source-cancel') { if (modal.draft.createdServiceId) createService(false); else sourceStep('sources'); }
    else if (name === 'source-config') sourceStep('config');
    else if (name === 'source-confirm-saved') {
      const saved = sourceContext().project.services.find((item) => item.id === modal.draft.createdServiceId);
      if (!saved) return showError('尚未找到原保存请求的结果，请保留此请求稍后核对。');
      demoRequest('source-confirm-saved', '正在确认保存结果…', () => {
        Object.assign(modal.draft, clone(saved.draft), { savedRevision: saved.revision, savedSignature: JSON.stringify(saved.draft), saveUnknown: false });
        sourceStep('review');
      });
    }
    else if (name === 'create-draft') createService(false);
    else if (name === 'create-deploy') demoRequest(name, '正在受理发布…', () => createService(true));
    else if (name === 'variable-add') { const config = configForPrefix(el.dataset.prefix || 'config'); config.variables.push({ key: '', value: '', mode: 'plain' }); render(); const index = config.variables.length - 1; document.getElementById((el.dataset.prefix || 'config') + '.variables.' + index + '.key')?.focus(); }
    else if (name === 'variable-remove') { configForPrefix(el.dataset.prefix || 'config').variables.splice(Number(el.dataset.index), 1); render(); }
    else if (name === 'port-add') { configForPrefix(el.dataset.prefix || 'config').ports.push({ name: '', port: '8080', expose: 'private' }); render(); }
    else if (name === 'port-remove') { configForPrefix(el.dataset.prefix || 'config').ports.splice(Number(el.dataset.index), 1); render(); }
    else if (name === 'mount-add') { configForPrefix(el.dataset.prefix || 'config').mounts.push({ volumeId: '', path: '/data', readOnly: false }); render(); }
    else if (name === 'mount-remove') { configForPrefix(el.dataset.prefix || 'config').mounts.splice(Number(el.dataset.index), 1); render(); }
    else if (name === 'import-env') openModal({ type: 'import-env', title: '批量导入 .env', prefix: el.dataset.prefix || 'config', parent: modal?.type === 'source' ? modal : null, text: '', protect: false, parsed: null });
    else if (name === 'import-cancel') { modal.text = ''; modal.parsed = null; if (modal.parent) { state.modal = modal.parent; state.errors = {}; render(); restoreFocus(modal.triggerFocus, modal.parent); } else closeModal(); }
    else if (name === 'env-apply') {
      if (!modal.parsed?.length) return;
      const config = configForPrefix(modal.prefix);
      const existing = new Set(config.variables.map((v) => v.key));
      if (modal.parsed.some((v) => existing.has(v.key))) return showError('导入变量与当前草稿重复。请修改名称后重新解析。');
      if (modal.parsed.length + config.variables.length > 128) return showError('导入后超过 128 个变量，请减少本次内容。');
      config.variables.push(...modal.parsed.map((row) => ({ ...row, mode: modal.protect ? 'secret' : 'plain' })));
      if (modal.parent) { state.modal = modal.parent; render(); } else closeModal();
    } else if (name === 'save-config') saveServiceConfig();
    else if (name === 'discard-config' || name === 'reload-config') confirm({ title: name === 'reload-config' ? '载入最新草稿？' : '放弃本地修改？', description: '本地未保存的内容会替换为服务已保存的草稿，已发布配置保持独立。', confirmText: name === 'reload-config' ? '载入最新草稿' : '放弃修改', onConfirm() { delete state.serviceEdits[s.id]; state.scenario = state.scenario === 'conflict' ? 'normal' : state.scenario; state.errors = {}; render(); } });
    else if (name === 'review-deploy') openReview(ctx);
    else if (name === 'review-edit') { closeModal(false); goto(serviceUrl(ctx.project, s, 'settings')); }
    else if (name === 'service-restart') serviceOperation('restart');
    else if (name === 'service-stop') serviceOperation('stop');
    else if (name === 'service-resume') serviceOperation('resume');
    else if (name === 'service-delete') deleteService(ctx);
    else if (name === 'show-source') goto(serviceUrl(ctx.project, s, 'settings'));
    else if (name === 'deployment-history') openModal({ type: 'history', title: s.draft.name + ' 的部署记录', serviceId: s.id, page: 0, filter: '', wide: true });
    else if (name === 'history-prev' || name === 'history-next') { modal.page += name === 'history-prev' ? -1 : 1; render(); }
    else if (name === 'task-detail') openModal({ type: 'task', title: '任务详情', taskId: el.dataset.id, wide: true });
    else if (name === 'task-cancel') cancelTask(el.dataset.id);
    else if (name === 'task-retry') retryTask(el.dataset.id);
    else if (name === 'task-reconcile') {
      const task = state.tasks.find((t) => t.id === el.dataset.id);
      if (state.scenario === 'offline') { task.logs.push('[演示] 连接仍不可用，结果保持未知。可在演示场景中恢复连接。'); render(); }
      else { task.outcome = 'succeeded'; finishTask(task, task._onSuccess); }
    } else if (name === 'instances') openModal({ title: s.draft.name + ' 的实例', wide: true, body: (s.status === 'stopped' || s.status === 'draft' ? empty('没有运行实例', s.status === 'stopped' ? '服务按用户意图停止，恢复时使用原已发布配置。' : '先发布当前服务。') : '<div class="table-scroll"><table class="data-table"><thead><tr><th>Pod / 容器</th><th>状态</th><th>重启</th><th>节点</th></tr></thead><tbody><tr><td><code>' + esc(s.podId) + '</code><small class="block">main · imageID sha256:8a35c4d…</small></td><td>' + badge(state.scenario === 'offline' ? 'unknown' : s.status) + '</td><td>' + s.restarts + '</td><td>' + esc(targetFor(ctx.project).name) + '</td></tr></tbody></table></div>') + keyValues([['已发布配置', 'r' + (s.publishedRevision || '未发布')], ['最近观察', date(s.observedAt)], ['期望副本', s.desiredState === 'stopped' ? '0' : s.draft.replicas]]), footer: button('查看日志', 'open-logs', { primary: true, icon: 'log' }) });
    else if (name === 'open-logs') openModal({ type: 'logs', title: '容器日志', serviceId: s.id, wide: true });
    else if (name === 'log-follow') {
      const service = findService(modal.serviceId)?.service; if (!service) return;
      const view = logsFor(service); view.follow = !view.follow; view.paused = false;
      if (view.follow) readLogs(service);
      else { cancelLogRead(view); view.connection = 'ended'; render(); }
    }
    else if (name === 'log-wrap') { const v = logsFor(findService(modal.serviceId).service); v.wrap = !v.wrap; render(); }
    else if (name === 'log-refresh') readLogs(findService(modal.serviceId)?.service, true);
    else if (name === 'log-bottom') { const v = logsFor(findService(modal.serviceId).service); v.paused = false; v.unread = 0; render(); const log = document.querySelector('.log-output'); if (log) log.scrollTop = log.scrollHeight; }
    else if (name === 'log-copy' || name === 'task-log-copy') copyText(copyValue(el), el);
    else if (name === 'task-log-follow' || name === 'task-log-bottom') {
      const task = state.tasks.find((item) => item.id === el.dataset.id); if (!task) return;
      const view = taskLogsFor(task);
      view.follow = name === 'task-log-bottom' ? true : !view.follow; view.paused = false; view.unread = 0; render();
      if (name === 'task-log-bottom') { const log = document.querySelector('.task-log-output'); if (log) log.scrollTop = log.scrollHeight; }
    }
    else if (name === 'refresh-runtime') {
      addTask({ type: 'observe', name: s.draft.name + ' · 重新观察', serviceId: s.id, projectId: ctx.project.id, environmentId: s.environmentId, targetId: ctx.project.targetId }, (task) => { s.observedAt = now(); task.result = '已重新读取当前实例、事件和即时指标。'; });
    } else if (name === 'check-commits') {
      addTask({ type: 'git-check', name: s.draft.name + ' · 检查最新提交', serviceId: s.id, projectId: ctx.project.id, environmentId: s.environmentId }, (task) => { const commit = { sha: uid('commit').slice(-7), message: '更新应用内容', branch: s.draft.branch, createdAt: now() }; s.pendingCommits.unshift(commit); task.result = '发现新提交 ' + commit.sha + '，已放入待发布列表。'; });
    } else if (name === 'git-events') {
      const events = state.gitEvents.filter((event) => event.serviceId === s.id);
      openModal({ title: s.draft.name + ' 的 Git 事件', wide: true, body: '<div class="table-scroll"><table class="data-table"><thead><tr><th>提交</th><th>分支</th><th>处理结果</th><th></th></tr></thead><tbody>' + events.map((event) => '<tr><td><code>' + esc(event.commit) + '</code></td><td>' + esc(event.branch) + '</td><td>' + esc(event.outcome) + '</td><td>' + (event.taskId ? button('部署记录', 'task-detail', { small: true, id: event.taskId }) : '未创建部署') + '</td></tr>').join('') + '</tbody></table></div>', footer: linkButton('全部 Git 事件', '#/activity?tab=git') });
    } else if (name === 'demo-git-push' || name === 'demo-git-reject') {
      const reject = name === 'demo-git-reject'; const commit = { sha: uid('commit').slice(-7), message: '更新应用内容', branch: s.draft.branch, createdAt: now() };
      const event = { id: uid('event'), projectId: ctx.project.id, serviceId: s.id, repository: s.draft.repository, branch: commit.branch, commit: commit.sha, createdAt: now(), status: reject ? 'rejected' : 'pending', outcome: reject ? '签名无效，拒绝且未创建部署' : s.status === 'stopped' ? '服务已停止，保留待发布提交' : '等待复核发布' };
      state.gitEvents.unshift(event);
      if (!reject) {
        s.pendingCommits.unshift(commit);
        if (s.draft.autoDeploy && s.status === 'running') { const task = publishService(ctx.project, s, clone(s.publishedSnapshot || s.draft), s.publishedRevision || s.revision); if (task) { event.taskId = task.id; event.status = 'queued'; event.outcome = '自动发布已受理'; } else { event.status = 'pending'; event.outcome = '发布条件暂不满足，保留待发布提交与原任务'; return render(); } }
      }
      closeModal(); notify(reject ? '已记录拒绝事件，没有创建发布。' : 'Git 事件与待发布提交已更新。');
    } else if (name === 'domain-add') {
      if (window.OzzManagement) return window.OzzManagement.action('mg:domain-new', el, ctx);
      openModal({ type: 'domain-create', title: '分配默认域名', hostname: s.draft.slug || s.draft.name, portName: s.publishedSnapshot.portName || 'http' });
    }
    else if (name === 'domain-check') {
      if (window.OzzManagement) return window.OzzManagement.action('mg:domain-check', el, ctx);
      const domain = state.domains.find((d) => d.id === el.dataset.id);
      const task = addTask({ type: 'domain-check', name: '检查域名 · ' + domain.hostname, projectId: domain.projectId, environmentId: domain.environmentId, serviceId: domain.serviceId, targetId: domain.id }, () => { domain.dns = 'ready'; domain.route = 'ready'; domain.tls = 'ready'; domain.status = 'ready'; domain.observedAt = now(); });
      openModal({ type: 'task', title: '域名检查', taskId: task.id, wide: true });
    } else if (name === 'domain-detail') goto('#/domain/' + el.dataset.id);
    else if (name === 'volume-create') {
      if (window.OzzManagement) return window.OzzManagement.action('mg:volume-new', el, ctx);
      openModal({ type: 'volume-create', title: '创建数据卷', name: '', size: '5', storageClass: 'local-path' });
    }
    else if (name === 'mount-dialog') {
      const index = el.dataset.index !== undefined ? Number(el.dataset.index) : undefined; const mount = index !== undefined ? s.draft.mounts[index] : null;
      openModal({ type: 'mount', title: mount ? '编辑挂载草稿' : '挂载数据卷', index, volumeId: mount?.volumeId || '', path: mount?.path || '/data', readOnly: mount?.readOnly || false });
    } else if (name === 'mount-unmount') {
      s.draft.mounts.splice(modal.index, 1); s.revision += 1; delete state.serviceEdits[s.id]; syncReferences(); closeModal(); notify('已保存卸载草稿，发布后生效。');
    } else if (name === 'connection-dialog') {
      const index = el.dataset.index !== undefined ? Number(el.dataset.index) : undefined; const connection = index !== undefined ? s.draft.connections[index] : null;
      openModal({ type: 'connection', title: connection ? '编辑数据库连接' : '连接数据库', index, databaseId: connection?.databaseId || '', variable: connection?.variable || 'DATABASE_URL' });
    } else if (name === 'connection-remove') confirm({ title: '移除数据库连接草稿？', description: '保存后还需要部署服务。原已发布连接在新的部署完成前仍保留。', confirmText: '保存移除草稿', onConfirm() { s.draft.connections.splice(Number(el.dataset.index), 1); s.revision += 1; delete state.serviceEdits[s.id]; syncReferences(); render(); } });
    else if (name === 'plan') openPlan(el.dataset.id, ctx);
    else if (name === 'planning-service') goto('#/planning?project=' + ctx.project.id + '&env=' + ctx.environment.id);
    else if (name === 'plan-edit') { modal.step = 'configure'; state.errors = {}; render(); }
    else if (name === 'plan-run' || name === 'plan-retry') {
      const run = { id: uid('plan'), featureId: modal.featureId, name: modal.definition.name, parameters: clone(modal.parameters), projectId: modal.planContext.project?.id, serviceId: modal.planContext.service?.id, status: 'running', createdAt: now(), attemptOf: name === 'plan-retry' ? modal.runId : null };
      const failure = state.scenario === 'task-failure'; if (failure) state.scenario = 'normal';
      state.planningRuns.unshift(run); modal.runId = run.id; modal.step = 'running'; render();
      setTimeout(() => { run.status = failure ? 'failed' : 'succeeded'; run.finishedAt = now(); if (state.modal === modal) modal.step = 'result'; render(); }, 850);
    } else if (name === 'plan-validate-data') {
      const run = state.planningRuns.find((r) => r.id === modal.runId);
      if (run.status !== 'succeeded' || !modal.parameters.verifySchema || !modal.parameters.verifyData || !modal.parameters.verifyApp) return;
      run.validated = true; run.validationAt = now(); render();
    } else if (name === 'copy') copyText(el.dataset.copy || '', el);
    else if (name === 'account') openModal({ title: '个人工作区', body: '<div class="account-dialog"><span class="avatar">M</span><div><strong>演示管理员</strong><small>原型中的本地会话</small></div></div><div class="section-actions">' + button('外观与演示场景', 'demo-options', { icon: 'sun' }) + button('退出当前会话', 'logout', { icon: 'logout' }) + '</div>' });
    else if (name === 'logout' || name === 'demo-expired') {
      const exitSession = () => { state.returnTo = location.hash; state.signedIn = false; state.pendingAction = null; clearCopyFeedback(); if (modal?.type === 'logs') cancelLogRead(state.logViews[modal.serviceId]); state.login = { username: '', password: '', show: false }; state.errors = name === 'demo-expired' ? { form: '会话已过期。重新登录后返回原页面，不会重放写操作。' } : {}; state.modal = null; render(); };
      if (name !== 'demo-expired' && unsaved()) confirm({ title: '退出并放弃未保存修改？', description: '当前本地草稿尚未保存。', confirmText: '退出当前会话', onConfirm() { if (s) delete state.serviceEdits[s.id]; exitSession(); } }); else exitSession();
    } else if (name === 'initialization-guide') openModal({ title: '首次初始化', body: '<p>真实 Ozz 使用运维 CLI 初始化唯一管理员与主密钥，不提供公开注册或默认密码。</p>' + notice('缺少主密钥时应恢复原密钥，不能重新生成并冒充恢复。', 'warning') + '<pre class="inline-code">查看项目安装文档中的管理员初始化步骤\n此原型不执行初始化命令。</pre>', footer: button('返回演示登录', 'close-modal') });
  }
  function copyValue(element) {
    if (element.dataset.action === 'log-copy') {
      const service = findService(state.modal?.serviceId)?.service;
      return service ? visibleLogLines(service).join('\n') : '';
    }
    if (element.dataset.action === 'task-log-copy') {
      const task = state.tasks.find((item) => item.id === element.dataset.id);
      return task ? visibleTaskLogLines(task).join('\n') : '';
    }
    return element.dataset.copy || '';
  }
  function copyKey(element) {
    const action = element.dataset.action;
    const index = [...document.querySelectorAll('[data-action="' + action + '"]')].indexOf(element);
    return [location.hash, state.modal?.type, state.modal?.serviceId, state.modal?.taskId, action, index].join('|');
  }
  function copyScope(element) {
    if (element.dataset.action === 'log-copy') {
      const view = state.logViews[state.modal?.serviceId];
      return JSON.stringify([view?.pod, view?.container, view?.previous, view?.tail, view?.query]);
    }
    if (element.dataset.action === 'task-log-copy') { const view = state.taskLogViews[element.dataset.id]; return JSON.stringify([view?.group, view?.query]); }
    return copyValue(element);
  }
  function clearCopyFeedback() {
    for (const value of copyStates.values()) clearTimeout(value.timer);
    copyStates.clear();
  }
  function decorateCopies() {
    document.querySelectorAll('[data-action="copy"], [data-action="log-copy"], [data-action="task-log-copy"]').forEach((element) => {
      const key = copyKey(element); const text = copyValue(element);
      let record = copyStates.get(key);
      if (record && record.scope !== copyScope(element)) {
        if (record.status === 'pending') record.stale = true;
        else { clearTimeout(record.timer); copyStates.delete(key); record = null; }
      }
      if (!element.dataset.copyOriginal) { element.dataset.copyOriginal = element.innerHTML; element.dataset.copyDisabled = String(element.disabled); }
      element.disabled = element.dataset.copyDisabled === 'true' || !text || record?.status === 'pending' || Boolean(state.pendingAction);
      element.setAttribute('aria-busy', String(record?.status === 'pending'));
      element.innerHTML = record?.status === 'pending' ? icon('refresh', 'pending-icon') + '正在复制' : record?.status === 'copied' ? icon('check') + '已复制' : element.dataset.copyOriginal;
      const feedback = element.nextElementSibling?.classList.contains('copy-feedback') ? element.nextElementSibling : null;
      if (record?.status === 'error') {
        if (!feedback) element.insertAdjacentHTML('afterend', '<span class="copy-feedback" role="status">复制失败，请选中文本后复制。</span>');
      } else feedback?.remove();
    });
  }
  async function copyText(text, element) {
    if (!(element instanceof HTMLElement) || !text) return;
    const key = copyKey(element);
    if (copyStates.get(key)?.status === 'pending') return;
    clearTimeout(copyStates.get(key)?.timer);
    const record = { scope: copyScope(element), status: 'pending', timer: null };
    copyStates.set(key, record); decorateCopies();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (copyStates.get(key) !== record) return;
      if (record.stale) { copyStates.delete(key); decorateCopies(); return; }
      record.status = 'copied';
      record.timer = setTimeout(() => { if (copyStates.get(key) === record) { copyStates.delete(key); decorateCopies(); } }, 1600);
    } catch {
      if (copyStates.get(key) !== record) return;
      if (record.stale) { copyStates.delete(key); decorateCopies(); return; }
      record.status = 'error';
    }
    decorateCopies();
  }
  function handleSubmit(name, form) {
    const ctx = context(), modal = state.modal, s = ctx.service;
    const lock = interactionLock();
    if (state.pendingAction || (lock && name !== 'create-project')) { notify(lock); return; }
    if (name.startsWith('mg:')) return window.OzzManagement?.submit(name, form, ctx);
    if (state.composing || Date.now() - state.compositionEndedAt < 160) return;
    if (name === 'create-project') return createProject();
    if (name === 'service-config') return saveServiceConfig();
    if (name === 'source-review') {
      const draft = modal.draft; const scope = sourceContext();
      draft.name = draft.name.trim() || (draft.source === 'git' ? draft.repository.split('/').pop() : slug(draft.image.split('/').pop().split(':')[0])) || 'service-' + draft.fallback.slice(-5);
      draft.slug = draft.slug.trim() || slug(draft.name) || draft.fallback;
      const problem = validateConfig(draft, scope, 'create'); if (problem) return showError(problem.message, problem.key);
      if (draft.type === 'database' && (Number(draft.storage) < 1 || Number(draft.storage) > 1024)) return showError('数据卷容量需要在 1 到 1024 GiB 之间。', 'create.storage');
      if (draft.newVolumeEnabled && (Number(draft.newVolumeSize) < 1 || !draft.newVolumePath.startsWith('/') || draft.newVolumePath === '/')) return showError('请核对新数据卷容量与绝对挂载目录。', 'create.newVolumePath');
      demoRequest('source-review', '正在保存服务…', () => {
        const saved = saveCreationDraft(); if (!saved) return;
        draft.saveUnknown = state.scenario === 'offline';
        sourceStep(draft.saveUnknown ? 'save-unknown' : 'review');
      });
    } else if (name === 'deploy-review') {
      if (state.readOnly) return showError('平台当前只读。');
      if (s.revision !== modal.revision || JSON.stringify(s.draft) !== modal.signature || state.scenario === 'conflict') return showError('配置或来源已变化，当前预览已失效。返回配置并重新核对。');
      if (s.status === 'stopped' && !modal.start) return showError('请明确确认部署并启动已停止的服务。');
      if (s.configurationState === 'partial' && !modal.repair) return showError('请明确确认按本次快照修复部分应用状态。');
      if (targetFor(ctx.project).status !== 'ready') return showError('部署位置尚未就绪，请先验证集群连接。');
      const snapshot = clone(modal.snapshot); const revision = modal.revision;
      demoRequest('deploy-review', '正在受理部署…', () => { closeModal(false); publishService(ctx.project, s, snapshot, revision); restoreFocus(modal.rootFocus); });
    } else if (name === 'confirm') {
      if (modal.requireName && modal.input !== modal.requireName) return showError('请输入完整名称 ' + modal.requireName + '。', 'modal.input');
      const callback = modal.onConfirm;
      demoRequest('confirm', modal.pendingLabel || '正在处理…', () => {
        closeModal(false); callback?.();
        if (state.modal) state.modal.rootFocus = modal.rootFocus;
        else restoreFocus(modal.rootFocus);
      });
    } else if (name === 'env-parse') {
      const parsed = []; const keys = new Set();
      for (const [index, raw] of (modal.text || '').split(/\r?\n/).entries()) {
        const line = raw.trim(); if (!line || line.startsWith('#')) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) return showError('第 ' + (index + 1) + ' 行格式不正确，需要 KEY=value。', 'modal.text');
        if (keys.has(match[1])) return showError('第 ' + (index + 1) + ' 行变量 ' + match[1] + ' 重复。', 'modal.text');
        let value = match[2];
        if (/^["']/.test(value)) { if (value.at(-1) !== value[0]) return showError('第 ' + (index + 1) + ' 行引号未闭合。', 'modal.text'); value = value.slice(1, -1); }
        keys.add(match[1]); parsed.push({ key: match[1], value });
      }
      if (!parsed.length) return showError('请先填写至少一行变量。', 'modal.text');
      modal.parsed = parsed; state.errors = {}; render();
    } else if (name === 'domain-create') {
      if (state.readOnly) return;
      if (!/^[a-z][a-z0-9-]*$/.test(modal.hostname || '')) return showError('域名前缀需要以小写字母开头，只包含字母、数字和连字符。', 'modal.hostname');
      const hostname = modal.hostname + '.' + (targetFor(ctx.project).suffix || 'cluster') + '.' + state.platform.suffix;
      if (state.domains.some((d) => d.hostname === hostname)) return showError('此域名已经分配，请使用其他前缀。', 'modal.hostname');
      const domain = { id: uid('domain'), hostname, projectId: ctx.project.id, environmentId: ctx.environment.id, serviceId: s.id, portName: modal.portName, port: Number(s.publishedSnapshot.port), status: 'pending', dns: 'pending', route: 'pending', tls: 'pending', certificate: 'staging', target: '192.0.2.10', observedAt: null };
      state.domains.push(domain); closeModal(false);
      const task = addTask({ type: 'domain-allocate', name: '分配域名 · ' + hostname, targetId: domain.id, serviceId: s.id, projectId: ctx.project.id, environmentId: ctx.environment.id, onFailure() { domain.status = 'failed'; } }, (record) => { domain.status = 'ready'; domain.dns = 'ready'; domain.route = 'ready'; domain.tls = 'ready'; domain.observedAt = now(); record.result = '演示 DNS、路由与 staging 证书检查已完成。'; });
      openModal({ type: 'task', title: '域名分配任务', taskId: task.id, wide: true });
    } else if (name === 'volume-create') {
      if (state.readOnly) return;
      if (!modal.name.trim() || Number(modal.size) < 1 || Number(modal.size) > 1024) return showError('填写卷名称与 1–1024 GiB 的容量。', 'modal.name');
      if (state.volumes.some((v) => v.environmentId === ctx.environment.id && v.name === modal.name.trim())) return showError('当前环境已存在同名数据卷。', 'modal.name');
      const volume = { id: uid('vol'), name: modal.name.trim(), projectId: ctx.project.id, environmentId: ctx.environment.id, serviceId: null, capacity: Number(modal.size), sizeGiB: Number(modal.size), storageClass: 'local-path', status: 'pending', node: null, references: [], actualReferences: [], retained: true, protected: false, records: [], maintenance: null };
      state.volumes.push(volume); closeModal(false);
      addTask({ type: 'volume-create', name: '创建数据卷 · ' + volume.name, targetId: volume.id, projectId: ctx.project.id, environmentId: ctx.environment.id, onFailure() { volume.status = 'failed'; } }, (task) => { volume.status = 'pending'; volume.pvc = 'pvc-demo-' + volume.id; volume.observedAt = now(); task.result = '演示 PVC 已创建，等待第一个消费者挂载，尚未观察到 PV 与节点。'; });
    } else if (name === 'mount-save') {
      const mount = { volumeId: modal.volumeId, path: modal.path, readOnly: modal.readOnly };
      const trial = clone(s.draft); if (modal.index !== undefined) trial.mounts[modal.index] = mount; else trial.mounts.push(mount);
      const problem = validateConfig(trial, ctx, 'modal'); if (problem) return showError(problem.message);
      s.draft.mounts = trial.mounts; s.revision += 1; delete state.serviceEdits[s.id]; syncReferences(); closeModal(); notify('挂载草稿已保存，部署后生效。');
    } else if (name === 'connection-save') {
      const database = state.databases.find((d) => d.id === modal.databaseId);
      if (!database || database.projectId !== ctx.project.id || database.environmentId !== ctx.environment.id) return showError('请选择当前环境的数据库。', 'modal.databaseId');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(modal.variable)) return showError('请输入有效的注入变量名。', 'modal.variable');
      if (s.draft.connections.some((c, index) => index !== modal.index && c.variable === modal.variable) || s.draft.variables.some((v) => v.key === modal.variable)) return showError('这个变量名已经存在，请明确使用其他名称。', 'modal.variable');
      const connection = { databaseId: database.id, variable: modal.variable };
      if (modal.index !== undefined) s.draft.connections[modal.index] = connection; else s.draft.connections.push(connection);
      s.revision += 1; delete state.serviceEdits[s.id]; syncReferences(); closeModal(); notify('数据库连接已保存为草稿，发布后生效。');
    } else if (name === 'plan-preview') {
      const problem = validatePlan(modal); if (problem) return showError(problem);
      modal.step = 'preview'; state.errors = {}; render();
    } else if (name === 'login') {
      if (!state.login?.username.trim() || !state.login?.password) return showError('填写演示账号与密码。', 'login.username');
      if (state.scenario === 'page-error') return showError('演示登录暂时不可用。恢复正常场景后重试。');
      state.login.password = ''; state.signedIn = true; state.errors = {}; render();
    }
  }
  function updateBinding(el) {
    const key = el.dataset.bind; if (!key) return false;
    const value = el.type === 'checkbox' ? el.checked : el.value;
    const [prefix, ...parts] = key.split('.'); const path = parts.join('.');
    let target;
    if (prefix === 'config') target = context().service ? serviceEdit(context().service) : null;
    else if (prefix === 'create') target = configForPrefix('create');
    else if (prefix === 'project') { target = state.projectDraft; target.dirty = true; }
    else if (prefix === 'modal') target = state.modal;
    else if (prefix === 'plan') target = state.modal?.parameters;
    else if (prefix === 'login') target = state.login || (state.login = { username: '', password: '', show: false });
    else if (key === 'theme') { theme(value); render(); return true; }
    if (!target) return false;
    if (path === 'port' && target.targetPort === target.port) target.targetPort = value;
    if (path === 'image' && target.image !== value) { target.imageDigest = ''; target.imageVersion = ''; }
    if (path.endsWith('.mode')) {
      const array = target.variables; const index = Number(parts[1]);
      if (array?.[index] && array[index].mode !== value) array[index].value = '';
    }
    setPath(target, path, value);
    if (prefix === 'create') target.dirty = true;
    if (prefix === 'modal' && path === 'text') target.parsed = null;
    if (!state.composing) render();
    return true;
  }
  function inputEvent(event) {
    const el = event.target; const ctx = context();
    if (interactionLock()) return;
    if (window.OzzManagement?.change(event, ctx)) return;
    if (el.dataset.bind) return updateBinding(el);
    if (el.dataset.log && state.modal?.type === 'logs') {
      const service = findService(state.modal.serviceId)?.service; if (!service) return;
      const view = logsFor(service); const key = el.dataset.log; const value = el.type === 'checkbox' ? el.checked : el.value;
      if (view[key] === value) return;
      view[key] = value;
      if (['pod', 'container', 'previous'].includes(key)) { view.buffer = []; view.unread = 0; view.paused = false; readLogs(service); }
      else if (key === 'tail') readLogs(service);
      else render();
      return;
    }
    if (el.dataset.taskLog) { const task = state.tasks.find((item) => item.id === el.dataset.taskId); if (task) { taskLogsFor(task).query = el.value; render(); } return; }
    const name = el.dataset.action;
    if (name === 'project-search') { state.search = el.value; if (!state.composing) updateProjectSearch(el.value); }
    else if (name === 'environment-switch') {
      const env = ctx.project.environments.find((e) => e.id === el.value); if (env) goto(projectUrl(ctx.project, '', env.id));
    } else if (name === 'history-filter') { state.modal.filter = el.value; state.modal.page = 0; render(); }
    else if (name === 'demo-scenario') { state.scenario = el.value; render(); }
    else if (name === 'readonly-toggle') { state.readOnly = el.checked; render(); }
  }

  document.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (control && !control.disabled) {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName)) return;
      if (control.tagName === 'A' || control.type !== 'submit') event.preventDefault();
      handleAction(control.dataset.action, control); return;
    }
    const anchor = event.target.closest('a[href^="#/"]');
    if (anchor) { event.preventDefault(); goto(anchor.getAttribute('href')); }
  });
  document.addEventListener('auxclick', (event) => { if (event.target.closest('a[href]') && interactionLock()) { event.preventDefault(); notify(interactionLock()); } });
  document.addEventListener('submit', (event) => { event.preventDefault(); if (event.target.dataset.form) handleSubmit(event.target.dataset.form, event.target); });
  document.addEventListener('input', inputEvent);
  document.addEventListener('change', inputEvent);
  document.addEventListener('compositionstart', () => { state.composing = true; });
  document.addEventListener('compositionend', (event) => { state.composing = false; state.compositionEndedAt = Date.now(); if (event.target.dataset.action === 'project-search') updateProjectSearch(event.target.value); else requestAnimationFrame(() => render()); });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || state.composing || Date.now() - state.compositionEndedAt < 160) return;
    if (interactionLock() && (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'))) { event.preventDefault(); notify(interactionLock()); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openModal({ type: 'search', title: '快速导航', query: '' }); return; }
    if (event.key === 'Home' && event.target.classList?.contains('task-log-output')) {
      const task = state.tasks.find((item) => item.id === event.target.dataset.taskId);
      if (task) { event.preventDefault(); const view = taskLogsFor(task); view.paused = true; view.scrollTop = 0; event.target.scrollTop = 0; render(); return; }
    }
    if (!state.modal) return;
    if (event.key === 'Escape') { event.preventDefault(); if (state.modal.type === 'source') handleAction('source-back', document.createElement('button')); else if (state.modal.type === 'import-env') handleAction('import-cancel', document.createElement('button')); else closeModal(); return; }
    const items = [...document.querySelectorAll('.dialog [data-command-item]')];
    if (items.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const index = items.indexOf(document.activeElement);
      state.commandIndex = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[state.commandIndex].focus();
    } else if (items.length && event.key === 'Enter' && ['command-query', 'repo-search'].includes(document.activeElement?.id)) { event.preventDefault(); items[state.commandIndex || 0]?.click(); }
    if (event.key === 'Tab') {
      const focusable = [...document.querySelectorAll('.dialog a[href],.dialog button:not([disabled]),.dialog input:not([disabled]),.dialog select:not([disabled]),.dialog textarea:not([disabled]),.dialog summary')].filter((node) => node.getClientRects().length);
      if (!focusable.length) { event.preventDefault(); document.querySelector('.dialog')?.focus(); return; }
      if (!document.querySelector('.dialog')?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus(); return; }
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
    }
  });
  document.addEventListener('scroll', (event) => {
    if (event.target.classList?.contains('task-log-output')) {
      const task = state.tasks.find((item) => item.id === event.target.dataset.taskId); if (!task) return;
      const view = taskLogsFor(task); const element = event.target;
      view.scrollTop = element.scrollTop;
      if (view.follow && element.scrollHeight - element.scrollTop - element.clientHeight > 24 && !view.paused) { view.paused = true; render(); }
      return;
    }
    if (!event.target.classList?.contains('log-output') || state.modal?.type !== 'logs') return;
    const element = event.target; const view = logsFor(findService(state.modal.serviceId).service);
    if (view.follow && element.scrollHeight - element.scrollTop - element.clientHeight > 24 && !view.paused) { view.paused = true; render(); }
  }, true);
  window.addEventListener('hashchange', () => {
    const lock = interactionLock();
    if (lock) { history.replaceState({ ...(history.state || {}), [projectListKey]: projectList }, '', renderedHash); notify(lock); return; }
    const previous = renderedHash;
    const saved = history.state?.[projectListKey];
    if (isProjectList(location.hash) && typeof saved?.query === 'string' && Number.isFinite(saved?.scroll)) projectList = { query: saved.query, scroll: Math.max(0, saved.scroll) };
    if (state.modal && state.modal.route !== location.hash) closeModal(false);
    clearCopyFeedback(); state.mobileOpen = false; state.errors = {}; render();
    history.replaceState({ ...(history.state || {}), [projectListKey]: projectList }, '', location.href);
    if (isProjectList(location.hash)) { const top = projectList.scroll; requestAnimationFrame(() => window.scrollTo({ top })); }
    else if (previous.split('?')[0] !== location.hash.split('?')[0]) window.scrollTo({ top: 0 });
  });
  let listScrollTimer;
  window.addEventListener('scroll', () => {
    if (!isProjectList(location.hash) || renderedHash !== location.hash) return;
    projectList.scroll = window.scrollY;
    clearTimeout(listScrollTimer); listScrollTimer = setTimeout(rememberProjectList, 120);
  });
  window.addEventListener('beforeunload', (event) => { if (unsaved() || interactionLock()) { event.preventDefault(); event.returnValue = ''; } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.theme === 'system') theme('system'); });
  setInterval(() => {
    if (state.modal?.type !== 'logs') return;
    const found = findService(state.modal.serviceId); if (!found) return;
    const view = logsFor(found.service);
    if (!view.follow || view.previous || view.connection !== 'receiving' || view.pod !== found.service.podId || found.service.status !== 'running' || state.scenario === 'offline' || state.scenario === 'empty') return;
    view.buffer.push(new Date().toISOString() + ' INFO  [演示] GET /health 200 ' + (2 + view.buffer.length % 5) + 'ms');
    if (view.buffer.length > 1000) view.buffer.shift();
    if (view.paused) view.unread += 1;
    render();
  }, 1800);
  const api = { state, esc, icon, badge, uid, now, goto, projectUrl, serviceUrl, targetFor, allServices, findService, render, notify, openModal, closeModal, confirm, demoRequest, taskLogPanel, addTask, cancelTask, retryTask, openPlan, templates, field, selectField, button, notice, empty, keyValues, syncReferences, date, serviceEdit };
  window.OzzManagement?.init(api);
  window.OzzPrototype = { state, api, context, render, openSource, openPlan, templates };
  theme(state.theme);
  render();
  if (isProjectList(location.hash)) { const top = projectList.scroll; requestAnimationFrame(() => window.scrollTo({ top })); }
})();
