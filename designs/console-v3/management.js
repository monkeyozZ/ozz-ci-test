(() => {
  'use strict';
  let api, state;
  const ui = { drafts: {}, messages: {}, formErrors: {}, dialog: null };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const e = (value) => api.esc(value);
  const icon = (name) => api.icon(name);
  const badge = (value, label) => api.badge(value, label);
  const activeStates = ['queued', 'running', 'cancelling', 'unknown'];
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未观察';
  const attr = (value) => value ? ' checked' : '';
  const disabled = (value) => value ? ' disabled' : '';
  const btn = (label, name, opts = {}) => `<button type="${opts.submit ? 'submit' : 'button'}" class="btn ${opts.primary ? 'primary' : ''} ${opts.danger ? 'danger' : ''} ${opts.small ? 'small' : ''} ${opts.subtle ? 'subtle' : ''}"${name ? ` data-action="mg:${name}"` : ''}${opts.id ? ` data-id="${e(opts.id)}"` : ''}${opts.extra || ''}${disabled(opts.disabled)}>${opts.icon ? icon(opts.icon) : ''}${label}</button>`;
  const link = (label, href, symbol = '') => `<a class="btn" href="${e(href)}">${symbol ? icon(symbol) : ''}${label}</a>`;
  const textLink = (label, href) => `<a class="mg-text-link" href="${e(href)}">${e(label)}</a>`;
  const hasValue = (value) => value !== null && value !== undefined && value !== '';
  const copyButton = (value, label) => hasValue(value) ? `<button type="button" class="btn subtle small" data-action="copy" data-copy="${e(value)}" aria-label="复制${e(label)}">${icon('copy')}复制</button>` : '';
  const copyField = (value, label) => hasValue(value) ? `<span class="mg-copy-value"><code>${e(value)}</code>${copyButton(value, label)}</span>` : '<span class="mg-muted">尚未观察</span>';
  const notice = (body, type = '') => `<div class="notice ${type}">${icon(type === 'error' ? 'alert' : 'info')}<span>${body}</span></div>`;
  const facts = (rows) => `<dl class="mg-facts">${rows.map(([label, value]) => `<dt>${e(label)}</dt><dd>${value ?? '尚无记录'}</dd>`).join('')}</dl>`;
  const section = (title, body, action = '') => `<section class="mg-section"><div class="mg-section-head"><h2>${title}</h2>${action}</div>${body}</section>`;
  const table = (heads, rows, empty = '没有匹配的记录') => `<div class="mg-table-wrap"><table class="mg-table"><thead><tr>${heads.map((head) => `<th>${head}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${heads.length}"><div class="mg-empty"><strong>${empty}</strong><p>调整筛选，或从上方入口添加资源。</p></div></td></tr>`}</tbody></table></div>`;
  const row = (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
  const identity = (name, detail = '') => `<strong class="mg-row-name">${e(name)}</strong>${detail ? `<small class="mg-sub">${detail}</small>` : ''}`;
  const scope = (item) => {
    const p = state.projects.find((value) => value.id === item.projectId);
    const env = p?.environments.find((value) => value.id === item.environmentId);
    return p ? `${e(p.name)}${env ? ` / ${e(env.name)}` : ''}` : '归属项目已移除';
  };
  const target = (item) => state.clusters.find((value) => value.id === (item.targetId || item.clusterId)) || api.targetFor(state.projects.find((value) => value.id === item.projectId) || {});
  const reference = (id) => api.findService(id);
  const serviceLink = (id, tab = 'status') => {
    const found = reference(id);
    const section = { data: 'storage', deployments: 'status' }[tab] || tab;
    return found ? textLink(found.service.draft.name, api.serviceUrl(found.project, found.service, section)) : '<span class="mg-muted">源服务已移除</span>';
  };
  const header = (title, description = '', action = '') => `<div class="mg-page-head"><div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div><div class="mg-actions">${action}</div></div>`;
  const pageKey = (ctx) => [ctx.kind, ctx.id || '', ctx.params.get('tab') || ''].join(':');
  const message = (ctx) => ui.messages[pageKey(ctx)] ? notice(e(ui.messages[pageKey(ctx)].text), ui.messages[pageKey(ctx)].error ? 'error' : 'success') : '';
  const flash = (ctx, text, error = false) => { ui.messages[pageKey(ctx)] = { text, error }; api.render(); };
  const missing = (name, href) => header(`${name}已不存在`) + notice('链接中的资源已移除。请返回列表核对，保留数据可以通过资源列表独立打开。', 'error') + link('返回列表', href, 'back');
  const readonly = () => state.readOnly ? notice('控制面处于恢复只读状态。可以查看资源与已有任务，变更暂不可提交。') : '';
  const tabs = (items, current) => `<nav class="mg-tabs" aria-label="管理分组">${items.map(([id, label, href]) => `<a href="${e(href)}"${id === current ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  function queryHref(path, values, ctx) {
    const params = new URLSearchParams(ctx?.params || '');
    for (const [key, value] of Object.entries(values)) value ? params.set(key, value) : params.delete(key);
    return `#/${path}${params.size ? '?' + params : ''}`;
  }
  function listHref(value, resource) {
    if (typeof value !== 'string' || !value.startsWith('#/')) return '';
    try {
      const url = new URL(value.slice(1), 'https://ozz-prototype.invalid');
      if (url.origin !== 'https://ozz-prototype.invalid') return '';
      const infrastructure = ['server', 'cluster'].includes(resource);
      if (url.pathname !== (infrastructure ? '/servers' : '/resources')) return '';
      if (infrastructure && (url.searchParams.get('tab') === 'clusters' ? 'cluster' : 'server') !== resource) return '';
      if (!infrastructure && url.searchParams.get('type') !== { volume: 'volumes', database: 'databases', domain: 'domains' }[resource]) return '';
      const keys = infrastructure ? ['tab', 'q', 'status', 'page'] : ['type', 'q', 'project', 'env', 'service', 'cluster', 'retained', 'status', 'page'];
      const clean = new URLSearchParams();
      for (const key of keys) {
        if (url.searchParams.getAll(key).length > 1) return '';
        if (url.searchParams.has(key)) clean.set(key, url.searchParams.get(key));
      }
      return '#' + url.pathname + (clean.size ? '?' + clean : '');
    } catch { return ''; }
  }
  function detailHref(resource, id, ctx, values = {}) {
    const inherited = ctx?.params.getAll('list').length === 1 ? ctx.params.get('list') : '';
    const current = ctx && ['servers', 'resources'].includes(ctx.kind) ? queryHref(ctx.kind, {}, ctx) : inherited;
    const list = listHref(current, resource);
    const params = new URLSearchParams(values);
    if (list) params.set('list', list);
    return `#/${resource}/${id}${params.size ? '?' + params : ''}`;
  }
  const returnHref = (ctx, resource, fallback) => ctx.params.getAll('list').length === 1 ? listHref(ctx.params.get('list'), resource) || fallback : fallback;
  function field(label, name, value = '', opts = {}) {
    const id = `mg-${name}`;
    const attrs = `id="${id}" name="${name}" ${opts.secret ? 'data-mg-secret' : `data-mg-field="${name}"`}${opts.mask && opts.area ? ' class="mg-secret-mask"' : ''}${opts.required ? ' required' : ''}${opts.readonly ? ' readonly' : ''}${opts.min != null ? ` min="${opts.min}"` : ''}${opts.max != null ? ` max="${opts.max}"` : ''}${opts.pattern ? ` pattern="${e(opts.pattern)}"` : ''} autocomplete="off"`;
    const control = opts.choices ? `<select ${attrs}>${opts.choices.map(([key, text]) => `<option value="${e(key)}"${String(key) === String(value) ? ' selected' : ''}>${e(text)}</option>`).join('')}</select>` : opts.area ? `<textarea ${attrs} rows="${opts.rows || 3}" placeholder="${e(opts.placeholder || '')}">${opts.secret ? '' : e(value)}</textarea>` : `<input ${attrs} type="${opts.type || 'text'}" value="${opts.secret ? '' : e(value)}" placeholder="${e(opts.placeholder || '')}" />`;
    return `<div class="field"><label for="${id}">${label}</label>${control}${opts.hint ? `<small class="hint">${opts.hint}</small>` : ''}</div>`;
  }
  const check = (label, name, value = false) => `<label class="mg-check"><input type="checkbox" name="${name}" data-mg-field="${name}"${attr(value)} />${label}</label>`;
  const form = (name, body, label = '保存', extra = '') => `<form id="mg-form-${name}" data-form="mg:${name}" data-mg-draft="${name}" novalidate><div class="mg-form-error" role="alert"${ui.formErrors[name] ? '' : ' hidden'}>${e(ui.formErrors[name] || '')}</div><fieldset class="mg-form-fields"${disabled(state.readOnly)}>${body.replace(/ (id|for)="mg-/g, ` $1="mg-${name}-`)}</fieldset><div class="mg-form-footer">${extra}${btn(label, '', { submit: true, primary: true, disabled: state.readOnly })}</div></form>`;
  function data(formElement) {
    return Object.fromEntries(new FormData(formElement).entries());
  }
  function valid(formElement) {
    const invalid = formElement.querySelector('input:invalid,select:invalid,textarea:invalid');
    if (!invalid) return true;
    let p = invalid.parentElement;
    while (p) { if (p.tagName === 'DETAILS') p.open = true; p = p.parentElement; }
    invalid.focus(); invalid.reportValidity(); return false;
  }
  function error(formElement, text) {
    if (formElement?.dataset.mgDraft) ui.formErrors[formElement.dataset.mgDraft] = text;
    const node = formElement?.querySelector('.mg-form-error');
    if (node) { node.textContent = text; node.hidden = false; node.tabIndex = -1; node.focus(); }
    else api.openModal({ title: '暂时不能继续', body: notice(e(text), 'error'), footer: btn('关闭', 'close') });
    return true;
  }
  function redraw() {
    const focused = document.activeElement;
    const id = focused?.id;
    const start = focused?.selectionStart;
    const end = focused?.selectionEnd;
    api.render();
    const next = id && document.getElementById(id);
    if (next) { next.focus({ preventScroll: true }); if (typeof next.setSelectionRange === 'function' && start != null) try { next.setSelectionRange(start, end); } catch {} }
  }
  function openDialog(name, draft, ctx, body, title, subtitle = '', extra = {}) {
    const dialog = { name, draft: copy(draft), ctx, revealSecret: false, ...extra };
    ui.dialog = dialog;
    ui.formErrors = {};
    api.openModal({ title, subtitle, body: typeof body === 'function' ? () => body(ui.dialog?.draft || draft) : body, wide: true, management: dialog, beforeClose: () => confirmFormClose(dialog), onClosed: () => { if (ui.dialog === dialog) { delete ui.drafts[draftKey(name, dialog.draft.id)]; ui.dialog = null; } } });
    const element = document.querySelector(`form[data-mg-draft="${name}"]`);
    if (element) dialog.initial = safeFormValues(element);
  }
  function safeFormValues(element) {
    const secretNames = new Set([...element.querySelectorAll('[data-mg-secret]')].map((input) => input.name));
    return JSON.stringify([...new FormData(element)].filter(([key]) => !secretNames.has(key)));
  }
  function secretSnapshot(element, dialog, modal) {
    const values = [...element.querySelectorAll('[data-mg-secret]')].map((input) => [input.name, input.value]);
    const kind = element.querySelector('[name="kind"]')?.value;
    return {
      clear() { values.forEach((value) => { value[1] = ''; }); values.length = 0; },
      restore() {
        const formElement = document.querySelector('form[data-mg-draft="credential-save"]');
        if (state.modal === modal && ui.dialog === dialog && formElement?.querySelector('[name="kind"]')?.value === kind) {
          for (const [name, value] of values) { const input = formElement.elements.namedItem(name); if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) input.value = value; }
          applySecretVisibility(formElement, dialog.revealSecret);
        }
        this.clear();
      },
    };
  }
  function preserveInputs() {
    const element = document.querySelector('form[data-mg-draft="credential-save"]');
    if (!element || state.modal?.management !== ui.dialog || ui.dialog?.name !== 'credential-save') return;
    const snapshot = secretSnapshot(element, ui.dialog, state.modal);
    return () => snapshot.restore();
  }
  function applySecretVisibility(element, visible) {
    element.querySelectorAll('[data-mg-secret]').forEach((input) => { if (input instanceof HTMLTextAreaElement) input.classList.toggle('mg-secret-mask', !visible); else input.type = visible ? 'text' : 'password'; });
    const trigger = element.querySelector('[data-action="mg:credential-visibility"]');
    if (trigger) { trigger.textContent = visible ? '隐藏内容' : '显示内容'; trigger.setAttribute('aria-pressed', String(visible)); }
  }
  function confirmFormClose(dialog) {
    if (ui.dialog !== dialog || !['credential-save', 'cluster-save'].includes(dialog.name) || (dialog.name === 'cluster-save' && dialog.draft.id)) return true;
    const element = document.querySelector(`form[data-mg-draft="${dialog.name}"]`);
    if (!element || (safeFormValues(element) === dialog.initial && ![...element.querySelectorAll('[data-mg-secret]')].some((input) => input.value))) return true;
    const parent = state.modal;
    const secrets = dialog.name === 'credential-save' ? secretSnapshot(element, dialog, parent) : null;
    api.confirm({ title: dialog.name === 'credential-save' ? '放弃凭证输入？' : '放弃新集群资料？', description: '关闭后清空本次尚未保存的输入。已保存的资源与引用保持不变。', confirmText: '清空并关闭', onCancel: () => secrets?.restore(), onConfirm: () => { secrets?.clear(); delete ui.drafts[draftKey(dialog.name, dialog.draft.id)]; if (ui.dialog === dialog) ui.dialog = null; } });
    return false;
  }
  const refreshDialog = (body) => { if (state.modal) { state.modal.body = body; redraw(); } };
  function blockWrite(formElement) {
    if (!state.readOnly) return false;
    error(formElement, '恢复只读期间不能提交变更，请查看平台状态与恢复指引。'); return true;
  }
  function sameRevision(entity, input, formElement) {
    if (entity && state.scenario === 'conflict' && !entity.demoConflictObserved) { bump(entity); entity.demoConflictObserved = true; }
    if (!entity || Number(input.revision) !== (entity.revision || 1)) {
      error(formElement, '资料已有新版本。请关闭当前编辑，重新载入后再修改；你的输入尚未覆盖已保存内容。'); return false;
    }
    return true;
  }
  const credentialChoices = (kind) => [['', '选择凭证引用'], ...state.credentials.filter((c) => !kind || (Array.isArray(kind) ? kind.includes(c.kind) : c.kind === kind)).map((c) => [c.id, `${c.name}${credentialExpired(c) ? '（已到期）' : ''}`])];
  const credentialExpired = (c) => !c || c.status === 'expired' || (c.expiresAt && Date.parse(c.expiresAt.length === 10 ? `${c.expiresAt}T23:59:59` : c.expiresAt) < Date.now());
  function credentialRefs(id) {
    const refs = [];
    for (const server of state.servers) if (server.credentialId === id) refs.push([`服务器 ${server.name}`, `#/server/${server.id}`]);
    for (const cluster of state.clusters) if (cluster.credentialId === id) refs.push([`集群 ${cluster.name}`, `#/cluster/${cluster.id}`]);
    for (const item of state.integrations) if (item.credentialId === id || item.pullCredentialId === id || item.webhookCredentialId === id) refs.push([`集成 ${item.name}`, '#/settings?tab=git']);
    for (const db of state.databases) if (db.credentialId === id) refs.push([`数据库 ${db.name}`, `#/database/${db.id}`]);
    for (const s of api.allServices()) {
      const uses = (config) => config && (config.credentialId === id || (config.variables || []).some((v) => v.credentialId === id || v.secretRefId === id || (v.mode === 'reference' && v.value === id)));
      if (uses(s.draft) || uses(s.publishedSnapshot)) refs.push([`服务 ${s.draft.name}${uses(s.publishedSnapshot) ? '（含已发布引用）' : '（草稿）'}`, api.serviceUrl(s.project, s, 'settings')]);
    }
    for (const task of state.tasks) if (activeStates.includes(task.status) && JSON.stringify(task.snapshot || {}).includes(`"${id}"`)) refs.push([`在途任务 ${task.name}`, `#/task/${task.id}`]);
    return refs;
  }
  function pendingFor(id) { return id ? state.tasks.find((task) => (task.resourceId === id || task.serviceId === id || task.targetId === id) && activeStates.includes(task.status)) : undefined; }
  function queue(entity, input, done, ctx, navigate = true) {
    const existing = pendingFor(entity?.id || input.resourceId);
    if (existing) { api.goto(`#/task/${existing.id}`); return existing; }
    const revision = entity?.revision || 1;
    const task = api.addTask({ kind: 'operation', resourceId: entity?.id, targetId: entity?.clusterId || entity?.targetId || entity?.id, projectId: entity?.projectId, environmentId: entity?.environmentId, snapshot: entity ? { id: entity.id, name: entity.name, revision } : {}, ...input }, (value) => {
      if (entity && !['servers', 'clusters', 'volumes', 'domains', 'databases', 'integrations', 'projects'].some((key) => state[key].some((item) => item === entity))) { value.status = 'failed'; value.error = '固定资源已移除，旧任务没有重建资源或更新其他目标。'; value.result = value.error; if (value.stages.length) value.stages[value.stages.length - 1].status = 'failed'; return; }
      if (entity && (entity.revision || 1) !== revision) { value.status = 'failed'; value.error = '资料已变化，本次任务没有覆盖较新的配置。'; value.result = value.error; if (value.stages.length) value.stages[value.stages.length - 1].status = 'failed'; return; }
      done?.(value);
      if (value.status === 'failed' && value.stages.length) value.stages[value.stages.length - 1].status = 'failed';
    });
    if (entity) entity.lastTaskId = task.id;
    if (navigate) api.goto(`#/task/${task.id}`); else api.render();
    return task;
  }
  function pageList(items, ctx, renderRow, heads, emptyLabel) {
    const limit = 6;
    const requestedPage = Math.max(1, Math.trunc(Number(ctx.params.get('page'))) || 1);
    const maxPage = Math.max(1, Math.ceil(items.length / limit));
    const page = Math.min(requestedPage, maxPage);
    const slice = items.slice((Math.min(page, maxPage) - 1) * limit, Math.min(page, maxPage) * limit);
    return table(heads, slice.map(renderRow), emptyLabel) + `<div class="mg-pagination"><span>${items.length} 条记录 · 第 ${Math.min(page, maxPage)} / ${maxPage} 页</span><div>${btn('上一页', 'page', { extra: ` data-page="${Math.max(1, page - 1)}"`, disabled: page <= 1 })}${btn('下一页', 'page', { extra: ` data-page="${Math.min(maxPage, page + 1)}"`, disabled: page >= maxPage })}</div></div>`;
  }
  function filters(ctx, opts = {}) {
    return `<div class="mg-filters"><label class="mg-search">${icon('search')}<input id="mg-filter-search" data-mg-filter="q" placeholder="${opts.placeholder || '搜索名称'}" aria-label="搜索资源" value="${e(ctx.params.get('q') || '')}" /></label>${opts.projects ? `<select id="mg-filter-project" data-mg-filter="project" aria-label="项目筛选"><option value="">所有项目</option>${state.projects.map((p) => `<option value="${p.id}"${ctx.params.get('project') === p.id ? ' selected' : ''}>${e(p.name)}</option>`).join('')}</select>` : ''}${opts.projects && ctx.params.get('project') ? `<select id="mg-filter-env" data-mg-filter="env" aria-label="环境筛选"><option value="">所有环境</option>${(state.projects.find((p) => p.id === ctx.params.get('project'))?.environments || []).map((env) => `<option value="${env.id}"${ctx.params.get('env') === env.id ? ' selected' : ''}>${e(env.name)}</option>`).join('')}</select>` : ''}${opts.statuses ? `<select id="mg-filter-status" data-mg-filter="status" aria-label="状态筛选"><option value="">所有状态</option>${opts.statuses.map(([key, label]) => `<option value="${key}"${ctx.params.get('status') === key ? ' selected' : ''}>${label}</option>`).join('')}</select>` : ''}${ctx.params.get('q') || ctx.params.get('status') ? btn('清空筛选', 'clear-filters', { subtle: true }) : ''}</div>`;
  }
  function filtered(items, ctx) {
    const q = (ctx.params.get('q') || '').trim().toLowerCase();
    return items.filter((item) => (!q || `${item.name || item.draft?.name || ''} ${item.address || item.hostname || ''} ${item.id}`.toLowerCase().includes(q)) && (!ctx.params.get('status') || item.status === ctx.params.get('status')) && (!ctx.params.get('project') || item.projectId === ctx.params.get('project')) && (!ctx.params.get('env') || item.environmentId === ctx.params.get('env')) && (!ctx.params.get('service') || (item.serviceId || item.id) === ctx.params.get('service')));
  }

  function serversPage(ctx) {
    const tab = ctx.params.get('tab') === 'clusters' ? 'clusters' : 'servers';
    const rows = state.scenario === 'empty' ? [] : filtered(tab === 'servers' ? state.servers : state.clusters, ctx);
    return header('服务器', '连接自己的服务器，或导入已有 Kubernetes 集群。', btn(tab === 'servers' ? '添加服务器' : '登记集群', tab === 'servers' ? 'server-new' : 'cluster-new', { primary: true, icon: 'plus' }) + btn('导入已有集群', 'cluster-import')) + tabs([['servers', '服务器', queryHref('servers', { tab: '', page: '' }, ctx)], ['clusters', '集群', queryHref('servers', { tab: 'clusters', page: '' }, ctx)]], tab) + filters(ctx, { statuses: [['ready', '已连接'], ['unverified', '未验证'], ['offline', '已失联']] }) + pageList(rows, ctx, (item) => tab === 'servers' ? row([textLink(item.name, detailHref('server', item.id, ctx)), `<code>${e(item.address || item.host)}</code><small class="mg-sub">${e(item.user || item.sshUser)} · SSH ${item.port || item.sshPort || 22}</small>`, e(item.region || item.location || '未填写'), badge(item.status), item.clusterId ? textLink(state.clusters.find((c) => c.id === item.clusterId)?.name || '关联集群', `#/cluster/${item.clusterId}`) : btn('继续接入', 'server-onboard', { id: item.id, small: true }), btn('管理', 'server-open', { id: item.id, small: true })]) : row([textLink(item.name, detailHref('cluster', item.id, ctx)), e(item.location || item.region || '未填写'), badge(item.status), `${item.nodeCount || item.nodes?.length || 0} 个节点`, `${state.projects.filter((p) => (p.targetId || p.clusterId) === item.id).length} 个项目`, btn('管理', 'cluster-open', { id: item.id, small: true })]), tab === 'servers' ? ['服务器', '连接地址', '地区', '状态', '所属集群', ''] : ['集群', '地区', '状态', '节点', '项目', ''], tab === 'servers' ? '还没有登记服务器' : '还没有登记集群') + notice('服务器是 SSH 主机，集群是项目的部署位置。一个多节点集群只作为一个部署目标。');
  }
  function serverForm(d) {
    d = draftFor('server-save', d);
    return form('server-save', `<input type="hidden" name="id" value="${e(d.id || '')}" /><input type="hidden" name="revision" value="${d.revision || 1}" />${field('服务器名称', 'name', d.name, { required: true })}<div class="mg-two">${field('地址', 'address', d.address || d.host || '', { required: true, pattern: '(?:[A-Za-z0-9.:]|-)+', placeholder: '例如：192.0.2.30' })}${field('SSH 端口', 'port', d.port || d.sshPort || 22, { type: 'number', required: true, min: 1, max: 65535 })}</div><div class="mg-two">${field('SSH 用户', 'user', d.user || d.sshUser || 'deploy', { required: true })}${field('SSH 凭证', 'credentialId', d.credentialId, { choices: credentialChoices('ssh'), required: true })}</div><div class="mg-two">${field('地区', 'region', d.region || '')}${field('标签', 'tags', Array.isArray(d.tags) ? d.tags.join(', ') : d.tags || '', { hint: '用逗号分隔，例如 blog, production。' })}</div>${notice('保存登记后，再核对主机指纹和执行只读预检。')}`, d.id ? '保存服务器资料' : '登记服务器', d.id ? reloadButton('server-save', d.id) : closeButton());
  }
  function serverPage(ctx) {
    const s = state.servers.find((item) => item.id === ctx.id);
    if (!s) return missing('服务器', '#/servers');
    const tab = ctx.params.get('tab') || 'overview';
    const cluster = state.clusters.find((item) => item.id === s.clusterId);
    let body = '';
    if (tab === 'settings') body = section('服务器资料', serverForm(s)) + section('移除登记', '<p>移除后不卸载远端软件，不删除集群或数据。</p>' + btn('移除服务器登记', 'server-remove', { id: s.id, danger: true }));
    else if (tab === 'preflight') body = section('主机指纹', facts([['已发现指纹', `<code>${e(s.fingerprint || '尚未发现')}</code>`], ['信任状态', badge(s.fingerprintConfirmed ? 'ready' : 'unverified', s.fingerprintConfirmed ? '已明确确认' : '等待确认')]]) + `<div class="mg-actions">${btn('发现主机指纹', 'fingerprint-discover', { id: s.id })}${s.fingerprint && !s.fingerprintConfirmed ? btn('确认这个指纹', 'fingerprint-confirm', { id: s.id, primary: true }) : ''}</div>`) + section('只读预检', s.preflight ? table(['检查项', '观察结果', '状态'], s.preflight.checks.map((item) => row([e(item.name), e(item.value), badge(item.ok ? 'ready' : 'failed', item.ok ? '通过' : '需要处理')]))) + `<p class="mg-muted">观察时间 ${date(s.preflight.observedAt)}。预检没有安装软件。</p>` : notice('尚未执行预检。检查系统、架构、资源、磁盘、端口和现有安装。'), btn('执行只读预检', 'server-preflight', { id: s.id, primary: true, disabled: !s.fingerprintConfirmed })) + section('初始化 K3s', cluster ? notice(`已关联 ${e(cluster.name)}，不会覆盖已有安装。`) + link('查看集群', `#/cluster/${cluster.id}`) : notice('先通过指纹和预检，再确认固定版本安装。安装结果通过独立任务核对。') + btn('初始化 K3s', 'server-install', { id: s.id, primary: true, disabled: !s.preflight?.passed }));
    else body = section('连接信息', facts([['服务器', e(s.name)], ['SSH 地址', `<code>${e(s.user || s.sshUser)}@${e(s.address || s.host)}:${s.port || s.sshPort || 22}</code>`], ['凭证引用', textLink(state.credentials.find((c) => c.id === s.credentialId)?.name || '尚未选择', '#/settings?tab=credentials')], ['主机指纹', `<code>${e(s.fingerprint || '待发现')}</code>`], ['所属集群', cluster ? textLink(cluster.name, `#/cluster/${cluster.id}`) : '尚未关联'], ['观察时间', date(s.observedAt)]]), btn('检查连接', 'server-onboard', { id: s.id })) + section('主机与工作负载', facts([['系统', e(s.os || '待预检')], ['CPU / 内存', s.cpu ? `${s.cpu} 核 / ${s.memory} GiB` : '未知'], ['可用磁盘', s.disk ? `${s.disk} GiB` : '未知']]) + (cluster ? `<div class="mg-link-list">${state.projects.filter((p) => (p.targetId || p.clusterId) === cluster.id).map((p) => textLink(p.name, api.projectUrl(p))).join('') || '<p>暂无关联项目。</p>'}</div>` : notice('初始化或导入集群后，才能创建承载在这里的项目。'))) + section('最近操作', taskLinks(state.tasks.filter((t) => t.resourceId === s.id || t.targetId === s.id).slice(0, 5)));
    return header(e(s.name), `${e(s.region || s.location || '未填写地区')} · ${e(s.address || s.host)}`, badge(s.status) + link('服务器列表', returnHref(ctx, 'server', '#/servers'), 'back')) + tabs([['overview', '概览', detailHref('server', s.id, ctx)], ['preflight', '连接与接入', detailHref('server', s.id, ctx, { tab: 'preflight' })], ['settings', '设置', detailHref('server', s.id, ctx, { tab: 'settings' })]], tab) + body;
  }
  function clusterForm(d) {
    d = draftFor('cluster-save', d);
    return form('cluster-save', `<input type="hidden" name="id" value="${e(d.id || '')}" /><input type="hidden" name="revision" value="${d.revision || 1}" />${field('集群名称', 'name', d.name, { required: true })}<div class="mg-two">${field('地区', 'location', d.location || d.region || '')}${field('描述', 'description', d.description || '')}</div>${d.id ? notice(`集群身份保持固定：<code>${e(d.identity || '待连接核对')}</code>。更新 API 地址或凭证须通过连接预览。`) : notice('先保存集群登记。导入并验证连接后才可实际部署。')}`, d.id ? '保存集群资料' : '登记集群', d.id ? reloadButton('cluster-save', d.id) : closeButton());
  }
  function clusterPage(ctx) {
    const c = state.clusters.find((item) => item.id === ctx.id);
    if (!c) return missing('集群', '#/servers?tab=clusters');
    const tab = ctx.params.get('tab') || 'overview';
    const projects = state.projects.filter((p) => (p.targetId || p.clusterId) === c.id);
    let body;
    if (tab === 'settings') body = section('集群资料', clusterForm(c)) + section('集群入口', entryForm(c)) + section('移除登记', '<p>关联项目、数据和活动任务会阻止移除。该操作不卸载远端集群。</p>' + btn('移除集群登记', 'cluster-remove', { id: c.id, danger: true }));
    else if (tab === 'connection') body = section('固定集群身份', facts([['Kubernetes API', `<code>${e(c.endpoint || '尚未导入')}</code>`], ['kube-system UID', `<code>${e(c.identity || '待核对')}</code>`], ['凭证引用', c.credentialId ? textLink(c.credentialId, '#/settings?tab=credentials') : '尚未登记'], ['最后观察', date(c.observedAt)]]), btn(c.endpoint ? '更新连接' : '导入 kubeconfig', 'cluster-import', { id: c.id, primary: true })) + section('连接与能力检查', table(['项目', '结果', '状态'], [['rbac', '访问 Kubernetes API'], ['ingress', 'HTTP 入口'], ['storage', 'local-path 持久存储'], ['metrics', '即时指标'], ['certificate', 'cert-manager 证书组件']].map(([key, label]) => row([label, c.capabilities?.[key] ? '已观察到所需能力' : '尚未验证或未安装', badge(c.capabilities?.[key] ? 'ready' : 'unverified')]))), btn('重新检查集群', 'cluster-check', { id: c.id })) + (!c.capabilities?.certificate ? section('证书组件', notice('默认 HTTPS 需要 cert-manager。安装将创建独立任务，完成后再核对能力。'), btn('检查或安装 cert-manager', 'certificate-install', { id: c.id })) : '');
    else body = section('集群概览', facts([['部署位置', e(c.location || c.region || '未填写')], ['API 地址', `<code>${e(c.endpoint || '尚未导入')}</code>`], ['关联服务器', c.serverId ? textLink(state.servers.find((s) => s.id === c.serverId)?.name || '服务器', `#/server/${c.serverId}`) : '外部导入'], ['观察时间', date(c.observedAt)]]), btn('运行诊断', 'cluster-check', { id: c.id })) + section('节点', table(['节点', '架构', '资源', '状态', ''], (c.nodes || []).map((node) => row([identity(node.name, `<code>${e(node.uid)}</code>`), e(node.architecture), `${node.cpu} 核 / ${node.memory} GiB`, badge(c.status === 'offline' ? 'unknown' : node.status), btn('查看节点', 'node-detail', { id: node.id, small: true, extra: ` data-cluster="${c.id}"` })])), '尚未观察到节点'), btn('节点维护', 'plan', { extra: ' data-feature="F41"', small: true }) + '<span class="mg-planned">P1 规划演示</span>') + section('关联项目', projects.length ? `<div class="mg-link-list">${projects.map((p) => textLink(p.name, api.projectUrl(p))).join('')}</div>` : notice('这个集群还没有项目。'), link('在此创建项目', `#/new-project?target=${c.id}`, 'plus')) + section('最近操作', taskLinks(state.tasks.filter((t) => t.targetId === c.id || t.resourceId === c.id).slice(0, 5)));
    return header(e(c.name), '项目、环境与服务共享这个固定部署目标。', badge(c.status) + link('集群列表', returnHref(ctx, 'cluster', '#/servers?tab=clusters'), 'back')) + tabs([['overview', '概览与节点', detailHref('cluster', c.id, ctx)], ['connection', '连接与能力', detailHref('cluster', c.id, ctx, { tab: 'connection' })], ['settings', '设置', detailHref('cluster', c.id, ctx, { tab: 'settings' })]], tab) + body;
  }

  const credentialKinds = [['ssh', 'SSH 私钥'], ['kubeconfig', 'Kubernetes 连接'], ['git', 'Git 授权'], ['registry', '镜像仓库'], ['database', '数据库密码'], ['generic', '通用秘密'], ['webhook', 'Webhook 签名'], ['builder', 'Builder mTLS']];
  const kindName = (kind) => credentialKinds.find(([key]) => key === kind)?.[1] || kind;
  const draftKey = (name, id = '') => `${name}:${id}`;
  const draftFor = (name, entity) => ui.drafts[draftKey(name, entity?.id)] || entity || {};
  const revisionInput = (entity) => `<input type="hidden" name="id" value="${e(entity.id || '')}" /><input type="hidden" name="revision" value="${entity.revision || 1}" />`;
  const safeSlug = (value) => /^[a-z][a-z0-9-]{0,47}$/.test(value);
  const safeHostname = (value) => value.length <= 253 && value.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
  const sameScope = (left, right) => left.projectId === right.projectId && left.environmentId === right.environmentId;
  const bump = (entity) => { entity.revision = Number(entity.revision ?? 1) + 1; };
  const planButton = (feature, label, opts = {}) => btn(label, 'plan', { ...opts, extra: ` data-feature="${feature}"${opts.extra || ''}` });
  const closeButton = () => btn('取消', 'close');
  const reloadButton = (name, id = '') => btn('加载最新', 'form-reload', { id, extra: ` data-form-name="${name}"` });
  function taskLinks(items) {
    return items.length ? `<div class="mg-link-list">${items.map((t) => `<a href="#/task/${e(t.id)}"><span>${e(t.name)}<small class="mg-sub">${date(t.createdAt)}</small></span>${badge(t.status)}</a>`).join('')}</div>` : '<p class="mg-muted">还没有操作记录。请求受理后，会保留独立的阶段、输出和结果。</p>';
  }
  function entryForm(entity = state.platform) {
    const d = draftFor(entity.id ? 'cluster-entry' : 'platform-entry', entity);
    return form(entity.id ? 'cluster-entry' : 'platform-entry', revisionInput(d) + `<div class="mg-two">${field(entity.id ? '集群域名片段' : '平台域名后缀', 'suffix', d.suffix || '', { required: true, placeholder: entity.id ? 'tokyo' : 'example.com', hint: entity.id ? `默认域名组合：服务前缀.${e(d.suffix || 'cluster')}.${e(state.platform.suffix)}` : '用于生成默认域名。修改不会自动重写已绑定域名。' })}${field('ACME 联系邮箱', 'email', d.email || state.platform.email, { type: 'email', required: true })}</div>${entity.id ? `<div class="mg-two">${field('入口类型', 'entryType', d.entryType || 'ip', { choices: [['ip', 'IP 地址'], ['cname', 'CNAME 目标']] })}${field('入口地址', 'entryAddress', d.entryAddress || '', { required: true, placeholder: '192.0.2.10 或 edge.example.com' })}</div>` : ''}${notice('DNS 记录由你在域名服务商处配置。这里保存入口设置，之后可在域名详情分别检查 DNS、路由和 TLS。')}`, '保存入口设置', reloadButton(entity.id ? 'cluster-entry' : 'platform-entry', entity.id));
  }
  function credentialForm(input, replacing = '') {
    const d = input || { kind: 'ssh' };
    const kind = d.kind || 'ssh';
    const secretNames = kind === 'ssh' ? [['privateKey', 'SSH 私钥', true]] : kind === 'kubeconfig' ? [['kubeconfig', 'kubeconfig 内容', true]] : kind === 'builder' ? [['ca', 'CA 证书', true], ['certificate', '客户端证书', true], ['privateKey', '客户端私钥', true]] : [['secret', kind === 'git' ? '访问令牌' : kind === 'registry' ? '密码或访问令牌' : kind === 'database' ? '数据库密码' : kind === 'webhook' ? '签名密钥' : '秘密值', false]];
    return form('credential-save', `<input type="hidden" name="replaceId" value="${e(replacing)}" />${field('名称', 'name', d.name || '', { required: true })}<div class="mg-two">${field('凭证类型', 'kind', kind, { choices: credentialKinds })}${field('到期日期（可选）', 'expiresAt', d.expiresAt || '', { type: 'date' })}</div>${['registry', 'database'].includes(kind) ? field('用户名', 'username', d.username || '', { required: true }) : ''}<div class="mg-actions">${btn('显示内容', 'credential-visibility', { subtle: true, small: true, extra: ' aria-pressed="false"' })}</div>${secretNames.map(([key, label, area]) => field(label, key, '', { secret: true, mask: true, required: true, type: area ? 'text' : 'password', area, rows: 3, hint: '请用示例值体验。原型不保存或发送秘密内容。' })).join('')}${kind === 'ssh' ? field('私钥口令（选填）', 'passphrase', '', { secret: true, type: 'password' }) : ''}${field('说明', 'description', d.description || '', { area: true })}${notice(replacing ? '这会创建一个新凭证引用。原引用仍保留，下一步选择需要切换的使用方并重新验证。' : '保存后只保留名称、类型、到期和引用关系。秘密不能读回；关闭后清空，有输入时切换类型需先确认。')}`, replacing ? '创建替换凭证' : '创建凭证引用', closeButton());
  }
  function credentialPage(ctx) {
    const kind = ctx.params.get('kind') || '';
    const list = filtered(state.scenario === 'empty' ? [] : state.credentials.map((c) => ({ ...c, status: credentialExpired(c) ? 'expired' : 'active' })), ctx).filter((c) => !kind || c.kind === kind);
    return header('凭证', '统一管理引用与到期；秘密值不会在保存后显示。', btn('新建凭证', 'credential-new', { primary: true, icon: 'plus' })) + filters(ctx, { statuses: [['active', '有效'], ['expired', '已到期']] }) + `<div class="mg-filter-inline"><label for="mg-credential-kind">类型</label><select id="mg-credential-kind" data-mg-filter="kind"><option value="">全部类型</option>${credentialKinds.map(([key, label]) => `<option value="${key}"${kind === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div>` + pageList(list, ctx, (c) => row([identity(c.name, `<code>${e(c.id)}</code>`), e(kindName(c.kind)), badge(c.status, c.status === 'expired' ? '已到期' : '有效'), c.expiresAt ? e(c.expiresAt) : '未设置', `${credentialRefs(c.id).length} 个使用方`, btn('查看引用', 'credential-detail', { id: c.id, small: true })]), ['凭证', '类型', '状态', '到期', '引用', ''], '还没有匹配的凭证');
  }
  function integrationForm(input) {
    const d = input;
    const kind = d.kind || 'github';
    const builderFields = kind === 'builder' ? `<div class="mg-two">${field('固定实例 ID', 'instanceId', d.instanceId || '', { required: true, readonly: Boolean(d.id), hint: '由安装资料核对；更换实例需新增连接。' })}${field('架构', 'platform', d.platform || 'amd64', { choices: [['amd64', 'linux/amd64'], ['arm64', 'linux/arm64']] })}</div><details class="mg-config-details"><summary>固定构建工具与身份</summary>${field('BuildKit 版本', 'buildkitVersion', d.buildkitVersion || d.profile?.buildkitVersion || '', { required: true, placeholder: 'v0.16.0' })}${field('Dockerfile frontend digest', 'frontendDigest', d.frontendDigest || d.profile?.frontendDigest || '', { required: true, pattern: 'sha256:[a-f0-9]{64}' })}${field('实例身份签名公钥', 'identityPublicKey', d.identityPublicKey || '', { area: true, rows: 4, required: true, readonly: Boolean(d.id), hint: '地址或 mTLS 轮换仍须匹配这个固定公钥。公钥不属于秘密。' })}${d.id ? `<p class="mg-muted">工具配置版本 r${d.profileRevision || 1}</p>` : btn('填入演示身份与工具配置', 'builder-sample', { subtle: true })}</details>${check('允许新的构建使用此 Builder', 'enabled', d.enabled !== false)}` : '';
    return form('integration-save', revisionInput(d) + `<input type="hidden" name="kind" value="${e(kind)}" />${field('连接名称', 'name', d.name || '', { required: true })}${field(kind === 'registry' ? 'Registry 地址（固定 authority）' : '服务地址', 'endpoint', d.endpoint || (kind === 'github' ? 'https://api.github.com' : ''), { required: true, readonly: kind === 'registry' && Boolean(d.id), placeholder: kind === 'registry' ? 'ghcr.io' : 'https://example.com' })}${kind === 'registry' ? field('固定命名空间', 'namespace', d.namespace || '', { required: true, readonly: Boolean(d.id), placeholder: 'my-team', hint: 'Registry 地址与命名空间登记后保持固定；换目标需新增连接。' }) : ''}${field(kind === 'registry' ? '推送凭证' : kind === 'builder' ? 'mTLS 凭证' : 'Git 授权凭证', 'credentialId', d.credentialId || '', { choices: credentialChoices(kind === 'github' ? 'git' : kind), required: true })}${kind === 'registry' ? field('拉取凭证', 'pullCredentialId', d.pullCredentialId || '', { choices: credentialChoices('registry'), required: true, hint: '使用独立拉取身份。推送与拉取凭证不能相同。' }) : ''}${kind === 'github' ? field('GitHub 账户或组织', 'account', d.account || '', { required: true }) : ''}${builderFields}${notice('保存资料后需要独立验证。已有服务继续引用此连接，编辑不会立即开始构建。')}`, d.id ? '保存连接' : '添加连接', closeButton());
  }
  function integrationsPage(ctx) {
    const kind = ['github', 'registry', 'builder'].includes(ctx.params.get('kind')) ? ctx.params.get('kind') : 'github';
    const list = filtered(state.scenario === 'empty' ? [] : state.integrations.filter((item) => item.kind === kind), ctx);
    return header('Git 与构建集成', '分别配置源码、镜像推送与拉取、远程构建。', btn('添加连接', 'integration-new', { primary: true, extra: ` data-kind="${kind}"`, icon: 'plus' })) + tabs([['github', 'GitHub', '#/settings?tab=git&kind=github'], ['registry', '镜像仓库', '#/settings?tab=git&kind=registry'], ['builder', 'Builder', '#/settings?tab=git&kind=builder']], kind) + filters(ctx, { statuses: [['ready', '已验证'], ['unverified', '待验证'], ['failed', '验证失败']] }) + pageList(list, ctx, (item) => row([identity(item.name, `<code>${e(item.endpoint)}</code>`), badge(item.enabled === false ? 'paused' : item.status, item.enabled === false ? '已停用' : undefined), textLink(state.credentials.find((c) => c.id === item.credentialId)?.name || '凭证缺失', '#/settings?tab=credentials'), date(item.observedAt), `<div class="mg-actions">${btn('管理', 'integration-detail', { id: item.id, small: true })}${btn('验证', 'integration-verify', { id: item.id, small: true })}</div>`]), ['连接', '状态', kind === 'registry' ? '推送凭证' : '凭证', '验证时间', ''], '还没有连接') + (kind === 'github' ? notice('仓库与分支在连接详情查看。Webhook 注册独立配置，只接收事件，不作为通知目标。') : kind === 'builder' ? notice('Builder 的地址、实例身份、mTLS 和架构共同决定可用性；停用后不再接受新构建。') : notice('构建推送使用推送凭证，目标集群拉取镜像使用拉取凭证。两者分别验证。'));
  }
  function platformPage(ctx) {
    const worker = state.worker;
    const items = state.tasks.filter((t) => t.type === 'platform-diagnostic');
    return header('平台状态', '查看执行器与恢复状态，沿固定任务查找变更结果。', btn('运行平台诊断', 'platform-diagnostic', { primary: true })) + `<div class="mg-stat-grid">${[['执行器', badge(worker.status)], ['最后心跳', date(worker.heartbeat)], ['排队 / 待投递', `${state.tasks.filter((t) => t.status === 'queued').length} / ${worker.pending || 0}`], ['Redis', badge(worker.redis)], ['写入状态', badge(state.readOnly ? 'paused' : 'ready', state.readOnly ? '恢复只读' : '正常')]].map(([label, value]) => `<div class="mg-stat"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>` + section('诊断结果', worker.diagnostics ? table(['组件', '状态', '说明'], worker.diagnostics.map((d) => row([e(d.name), badge(d.status), e(d.detail)]))) : notice('运行诊断后，将记录控制面、数据库、队列、执行器和目标连接的分项观察。')) + section('恢复核验', `<ol class="mg-guide"><li>在可信的控制面主机上核对数据库、主密钥版本与备份来源。</li><li>按项目的恢复运行手册执行恢复校验，查看未知任务和资源 revision；不要重放旧任务。</li><li>对账远端资源、helper 与持久卷引用，保留诊断和恢复记录。</li><li>通过真实运维 CLI 的受控流程解除恢复锁，再读取平台状态确认。</li></ol>${notice('Web 端提供状态和指引。这里只读展示恢复核验进度，没有一键解锁。')}`) + section('近期诊断', taskLinks(items.slice(0, 6))) + section('能力与留存', '<p>当前展示即时资源、实例事件与有界日志。历史采样、集中日志和告警需要额外存储与观测能力。</p><div class="mg-actions">' + planButton('F36', '历史指标与采样') + planButton('F37', '日志保留与检索') + planButton('F38', '告警与通知') + '</div><p class="mg-planned">以上为 P1 规划演示。</p>');
  }
  function settingsPage(ctx) {
    const tab = ctx.params.get('tab') === 'integrations' ? 'git' : ctx.params.get('tab') || 'git';
    const navigation = tabs([['git', 'Git 与构建', '#/settings?tab=git'], ['credentials', '凭证', '#/settings?tab=credentials'], ['entry', '域名与入口', '#/settings?tab=entry'], ['appearance', '外观', '#/settings?tab=appearance'], ['platform', '平台状态', '#/settings?tab=platform'], ['automation', '自动化', '#/settings?tab=automation']], tab);
    let body;
    if (tab === 'credentials') body = credentialPage(ctx);
    else if (tab === 'entry') body = header('域名与入口', '统一默认后缀，在每个部署集群中维护实际入口。') + section('平台默认值', entryForm()) + section('集群入口', table(['集群', '完整后缀', '入口', '证书组件', ''], state.clusters.map((c) => row([textLink(c.name, `#/cluster/${c.id}`), `<code>${e(c.suffix || '未填写')}.${e(state.platform.suffix)}</code>`, e(c.entryAddress || '未填写'), badge(c.capabilities?.certificate ? 'ready' : 'unverified'), link('编辑入口', `#/cluster/${c.id}?tab=settings`)])))) + section('自定义域名与 DNS 托管', '<p>默认域名已支持。自定义域名、多个域名、Cloudflare 授权与记录冲突检测在规划流程中单独体验。</p>', planButton('F33', '体验规划流程'));
    else if (tab === 'appearance') body = header('外观', '主题在当前浏览器保留，切换时保持页面与非敏感编辑内容。') + section('界面主题', `<div class="mg-theme-options">${[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']].map(([key, label]) => `<label class="mg-theme-choice${state.theme === key ? ' selected' : ''}"><input type="radio" name="mg-theme" value="${key}" data-mg-theme${attr(state.theme === key)} /><span class="mg-theme-sample ${key}"></span><strong>${label}</strong></label>`).join('')}</div>`);
    else if (tab === 'platform') body = platformPage(ctx);
    else if (tab === 'automation') body = header('自动化', '以明确的项目、环境与权限运行操作。') + section('现有 OpenAPI 与运维工具', `<p>当前产品有 OpenAPI 契约，以及初始化、诊断和恢复等有限运维 CLI。完整用户 Token 与日常 CLI 尚未接入。</p>${facts([['请求上下文', '<code>Project → Environment → Service</code>'], ['变更结果', '读取独立 Deployment / Operation，受理不等于成功'], ['恢复操作', '在可信主机按真实运行手册核验，不在浏览器执行解锁']])}`) + section('用户 CLI 与 API Token', '<p>体验一次显示、到期、撤销与非交互调用的完整规划流程。</p>', planButton('F42', '配置自动化')) + section('外部集成', `<div class="mg-actions">${planButton('F35', '对象存储与自动备份')}${planButton('F36', 'Prometheus / 历史指标')}${planButton('F37', 'Loki / 历史日志')}${planButton('F38', '通知目标与投递')}</div><p class="mg-planned">P1 规划演示 · 不创建真实外部连接。</p>`);
    else body = integrationsPage(ctx);
    return navigation + body;
  }

  function volumeRefs(volume) {
    const result = [];
    const actualIds = volume.actualReferences || api.allServices().filter((s) => s.observedAt && (s.publishedSnapshot?.mounts || []).some((m) => m.volumeId === volume.id)).map((s) => s.id);
    for (const s of api.allServices()) {
      const draft = (s.draft.mounts || []).find((m) => m.volumeId === volume.id);
      const published = (s.publishedSnapshot?.mounts || []).find((m) => m.volumeId === volume.id);
      const pending = state.tasks.filter((t) => t.serviceId === s.id && activeStates.includes(t.status) && (t.snapshot?.mounts || []).some((m) => m.volumeId === volume.id));
      if (draft || published || pending.length || actualIds.includes(s.id)) result.push({ service: s, draft, published, pending, actual: actualIds.includes(s.id) });
    }
    for (const id of actualIds) if (!result.some((r) => r.service.id === id)) result.push({ service: { id, draft: { name: `已移除服务 ${id}` } }, actual: true, pending: [] });
    return result;
  }
  function databaseRefs(db) {
    return api.allServices().map((s) => ({ service: s, draft: (s.draft.connections || []).filter((c) => c.databaseId === db.id), published: (s.publishedSnapshot?.connections || []).filter((c) => c.databaseId === db.id), pending: state.tasks.filter((t) => t.serviceId === s.id && activeStates.includes(t.status) && (t.snapshot?.connections || []).some((c) => c.databaseId === db.id)) })).filter((r) => r.draft.length || r.published.length || r.pending.length);
  }
  function resourcesPage(ctx) {
    const type = ['services', 'domains', 'databases', 'volumes'].includes(ctx.params.get('type')) ? ctx.params.get('type') : 'services';
    const p = state.projects.find((project) => project.id === ctx.params.get('project'));
    const values = type === 'services' ? api.allServices() : state[type];
    const rows = state.scenario === 'empty' ? [] : filtered(values, ctx);
    const name = { services: '服务', domains: '域名', databases: '数据库', volumes: '持久卷' }[type];
    const statuses = type === 'services' ? [['running', '运行中'], ['stopped', '已停止'], ['draft', '待发布'], ['failed', '失败']] : type === 'volumes' ? [['bound', '已绑定'], ['pending', '等待绑定'], ['failed', '失败']] : [['ready', '可用'], ['pending', '处理中'], ['failed', '失败'], ['unknown', '未知']];
    const actions = type === 'volumes' ? btn('创建数据卷', 'volume-new', { primary: true, icon: 'plus' }) : type === 'domains' ? btn('分配默认域名', 'domain-new', { primary: true, icon: 'plus' }) : type === 'databases' ? p ? link('添加数据库服务', api.projectUrl(p, '', ctx.params.get('env') || p.lastEnvironmentId)) : link('进入项目添加数据库', '#/projects') : '';
    const renderRow = (item) => {
      if (type === 'services') return row([textLink(item.draft.name, api.serviceUrl(item.project, item)), scope(item), badge(item.status), e(target(item).name || '目标已移除'), e(item.draft.source), link('查看服务', api.serviceUrl(item.project, item))]);
      if (type === 'domains') return row([textLink(item.hostname, detailHref('domain', item.id, ctx)), scope(item), serviceLink(item.serviceId, 'network'), badge(item.status), `${badge(item.dns, 'DNS')} ${badge(item.route, '路由')} ${badge(item.tls, 'TLS')}`, date(item.observedAt)]);
      if (type === 'databases') return row([textLink(item.name, detailHref('database', item.id, ctx)), scope(item), `${e(item.engine)} ${e(item.version)}`, serviceLink(item.serviceId, 'data'), badge(item.status), textLink(state.volumes.find((v) => v.id === item.volumeId)?.name || '数据卷', `#/volume/${item.volumeId}`)]);
      return row([textLink(item.name, detailHref('volume', item.id, ctx)), scope(item), `${item.sizeGiB || item.capacity} GiB<small class="mg-sub">${e(item.storageClass)}</small>`, badge(item.status), item.retained ? '<span class="mg-token">已保留</span>' : `${volumeRefs(item).length} 个引用`, item.maintenance ? badge('paused', '维护锁定') : item.protected ? '已保护' : '未保护']);
    };
    const heads = { services: ['服务', '归属', '状态', '部署位置', '来源', ''], domains: ['域名', '归属', '服务', '状态', '分别观察', '观察时间'], databases: ['数据库', '归属', '版本', '源服务', '状态', '持久数据'], volumes: ['数据卷', '归属', '申请容量', '状态', '引用', '保护与维护'] }[type];
    return header(p ? `${e(p.name)} · 资源` : '所有资源', '按归属查找资源；服务移除后，保留的数据仍可独立访问。', actions + (p ? link('返回项目', api.projectUrl(p, '', ctx.params.get('env') || p.lastEnvironmentId), 'back') : '')) + tabs(['services', 'domains', 'databases', 'volumes'].map((key) => [key, { services: '服务', domains: '域名', databases: '数据库', volumes: '持久卷' }[key], queryHref('resources', { type: key, status: '', page: '' }, ctx)]), type) + filters(ctx, { projects: true, statuses, placeholder: `搜索${name}` }) + pageList(rows, ctx, renderRow, heads, `没有匹配的${name}`) + (type === 'volumes' ? notice('申请容量是存储请求值。local-path 不代表硬配额，也不自动跨节点迁移。') : '') + (type === 'domains' ? `<div class="mg-actions">${planButton('F33', '自定义域名 / Cloudflare')}${planButton('F34', '公网 TCP')}</div><p class="mg-planned">增强网络为 P1 规划演示。</p>` : '');
  }
  function projectEnvironmentFields(d, fixed = false) {
    const project = state.projects.find((p) => p.id === d.projectId);
    return `<div class="mg-two">${field('项目', 'projectId', d.projectId || '', { choices: [['', '选择项目'], ...state.projects.map((p) => [p.id, p.name])], required: true, readonly: fixed })}${field('环境', 'environmentId', d.environmentId || '', { choices: [['', '选择环境'], ...(project?.environments || []).map((env) => [env.id, `${env.name} · ${env.slug}`])], required: true, readonly: fixed })}</div>`;
  }
  function volumeForm(d) {
    return form('volume-create', field('数据卷名称', 'name', d.name || '', { required: true }) + projectEnvironmentFields(d) + `<div class="mg-two">${field('申请容量 / GiB', 'sizeGiB', d.sizeGiB || 5, { type: 'number', required: true, min: 1, max: 1024 })}${field('StorageClass', 'storageClass', d.storageClass || 'local-path', { choices: [['local-path', 'local-path']], required: true })}</div>${check('开启防销毁保护', 'protected', d.protected || false)}${notice('创建后需要独立挂载到同环境服务，再部署草稿。创建卷本身不会启动服务。')}`, '创建数据卷', closeButton());
  }
  function volumePage(ctx) {
    const v = state.volumes.find((item) => item.id === ctx.id);
    if (!v) return missing('数据卷', '#/resources?type=volumes');
    const tab = ctx.params.get('tab') === 'manual' ? 'maintenance' : ctx.params.get('tab') || 'overview';
    let body;
    if (tab === 'maintenance') body = maintenancePanel(v, ctx);
    else if (tab === 'records') body = recordsPanel(v, ctx);
    else body = section('持久数据', facts([['归属', scope(v)], ['源服务', serviceLink(v.serviceId, 'data')], ['部署集群', textLink(target(v).name || '目标已移除', `#/cluster/${target(v).id}`)], ['PVC / PV', `<code>${e(v.pvc || '尚未观察')}</code><br /><code>${e(v.pv || '等待使用方调度后绑定')}</code>`], ['申请容量 / StorageClass', `${v.sizeGiB || v.capacity} GiB / ${e(v.storageClass)}`], ['实际节点 / 回收策略', `${e(v.node || '尚未绑定')} / Retain`], ['数据身份', v.databaseId ? textLink(state.databases.find((db) => db.id === v.databaseId)?.name || '数据库', `#/database/${v.databaseId}`) : '普通文件'], ['观察时间', date(v.observedAt)]])) + section('挂载与引用', table(['服务', '草稿', '已发布', '在途任务', '实际观察', ''], volumeRefs(v).map((r) => row([serviceLink(r.service.id, 'data'), r.draft ? `<code>${e(r.draft.path)}</code>${r.draft.readOnly ? ' · 只读' : ' · 可写'}` : '无', r.published ? `<code>${e(r.published.path)}</code>` : '无', r.pending.length ? r.pending.map((t) => textLink(t.name, `#/task/${t.id}`)).join('<br />') : '无', r.actual ? '仍有引用' : '无已观察引用', r.draft ? btn('移除挂载草稿', 'volume-unmount', { id: v.id, small: true, extra: ` data-service="${e(r.service.id)}"` }) : ''])), '这个卷没有服务引用') + notice('保存或移除挂载只修改服务草稿。已发布与实际挂载会保留到部署成功后。'), btn('挂载到服务', 'volume-mount', { id: v.id, primary: true, disabled: Boolean(v.maintenance) })) + section('保护与销毁', facts([['保留状态', v.retained ? '源服务已移除，数据独立保留' : '属于当前项目与环境'], ['保护状态', v.protected ? '开启防销毁保护' : '未开启保护'], ['维护状态', v.maintenance ? badge('paused', '维护锁定') : '未进入维护']]) + `<div class="mg-actions">${btn(v.protected ? '关闭防销毁保护' : '开启防销毁保护', 'volume-protection', { id: v.id })}${btn('审查并销毁数据卷', 'volume-destroy', { id: v.id, danger: true })}</div>` + notice('销毁是独立的数据操作。任何草稿、已发布、在途、实际引用或维护锁都会阻止销毁。')) + section('最近操作', taskLinks(state.tasks.filter((t) => t.resourceId === v.id).slice(0, 5)));
    return header(e(v.name), `${scope(v)} · ${v.sizeGiB || v.capacity} GiB · ${e(v.storageClass)}`, badge(v.status) + link('数据卷列表', returnHref(ctx, 'volume', `#/resources?type=volumes&project=${v.projectId}&env=${v.environmentId}`), 'back')) + tabs([['overview', '概览与挂载', detailHref('volume', v.id, ctx)], ['maintenance', '手工备份 / 恢复', detailHref('volume', v.id, ctx, { tab: 'maintenance' })], ['records', '备份与恢复记录', detailHref('volume', v.id, ctx, { tab: 'records' })]], tab) + body;
  }
  function databasePage(ctx) {
    const db = state.databases.find((item) => item.id === ctx.id);
    if (!db) return missing('数据库', '#/resources?type=databases');
    const v = state.volumes.find((item) => item.id === db.volumeId);
    const databaseName = db.kind === 'redis' ? db.redisDatabase ?? db.databaseName : db.databaseName;
    return header(e(db.name), `${scope(db)} · ${e(db.engine)} ${e(db.version)}`, badge(db.status) + link('数据库列表', returnHref(ctx, 'database', `#/resources?type=databases&project=${db.projectId}&env=${db.environmentId}`), 'back')) + section('数据身份', facts([['数据库 ID', `<code>${e(db.identity || db.id)}</code>`], ['引擎 / 版本', `${e(db.engine)} / ${e(db.version)}`], ['初始化凭证', textLink(state.credentials.find((c) => c.id === db.credentialId)?.name || db.credentialId || '缺失', '#/settings?tab=credentials')], ['源服务', serviceLink(db.serviceId, 'data')], ['持久数据卷', v ? textLink(v.name, `#/volume/${v.id}`) : '数据卷已移除'], ['认证 / 持久化', db.kind === 'redis' ? 'AUTH 引用 · AOF everysec' : '密码引用 · 单实例 PostgreSQL']])) + section('私有连接', facts([['Host', copyField(db.host, 'Host')], ['Port', copyField(db.port, 'Port')], [db.kind === 'redis' ? 'Redis 数据库编号' : '数据库名称', copyField(databaseName, '数据库')], ['用户名', copyField(db.username, '用户名')], ['连接示意', hasValue(db.host) && hasValue(db.port) ? `<code>${db.kind === 'redis' ? 'redis' : 'postgresql'}://&lt;凭证引用&gt;@${e(db.host)}:${db.port}/${e(databaseName ?? '')}</code>` : '等待服务发布后的私有端点。']]) + notice('选择同环境应用，先核对变量映射，再保存连接草稿。发布成功后才会注入运行实例。'), btn('连接到应用', 'database-connect', { id: db.id, primary: true, disabled: !reference(db.serviceId) || !db.identity })) + section('消费者', table(['应用', '草稿变量', '已发布变量', '在途发布', ''], databaseRefs(db).map((r) => row([serviceLink(r.service.id, 'variables'), r.draft.map((c) => `<code>${e(c.variable)}</code>`).join(', ') || '无', r.published.map((c) => `<code>${e(c.variable)}</code>`).join(', ') || '无', r.pending.length ? taskLinks(r.pending) : '无', r.draft.length ? btn('移除连接草稿', 'database-disconnect', { id: db.id, small: true, extra: ` data-service="${r.service.id}"` }) : ''])), '尚无应用引用此数据库')) + section('备份与恢复', v ? `<p>手工维护与证据跟随持久数据保存，源服务移除后仍可访问。</p><div class="mg-actions">${link('手工维护与指引', `#/volume/${v.id}?tab=maintenance`)}${link('查看证据记录', `#/volume/${v.id}?tab=records`)}${planButton('F35', '自动备份与恢复')}</div>` : notice('当前没有可达的持久数据卷，请核对原任务和保留资源。', 'error')) + section('版本与迁移', '<p>密码轮换、主版本升级与跨集群迁移是独立流程，需要新目标与数据验证。</p>', planButton('F48', '查看 P2 规划'));
  }

  function domainPage(ctx) {
    const d = state.domains.find((item) => item.id === ctx.id);
    if (!d) return missing('域名绑定', '#/resources?type=domains');
    const dnsRecords = [
      ...(d.expectedAddresses || []).map((value, index) => ['预期地址 ' + (index + 1), copyField(value, '预期地址 ' + (index + 1))]),
      ...(hasValue(d.expectedCname) ? [['预期 CNAME', copyField(d.expectedCname, '预期 CNAME')]] : []),
      ...(d.addresses || []).map((value, index) => ['已观察地址 ' + (index + 1), copyField(value, '已观察地址 ' + (index + 1))]),
      ...(d.cnameChain || []).map((value, index) => ['CNAME 链 ' + (index + 1), copyField(value, 'CNAME 链 ' + (index + 1))]),
    ];
    return header(e(d.hostname), `${scope(d)} · ${date(d.observedAt)} 观察`, badge(d.status) + copyButton(d.hostname, '域名') + link('域名列表', returnHref(ctx, 'domain', `#/resources?type=domains&project=${d.projectId}&env=${d.environmentId}`), 'back')) + section('绑定', facts([['服务', serviceLink(d.serviceId, 'network')], ['已发布端口', `<code>${e(d.portName)}:${d.port}</code>`], ['部署集群', textLink(target(d).name || '目标已移除', `#/cluster/${target(d).id}`)], ['DNS 目标', copyField(d.target, 'DNS 目标')], ['证书环境', e(d.certificate || 'staging')], ['证书到期', d.expiresAt ? e(d.expiresAt) : '尚未签发']])) + (dnsRecords.length ? section('DNS 记录', facts(dnsRecords)) : '') + section('DNS、路由与 TLS', table(['检查', '观察状态', '说明', '观察时间'], [['DNS', d.dns, d.dns === 'ready' ? '解析目标与集群入口一致' : '请核对 DNS 记录与传播'], ['路由', d.route, d.route === 'ready' ? 'Ingress 指向指定服务和端口' : '需核对入口与已发布 HTTP 端口'], ['TLS', d.tls, d.tls === 'ready' ? `${d.certificate === 'production' ? '生产' : 'staging'} 证书已观察就绪` : '证书尚未观察就绪']].map(([label, status, detail]) => row([label, badge(status), detail, date(d.observedAt)]))), `<div class="mg-actions">${btn('重新检查', 'domain-check', { id: d.id })}${btn('重新应用路由', 'domain-reapply', { id: d.id })}${d.certificate !== 'production' ? btn('申请 production 证书', 'domain-production', { id: d.id, primary: true }) : ''}</div>`) + notice(d.certificate === 'production' && d.tls === 'ready' ? '当前结果对应此域名、端口与观察时间。证书和路由会随后续配置变化重新核对。' : '先确认 staging 的 DNS、路由和 TLS 均通过，再显式申请 production 证书。') + section('解除绑定', '<p>解除后清理本绑定拥有的路由与证书记录。手工 DNS 和共享集群入口仍保留。</p>', btn('审查并解除绑定', 'domain-unbind', { id: d.id, danger: true })) + section('操作记录', taskLinks(state.tasks.filter((t) => t.resourceId === d.id).slice(0, 6)));
  }

  const backupRecords = () => state.volumes.flatMap((v) => (v.records || []).filter((r) => r.type === 'backup').map((r) => ({ ...r, volume: v })));
  const engineFor = (v) => state.databases.find((db) => db.volumeId === v.id)?.kind || v.dataEngine || 'files';
  const engineLabel = (engine) => ({ postgresql: 'PostgreSQL', redis: 'Redis', files: '普通文件卷' }[engine] || engine);
  function manualGuide(v) {
    const engine = ui.drafts[`guide:${v.id}`]?.engine || engineFor(v);
    const guides = {
      postgresql: [['准备', '记录数据库身份、PostgreSQL 主版本和 pg_dump 工具版本；确认离机位置、可用空间与权限。'], ['导出', '进入备份维护并核对任务后，由操作者使用 pg_dump 自定义格式导出。原型只提供指引，不执行命令。'], ['检查', '计算完整 SHA256 与字节数；用 pg_restore --list 检查归档目录，保存退出状态、数据时间和验证证据。'], ['新目标恢复', '选择已登记且完整性通过的备份，在不同的新数据卷上进入恢复维护；操作者执行 pg_restore 后做应用数据验证。'], ['退出', '移除 helper，核对实际挂载与写入状态，再提交退出核验。登记记录不能代替执行和验证。']],
      redis: [['准备', '记录 Redis 版本、认证引用、AOF 策略与数据时间，确认源服务的持久化状态。'], ['RDB 备份', '进入维护并核对任务。操作者生成并复制 RDB，保存大小、SHA256 和离机位置；记录 Redis 工具版本。'], ['新目标导入', '使用已登记 RDB，在不同的新目标进入恢复维护。由操作者导入 RDB，启动后核对关键数量与业务数据。'], ['RDB → AOF', '显式执行 AOF 转换，核对转换完成和 AOF 文件状态，再用启用 AOF 的配置重启并复验；不能直接把 RDB 改名为 AOF。'], ['退出', '记录转换与重启证据，移除 helper，核对实际挂载和写入后提交退出核验。']],
      files: [['准备', '识别数据卷、实际节点、目录、属主权限与一致性要求；停止或冻结需要一致性的写入。'], ['归档', '进入维护后，由操作者使用归档工具导出，保存文件权限、软链接等必要元数据。归档写到不同位置。'], ['检查', '记录工具版本、格式、字节数、SHA256、执行时间、数据时间和离机位置；检查归档可读性和文件清单。'], ['新目标恢复', '选择已登记的备份，在不同的新数据卷执行解压。核对权限、关键文件和应用读取结果。'], ['退出', '移除维护 helper，核对挂载与恢复写入，记录验证证据并提交退出核验。']],
    };
    return `<div class="mg-filter-inline"><label for="mg-guide-engine">操作指引</label><select id="mg-guide-engine" data-mg-guide="${v.id}">${[['postgresql', 'PostgreSQL · pg_dump'], ['redis', 'Redis · RDB → AOF'], ['files', '文件卷归档']].map(([key, label]) => `<option value="${key}"${engine === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div><ol class="mg-steps">${guides[engine].map(([label, detail], index) => `<li class="mg-step"><span>${index + 1}</span><div><h3>${label}</h3><p>${detail}</p></div></li>`).join('')}</ol>`;
  }
  function maintenancePanel(v, ctx) {
    const m = v.maintenance;
    const t = m && (pendingFor(v.id) || state.tasks.find((task) => task.id === m.taskId));
    const phase = !m ? '未进入维护' : t?.status === 'unknown' ? '执行结果未知，保持锁定' : t?.status === 'failed' ? '任务失败，仍需退出核验' : t?.status === 'cancelled' ? '任务已取消，仍需核对实际状态' : m.status === 'active' ? '维护已就绪' : m.status === 'exiting' ? '正在核对退出' : '正在进入维护';
    return section('手工维护', facts([['状态', m ? badge('paused', phase) : phase], ['当前模式', m ? m.mode === 'restore' ? '恢复到新目标' : '备份源数据' : '—'], ['维护对象', `<code>${e(v.id)}</code>`], ['关联任务', t ? textLink(t.name, `#/task/${t.id}`) : '尚无'], ['开始时间', m ? date(m.startedAt) : '—'], ['数据类型', engineLabel(engineFor(v))]]) + (m ? notice('维护锁与任务状态分别保留。超时、未知和取消不会直接解除锁；退出前必须核对 helper 与实际挂载。') : notice('进入维护会创建独立任务。执行成功后再按下方指引由操作者导出或恢复数据。')) + `<div class="mg-actions">${!m ? btn('进入备份维护', 'maintenance-new', { id: v.id, primary: true, extra: ' data-mode="backup"' }) + btn('在此恢复已登记备份', 'maintenance-new', { id: v.id, extra: ' data-mode="restore"' }) : btn('核对并退出维护', 'maintenance-exit', { id: v.id, disabled: Boolean(t && activeStates.includes(t.status)) })}${m?.status === 'active' && t?.status === 'succeeded' ? btn(m.mode === 'restore' ? '登记恢复证据' : '登记备份证据', 'record-new', { id: v.id, extra: ` data-type="${m.mode}"`, primary: true }) : ''}</div>`) + section('操作指引', manualGuide(v)) + section('证据与历史', recordsTable(v.records || [], v, ctx), link('查看全部记录', `#/volume/${v.id}?tab=records`)) + section('自动备份与恢复向导', '<p>自动计划、对象存储、平台执行、独立数据验证与切流属于 P1 规划；手工记录不会启动这些动作。</p>', planButton('F35', '体验自动流程'));
  }
  function recordsTable(records, volume, ctx) {
    return table(['记录', '类型 / 数据版本', '结果 / 完整性', '执行时间', ''], records.map((r) => row([identity(r.backupId || r.id, `<code>${e(r.id)}</code>`), `${r.type === 'restore' ? '恢复' : '备份'} · ${engineLabel(r.engine)} ${e(r.version)}`, `${badge(r.result === 'passed' ? 'succeeded' : 'failed', r.result === 'passed' ? '已登记通过' : '已登记失败')}<small class="mg-sub">${r.integrity === 'passed' ? '完整性通过（操作者证据）' : '完整性未通过'}</small>`, date(r.finishedAt), btn('查看证据', 'record-detail', { id: r.id, small: true, extra: ` data-volume="${volume.id}"` })])), '尚未登记手工操作证据');
  }
  function recordsPanel(v, ctx) {
    return notice('这里保存操作者提交的备份与恢复证据。保存记录不执行导出、恢复或数据验证。') + section('备份与恢复记录', recordsTable(v.records || [], v, ctx), v.maintenance?.status === 'active' ? btn('登记本次维护证据', 'record-new', { id: v.id, primary: true, extra: ` data-type="${v.maintenance.mode}"` }) : link('先进入手工维护', `#/volume/${v.id}?tab=maintenance`)) + section('恢复到新目标', '<p>选择完整性已通过的备份，进入同环境的新数据卷开展恢复；源卷和现有服务保持原归属。</p><div class="mg-actions">' + btn('创建新的数据卷', 'volume-new', { extra: ` data-project="${v.projectId}" data-env="${v.environmentId}"` }) + link('选择目标卷', `#/resources?type=volumes&project=${v.projectId}&env=${v.environmentId}`) + '</div>');
  }
  function maintenanceForm(d) {
    const v = state.volumes.find((item) => item.id === d.id);
    const backups = backupRecords().filter((r) => r.volume.id !== v.id && sameScope(r.volume, v) && r.result === 'passed' && r.integrity === 'passed');
    return form('maintenance-enter', revisionInput(v) + `<input type="hidden" name="mode" value="${e(d.mode)}" />${facts([['固定目标卷', e(v.name)], ['归属', scope(v)], ['操作', d.mode === 'restore' ? '恢复到这个新目标' : '为源数据建立备份维护窗口']])}${d.mode === 'restore' ? field('已登记备份', 'recordId', d.recordId || '', { choices: [['', '选择备份'], ...backups.map((r) => [r.id, `${r.backupId} · ${r.volume.name} · ${engineLabel(r.engine)} ${r.version}`])], required: true, hint: '只列出同环境、不同源卷、结果与完整性通过的备份。' }) : ''}${notice(d.mode === 'restore' ? '目标必须没有服务引用、维护锁和已有数据身份。源卷不会被覆盖；数据导入由操作者按指引执行。' : '进入维护时将核对并冻结相关写入，准备维护 helper。任务受理不等于可开始导出。')}${check('已核对维护对象、服务影响与离机备份位置', 'ack', d.ack)}`, '确认并创建维护任务', closeButton());
  }
  function recordForm(d) {
    const v = state.volumes.find((item) => item.id === d.volumeId);
    const m = v.maintenance;
    const source = m?.mode === 'restore' ? backupRecords().find((r) => r.id === m.recordId) : null;
    const engine = source?.engine || engineFor(v);
    const db = state.databases.find((item) => item.volumeId === (source?.volume.id || v.id));
    const formats = engine === 'postgresql' ? [['pg-custom', 'pg_dump 自定义格式']] : engine === 'redis' ? [['redis-rdb', 'RDB'], ['redis-aof', 'AOF（转换与重启已验证）']] : [['tar', 'tar 归档'], ['tar-zstd', 'tar + zstd 归档']];
    return form('record-save', `<input type="hidden" name="volumeId" value="${e(v.id)}" /><input type="hidden" name="maintenanceId" value="${e(m?.id || '')}" /><input type="hidden" name="type" value="${e(m?.mode || 'backup')}" />${facts([['本次模式', m?.mode === 'restore' ? '登记新目标恢复证据' : '登记手工备份证据'], ['源 / 目标', source ? `${e(source.volume.name)} → ${e(v.name)}` : `${e(v.name)} → 离机归档`], ['数据类型', engineLabel(engine)]])}${field('备份 ID', 'backupId', source?.backupId || d.backupId || '', { required: true, readonly: Boolean(source), hint: source ? '固定引用已登记的源备份，不能改用其他备份。' : '用于后续恢复时明确引用这份备份。' })}<div class="mg-two">${field('引擎版本', 'version', source?.version || d.version || db?.version || '', { required: true })}${field('格式', 'format', d.format || source?.format || formats[0][0], { choices: formats, required: true })}</div>${field('工具及版本', 'toolVersion', d.toolVersion || '', { required: true, placeholder: engine === 'postgresql' ? 'pg_dump / pg_restore，与目标数据库版本匹配' : engine === 'redis' ? 'redis-cli / redis-check-rdb，与目标版本匹配' : 'GNU tar 1.35' })}<div class="mg-two">${field('文件大小 / 字节', 'sizeBytes', d.sizeBytes || source?.sizeBytes || '', { type: 'number', required: true, min: 1 })}${field('SHA256', 'sha256', d.sha256 || source?.sha256 || '', { required: true, pattern: '[a-fA-F0-9]{64}' })}</div><div class="mg-two">${field('执行开始时间', 'startedAt', d.startedAt || '', { type: 'datetime-local', required: true })}${field('执行结束时间', 'finishedAt', d.finishedAt || '', { type: 'datetime-local', required: true })}</div>${field('数据截至时间', 'dataAt', d.dataAt || '', { type: 'datetime-local', required: true })}${field('离机存放位置（不含访问密钥）', 'location', d.location || source?.location || '', { required: true, placeholder: 's3://backup-demo/ozz/example.dump' })}<div class="mg-two">${field('完整性检查', 'integrity', d.integrity || '', { choices: [['', '选择结果'], ['passed', '通过'], ['failed', '未通过']], required: true })}${field('本次操作结果', 'result', d.result || '', { choices: [['', '选择结果'], ['passed', '通过'], ['failed', '失败']], required: true })}</div>${field('验证方法与结果', 'verification', d.verification || '', { area: true, required: true, placeholder: source ? '恢复后数据计数、业务抽样、Redis AOF 转换与重启核对等。' : '校验和核对、归档清单、工具退出状态等。' })}${field('证据位置或摘要', 'evidence', d.evidence || '', { area: true, required: true, hint: '登记操作者已经完成的检查；不要粘贴密码、令牌或私钥。' })}${check('我确认这些字段是操作与验证证据，保存不会执行备份或恢复', 'ack', d.ack)}${notice('原型只登记演示证据，不读取文件、不执行命令、不判断实际数据是否正确。')}`, '保存证据记录', btn('填入演示证据', 'record-sample', { subtle: true }) + closeButton());
  }

  function activityPage(ctx) {
    const tab = ctx.params.get('tab') || 'deployments';
    const list = tab === 'events' ? state.gitEvents.map((t) => ({ ...t, name: `${t.repository} ${t.commit}`, environmentId: t.environmentId || reference(t.serviceId)?.service.environmentId })) : state.tasks.filter((t) => t.kind === (tab === 'operations' ? 'operation' : 'deployment'));
    const items = state.scenario === 'empty' ? [] : filtered(list, ctx);
    const serviceOptions = api.allServices().filter((s) => (!ctx.params.get('project') || s.projectId === ctx.params.get('project')) && (!ctx.params.get('env') || s.environmentId === ctx.params.get('env')));
    return header('活动与任务', '按固定项目、环境与资源追踪每一次发布和操作。', link('平台状态', '#/settings?tab=platform')) + tabs([['deployments', '发布', '#/activity?tab=deployments'], ['operations', '资源操作', '#/activity?tab=operations'], ['events', 'Git 事件', '#/activity?tab=events']], tab) + filters(ctx, { projects: true, statuses: tab === 'events' ? [['succeeded', '已接收'], ['ignored', '已忽略'], ['rejected', '已拒绝']] : [['queued', '排队'], ['running', '执行中'], ['succeeded', '成功'], ['failed', '失败'], ['cancelling', '取消待确认'], ['cancelled', '已取消'], ['unknown', '结果未知']] }) + `<div class="mg-filter-inline"><label for="mg-filter-service">服务</label><select id="mg-filter-service" data-mg-filter="service"><option value="">所有服务</option>${serviceOptions.map((s) => `<option value="${s.id}"${ctx.params.get('service') === s.id ? ' selected' : ''}>${e(s.project.name)} / ${e(s.draft.name)}</option>`).join('')}</select></div>` + pageList(items, ctx, (t) => tab === 'events' ? row([identity(t.repository, `${e(t.branch)} · <code>${e(t.commit)}</code>`), serviceLink(t.serviceId, 'deployments'), badge(t.status), e(t.outcome), date(t.createdAt), btn('投递详情', 'git-event', { id: t.id, small: true })]) : row([textLink(t.name, `#/task/${t.id}`), scope(t), t.serviceId ? serviceLink(t.serviceId, 'deployments') : resourceLink(t), badge(t.status), date(t.createdAt), link('详情', `#/task/${t.id}`)]), tab === 'events' ? ['仓库 / 提交', '服务', '接收状态', '结果', '接收时间', ''] : ['任务', '归属', '资源', '状态', '创建时间', ''], '还没有匹配的活动记录') + (tab === 'events' ? notice('拒绝或忽略的事件保留原因，不创建虚假的部署记录。停止服务的合法新提交只进入待发布。') : '') + section('告警与通知', '<p>运行事件与失败任务可在当前记录查看。告警规则、通知目标与独立投递重试属于 P1 规划。</p>', planButton('F38', '体验告警流程'));
  }
  function resourceLink(t) {
    const id = t.resourceId || t.targetId;
    const collections = [['volumes', 'volume'], ['domains', 'domain'], ['servers', 'server'], ['clusters', 'cluster'], ['databases', 'database']];
    for (const [collection, route] of collections) {
      const item = state[collection].find((v) => v.id === id);
      if (item) return textLink(item.name || item.hostname, `#/${route}/${id}`);
    }
    const integration = state.integrations.find((v) => v.id === id);
    if (integration) return textLink(integration.name, `#/settings?tab=git&kind=${integration.kind}`);
    if (id === 'platform') return textLink('控制面', '#/settings?tab=platform');
    return `<span class="mg-muted">${e(id || '平台操作')}${id ? '（原对象可能已移除）' : ''}</span>`;
  }
  function taskPage(ctx) {
    const t = state.tasks.find((item) => item.id === ctx.id);
    if (!t) return missing('任务记录', '#/activity');
    const active = ['queued', 'running'].includes(t.status);
    const actions = active ? btn('请求取消', 'task-cancel', { id: t.id }) : t.status === 'failed' || t.status === 'cancelled' ? btn('创建独立重试', 'task-retry', { id: t.id, primary: true }) : t.status === 'unknown' ? btn('核对原任务结果', 'task-reconcile', { id: t.id, primary: true }) : '';
    const logTab = ctx.params.get('output') || 'all';
    return header(e(t.name), `${t.kind === 'deployment' ? 'Deployment' : 'Operation'} · ${e(t.id)}`, badge(t.status) + actions + link('活动列表', `#/activity?tab=${t.kind === 'deployment' ? 'deployments' : 'operations'}${t.projectId ? `&project=${t.projectId}` : ''}${t.environmentId ? `&env=${t.environmentId}` : ''}`)) + (t.status === 'unknown' ? notice('结果未知时保持原请求与固定目标，不能直接重试。先核对原任务，保留远端完成证据与资源版本。', 'error') : t.status === 'cancelling' ? notice('取消请求已记录，正在等待执行器确认。已发生的操作不会在此提前回滚。') : '') + section('执行阶段', `<ol class="mg-timeline">${(t.stages || []).map((stage, index) => `<li class="${e(stage.status)}"><span>${stage.status === 'succeeded' ? icon('check') : index + 1}</span><div><strong>${e(stage.name)}</strong>${badge(stage.status)}</div></li>`).join('')}</ol>`) + `<div class="mg-two">${section('固定对象', facts([['项目 / 环境', scope(t)], ['资源', t.serviceId ? serviceLink(t.serviceId, 'deployments') : resourceLink(t)], ['部署目标', t.targetId ? textLink(state.clusters.find((c) => c.id === t.targetId)?.name || state.servers.find((s) => s.id === t.targetId)?.name || t.targetId, state.servers.some((s) => s.id === t.targetId) ? `#/server/${t.targetId}` : state.clusters.some((c) => c.id === t.targetId) ? `#/cluster/${t.targetId}` : '#/settings?tab=platform') : '控制面'], ['创建 / 完成', `${date(t.createdAt)} / ${t.finishedAt ? date(t.finishedAt) : '尚未完成'}`], ['重试来源', t.attemptOf ? textLink(t.attemptOf, `#/task/${t.attemptOf}`) : '初次请求']]))}${section('执行结果', `<p>${e(t.error || t.result || '任务尚未给出终态。')}</p>${t.reconciliation ? notice(e(t.reconciliation)) : ''}${t.targetInstance ? facts([['目标实例', e(t.targetInstance)], ['观察时间', date(t.finishedAt)]]) : ''}`)}</div>` + section('执行输出', tabs([['all', '全部输出', queryHref(`task/${t.id}`, { output: 'all' }, ctx)], ['build', '构建 / 推送', queryHref(`task/${t.id}`, { output: 'build' }, ctx)], ['runtime', '部署 / 操作', queryHref(`task/${t.id}`, { output: 'runtime' }, ctx)]], logTab) + (t.logsExpired ? notice('本任务输出已超过演示留存时间；任务结果与快照仍保留。') : logTab === 'build' && t.source !== 'git' ? notice('此任务没有 Git 构建与推送阶段。镜像部署直接解析固定镜像。') : api.taskLogPanel(t, logTab))) + section('固定请求快照', `<details class="mg-snapshot"><summary>查看配置、输入与数据引用</summary><pre>${e(JSON.stringify(t.snapshot || {}, null, 2))}</pre></details><p class="mg-muted">快照只记录安全输入与凭证引用，不记录秘密原文。后续编辑不会改写旧任务。</p>`);
  }

  function projectSettingsPage(ctx) {
    const p = ctx.project;
    if (!p) return missing('项目', '#/projects');
    const d = draftFor('project-save', p);
    const envRows = p.environments;
    const environments = pageList(envRows, ctx, (env) => row([identity(env.name, e(env.description || '')), `<code>${e(env.slug)}</code>${ctx.environment?.id === env.id ? '<small class="mg-sub">当前环境</small>' : ''}`, `${p.services.filter((s) => s.environmentId === env.id).length} / ${state.volumes.filter((v) => v.environmentId === env.id && v.projectId === p.id).length}`, `<div class="mg-actions">${btn('切换', 'environment-switch', { id: env.id, small: true })}${btn('编辑', 'environment-edit', { id: env.id, small: true })}${btn('删除', 'environment-remove', { id: env.id, small: true, danger: true })}</div>`]), ['环境', '稳定标识', '服务 / 数据卷', '操作'], '当前项目没有环境');
    const body = form('project-save', revisionInput(d) + `<div class="mg-two">${field('项目名称', 'name', d.name, { required: true })}${field('稳定标识', 'slug', d.slug, { readonly: true, hint: '创建后保留，普通资料编辑不会改变命名空间。' })}</div>${field('描述', 'description', d.description || '', { area: true })}${facts([['部署位置', textLink(api.targetFor(p).name, `#/cluster/${api.targetFor(p).id}`)], ['已载入版本', `r${d.revision || 1}`]])}`, '保存项目资料', btn('加载最新', 'project-reload', { id: p.id }));
    return header('项目设置', `${e(p.name)} · 资料、环境与项目范围`, link('返回服务', api.projectUrl(p, '', ctx.environment?.id), 'back')) + section('项目资料', body) + section('环境', notice('环境组织同一项目下的一组服务、变量、域名与数据。默认 production 已自动创建；只有一个环境时，日常页面不显示切换器。') + environments, btn('添加环境', 'environment-new', { id: p.id, primary: true })) + section('导入、导出与配置复制', '<p>复制配置不复制秘密值、数据库数据或运行状态。目标映射与部分失败会在预览中明确显示。</p><div class="mg-actions">' + planButton('F39', '项目导入 / 导出 / 复制') + planButton('F40', '环境差异与复制') + '</div><p class="mg-planned">P1 规划演示</p>') + section('删除项目', '<p>只有没有服务、数据卷、数据库、域名和活动任务的项目可以删除。production 不能单独删除。</p>', btn('审查并删除项目', 'project-remove', { id: p.id, danger: true }));
  }
  function projectIntegrationsPage(ctx) {
    const p = ctx.project;
    const uses = state.integrations.map((i) => ({ integration: i, services: p.services.filter((s) => s.draft.source === 'git' && [s.draft.gitConnection, s.draft.registry, s.draft.builder].includes(i.id)) })).filter((r) => r.services.length);
    return header('整合', `${e(p.name)} 当前服务所用的源码与构建连接`, link('管理全局连接', '#/settings?tab=git')) + section('项目正在使用', table(['连接', '用途', '状态', '关联服务', ''], uses.map(({ integration: i, services }) => row([e(i.name), { github: 'GitHub 源码', registry: '镜像推送 / 拉取', builder: '远程构建' }[i.kind], badge(i.status), services.map((s) => serviceLink(s.id, 'settings')).join('<br />'), btn('连接详情', 'integration-detail', { id: i.id, small: true })])), '这个项目尚未使用 Git 构建集成')) + notice('连接在全局维护，项目根据服务配置引用。添加或修改连接后，需要在对应服务保存来源配置并明确部署。') + section('相关活动', taskLinks(state.tasks.filter((t) => t.projectId === p.id && t.source === 'git').slice(0, 5)), link('查看 Git 事件', `#/activity?tab=events&project=${p.id}`)) + section('项目自动化', '<div class="mg-actions">' + planButton('F29', 'Monorepo 路径规则') + planButton('F38', '告警与通知') + planButton('F42', 'CLI 与 API Token') + '</div><p class="mg-planned">P1 规划演示</p>');
  }

  const features = [
    ['F26', '变量引用与依赖', '已有同环境数据库连接；规划通用输出、构建 / 运行期、秘密传播与依赖检查。'],
    ['F27', '配置文件', '文本 / 秘密文件、权限与路径冲突、差异和发布。'],
    ['F28', '模板仓库与组合模板', '已有五个内置模板；规划仓库版本、组合组件、依赖和定向重试。'],
    ['F29', 'Monorepo', '已有 Dockerfile 与上下文；规划监听路径、共享目录与无关推送跳过。'],
    ['F30', '自动构建', '已有 Dockerfile 构建；规划语言识别、锁文件冲突、命令覆盖与降级。'],
    ['F31', '历史镜像回滚', '已有固定输入重试与原版本恢复；规划历史 digest、可信快照和数据保护。'],
    ['F32', '容器终端', '固定 Pod / container、权限、超时、断开与结束会话。'],
    ['F33', '自定义域名与 DNS', '已有默认域名与解绑；规划多域名、Cloudflare、所有权和记录冲突。'],
    ['F34', '公网 TCP', '已有私有端口；规划公网分配、防火墙、冲突与撤销观察。'],
    ['F35', '自动备份与恢复', '已有手工维护和证据；规划计划、对象存储、自动恢复、数据验证与切流。'],
    ['F36', '历史指标', '已有即时观察；规划时间范围、采样缺口、外部存储与留存。'],
    ['F37', '历史日志', '已有有界实例日志；规划检索、下载、集中留存与存储容量。'],
    ['F38', '告警与通知', '已有运行 / Git / 任务事件；规划规则、持续与冷却、独立通知投递。'],
    ['F39', '项目声明配置', '已有项目资料；规划导入、导出、复制、目标映射与部分失败。'],
    ['F40', '环境差异与隔离', '已有环境归属；规划配置差异、引用重绑和网络隔离能力核对。'],
    ['F41', '节点维护', '已有节点观察；规划加入、排空、恢复调度、移除与本地数据保护。'],
    ['F42', '用户 CLI 与 API Token', '已有 OpenAPI / 运维 CLI；规划 Token、上下文、非交互命令与撤销。'],
    ['F43', '文件管理', '容器临时文件、PVC 与配置文件分开，浏览、传输、冲突与删除。'],
    ['F44', '主机 Web SSH', 'Server 指纹与维护会话，独立于容器终端；浏览器不获取私钥。'],
    ['F45', 'AI 与知识库', '显式文档导入、部署计划与日志证据，流式响应、取消和独立运行记录。'],
    ['F46', 'PR 预览', '继承目标、可信来源与秘密、TTL 与配额、更新和关闭清理。'],
    ['F47', '本地源码上传', '归档、排除、大小与 hash，上传、取消与独立构建。'],
    ['F48', '迁移与数据库维护', '新目标与映射、备份恢复、验证、停写切流与回退；升级和轮换单独确认。'],
    ['F49', '高级路由与 IP 规则', '条件、优先级、匹配测试、影响预览和撤回。'],
    ['F50', '无状态 HPA', '上下限、指标、配额与容量；数据库和本地写入卷有明确保护。'],
  ];
  function planningPage(ctx) {
    const phase = ctx.params.get('phase') === 'p2' ? 'p2' : 'p1';
    const list = features.filter(([id]) => phase === 'p2' ? Number(id.slice(1)) >= 43 : Number(id.slice(1)) < 43).filter((item) => !ctx.params.get('q') || item.join(' ').toLowerCase().includes(ctx.params.get('q').toLowerCase()));
    return header('产品规划', '完整体验参数、影响预览、执行阶段和演示结果；所有规划记录与现有资源独立保存。') + tabs([['p1', 'P1 · 近期能力', '#/planning?phase=p1'], ['p2', 'P2 · 未来概念', '#/planning?phase=p2']], phase) + filters(ctx, { placeholder: '搜索功能或编号' }) + `<div class="mg-feature-grid">${list.map(([id, name, detail]) => `<article class="mg-feature"><div><span class="mg-planned">${id} · ${phase.toUpperCase()}</span><h2>${e(name)}</h2><p>${e(detail)}</p></div>${planButton(id, '打开交互流程', { small: true })}</article>`).join('') || '<p class="mg-empty">没有匹配的规划能力。</p>'}</div>` + section('规划演示记录', table(['功能', '记录', '状态', '开始时间', ''], state.planningRuns.slice(0, 12).map((run) => row([e(features.find(([id]) => id === run.featureId)?.[1] || run.featureId), `<code>${e(run.id)}</code>${run.attemptOf ? `<small class="mg-sub">重试自 ${e(run.attemptOf)}</small>` : ''}`, badge(run.status), date(run.createdAt), btn('查看参数与结果', 'plan-record', { id: run.id, small: true })])), '尚未运行规划演示'));
  }

  function finishForm(name, id = '', href, text) {
    delete ui.drafts[draftKey(name, id)]; delete ui.formErrors[name]; ui.dialog = null;
    api.closeModal(); if (href) api.goto(href); if (text) api.notify(text);
  }
  function confirmWrite(options) {
    if (blockWrite()) return;
    const callback = options.onConfirm;
    const pendingLabel = { '删除凭证': '正在删除凭证…', '申请 production 证书': '正在提交证书申请…', '解除域名绑定': '正在提交解绑…', '安装证书组件': '正在受理安装…' }[options.title];
    api.confirm({ pendingLabel, ...options, onConfirm: () => { if (!blockWrite()) callback(); } });
  }
  const formOf = (el) => el?.closest('form');
  const getVolume = (id) => state.volumes.find((v) => v.id === id);
  const getDatabase = (id) => state.databases.find((db) => db.id === id);
  function verifyCredential(id, kind) {
    const cred = state.credentials.find((c) => c.id === id);
    return Boolean(cred && !credentialExpired(cred) && (!kind || (Array.isArray(kind) ? kind.includes(cred.kind) : cred.kind === kind)));
  }
  function scopeFrom(d, formElement) {
    const project = state.projects.find((p) => p.id === d.projectId);
    const environment = project?.environments.find((env) => env.id === d.environmentId);
    if (!project || !environment) { error(formElement, '请明确选择属于该项目的环境。无效环境不会自动切到 production。'); return null; }
    return { project, environment, cluster: api.targetFor(project) };
  }
  function editableService(s, formElement) {
    if (!s) { error(formElement, '服务已移除，请重新选择。'); return false; }
    if (state.serviceEdits?.[s.id] && JSON.stringify(state.serviceEdits[s.id]) !== JSON.stringify(s.draft)) { error(formElement, '此服务还有未保存的本地编辑。请先回到服务保存或取消，再修改引用。'); return false; }
    if (pendingFor(s.id)) { error(formElement, '此服务还有执行中或结果未知的任务，请先核对原任务。'); return false; }
    return true;
  }
  function commitServiceDraft(s) {
    bump(s); s.configurationState = s.publishedSnapshot ? 'pending' : 'draft';
    if (!s.publishedSnapshot) s.status = 'draft';
    if (state.serviceEdits?.[s.id]) state.serviceEdits[s.id] = copy(s.draft);
    api.syncReferences?.();
  }
  function canDestroyVolume(v) {
    if (!v) return '数据卷已移除。';
    if (v.maintenance) return '数据卷处于维护锁定中，请先通过退出核验。';
    if (v.protected) return '数据卷开启了防销毁保护，请先明确关闭保护。';
    if (volumeRefs(v).length) return '仍有草稿、已发布、在途或实际挂载引用。请逐项解除并部署后重新观察。';
    if (state.databases.some((db) => db.volumeId === v.id && databaseRefs(db).length)) return '此卷的数据身份仍被应用引用，请先移除连接并部署。';
    if (pendingFor(v.id)) return '此卷还有执行中或结果未知的任务。';
    return '';
  }
  function publishedHttpPorts(service) {
    const config = service?.publishedSnapshot;
    if (!config || config.type === 'database') return [];
    const ports = config.port && config.expose === 'http' ? [{ name: config.portName || 'http', port: Number(config.port) }] : [];
    return [...ports, ...(config.ports || []).filter((p) => p.expose === 'http').map((p) => ({ name: p.name, port: Number(p.port) }))].filter((p, index, items) => p.name && Number.isInteger(p.port) && p.port > 0 && p.port <= 65535 && items.findIndex((item) => item.name === p.name) === index);
  }
  function domainPrerequisite(d) {
    const found = reference(d.serviceId);
    if (!found || !found.service.publishedSnapshot) return '需要仍存在且已成功发布的服务。';
    const ports = publishedHttpPorts(found.service);
    if (!ports.length) return '默认域名只支持已发布并明确标为 HTTP 的端口，不会自动公开私有端口。';
    if (d.portName && !ports.some((p) => p.name === d.portName && (d.port == null || Number(d.port) === p.port))) return '固定的已发布 HTTP 端口已变化，请重新核对绑定。';
    const cluster = api.targetFor(found.project);
    if (cluster.status !== 'ready') return '部署集群尚未验证或已失联，请先核对连接。';
    if (!cluster.capabilities?.ingress || !cluster.capabilities?.certificate) return '需要 HTTP 入口与 cert-manager 能力，请在集群连接与能力中补齐。';
    if (!cluster.entryAddress || !cluster.suffix || !state.platform.suffix || !(cluster.email || state.platform.email)) return '缺少集群入口地址、域名后缀或 ACME 邮箱。';
    return '';
  }
  function integrationDetail(item, ctx) {
    const referenced = api.allServices().filter((s) => s.draft.source === 'git' && [s.draft.gitConnection, s.draft.registry, s.draft.builder, s.publishedSnapshot?.gitConnection, s.publishedSnapshot?.registry, s.publishedSnapshot?.builder].includes(item.id));
    const credential = state.credentials.find((c) => c.id === item.credentialId);
    const detail = facts([['连接 ID', `<code>${e(item.id)}</code>`], ['地址', `<code>${e(item.endpoint)}</code>`], ['状态', badge(item.enabled === false ? 'paused' : item.status)], ['凭证引用', textLink(credential?.name || item.credentialId, '#/settings?tab=credentials')], ...(item.kind === 'registry' ? [['拉取凭证', textLink(state.credentials.find((c) => c.id === item.pullCredentialId)?.name || item.pullCredentialId, '#/settings?tab=credentials')]] : []), ...(item.kind === 'builder' ? [['实例 / 配置 / 架构', `${e(item.instanceId)} / r${item.profileRevision || 1} / linux/${e(item.platform)}`], ['BuildKit / frontend', `${e(item.profile?.buildkitVersion || item.buildkitVersion)}<br /><code>${e(item.profile?.frontendDigest || item.frontendDigest)}</code>`], ['签名公钥', `<pre class="mg-inline-code">${e(item.identityPublicKey)}</pre>`], ['接受新构建', item.enabled === false ? '已停用' : '已启用']] : []), ['最后验证', date(item.observedAt)]]) + (item.validation ? notice(e(item.validation), item.status === 'failed' ? 'error' : 'success') : notice('连接尚未给出验证结果。')) + `<div class="mg-actions">${btn('编辑连接', 'integration-edit', { id: item.id })}${btn('验证连接', 'integration-verify', { id: item.id, primary: true })}${item.kind === 'github' ? btn('仓库与分支', 'github-repositories', { id: item.id }) + btn(item.webhook ? '更新 Webhook 注册' : '注册 Webhook', 'webhook-edit', { id: item.id }) : ''}</div>` + section('关联服务', referenced.length ? referenced.map((s) => serviceLink(s.id, 'settings')).join('<br />') : '<p class="mg-muted">尚未发现显式引用此连接的服务。</p>') + section('验证记录', taskLinks(state.tasks.filter((t) => t.resourceId === item.id).slice(0, 5)));
    const observations = item.kind === 'registry' ? section('推送与拉取分别验证', facts([['固定镜像范围', `<code>${e(item.authority || item.endpoint)}/${e(item.namespace || '')}</code>`], ['构建推送', badge(item.pushVerification?.status || 'unverified')], ['运行拉取 / 只读权限', badge(item.pullVerification?.status || 'unverified')], ['最近检查时间', date(item.pushVerification?.observedAt || item.observedAt)]])) : item.kind === 'builder' ? section('已观察构建能力', facts([['平台', item.capabilities ? `linux/${e(item.capabilities.architecture)}` : '尚未分别核对'], ['最大并发', item.capabilities?.maxConcurrency ?? '尚未观察'], ['Builder / 控制面代际', item.capabilities ? `${item.capabilities.highGeneration} / ${item.capabilities.controlPlaneGenerationAtCheck}` : '尚未观察']])) : '';
    ui.dialog = null; api.openModal({ title: item.name, body: detail + observations, wide: true, footer: btn('关闭', 'close') });
  }
  function openCredentialDetail(c, ctx) {
    const refs = credentialRefs(c.id);
    openDialog('credential-meta', c, ctx, (d) => facts([['凭证 ID', `<code>${e(c.id)}</code>`], ['类型 / 状态', `${e(kindName(c.kind))} · ${badge(credentialExpired(c) ? 'expired' : 'ready', credentialExpired(c) ? '已到期' : '有效')}`], ['秘密内容', '保存后不可读回']]) + form('credential-meta', revisionInput(d) + field('名称', 'name', d.name, { required: true }) + field('到期日期', 'expiresAt', d.expiresAt || '', { type: 'date' }) + field('说明', 'description', d.description || '', { area: true }), '保存元数据') + section('使用方', refs.length ? `<div class="mg-link-list">${refs.map(([label, href]) => textLink(label, href)).join('')}</div>` : '<p>当前没有引用。</p>') + `<div class="mg-actions">${btn('创建替换凭证', 'credential-replace', { id: c.id })}${btn('删除凭证', 'credential-remove', { id: c.id, danger: true })}</div>`, c.name);
  }
  function rebindCandidates(id) {
    const refs = [];
    const add = (type, entity, key, label) => { if (entity[key] === id) refs.push({ key: `${type}:${entity.id}:${key}`, type, entity, field: key, label }); };
    state.servers.forEach((s) => add('server', s, 'credentialId', `服务器 ${s.name}`));
    state.clusters.forEach((c) => add('cluster', c, 'credentialId', `集群 ${c.name}`));
    state.integrations.forEach((i) => ['credentialId', 'pullCredentialId', 'webhookCredentialId'].forEach((key) => add('integration', i, key, `${i.name} · ${key === 'pullCredentialId' ? '拉取' : key === 'webhookCredentialId' ? 'Webhook' : '连接'}`)));
    api.allServices().forEach((entry) => {
      const s = reference(entry.id).service;
      if (s.draft.credentialId === id) refs.push({ key: `service:${s.id}:credentialId`, type: 'service', entity: s, target: s.draft, field: 'credentialId', label: `服务 ${s.draft.name} · 拉取草稿` });
      (s.draft.variables || []).forEach((v, index) => ['credentialId', 'secretRefId'].forEach((key) => { if (v[key] === id) refs.push({ key: `variable:${s.id}:${index}:${key}`, type: 'service', entity: s, target: v, field: key, label: `服务 ${s.draft.name} · 变量 ${v.key}` }); }));
      (s.draft.variables || []).forEach((v, index) => { if (v.mode === 'reference' && v.value === id) refs.push({ key: `variable:${s.id}:${index}:value`, type: 'service', entity: s, target: v, field: 'value', label: `服务 ${s.draft.name} · 变量 ${v.key}` }); });
    });
    return refs;
  }
  function rebindForm(d) {
    const before = state.credentials.find((c) => c.id === d.oldId);
    const after = state.credentials.find((c) => c.id === d.newId);
    const refs = rebindCandidates(d.oldId);
    return form('credential-rebind', `<input type="hidden" name="oldId" value="${e(d.oldId)}" /><input type="hidden" name="newId" value="${e(d.newId)}" />${facts([['原凭证', e(before?.name || d.oldId)], ['新凭证', e(after?.name || d.newId)]])}${refs.map((r) => check(e(r.label), `ref:${r.key}`, Boolean(d[`ref:${r.key}`]))).join('') || notice('没有可直接切换的配置引用。')} ${notice('切换后，服务器与集成需要分别重验；服务引用进入草稿，部署后才生效。原已发布引用仍保留。初始化数据库密码需要独立轮换流程，不能通过改引用完成。')}`, '切换选定引用', closeButton());
  }
  function kubeconfigForm(d) {
    return form('cluster-parse', `<input type="hidden" name="id" value="${e(d.id || '')}" /><input type="hidden" name="revision" value="${d.revision || 1}" />${field('集群名称', 'name', d.name || '', { required: true })}${field('kubeconfig', 'kubeconfig', '', { secret: true, area: true, rows: 8, required: true, hint: '请使用演示内容。配置只在当前输入框中解析，秘密不会进入状态或任务记录。' })}${d.id ? field('演示观察到的 kube-system UID', 'observedIdentity', d.observedIdentity || d.identity || '', { required: true, hint: '用于演示同身份校验。变更为其他 UID 会被拒绝，不会重定向已有项目。' }) : ''}${notice('只接受 HTTPS、内嵌 CA 与静态令牌 / 内嵌客户端证书。拒绝 exec、外部文件、代理和跳过 TLS 验证。')}`, '解析并预览连接', btn('填入演示 kubeconfig', 'kubeconfig-sample', { subtle: true }) + closeButton());
  }
  function connectionForm(d) {
    const db = getDatabase(d.databaseId);
    const applications = api.allServices().filter((s) => s.id !== db.serviceId && s.projectId === db.projectId && s.environmentId === db.environmentId && s.draft.type !== 'database');
    return form('database-preview', `<input type="hidden" name="databaseId" value="${e(db.id)}" />${field('同环境应用', 'serviceId', d.serviceId || '', { choices: [['', '选择应用'], ...applications.map((s) => [s.id, s.draft.name])], required: true })}${field('注入变量名', 'variable', d.variable || (db.kind === 'redis' ? 'REDIS_URL' : 'DATABASE_URL'), { required: true, pattern: '[A-Za-z_][A-Za-z0-9_]*' })}${notice(`引用 ${e(db.name)} 的私有连接，凭证只显示引用。下一步核对映射，保存后仍需部署。`)}`, '预览连接映射', closeButton());
  }
  function mountForm(d) {
    const v = getVolume(d.volumeId);
    const applications = api.allServices().filter((s) => sameScope({ projectId: s.projectId, environmentId: s.environmentId }, v));
    return form('volume-mount-save', `<input type="hidden" name="volumeId" value="${e(v.id)}" /><input type="hidden" name="revision" value="${v.revision || 1}" />${field('同环境服务', 'serviceId', d.serviceId || '', { choices: [['', '选择服务'], ...applications.map((s) => [s.id, s.draft.name])], required: true })}${field('容器内绝对路径', 'path', d.path || '/data', { required: true, hint: '例如 /data；不能使用相对路径或路径上跳。' })}${check('只读挂载', 'readOnly', d.readOnly)}${notice('每个卷只允许一个可写服务；已有草稿、发布、在途和实际引用都会纳入检查。')}`, '保存挂载草稿', closeButton());
  }
  function domainForm(d) {
    const list = api.allServices().filter((s) => (!d.projectId || s.projectId === d.projectId) && (!d.environmentId || s.environmentId === d.environmentId) && publishedHttpPorts(s).length);
    const found = reference(d.serviceId);
    const ports = publishedHttpPorts(found?.service);
    const selectedPort = ports.find((p) => p.name === d.portName) || ports[0];
    return form('domain-create', `<input type="hidden" name="projectId" value="${e(d.projectId || '')}" /><input type="hidden" name="environmentId" value="${e(d.environmentId || '')}" />${field('服务', 'serviceId', d.serviceId || '', { choices: [['', '选择服务'], ...list.map((s) => [s.id, `${s.project.name} / ${s.draft.name} · ${publishedHttpPorts(s).length} 个 HTTP 端口`])], required: true })}${field('已发布 HTTP 端口', 'portName', selectedPort?.name || '', { choices: ports.length ? ports.map((p) => [p.name, `${p.name}:${p.port}`]) : [['', '先选择服务']], required: true })}${field('域名前缀', 'prefix', d.prefix || '', { required: true, pattern: '[a-z0-9]((?:[a-z0-9]|-){0,61}[a-z0-9])?' })}${found ? facts([['完整域名', `<code>${e(d.prefix || found.service.draft.slug)}.${e(api.targetFor(found.project).suffix)}.${e(state.platform.suffix)}</code>`], ['固定端口', selectedPort ? `${e(selectedPort.name)}:${selectedPort.port}` : '尚未选择'], ['DNS 入口目标', copyField(api.targetFor(found.project).entryAddress, 'DNS 入口目标')]]) : ''}${notice('先以 staging 证书检查 DNS、路由与 TLS；完成后再显式申请 production。')}`, '分配并创建检查任务', closeButton());
  }

  function action(name, el, ctx, accepted = false) {
    if (!name?.startsWith('mg:')) return false;
    name = name.slice(3);
    const id = el.dataset.id;
    const reads = ['close', 'page', 'clear-filters', 'server-open', 'server-onboard', 'cluster-open', 'node-detail', 'credential-detail', 'credential-visibility', 'integration-detail', 'github-repositories', 'git-event', 'record-detail', 'plan', 'plan-record', 'environment-switch', 'project-reload', 'form-reload', 'platform-diagnostic'];
    if (!reads.includes(name) && blockWrite(formOf(el))) return true;
    if (state.pendingAction && !accepted) return true;
    const requestLabels = { 'fingerprint-discover': '正在受理指纹读取…', 'server-preflight': '正在受理预检…', 'cluster-check': '正在受理同步…', 'domain-check': '正在提交检查…', 'domain-reapply': '正在提交重新应用…' };
    if (!accepted && state.scenario === 'slow-response' && requestLabels[name]) {
      api.demoRequest('mg:' + name, requestLabels[name], () => action('mg:' + name, el, ctx, true));
      return true;
    }
    if (name === 'close') { api.closeModal(); return true; }
    if (name === 'credential-visibility') { if (ui.dialog?.name !== 'credential-save' || state.modal?.management !== ui.dialog) return true; ui.dialog.revealSecret = !ui.dialog.revealSecret; applySecretVisibility(formOf(el), ui.dialog.revealSecret); return true; }
    if (name === 'form-reload') {
      const targetForm = el.dataset.formName;
      if (!['server-save', 'cluster-save', 'cluster-entry', 'platform-entry'].includes(targetForm)) return false;
      api.confirm({ title: '加载最新资料', description: '当前未保存输入将被最新资料替换；其他页面草稿保留。', confirmText: '丢弃输入并加载最新', onConfirm: () => { delete ui.drafts[draftKey(targetForm, id)]; delete ui.formErrors[targetForm]; ui.dialog = null; api.closeModal(); api.render(); } }); return true;
    }
    if (name === 'page' || name === 'clear-filters') {
      const url = new URL(location.href);
      const [path, query = ''] = location.hash.split('?');
      const params = new URLSearchParams(query);
      if (name === 'page') params.set('page', el.dataset.page);
      else ['q', 'status', 'kind', 'project', 'env', 'service', 'page'].forEach((key) => params.delete(key));
      api.goto(path + (params.size ? '?' + params : '')); return true;
    }
    if (name === 'plan') {
      const collections = { volume: state.volumes, database: state.databases, domain: state.domains, task: state.tasks };
      const resource = collections[ctx.kind]?.find((item) => item.id === ctx.id);
      const found = resource?.serviceId ? reference(resource.serviceId) : null;
      const fixed = found && found.project.id === resource.projectId && found.service.environmentId === resource.environmentId ? { ...ctx, project: found.project, environment: found.project.environments.find((env) => env.id === found.service.environmentId), service: found.service, resource } : ctx;
      api.openPlan(el.dataset.feature, fixed); return true;
    }
    if (name === 'plan-record') {
      const run = state.planningRuns.find((r) => r.id === id);
      if (!run) return error(null, '规划记录已不存在。');
      api.openModal({ title: `${features.find(([key]) => key === run.featureId)?.[1] || run.featureId} · 演示记录`, wide: true, body: facts([['记录', e(run.id)], ['状态', badge(run.status)], ['开始时间', date(run.createdAt)], ['结果', e(run.result || (run.status === 'succeeded' ? '规划状态演示已完成，未修改真实资源。' : '请核对演示阶段结果。'))]]) + `<details class="mg-snapshot" open><summary>本次参数</summary><pre>${e(JSON.stringify(run.parameters || run.input || {}, null, 2))}</pre></details>`, footer: planButton(run.featureId, '重新配置演示') + btn('关闭', 'close') }); return true;
    }
    if (name === 'server-open' || name === 'server-onboard') { api.goto(detailHref('server', id, ctx, name === 'server-onboard' ? { tab: 'preflight' } : {})); return true; }
    if (name === 'cluster-open') { api.goto(detailHref('cluster', id, ctx)); return true; }
    if (name === 'server-new' || name === 'server-edit') {
      const d = id ? state.servers.find((s) => s.id === id) : { name: '', address: '', port: 22, user: 'deploy', credentialId: '' };
      if (!d) return error(null, '服务器已不存在。');
      openDialog('server-save', d, ctx, serverForm, id ? '编辑服务器' : '添加服务器'); return true;
    }
    if (name === 'cluster-new') { openDialog('cluster-save', {}, ctx, clusterForm, '登记集群'); return true; }
    if (name === 'server-remove') {
      const s = state.servers.find((item) => item.id === id);
      if (!s) return error(null, '服务器已不存在。');
      const blocked = () => s.clusterId || state.clusters.some((c) => c.serverId === id) || pendingFor(id);
      if (blocked()) return error(null, '服务器仍关联集群或活动任务，请先在集群详情核对引用。移除登记不会卸载集群。');
      confirmWrite({ title: '移除服务器登记', description: '只移除 Ozz 中的登记，远端软件和数据保留。', requireName: s.name, confirmText: '移除登记', onConfirm: () => { if (blocked()) return error(null, '引用已变化，当前不能移除。'); state.servers = state.servers.filter((item) => item.id !== id); api.goto('#/servers'); } }); return true;
    }
    if (['fingerprint-discover', 'fingerprint-confirm', 'server-preflight', 'server-install'].includes(name)) {
      const s = state.servers.find((item) => item.id === id);
      if (!s) return error(null, '服务器已不存在。');
      if (!verifyCredential(s.credentialId, 'ssh')) return error(null, 'SSH 凭证缺失或已到期，请先创建替换凭证。');
      if (name === 'fingerprint-discover') queue(s, { type: 'ssh-fingerprint', name: `${s.name} · 发现主机指纹` }, (t) => { s.fingerprint = `SHA256:DEMO-${s.id}-host-fingerprint`; s.fingerprintConfirmed = false; s.observedAt = api.now(); t.result = '已发现演示主机指纹，仍需操作者明确核对确认。'; }, ctx);
      if (name === 'fingerprint-confirm') {
        if (!s.fingerprint) return error(null, '请先发现主机指纹。');
        const fp = s.fingerprint;
        confirmWrite({ title: '确认主机指纹', description: `请与可信来源核对 ${fp}。确认仅适用于 ${s.address}:${s.port || 22}。`, confirmText: '确认这个指纹', pendingLabel: '正在保存可信指纹…', onConfirm: () => { if (s.fingerprint !== fp) return error(null, '指纹已变化，请重新核对。'); s.fingerprintConfirmed = true; bump(s); api.closeModal(); api.render(); } });
      }
      if (name === 'server-preflight') {
        if (!s.fingerprintConfirmed) return error(null, '先明确确认当前主机指纹。');
        queue(s, { type: 'ssh-preflight', name: `${s.name} · 只读预检` }, (t) => { s.os = 'Ubuntu 24.04 LTS'; s.cpu ||= 2; s.memory ||= 4; s.disk ||= 40; s.preflight = { passed: true, observedAt: api.now(), checks: [{ name: '操作系统', value: s.os, ok: true }, { name: '架构', value: 'linux/amd64', ok: true }, { name: '权限', value: 'SSH 与 sudo 可用', ok: true }, { name: 'CPU / 内存', value: `${s.cpu} 核 / ${s.memory} GiB`, ok: true }, { name: '可用磁盘', value: `${s.disk} GiB`, ok: true }, { name: '入口与 API 端口', value: '80 / 443 / 6443 检查完成', ok: true }, { name: '现有安装', value: s.clusterId ? '已有 K3s，初始化操作将被阻止' : '未发现现有安装', ok: true }] }; s.observedAt = api.now(); t.result = '只读预检完成。没有安装或覆盖远端软件。'; }, ctx);
      }
      if (name === 'server-install') {
        if (!s.fingerprintConfirmed || !s.preflight?.passed || s.clusterId || s.existingInstallation) return error(null, '需要已确认指纹且预检通过的空主机，已有安装不能覆盖。');
        confirmWrite({ title: '初始化 K3s', description: `在 ${s.name} 安装固定版本 v1.35.9+k3s1。确认后生成独立任务，失败、取消或未知结果会保留原记录。`, requireName: s.name, confirmText: '开始初始化', pendingLabel: '正在受理初始化…', onConfirm: () => {
          if (s.clusterId || !s.preflight?.passed) return error(null, '主机状态已变化，请重新核对。');
          queue(s, { type: 'k3s-install', name: `${s.name} · 初始化 K3s`, snapshot: { serverId: s.id, address: s.address, fingerprint: s.fingerprint, version: 'v1.35.9+k3s1', revision: s.revision } }, (t) => { const c = { id: api.uid('cluster'), name: s.name, location: s.region, region: s.region, status: 'ready', connectionStatus: 'ready', serverId: s.id, endpoint: `https://${s.address}:6443`, identity: `kube-system-demo-${s.id}`, revision: 1, suffix: s.name.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'cluster', entryType: 'ip', entryAddress: s.address, email: state.platform.email, capabilities: { rbac: true, ingress: true, storage: true, metrics: true, certificate: false }, nodes: [{ id: `node-${s.id}`, name: s.name, uid: `node-uid-${s.id}`, architecture: 'amd64', cpu: s.cpu, memory: s.memory, status: 'ready', observedAt: api.now() }], observedAt: api.now(), credentialId: `cred-kube-${s.id}` }; state.credentials.push({ id: c.credentialId, name: `${c.name} · Kubernetes`, kind: 'kubeconfig', status: 'active', revision: 1 }); state.clusters.push(c); s.clusterId = c.id; s.status = 'ready'; s.observedAt = api.now(); t.result = '演示安装任务完成，已观察并关联同一台服务器的集群。'; }, ctx);
        } });
      }
      return true;
    }
    if (name === 'cluster-import') {
      const c = id ? state.clusters.find((item) => item.id === id) : {};
      if (!c) return error(null, '集群已不存在。');
      openDialog('cluster-parse', c, ctx, kubeconfigForm, id ? '更新同一集群的连接' : '导入已有 Kubernetes 集群'); return true;
    }
    if (name === 'kubeconfig-sample') {
      const f = formOf(el); const current = ui.dialog?.draft;
      const input = f?.querySelector('[name="kubeconfig"]');
      if (input) { input.value = `apiVersion: v1\nkind: Config\nclusters:\n- name: demo\n  cluster:\n    server: ${current?.endpoint || 'https://new-cluster.example.test:6443'}\n    certificate-authority-data: REVNTy1PTkxZ\nusers:\n- name: demo\n  user:\n    token: demo-static-token\ncontexts:\n- name: demo\n  context:\n    cluster: demo\n    user: demo\ncurrent-context: demo`; input.focus(); }
      return true;
    }
    if (name === 'cluster-import-back') { const d = ui.dialog?.draft; openDialog('cluster-parse', d || {}, ctx, kubeconfigForm, '修改连接输入'); return true; }
    if (name === 'cluster-check' || name === 'certificate-install') {
      const c = state.clusters.find((item) => item.id === id);
      if (!c?.endpoint || !c.identity || !verifyCredential(c.credentialId, 'kubeconfig')) return error(null, '集群缺少可验证的连接与身份，请先导入 kubeconfig。');
      const start = () => queue(c, { type: name === 'cluster-check' ? 'cluster-check' : 'certificate-install', name: `${c.name} · ${name === 'cluster-check' ? '连接与能力诊断' : '安装证书组件'}` }, (t) => { c.status = 'ready'; c.connectionStatus = 'ready'; c.observedAt = api.now(); c.capabilities ||= {}; Object.assign(c.capabilities, { rbac: true, ingress: true, storage: true, metrics: true }); if (name === 'certificate-install') c.capabilities.certificate = true; t.result = name === 'cluster-check' ? '已重新观察固定 UID 的集群连接、RBAC、入口、存储与指标。' : '演示安装完成，cert-manager 能力已重新观察。'; }, ctx);
      if (name === 'certificate-install') confirmWrite({ title: '安装证书组件', description: `在固定集群 ${c.name} 检查并安装 cert-manager v1.21.3。`, confirmText: '创建安装任务', onConfirm: start }); else start(); return true;
    }
    if (name === 'cluster-remove') {
      const c = state.clusters.find((item) => item.id === id);
      if (!c) return error(null, '集群已不存在。');
      const blocking = () => state.projects.some((p) => (p.targetId || p.clusterId) === id) || state.volumes.some((v) => target(v).id === id) || pendingFor(id);
      if (blocking()) return error(null, '集群仍关联项目、数据或活动任务，当前不能移除。');
      confirmWrite({ title: '移除集群登记', description: '只移除控制面登记。远端集群、软件与数据不会卸载。', requireName: c.name, confirmText: '移除登记', onConfirm: () => { if (blocking()) return error(null, '集群引用已变化，请重新核对。'); state.servers.forEach((s) => { if (s.clusterId === id) { s.clusterId = null; s.existingInstallation = true; bump(s); } }); state.clusters = state.clusters.filter((item) => item.id !== id); api.goto('#/servers?tab=clusters'); } }); return true;
    }
    if (name === 'node-detail') {
      const c = state.clusters.find((item) => item.id === el.dataset.cluster); const n = c?.nodes?.find((item) => item.id === id);
      if (!n) return error(null, '节点不属于指定集群，无法显示观察。');
      const projects = state.projects.filter((p) => (p.targetId || p.clusterId) === c.id);
      api.openModal({ title: n.name, wide: true, body: facts([['Node UID', `<code>${e(n.uid)}</code>`], ['固定集群', textLink(c.name, `#/cluster/${c.id}`)], ['架构', e(n.architecture)], ['状态', badge(c.status === 'offline' ? 'unknown' : n.status)], ['CPU / 内存', `${n.cpu} 核 / ${n.memory} GiB`], ['观察时间', date(n.observedAt || c.observedAt)]]) + section('关联项目与工作负载', projects.map((p) => `<div class="mg-node-workloads">${textLink(p.name, api.projectUrl(p))}<div class="mg-link-list">${p.services.filter((s) => s.nodeId === n.id || s.nodeName === n.name).map((s) => serviceLink(s.id)).join('') || '<span class="mg-muted">尚无带节点归属的工作负载观察，可进入项目查看服务。</span>'}</div></div>`).join('') || '<p>暂无关联项目。</p>') + notice('节点工作负载仅按已知节点关联展示；失联时保留上次观察，不代表当前调度已验证。'), footer: planButton('F41', '节点维护规划') + btn('关闭', 'close') }); return true;
    }
    if (name === 'credential-new' || name === 'credential-replace') {
      const c = id && state.credentials.find((item) => item.id === id);
      if (id && !c) return error(null, '原凭证已不存在。');
      const d = c ? { kind: c.kind, name: `${c.name} · 新版本`, replaceId: c.id } : { kind: 'ssh', name: '' };
      openDialog('credential-save', d, ctx, (value) => credentialForm(value, value.replaceId), c ? '创建替换凭证' : '新建凭证'); return true;
    }
    if (name === 'credential-detail') {
      const c = state.credentials.find((item) => item.id === id);
      if (!c) return error(null, '凭证已不存在。');
      openCredentialDetail(c, ctx); return true;
    }
    if (name === 'credential-remove') {
      const c = state.credentials.find((item) => item.id === id);
      if (!c) return error(null, '凭证已不存在。');
      if (credentialRefs(id).length) return error(formOf(el), '该凭证仍被引用。请先创建替换凭证、更新相关引用，并完成需要的重新验证或部署。');
      confirmWrite({ title: '删除凭证', description: '删除后无法读回秘密内容。当前凭证没有已知引用。', requireName: c.name, confirmText: '删除凭证', onConfirm: () => { if (credentialRefs(id).length) return error(null, '凭证引用已变化，不能删除。'); state.credentials = state.credentials.filter((item) => item.id !== id); api.goto('#/settings?tab=credentials'); } }); return true;
    }
    if (name === 'integration-new' || name === 'integration-edit') {
      const item = id ? state.integrations.find((i) => i.id === id) : { kind: el.dataset.kind || 'github' };
      if (!item) return error(null, '连接已不存在。');
      openDialog('integration-save', item, ctx, integrationForm, id ? '编辑连接' : '添加连接'); return true;
    }
    if (name === 'builder-sample') {
      if (ui.dialog?.name !== 'integration-save' || ui.dialog.draft.id) return error(formOf(el), '已有 Builder 身份不能通过示例值替换。');
      Object.assign(ui.dialog.draft, { instanceId: 'c0741360-fd8d-467f-9e97-f77c438fb730', buildkitVersion: 'v0.16.0', frontendDigest: 'sha256:' + 'b'.repeat(64), identityPublicKey: '-----BEGIN PUBLIC KEY-----\nREVNTy1QVUJMSUMtS0VZLU9OTFk=\n-----END PUBLIC KEY-----' }); api.render(); return true;
    }
    if (name === 'integration-detail') { const item = state.integrations.find((i) => i.id === id); if (!item) return error(null, '连接已不存在。'); integrationDetail(item, ctx); return true; }
    if (name === 'integration-verify') {
      const item = state.integrations.find((i) => i.id === id);
      if (!item) return error(null, '连接已不存在。');
      const validCredential = verifyCredential(item.credentialId, item.kind === 'github' ? 'git' : item.kind) && (item.kind !== 'registry' || (item.pullCredentialId !== item.credentialId && verifyCredential(item.pullCredentialId, 'registry')));
      const invalid = !validCredential ? '凭证缺失、到期或推送与拉取身份未分开。' : item.kind === 'builder' && (!item.enabled || !item.instanceId || !item.identityPublicKey || !item.profile?.buildkitVersion || !item.profile?.frontendDigest) ? 'Builder 已停用或缺少固定实例身份与构建配置。' : '';
      queue(item, { type: 'integration-verify', name: `${item.name} · 验证连接`, ...(invalid ? { outcome: 'failed' } : {}), onFailure: (t) => { item.status = 'failed'; item.validation = invalid || '演示连接验证失败，请核对地址、权限与目标状态。'; if (item.kind === 'registry') { item.pushVerification = { status: 'failed', observedAt: api.now() }; item.pullVerification = { status: 'failed', observedAt: api.now() }; } t.error = item.validation; } }, (t) => { item.status = 'ready'; item.observedAt = api.now(); if (item.kind === 'registry') { item.pushVerification = { status: 'ready', observedAt: item.observedAt }; item.pullVerification = { status: 'ready', observedAt: item.observedAt, readOnly: true }; } if (item.kind === 'builder') item.capabilities = { architecture: item.platform, maxConcurrency: 1, highGeneration: 1, controlPlaneGenerationAtCheck: 1 }; item.validation = item.kind === 'registry' ? '独立推送与拉取身份均已演示验证。' : item.kind === 'builder' ? 'mTLS、预期实例 ID、构建配置与架构均已演示核对。' : '账户授权与仓库读取权限已演示验证。'; t.result = item.validation; }, ctx); return true;
    }
    if (name === 'github-repositories') {
      const item = state.integrations.find((i) => i.id === id);
      if (!item || item.kind !== 'github') return error(null, '请选择 GitHub 连接。');
      if (item.status !== 'ready' || !verifyCredential(item.credentialId, 'git') || state.scenario === 'integration-missing') return error(null, 'GitHub 尚未授权或验证，请先更新凭证并验证连接。不可见仓库不会作为可选来源。');
      openDialog('github-browse', { integrationId: item.id, repository: 'demo/personal-blog', branch: 'main' }, ctx, (d) => `<p class="mg-muted">${e(item.account)} · 仅展示原型授权范围内的演示仓库。</p>${field('仓库', 'repository', d.repository, { choices: [['demo/personal-blog', 'demo/personal-blog'], ['demo/notes', 'demo/notes'], ['demo/api-worker', 'demo/api-worker']] })}${field('分支', 'branch', d.branch, { choices: (d.repository === 'demo/notes' ? ['main', 'dev'] : ['main', 'staging', 'feature/docs']).map((branch) => [branch, branch]) })}${facts([['选定来源', `<code>${e(d.repository)} · ${e(d.branch)}</code>`], ['可用权限', '读取源码；是否允许 Webhook 注册需独立验证']])}${notice('在项目中选择“新建服务 → GitHub”，可用这些仓库创建服务；保存来源不会立即开始构建。')}`, `${item.name} · 仓库与分支`); return true;
    }
    if (name === 'webhook-edit') {
      const item = state.integrations.find((i) => i.id === id);
      if (!item || item.kind !== 'github') return error(null, '请选择 GitHub 连接。');
      openDialog('webhook-save', { id: item.id, revision: item.revision || 1, repository: item.webhookRepository || 'demo/personal-blog', credentialId: item.webhookCredentialId || '' }, ctx, (d) => form('webhook-save', revisionInput(d) + field('仓库', 'repository', d.repository, { required: true }) + field('独立签名凭证', 'credentialId', d.credentialId, { choices: credentialChoices('webhook'), required: true }) + notice('Webhook 接收源码推送事件。注册与权限校验使用独立任务；无效签名、无关分支和停止服务分别保留接收结果。'), item.webhook ? '更新注册' : '注册 Webhook', closeButton()), item.webhook ? '更新 Webhook 注册' : '注册 GitHub Webhook'); return true;
    }
    if (name === 'platform-diagnostic') {
      queue(null, { resourceId: 'platform', targetId: 'platform', type: 'platform-diagnostic', name: '控制面 · 平台诊断' }, (t) => { state.worker.heartbeat = api.now(); state.worker.diagnostics = [{ name: '控制面', status: 'ready', detail: state.readOnly ? 'API 可读，恢复锁生效' : 'API 响应正常' }, { name: '数据库', status: 'ready', detail: '元数据可读，版本可核对' }, { name: '队列 / Redis', status: state.worker.redis, detail: '保留待投递与未知任务' }, { name: 'Worker', status: state.worker.status, detail: '按心跳与阶段记录观察' }, { name: '资源对账', status: state.tasks.some((task) => task.status === 'unknown') ? 'unknown' : 'ready', detail: '未知任务需逐项核对，不重放旧请求' }]; t.result = '诊断记录已生成。恢复锁保持原状态，未通过 Web 解除。'; }, ctx); return true;
    }
    if (name === 'volume-new') {
      const projectId = el.dataset.project || ctx.project?.id || ctx.params.get('project') || '';
      const project = state.projects.find((p) => p.id === projectId);
      const environmentId = el.dataset.env || ctx.params.get('env') || (project?.environments.length === 1 ? project.environments[0].id : '');
      openDialog('volume-create', { projectId, environmentId, sizeGiB: 5 }, ctx, volumeForm, '创建数据卷'); return true;
    }
    if (name === 'volume-mount') {
      const v = getVolume(id);
      if (!v || v.maintenance) return error(null, '数据卷已不存在或正在维护，当前不能修改挂载。');
      openDialog('volume-mount-save', { volumeId: id, path: '/data' }, ctx, mountForm, `挂载 ${v.name}`); return true;
    }
    if (name === 'volume-unmount') {
      const v = getVolume(id); const found = reference(el.dataset.service); const s = found?.service;
      if (!v || v.maintenance || !editableService(s)) return error(null, '卷处于维护或服务当前不可编辑，请核对原任务。');
      confirmWrite({ title: '移除挂载草稿', description: `只从 ${s.draft.name} 草稿移除 ${v.name}。已发布与实际挂载保留到下一次部署成功。`, confirmText: '保存卸载草稿', onConfirm: () => { if (v.maintenance || !editableService(s)) return; s.draft.mounts = (s.draft.mounts || []).filter((m) => m.volumeId !== id); commitServiceDraft(s); api.closeModal(); flash(ctx, '挂载草稿已移除；请部署服务，再核对已发布和实际引用。'); } }); return true;
    }
    if (name === 'volume-protection') {
      const v = getVolume(id);
      if (!v) return error(null, '数据卷已不存在。');
      const before = Boolean(v.protected);
      confirmWrite({ title: before ? '关闭防销毁保护' : '开启防销毁保护', description: before ? '关闭保护不会销毁数据。后续销毁仍需通过引用、维护与名称确认。' : '开启后必须先显式关闭保护，才能独立销毁数据。', requireName: before ? v.name : undefined, confirmText: before ? '关闭保护' : '开启保护', onConfirm: () => { if (pendingFor(id) || v.maintenance) return error(null, '数据卷当前有活动任务或维护锁，请先核对。'); v.protected = !before; bump(v); api.closeModal(); api.render(); } }); return true;
    }
    if (name === 'volume-destroy') {
      const v = getVolume(id); const reason = canDestroyVolume(v);
      if (reason) return error(null, reason);
      const revision = v.revision || 1;
      confirmWrite({ title: `销毁 ${v.name}`, description: '永久销毁该卷的数据与保留数据库身份。此操作不同于移除服务，不会自动生成备份。', requireName: v.name, confirmText: '确认销毁数据', onConfirm: () => {
        const latest = canDestroyVolume(v); if (latest || v.revision !== revision) return error(null, latest || '数据卷已有新版本，请重新审查。');
        queue(v, { type: 'volume-destroy', name: `${v.name} · 销毁数据卷` }, (t) => { const changed = volumeRefs(v).length || v.maintenance || v.protected; if (changed) { t.status = 'failed'; t.error = '执行前发现新的引用或保护，没有销毁数据。'; return; } state.volumes = state.volumes.filter((item) => item.id !== id); state.databases = state.databases.filter((db) => db.volumeId !== id); t.result = '本地演示卷与关联数据身份已移除；原任务保留。'; }, ctx);
      } }); return true;
    }
    if (name === 'database-connect') {
      const db = getDatabase(id);
      if (!db || !db.identity || !reference(db.serviceId)) return error(null, '数据库身份不可信或源服务已移除，不能创建新运行连接。保留数据仍可访问。');
      openDialog('database-preview', { databaseId: id, variable: db.kind === 'redis' ? 'REDIS_URL' : 'DATABASE_URL' }, ctx, connectionForm, `连接 ${db.name}`); return true;
    }
    if (name === 'database-disconnect') {
      const db = getDatabase(id); const found = reference(el.dataset.service); const s = found?.service;
      if (!db || !editableService(s)) return true;
      confirmWrite({ title: '移除数据库连接草稿', description: '只修改应用草稿。已发布实例继续使用原连接，下一次部署后才会移除注入。', confirmText: '保存移除草稿', onConfirm: () => { if (!editableService(s)) return; s.draft.connections = (s.draft.connections || []).filter((c) => c.databaseId !== id); commitServiceDraft(s); api.closeModal(); api.render(); api.notify('连接草稿已移除，等待部署。'); } }); return true;
    }
    if (name === 'database-preview-back') { const d = ui.dialog?.draft; openDialog('database-preview', d, ctx, connectionForm, '修改数据库连接'); return true; }
    if (name === 'domain-new') {
      openDialog('domain-create', { projectId: ctx.project?.id || ctx.params.get('project') || '', environmentId: ctx.params.get('env') || '', serviceId: ctx.service?.id || '', prefix: ctx.service?.draft.slug || '' }, ctx, domainForm, '分配默认域名'); return true;
    }
    if (['domain-check', 'domain-reapply', 'domain-production', 'domain-unbind'].includes(name)) {
      const d = state.domains.find((item) => item.id === id);
      if (!d) return error(null, '域名绑定已不存在。');
      if (name !== 'domain-unbind') { const problem = domainPrerequisite(d); if (problem) return error(null, problem); }
      if (name === 'domain-unbind') {
        confirmWrite({ title: '解除域名绑定', description: '清理本绑定拥有的路由与证书。手工 DNS、共享入口和其他服务保留；失败或未知可追踪原任务。', requireName: d.hostname, confirmText: '确认解除绑定', onConfirm: () => queue(d, { type: 'domain-unbind', name: `${d.hostname} · 解除绑定` }, (t) => { state.domains = state.domains.filter((item) => item.id !== id); t.result = '本绑定的演示路由与证书记录已移除。手工 DNS 和共享集群资源保留。'; }, ctx) }); return true;
      }
      const production = name === 'domain-production';
      if (production && (d.certificate !== 'staging' || ['dns', 'route', 'tls'].some((key) => d[key] !== 'ready'))) return error(null, '先在 staging 完成 DNS、路由与 TLS 的独立检查，再申请 production。');
      const run = () => queue(d, { type: name, name: `${d.hostname} · ${production ? '申请 production 证书' : name === 'domain-check' ? '检查 DNS / 路由 / TLS' : '重新应用路由'}` }, (t) => { const problem = domainPrerequisite(d); if (problem) { t.status = 'failed'; t.error = problem; return; } d.dns = 'ready'; d.route = 'ready'; d.tls = 'ready'; d.status = 'ready'; d.observedAt = api.now(); if (production) { d.certificate = 'production'; d.expiresAt = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10); bump(d); } t.result = `演示分别观察到 DNS、路由和 ${d.certificate || 'staging'} TLS 就绪。`; }, ctx);
      if (production) confirmWrite({ title: '申请 production 证书', description: `已核对 ${d.hostname} 的 staging 结果。确认后创建生产证书申请任务。`, confirmText: '申请 production', onConfirm: run }); else run(); return true;
    }
    if (name === 'maintenance-new') {
      const v = getVolume(id);
      if (!v || v.maintenance || pendingFor(id)) return error(null, '目标卷已不存在，或仍有维护锁 / 活动任务。');
      if (el.dataset.mode === 'restore' && (volumeRefs(v).length || v.databaseId || v.dataEngine || (v.records || []).some((r) => r.type === 'restore' && r.result === 'passed'))) return error(null, '恢复必须选择不同源卷的全新目标；不能覆盖已有身份、恢复数据或服务引用。请创建新卷。');
      openDialog('maintenance-enter', { id, mode: el.dataset.mode || 'backup' }, ctx, maintenanceForm, el.dataset.mode === 'restore' ? '恢复到新目标维护' : '进入备份维护'); return true;
    }
    if (name === 'maintenance-exit') {
      const v = getVolume(id); const m = v?.maintenance; const task = m && state.tasks.find((t) => t.id === m.taskId);
      if (!m) return error(null, '当前没有维护锁。');
      if (pendingFor(id) || activeStates.includes(task?.status)) return error(null, '原维护任务尚未给出确定终态。未知或执行中不能直接退出，先核对原任务。');
      openDialog('maintenance-exit-save', { id: v.id, maintenanceId: m.id }, ctx, (d) => form('maintenance-exit-save', revisionInput(v) + `<input type="hidden" name="maintenanceId" value="${e(d.maintenanceId)}" />${facts([['维护对象', e(v.name)], ['原任务', task ? textLink(task.name, `#/task/${task.id}`) : '请核对原记录']])}${check('已核对维护 helper 已移除', 'helperRemoved', d.helperRemoved)}${check('已核对实际挂载、写入状态与受影响服务', 'mountsVerified', d.mountsVerified)}${field('退出核验证据', 'evidence', d.evidence || '', { area: true, required: true, hint: '说明 helper、实际挂载与写入恢复的观察结果；提交后仍需等待核验任务。' })}`, '创建退出核验任务', closeButton()), '核对并退出维护'); return true;
    }
    if (name === 'record-new') {
      const v = getVolume(id); const task = v?.maintenance && state.tasks.find((t) => t.id === v.maintenance.taskId);
      if (!v?.maintenance || v.maintenance.status !== 'active' || task?.status !== 'succeeded') return error(null, '需要已成功进入维护的确定任务。未知、失败或未就绪不能登记通过。');
      openDialog('record-save', { volumeId: v.id }, ctx, recordForm, v.maintenance.mode === 'restore' ? '登记恢复证据' : '登记备份证据'); return true;
    }
    if (name === 'record-sample') {
      const d = ui.dialog?.draft; const v = getVolume(d?.volumeId);
      if (!v) return error(formOf(el), '维护对象已不存在。');
      const local = (time) => { const dateValue = new Date(time); return new Date(dateValue.getTime() - dateValue.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
      const source = v.maintenance?.mode === 'restore' ? backupRecords().find((r) => r.id === v.maintenance.recordId) : null;
      const engine = source?.engine || engineFor(v);
      const version = source?.version || state.databases.find((db) => db.volumeId === v.id)?.version || (engine === 'files' ? '1' : '待核对');
      Object.assign(d, { backupId: source?.backupId || d.backupId || `backup-demo-${v.id}-${(v.records || []).length + 1}`, version, toolVersion: engine === 'postgresql' ? `pg_dump / pg_restore ${version}` : engine === 'redis' ? `redis-cli / redis-check-rdb ${version}` : 'GNU tar 1.35', sizeBytes: source?.sizeBytes || '1048576', sha256: source?.sha256 || 'd'.repeat(64), startedAt: local(Date.now() - 300000), finishedAt: local(Date.now() - 60000), dataAt: local(Date.now() - 300000), location: source?.location || 's3://demo-offsite/ozz/manual-backup', integrity: 'passed', result: 'passed', verification: '演示证据：归档清单可读，SHA256 已核对；恢复场景完成关键数据抽样、权限检查与必要的重启验证。', evidence: '演示操作记录 demo-evidence-001；未实际导出、恢复或校验数据。', ack: true }); api.render(); return true;
    }
    if (name === 'record-detail') {
      const v = getVolume(el.dataset.volume); const r = v?.records?.find((item) => item.id === id);
      if (!r) return error(null, '证据记录已不存在。');
      api.openModal({ title: `${r.type === 'restore' ? '恢复' : '备份'}证据 · ${r.backupId}`, wide: true, body: facts([['记录 / 备份 ID', `<code>${e(r.id)} / ${e(r.backupId)}</code>`], ['源 / 目标', `${e(r.sourceId)} → ${e(r.targetId || '离机归档')}`], ['引擎 / 版本', `${engineLabel(r.engine)} / ${e(r.version)}`], ['格式 / 工具', `${e(r.format)} / ${e(r.toolVersion)}`], ['大小 / SHA256', `${e(r.sizeBytes)} bytes<br /><code>${e(r.sha256)}</code>`], ['执行开始 / 结束', `${date(r.startedAt)} → ${date(r.finishedAt)}`], ['数据截至', date(r.dataAt)], ['离机位置', `<code>${e(r.location)}</code>`], ['完整性 / 结果', `${e(r.integrity)} / ${e(r.result)}`], ['验证方法', e(r.verification)], ['证据', e(r.evidence)], ['关联维护', `<code>${e(r.maintenanceId)}</code>`], ['登记时间', date(r.createdAt)]]) + notice('以上为已登记的操作者证据。保存记录没有执行备份、恢复或数据验证。'), footer: btn('关闭', 'close') }); return true;
    }
    if (name === 'task-cancel') {
      const task = state.tasks.find((t) => t.id === id);
      if (!task || !['queued', 'running'].includes(task.status)) return error(null, '任务状态已变化，请重新核对原记录。');
      api.cancelTask(id); return true;
    }
    if (name === 'task-retry') {
      const task = state.tasks.find((t) => t.id === id);
      if (!task || !['failed', 'cancelled'].includes(task.status)) return error(null, '只有明确失败或已取消的任务可以创建独立重试。未知结果必须先核对原请求。');
      confirmWrite({ title: '创建独立重试任务', description: '重试使用原固定目标与输入。原失败或取消记录保留；较新配置不会被覆盖。', confirmText: '创建重试', onConfirm: () => { const before = new Set(state.tasks.map((t) => t.id)); const returned = api.retryTask(id); const next = returned || state.tasks.find((t) => !before.has(t.id) && t.attemptOf === id); if (next?.id) api.goto(`#/task/${next.id}`); } }); return true;
    }
    if (name === 'task-reconcile') {
      const task = state.tasks.find((t) => t.id === id);
      if (!task || task.status !== 'unknown') return error(null, '原任务已不处于未知状态。');
      openDialog('task-reconcile-save', { taskId: id, observed: '', evidence: '' }, ctx, (d) => form('task-reconcile-save', `<input type="hidden" name="taskId" value="${e(id)}" />${facts([['原任务', e(task.name)], ['固定对象', e(task.resourceId || task.serviceId || task.targetId)], ['原输入版本', e(task.snapshot?.revision || task.revision || '随固定快照')]])}${field('演示核对结果', 'observed', d.observed, { choices: [['', '选择观察结果'], ['succeeded', '观察到原任务完成'], ['failed', '观察到明确失败'], ['unknown', '仍无法确定']], required: true })}${field('完成证据 / 核对说明', 'evidence', d.evidence, { area: true, required: true })}${check('已核对原任务 ID、固定目标、资源版本与完成证据', 'ack', d.ack)}${notice('这是原型的显式对账演示。不会创建新操作，也不会把其他任务或旧实例的健康当作本次完成。')}`, '保存原任务核对结果', closeButton()), '核对原任务'); return true;
    }
    if (name === 'git-event') {
      const event = state.gitEvents.find((t) => t.id === id);
      if (!event) return error(null, 'Git 事件已不存在。');
      api.openModal({ title: 'Git 事件与逐服务投递', wide: true, body: facts([['事件 ID', e(event.id)], ['仓库 / 分支', `${e(event.repository)} / ${e(event.branch)}`], ['提交', `<code>${e(event.commit)}</code>`], ['接收时间', date(event.createdAt)], ['状态 / 原因', `${badge(event.status)} · ${e(event.outcome || event.reason)}`], ['来源服务', event.serviceId ? serviceLink(event.serviceId, 'deployments') : '未定位到服务，不猜测归属'], ['部署任务', event.taskId ? textLink(event.taskId, `#/task/${event.taskId}`) : '未创建部署']]) + notice(event.status === 'rejected' ? '签名或授权未通过，本事件未创建部署。' : event.status === 'ignored' ? '事件被忽略或仅保存为待发布，不生成新的部署。' : '每个接收结果与目标服务、提交和任务保持关联。'), footer: btn('关闭', 'close') }); return true;
    }
    if (name === 'project-reload') {
      const p = ctx.project; if (!p) return error(null, '项目已不存在。');
      const reset = () => { delete ui.drafts[draftKey('project-save', p.id)]; delete ui.formErrors['project-save']; api.closeModal(); api.render(); };
      if (ui.drafts[draftKey('project-save', p.id)]) api.confirm({ title: '加载最新项目资料', description: '当前未保存的项目资料将被最新版本替换。', confirmText: '丢弃输入并加载最新', onConfirm: reset }); else reset(); return true;
    }
    if (name === 'project-remove') {
      const p = ctx.project; if (!p) return error(null, '项目已不存在。');
      const blocked = () => p.services.length || ['volumes', 'databases', 'domains'].some((key) => state[key].some((item) => item.projectId === p.id)) || state.tasks.some((t) => t.projectId === p.id && activeStates.includes(t.status));
      if (blocked()) return error(null, '项目仍有服务、数据卷、数据库、域名或活动任务。请先处理依赖，保留数据不会随项目删除。');
      confirmWrite({ title: '删除空项目', description: '删除项目及其空环境，固定部署集群和服务器保留。', requireName: p.name, confirmText: '删除项目', onConfirm: () => { if (blocked()) return error(null, '项目依赖已变化，请重新审查。'); state.projects = state.projects.filter((item) => item.id !== p.id); api.goto('#/projects'); } }); return true;
    }
    if (name === 'environment-new' || name === 'environment-edit') {
      const p = ctx.project; const env = name === 'environment-edit' ? p?.environments.find((item) => item.id === id) : { name: '', slug: '', description: '' };
      if (!p || !env) return error(null, '项目或环境已不存在。');
      openDialog('environment-save', { ...env, projectId: p.id }, ctx, (d) => form('environment-save', revisionInput(d) + `<input type="hidden" name="projectId" value="${e(p.id)}" /><div class="mg-two">${field('环境名称', 'name', d.name, { required: true })}${field('稳定标识', 'slug', d.slug, { required: true, readonly: Boolean(env.id), pattern: '[a-z](?:[a-z0-9]|-){0,47}', placeholder: 'staging' })}</div>${field('描述', 'description', d.description || '', { area: true })}${notice('环境继承项目的固定集群。创建环境不会复制其他环境的服务、变量或数据。')}`, env.id ? '保存环境资料' : '创建环境', closeButton()), env.id ? '编辑环境' : '添加环境'); return true;
    }
    if (name === 'environment-switch') {
      const p = ctx.project; const env = p?.environments.find((item) => item.id === id);
      if (!env) return error(null, '环境不属于当前项目，请重新选择。');
      p.lastEnvironmentId = env.id; api.goto(api.projectUrl(p, '', env.id)); return true;
    }
    if (name === 'environment-remove') {
      const p = ctx.project; const env = p?.environments.find((item) => item.id === id);
      if (!env) return error(null, '环境已不存在。');
      if (env.slug === 'production') return error(null, '默认 production 环境不能单独删除。');
      const blocked = () => p.services.some((s) => s.environmentId === id) || ['volumes', 'databases', 'domains'].some((key) => state[key].some((item) => item.projectId === p.id && item.environmentId === id)) || state.tasks.some((t) => t.projectId === p.id && t.environmentId === id && activeStates.includes(t.status));
      if (blocked()) return error(null, '环境仍有服务、保留数据或活动任务，不能删除。请先查看项目资源。');
      confirmWrite({ title: '删除空环境', description: '删除此环境元数据，不移动服务或数据，不改变项目部署位置。', requireName: env.name, confirmText: '删除环境', onConfirm: () => { if (blocked()) return error(null, '环境依赖已变化，请重新核对。'); p.environments = p.environments.filter((item) => item.id !== id); bump(p); const next = p.environments.find((item) => item.slug === 'production') || p.environments[0]; p.lastEnvironmentId = next.id; api.goto(api.projectUrl(p, '/settings', next.id)); } }); return true;
    }
    return false;
  }

  function submit(name, formElement, ctx, accepted = false) {
    if (!name?.startsWith('mg:')) return false;
    name = name.slice(3);
    if (blockWrite(formElement)) return true;
    delete ui.formErrors[name];
    if (!valid(formElement)) return true;
    const d = data(formElement);
    const dialog = formElement.closest('.dialog') ? ui.dialog : null;
    const origin = dialog?.ctx || ctx;
    if (!accepted && state.pendingAction) return true;
    if (!accepted && state.scenario === 'slow-response' && ['credential-save', 'cluster-save'].includes(name)) {
      api.demoRequest('mg:' + name, name === 'credential-save' ? '正在保存凭证…' : '正在保存集群登记…', () => {
        api.render();
        const current = document.querySelector(`form[data-mg-draft="${name}"]`);
        if (current) submit('mg:' + name, current, ctx, true);
      });
      return true;
    }
    if (name === 'server-save') {
      const existing = d.id ? state.servers.find((s) => s.id === d.id) : null;
      if (d.id && !sameRevision(existing, d, formElement)) return true;
      if (!d.name.trim() || !d.user.trim() || !d.address.trim()) return error(formElement, '请填写服务器名称、地址与 SSH 用户。');
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(d.user)) return error(formElement, 'SSH 用户只能包含字母、数字、下划线与短横线。');
      if (!verifyCredential(d.credentialId, 'ssh')) return error(formElement, '请选择未到期的 SSH 凭证。');
      if (state.servers.some((s) => s.id !== d.id && s.address === d.address.trim() && Number(s.port || 22) === Number(d.port))) return error(formElement, '这个 SSH 地址与端口已经登记，请打开已有服务器继续接入。');
      if (existing && pendingFor(existing.id)) return error(formElement, '服务器有活动任务，请先核对原任务。');
      const changedConnection = existing && (existing.address !== d.address.trim() || existing.user !== d.user.trim() || Number(existing.port) !== Number(d.port) || existing.credentialId !== d.credentialId);
      const item = existing || { id: api.uid('server'), revision: 0, status: 'unverified' };
      Object.assign(item, { name: d.name.trim(), address: d.address.trim(), host: d.address.trim(), user: d.user.trim(), sshUser: d.user.trim(), port: Number(d.port), sshPort: Number(d.port), credentialId: d.credentialId, region: (d.region || '').trim(), location: (d.region || '').trim(), tags: (d.tags || '').split(',').map((v) => v.trim()).filter(Boolean) });
      if (changedConnection) { item.fingerprint = ''; item.fingerprintConfirmed = false; item.preflight = null; item.status = 'unverified'; }
      bump(item); if (!existing) state.servers.unshift(item);
      finishForm(name, d.id, existing ? detailHref('server', item.id, ctx, { tab: 'settings' }) : `#/server/${item.id}?tab=preflight`, existing ? '服务器资料已保存。' : '登记已保存，继续核对主机指纹。'); return true;
    }
    if (name === 'cluster-save') {
      const existing = d.id ? state.clusters.find((c) => c.id === d.id) : null;
      if (d.id && !sameRevision(existing, d, formElement)) return true;
      if (!d.name.trim()) return error(formElement, '请填写集群名称。');
      if (state.clusters.some((c) => c.id !== d.id && c.name.toLowerCase() === d.name.trim().toLowerCase())) return error(formElement, '已有同名集群，请使用不同名称。');
      const c = existing || { id: api.uid('cluster'), revision: 0, status: 'unverified', connectionStatus: 'unverified', capabilities: {}, nodes: [], nodeCount: 0, suffix: '', entryAddress: '' };
      Object.assign(c, { name: d.name.trim(), location: (d.location || '').trim(), region: (d.location || '').trim(), description: (d.description || '').trim() }); bump(c);
      if (!existing) state.clusters.unshift(c);
      finishForm(name, d.id, existing ? detailHref('cluster', c.id, ctx, { tab: 'settings' }) : `#/cluster/${c.id}?tab=connection`, '集群资料已保存，固定身份保持不变。'); return true;
    }
    if (name === 'platform-entry' || name === 'cluster-entry') {
      const c = name === 'cluster-entry' ? state.clusters.find((item) => item.id === d.id) : state.platform;
      if (!sameRevision(c, d, formElement)) return true;
      const suffix = d.suffix.trim().toLowerCase();
      if (!safeHostname(suffix) || (name === 'cluster-entry' && suffix.includes('.'))) return error(formElement, '请填写合法域名后缀；集群片段不能包含点或协议。');
      if (name === 'cluster-entry') {
        const address = d.entryAddress.trim();
        if (d.entryType === 'ip' ? !(/^\d{1,3}(\.\d{1,3}){3}$/.test(address) && address.split('.').every((value) => Number(value) <= 255)) && !/^[a-fA-F0-9:]+$/.test(address) : !safeHostname(address)) return error(formElement, '入口地址与类型不匹配，请填写 IP 或合法 CNAME 目标。');
        if (pendingFor(c.id)) return error(formElement, '集群有活动任务，请稍后再更新入口。');
        c.entryType = d.entryType; c.entryAddress = address;
      }
      c.suffix = suffix; c.email = d.email.trim(); bump(c); delete ui.drafts[draftKey(name, d.id)]; flash(ctx, '入口设置已保存。已有绑定保留原域名，可在域名详情重新检查。'); return true;
    }
    if (name === 'cluster-parse') {
      const raw = d.kubeconfig || '';
      const unsafe = /^\s*(exec|auth-provider|proxy-url|certificate-authority|client-certificate|client-key|tokenFile|token-file)\s*:/m.test(raw) || /^\s*insecure-skip-tls-verify\s*:\s*(true|yes|1)/im.test(raw);
      if (unsafe) return error(formElement, '该 kubeconfig 含命令执行、外部文件、代理或跳过 TLS。请使用内嵌 CA 与静态认证的独立配置。');
      if (!/^apiVersion:\s*v1\s*$/m.test(raw) || !/^kind:\s*Config\s*$/m.test(raw)) return error(formElement, '需要 apiVersion: v1、kind: Config 的 kubeconfig。');
      const endpoints = [...raw.matchAll(/^\s*server:\s*["']?(https?:\/\/[^\s"']+)/gm)].map((m) => m[1]);
      if (endpoints.length !== 1 || !endpoints[0].startsWith('https://')) return error(formElement, '请提交只含一个目标的 HTTPS kubeconfig，避免当前上下文含糊。');
      let url;
      try { url = new URL(endpoints[0]); } catch { return error(formElement, 'Kubernetes API 地址格式不正确。'); }
      if (url.username || url.password || url.search || url.hash) return error(formElement, 'API 地址不能携带凭证、查询参数或片段。');
      if (!/^\s*certificate-authority-data:\s*\S+/m.test(raw) || (!/^\s*token:\s*\S+/m.test(raw) && !(/^\s*client-certificate-data:\s*\S+/m.test(raw) && /^\s*client-key-data:\s*\S+/m.test(raw)))) return error(formElement, '需要内嵌 CA，以及静态令牌或完整的内嵌客户端证书与私钥。');
      if (!/^current-context:\s*\S+/m.test(raw) || !/^contexts:\s*$/m.test(raw)) return error(formElement, '缺少明确的 contexts 与 current-context，请核对配置。');
      const existing = d.id ? state.clusters.find((c) => c.id === d.id) : null;
      if (d.id && !sameRevision(existing, d, formElement)) return true;
      const identity = d.observedIdentity?.trim() || `kube-system-demo-${url.hostname.replace(/[^a-z0-9]/gi, '-')}`;
      if (existing?.identity && existing.identity !== identity) return error(formElement, '观察到的 kube-system UID 与原集群不同。更新连接不能把已有项目重定向到其他集群。');
      if (state.clusters.some((c) => c.id !== d.id && (c.identity === identity || c.endpoint === endpoints[0]))) return error(formElement, '这个集群身份或 API 已登记，请进入原集群更新连接。');
      const preview = { id: d.id || '', revision: Number(d.revision), name: d.name.trim(), endpoint: endpoints[0], identity, credentialKind: 'kubeconfig' };
      formElement.querySelectorAll('[data-mg-secret]').forEach((input) => { input.value = ''; });
      openDialog('cluster-import-save', preview, origin, (value) => form('cluster-import-save', revisionInput(value) + facts([['集群名称', e(value.name)], ['Kubernetes API', `<code>${e(value.endpoint)}</code>`], ['演示观察到 UID', `<code>${e(value.identity)}</code>`], ['TLS / 认证', '内嵌 CA · 静态认证 · 秘密输入已清空'], ['能力核对', '导入后独立验证 RBAC、入口、存储与指标']]) + check('已核对这个固定集群身份与连接目标', 'ack', value.ack) + notice('这里只解析结构并演示身份核对，没有联网验证。确认后创建独立导入任务，失败可回到输入重新核对。'), '确认并导入连接', btn('返回修改', 'cluster-import-back')), '核对集群连接', '', { preview }); return true;
    }
    if (name === 'cluster-import-save') {
      const preview = dialog?.preview;
      if (!preview || !d.ack) return error(formElement, '请明确确认预览中的集群身份。');
      let c = preview.id ? state.clusters.find((item) => item.id === preview.id) : null;
      if (preview.id && (!sameRevision(c, d, formElement) || (c.identity && c.identity !== preview.identity))) return true;
      if (c && pendingFor(c.id)) return error(formElement, '集群仍有活动任务，请先核对原任务。');
      if (!c) { c = { id: api.uid('cluster'), name: preview.name, revision: 1, status: 'unverified', connectionStatus: 'unverified', nodes: [], capabilities: {}, suffix: '', nodeCount: 0 }; state.clusters.unshift(c); }
      const fixed = { ...preview, id: c.id };
      queue(c, { type: 'cluster-import', name: `${preview.name} · 导入连接`, snapshot: fixed }, (t) => {
        if (c.identity && c.identity !== fixed.identity) { t.status = 'failed'; t.error = '固定集群身份已变化，未更新连接。'; return; }
        const credentialId = api.uid('cred-kube'); state.credentials.unshift({ id: credentialId, name: `${c.name} · Kubernetes 连接`, kind: 'kubeconfig', status: 'active', revision: 1 });
        Object.assign(c, { name: fixed.name, endpoint: fixed.endpoint, identity: fixed.identity, credentialId, status: 'ready', connectionStatus: 'ready', observedAt: api.now(), capabilities: { rbac: true, ingress: true, storage: true, metrics: true, certificate: false } });
        if (!c.nodes.length) c.nodes = [{ id: api.uid('node'), name: 'imported-node-01', uid: api.uid('node-uid'), architecture: 'amd64', cpu: 2, memory: 4, status: 'ready', observedAt: api.now() }]; c.nodeCount = c.nodes.length; bump(c);
        t.result = '演示已核对同一集群身份并保存新的凭证引用；秘密原文未保存。';
      }, origin); ui.dialog = null; return true;
    }
    if (name === 'credential-save') {
      const kind = d.kind;
      if (!credentialKinds.some(([key]) => key === kind)) return error(formElement, '请选择已支持的凭证类型。');
      if (!d.name.trim()) return error(formElement, '请填写凭证名称。');
      if (d.expiresAt && Date.parse(d.expiresAt + 'T23:59:59') < Date.now()) return error(formElement, '新凭证的到期日期不能早于今天。');
      const original = d.replaceId && state.credentials.find((c) => c.id === d.replaceId);
      if (d.replaceId && (!original || original.kind !== kind)) return error(formElement, '替换凭证必须与原引用类型相同。');
      const requiredSecrets = kind === 'ssh' ? ['privateKey'] : kind === 'kubeconfig' ? ['kubeconfig'] : kind === 'builder' ? ['ca', 'certificate', 'privateKey'] : ['secret'];
      if (requiredSecrets.some((key) => !d[key]?.trim())) return error(formElement, '请填写全部必要的示例秘密字段。原型不会保存这些值。');
      const credential = { id: api.uid('cred'), name: d.name.trim(), kind, status: 'active', revision: 1, expiresAt: d.expiresAt || '', description: (d.description || '').trim(), username: ['registry', 'database'].includes(kind) ? d.username.trim() : undefined, createdAt: api.now() };
      state.credentials.unshift(credential);
      formElement.querySelectorAll('[data-mg-secret]').forEach((input) => { input.value = ''; });
      requiredSecrets.forEach((key) => { delete d[key]; });
      delete d.passphrase;
      finishForm(name, '', undefined, '凭证引用已创建，秘密内容已清空。');
      if (original) openDialog('credential-rebind', { oldId: original.id, newId: credential.id }, origin, rebindForm, '选择要切换的引用'); else api.goto('#/settings?tab=credentials'); return true;
    }
    if (name === 'credential-meta') {
      const c = state.credentials.find((item) => item.id === d.id);
      if (!sameRevision(c, d, formElement)) return true;
      if (!d.name.trim()) return error(formElement, '请填写凭证名称。');
      Object.assign(c, { name: d.name.trim(), expiresAt: d.expiresAt || '', description: (d.description || '').trim() }); bump(c);
      c.status = c.expiresAt && Date.parse(c.expiresAt + 'T23:59:59') < Date.now() ? 'expired' : 'active';
      finishForm(name, d.id, '#/settings?tab=credentials', '凭证元数据已保存。'); return true;
    }
    if (name === 'credential-rebind') {
      const before = state.credentials.find((c) => c.id === d.oldId); const after = state.credentials.find((c) => c.id === d.newId);
      if (!before || !after || before.kind !== after.kind || credentialExpired(after)) return error(formElement, '原引用、新凭证类型或到期状态已变化，请重新核对。');
      const selectedRefs = rebindCandidates(before.id).filter((r) => d[`ref:${r.key}`]);
      if (!selectedRefs.length) return error(formElement, '至少选择一个可切换的配置引用。数据库轮换请走独立规划流程。');
      for (const r of selectedRefs) {
        if (pendingFor(r.entity.id)) return error(formElement, `${r.label} 仍有活动任务，请先核对。`);
        if (r.type === 'service' && !editableService(r.entity, formElement)) return true;
        if (r.type === 'integration' && r.entity.kind === 'registry' && ((r.field === 'pullCredentialId' && r.entity.credentialId === after.id) || (r.field === 'credentialId' && r.entity.pullCredentialId === after.id))) return error(formElement, '切换后推送与拉取将使用同一凭证，请为两种身份分别创建凭证。');
      }
      const touched = new Set();
      selectedRefs.forEach((r) => { (r.target || r.entity)[r.field] = after.id; if (touched.has(r.entity.id)) return; touched.add(r.entity.id); if (r.type === 'service') commitServiceDraft(r.entity); else { r.entity.status = 'unverified'; r.entity.validation = '凭证引用已更新，等待重新验证。'; if (r.type === 'server') r.entity.preflight = null; bump(r.entity); } });
      finishForm(name, '', '#/settings?tab=credentials', '选定引用已切换；原凭证与已发布引用保留，请分别重验或部署。'); return true;
    }
    if (name === 'integration-save') {
      const old = d.id ? state.integrations.find((i) => i.id === d.id) : null;
      if (d.id && !sameRevision(old, d, formElement)) return true;
      if (!['github', 'registry', 'builder'].includes(d.kind)) return error(formElement, '连接类型不正确。');
      if (!d.name.trim() || !d.endpoint.trim()) return error(formElement, '请填写名称与地址。');
      if (d.kind === 'registry') {
        if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(d.endpoint.trim()) || !/^[a-z0-9][a-z0-9._/-]*$/.test(d.namespace || '')) return error(formElement, 'Registry 地址只使用主机名与可选端口；命名空间单独填写。');
        if (old && (old.endpoint !== d.endpoint.trim() || old.namespace !== d.namespace)) return error(formElement, 'Registry 地址与命名空间已固定，更换目标请新增连接。');
      }
      else { try { const endpoint = new URL(d.endpoint); if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw Error(); } catch { return error(formElement, '服务地址需要不含内嵌凭证的 HTTPS URL。'); } }
      if (!verifyCredential(d.credentialId, d.kind === 'github' ? 'git' : d.kind)) return error(formElement, '连接凭证缺失、类型不匹配或已到期。');
      if (d.kind === 'registry' && (!verifyCredential(d.pullCredentialId, 'registry') || d.pullCredentialId === d.credentialId)) return error(formElement, '选择独立且未到期的拉取凭证，不能与推送凭证相同。');
      if (old && pendingFor(old.id)) return error(formElement, '连接仍有验证任务，请先核对原结果。');
      if (d.kind === 'builder') {
        if (!d.instanceId?.trim() || !d.buildkitVersion?.trim() || !/^sha256:[a-f0-9]{64}$/.test(d.frontendDigest || '') || !/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(d.identityPublicKey?.trim() || '')) return error(formElement, '请核对固定实例 ID、BuildKit 版本、frontend digest 和 PEM 签名公钥。');
        if (old && (old.instanceId !== d.instanceId.trim() || old.identityPublicKey !== d.identityPublicKey.trim())) return error(formElement, '已有 Builder 的实例 ID 与签名公钥不可更换；请新增连接。');
      }
      const i = old || { id: api.uid(d.kind), revision: 0, kind: d.kind };
      Object.assign(i, { name: d.name.trim(), endpoint: d.endpoint.trim(), credentialId: d.credentialId, status: 'unverified', validation: '连接资料已保存，等待独立验证。' });
      if (d.kind === 'github') i.account = d.account.trim();
      if (d.kind === 'registry') { i.pullCredentialId = d.pullCredentialId; i.authority = d.endpoint.trim(); i.namespace = d.namespace; i.pushVerification = { status: 'unverified' }; i.pullVerification = { status: 'unverified' }; }
      if (d.kind === 'builder') {
        const changed = i.profile?.buildkitVersion !== d.buildkitVersion.trim() || i.profile?.frontendDigest !== d.frontendDigest;
        Object.assign(i, { instanceId: d.instanceId.trim(), identityPublicKey: d.identityPublicKey.trim(), profile: { buildkitVersion: d.buildkitVersion.trim(), frontendDigest: d.frontendDigest }, profileRevision: (i.profileRevision || 0) + (changed ? 1 : 0), platform: d.platform, enabled: Boolean(d.enabled) });
      }
      bump(i); if (!old) state.integrations.unshift(i);
      finishForm(name, d.id, `#/settings?tab=git&kind=${i.kind}`, '连接已保存，下一步验证连接。'); return true;
    }
    if (name === 'webhook-save') {
      const item = state.integrations.find((i) => i.id === d.id);
      if (!sameRevision(item, d, formElement)) return true;
      if (item.kind !== 'github' || item.status !== 'ready' || !verifyCredential(item.credentialId, 'git')) return error(formElement, '请先验证 GitHub 连接与仓库权限。');
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(d.repository) || !verifyCredential(d.credentialId, 'webhook')) return error(formElement, '请填写 owner/repository 并选择未到期的独立签名凭证。');
      const input = { repository: d.repository, credentialId: d.credentialId, id: item.id, revision: item.revision };
      queue(item, { type: 'github-webhook', name: `${item.name} · 注册 Webhook`, snapshot: input }, (t) => { item.webhook = true; item.webhookRepository = input.repository; item.webhookCredentialId = input.credentialId; item.webhookObservedAt = api.now(); bump(item); t.result = '演示注册完成。后续接收事件保留签名、分支与逐服务投递结果。'; }, origin); ui.dialog = null; return true;
    }
    if (name === 'volume-create') {
      const owner = scopeFrom(d, formElement); if (!owner) return true;
      if (!d.name.trim() || d.name.trim().length > 80) return error(formElement, '请输入 1–80 字的数据卷名称。');
      if (state.volumes.some((v) => sameScope(v, d) && v.name.toLowerCase() === d.name.trim().toLowerCase())) return error(formElement, '这个环境已有同名数据卷，请使用不同名称。');
      if (owner.cluster.status !== 'ready' || !owner.cluster.capabilities?.storage) return error(formElement, '目标集群未就绪或缺少存储能力，请先在集群详情核对。');
      const v = { id: api.uid('vol'), name: d.name.trim(), projectId: owner.project.id, environmentId: owner.environment.id, targetId: owner.cluster.id, sizeGiB: Number(d.sizeGiB), capacity: Number(d.sizeGiB), storageClass: 'local-path', status: 'pending', revision: 1, references: [], actualReferences: [], retained: false, protected: Boolean(d.protected), maintenance: null, records: [], node: null, serviceId: null, createdAt: api.now() };
      state.volumes.unshift(v);
      queue(v, { type: 'volume-create', name: `${v.name} · 创建持久卷`, snapshot: { id: v.id, name: v.name, projectId: v.projectId, environmentId: v.environmentId, targetId: v.targetId, sizeGiB: v.sizeGiB, storageClass: v.storageClass }, onFailure: () => { v.status = 'failed'; } }, (t) => { v.status = 'pending'; v.pvc = `pvc-${v.id}`; v.pv = null; v.node = null; v.observedAt = api.now(); t.result = '演示 PVC 已创建，local-path 等待首个使用方调度后绑定。保存挂载草稿并部署，才能观察 PV 与节点。'; }, origin); delete ui.drafts[draftKey(name)]; ui.dialog = null; return true;
    }
    if (name === 'volume-mount-save') {
      const v = getVolume(d.volumeId); const found = reference(d.serviceId); const s = found?.service;
      if (!v || !sameRevision(v, d, formElement)) return true;
      if (!editableService(s, formElement)) return true;
      if (!sameScope(v, { projectId: found.project.id, environmentId: s.environmentId })) return error(formElement, '只能挂载同一项目、同一环境的数据卷。');
      if (v.maintenance || pendingFor(v.id) || !['bound', 'pending'].includes(v.status)) return error(formElement, '卷正在维护、存在活动任务或创建失败，不能添加挂载。');
      const path = d.path.trim();
      if (!path.startsWith('/') || path === '/' || path.split('/').some((segment) => segment === '..' || segment === '.') || /[\r\n\0]/.test(path)) return error(formElement, '挂载路径需要容器内的绝对目录，不能覆盖根目录、路径上跳或包含控制字符。');
      if ((s.draft.mounts || []).some((m) => m.volumeId !== v.id && (m.path === path || m.path.startsWith(path.replace(/\/$/, '') + '/') || path.startsWith(m.path.replace(/\/$/, '') + '/')))) return error(formElement, '挂载路径与其他卷相同或互相覆盖，请使用独立目录。');
      const write = !d.readOnly;
      if (write && Number(s.draft.replicas || 1) > 1) return error(formElement, '本地卷可写挂载只支持一个实例，请先把服务副本设为 1。');
      if (write && volumeRefs(v).some((r) => r.service.id !== s.id && ((r.draft && !r.draft.readOnly) || (r.published && !r.published.readOnly) || r.pending.length || (r.actual && !r.published?.readOnly)))) return error(formElement, '此卷仍被另一个服务可写引用。先移除其草稿并部署，重新核对实际引用后再挂载。');
      s.draft.mounts ||= []; s.draft.mounts = s.draft.mounts.filter((m) => m.volumeId !== v.id); s.draft.mounts.push({ volumeId: v.id, path, readOnly: !write }); commitServiceDraft(s);
      finishForm(name, '', `#/volume/${v.id}`, '挂载已保存到服务草稿，部署成功后才会改变实际挂载。'); return true;
    }
    if (name === 'database-preview') {
      const db = getDatabase(d.databaseId); const found = reference(d.serviceId); const s = found?.service;
      if (!db || !db.identity || !reference(db.serviceId)) return error(formElement, '数据库来源或身份不可用，请重新核对。');
      if (!editableService(s, formElement)) return true;
      if (!sameScope(db, { projectId: found.project.id, environmentId: s.environmentId }) || db.serviceId === s.id || s.draft.type === 'database') return error(formElement, '选择同环境的应用服务，不能连接数据库自身或跨环境服务。');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.variable)) return error(formElement, '变量名只能使用字母、数字和下划线，不能以数字开头。');
      if ((s.draft.variables || []).some((v) => v.key === d.variable) || (s.draft.connections || []).some((c) => c.databaseId !== db.id && c.variable === d.variable)) return error(formElement, '变量名与现有变量或其他数据库映射冲突。');
      const preview = { databaseId: db.id, databaseIdentity: db.identity, serviceId: s.id, variable: d.variable, revision: s.revision };
      openDialog('database-bind', preview, origin, (value) => form('database-bind', `<input type="hidden" name="serviceId" value="${e(s.id)}" /><input type="hidden" name="revision" value="${value.revision}" />${facts([['应用 / 环境', `${e(s.draft.name)} · ${scope(db)}`], ['变量映射', `<code>${e(value.variable)}</code> → ${e(db.name)} 私有连接`], ['数据库身份', `<code>${e(db.identity)}</code>`], ['秘密', '保留凭证引用，不显示密码'], ['生效时间', '保存为草稿，下次部署后注入']])}`, '保存连接草稿', btn('返回修改', 'database-preview-back')), '核对数据库映射', '', { preview }); return true;
    }
    if (name === 'database-bind') {
      const preview = dialog?.preview; const db = preview && getDatabase(preview.databaseId); const found = preview && reference(preview.serviceId); const s = found?.service;
      if (!preview || !db || db.identity !== preview.databaseIdentity || !s || !reference(db.serviceId)) return error(formElement, '数据库或服务身份已变化，请返回重新核对。');
      if (!sameRevision(s, d, formElement) || !editableService(s, formElement)) return true;
      if (!sameScope(db, { projectId: found.project.id, environmentId: s.environmentId })) return error(formElement, '归属已变化，不能跨环境连接。');
      s.draft.connections ||= []; s.draft.connections = s.draft.connections.filter((c) => c.databaseId !== db.id); s.draft.connections.push({ databaseId: db.id, variable: preview.variable }); commitServiceDraft(s);
      finishForm(name, '', `#/database/${db.id}`, '数据库映射已保存为草稿，部署后才会注入应用。'); return true;
    }
    if (name === 'domain-create') {
      const found = reference(d.serviceId); const s = found?.service;
      const problem = domainPrerequisite({ serviceId: d.serviceId, portName: d.portName }); if (problem) return error(formElement, problem);
      const port = publishedHttpPorts(s).find((p) => p.name === d.portName);
      if (!port) return error(formElement, '请选择当前服务已发布的具体 HTTP 端口。');
      if ((d.projectId && d.projectId !== found.project.id) || (d.environmentId && d.environmentId !== s.environmentId)) return error(formElement, '所选服务不属于当前筛选的项目与环境。');
      const cluster = api.targetFor(found.project); const prefix = d.prefix.trim().toLowerCase();
      if (!safeHostname(prefix) || prefix.includes('.')) return error(formElement, '域名前缀需要单个合法名称，不能包含点或协议。');
      const hostname = `${prefix}.${cluster.suffix}.${state.platform.suffix}`;
      if (state.domains.some((item) => item.hostname === hostname)) return error(formElement, '这个域名已经绑定，请打开原绑定或更换前缀。');
      const domain = { id: api.uid('domain'), name: hostname, hostname, projectId: found.project.id, environmentId: s.environmentId, serviceId: s.id, targetId: cluster.id, port: port.port, portName: port.name, target: cluster.entryAddress, status: 'pending', dns: 'pending', route: 'pending', tls: 'pending', certificate: 'staging', revision: 1 };
      state.domains.unshift(domain);
      queue(domain, { type: 'domain-create', name: `${hostname} · 分配并检查`, snapshot: { id: domain.id, hostname, serviceId: s.id, portName: domain.portName, port: domain.port, targetId: cluster.id, certificate: 'staging', revision: s.publishedRevision }, onFailure: (t) => { domain.status = 'failed'; t.error = '演示域名检查失败。DNS、路由与 TLS 尚未给出通过观察，可在绑定详情重新检查。'; } }, (t) => { const latest = domainPrerequisite(domain); if (latest) { t.status = 'failed'; t.error = latest; domain.status = 'failed'; return; } Object.assign(domain, { status: 'ready', dns: 'ready', route: 'ready', tls: 'ready', observedAt: api.now() }); t.result = '演示 staging 观察已通过。生产证书仍需单独申请。'; }, origin); ui.dialog = null; return true;
    }
    if (name === 'maintenance-enter') {
      const v = getVolume(d.id);
      if (!sameRevision(v, d, formElement)) return true;
      if (v.maintenance || pendingFor(v.id)) return error(formElement, '目标卷已进入维护或仍有原任务，请先核对。');
      if (!d.ack) return error(formElement, '请确认已经核对维护对象与服务影响。');
      if (target(v).status !== 'ready') return error(formElement, '目标集群尚未就绪，不能开始维护任务。');
      if (!['backup', 'restore'].includes(d.mode)) return error(formElement, '维护模式无效。');
      let source;
      if (d.mode === 'restore') {
        source = backupRecords().find((r) => r.id === d.recordId);
        if (!source || source.volume.id === v.id || !sameScope(source.volume, v) || source.result !== 'passed' || source.integrity !== 'passed') return error(formElement, '恢复需要同环境、不同源卷且完整性通过的已登记备份。');
        if (volumeRefs(v).length || v.databaseId || v.dataEngine || (v.records || []).some((r) => r.type === 'restore' && r.result === 'passed')) return error(formElement, '恢复目标必须是没有已有身份或数据的新卷，不能覆盖当前数据。');
      }
      if (volumeRefs(v).some((r) => pendingFor(r.service.id))) return error(formElement, '引用服务仍有活动或结果未知的任务，请先核对。');
      const m = { id: api.uid('maintenance'), mode: d.mode, status: 'entering', startedAt: api.now(), sourceId: source?.volume.id || v.id, targetId: d.mode === 'restore' ? v.id : null, recordId: source?.id || null, engine: source?.engine || engineFor(v) };
      v.maintenance = m;
      const task = queue(v, { type: 'volume-maintenance-enter', name: `${v.name} · 进入${d.mode === 'restore' ? '恢复' : '备份'}维护`, snapshot: { ...m, volumeId: v.id, revision: v.revision }, onFailure: (t) => { m.status = 'failed-locked'; m.taskId = t.id; t.result = '维护任务失败；保留锁，需要核对实际 helper 与挂载后退出。'; } }, (t) => { if (v.maintenance?.id !== m.id) { t.status = 'failed'; t.error = '维护身份不一致，不能更新其他维护窗口。'; return; } m.status = 'active'; m.taskId = t.id; m.helper = d.mode === 'restore' ? 'new-target-restore-helper' : 'read-only-maintenance-helper'; m.writers = 'quiesced'; v.status = 'bound'; v.pvc ||= `pvc-${v.id}`; v.pv ||= `pv-${v.id}`; v.node ||= target(v).nodes?.[0]?.name || null; v.observedAt = api.now(); t.result = '演示维护 helper 与目标卷绑定已就绪。尚未执行备份或恢复，请按指引操作并登记证据。'; }, origin);
      m.taskId = task.id; ui.dialog = null; return true;
    }
    if (name === 'maintenance-exit-save') {
      const v = getVolume(d.id); const m = v?.maintenance;
      if (!sameRevision(v, d, formElement)) return true;
      if (!m || m.id !== d.maintenanceId) return error(formElement, '维护窗口已变化，请重新核对。');
      if (pendingFor(v.id)) return error(formElement, '维护相关任务仍在执行或结果未知，不能直接解除锁。');
      if (!d.helperRemoved || !d.mountsVerified || !d.evidence.trim()) return error(formElement, '退出需要完整核对 helper、实际挂载和写入状态，并登记证据。');
      const safeEvidence = d.evidence.trim(); m.status = 'exiting';
      const task = queue(v, { type: 'volume-maintenance-exit', name: `${v.name} · 退出维护核验`, snapshot: { volumeId: v.id, maintenanceId: m.id, helperRemoved: true, mountsVerified: true, evidence: safeEvidence }, onFailure: (t) => { m.status = 'failed-locked'; m.taskId = t.id; t.result = '退出核验失败，维护锁保留。'; } }, (t) => { if (v.maintenance?.id !== m.id) { t.status = 'failed'; t.error = '维护窗口已变化，未解除其他维护锁。'; return; } v.maintenanceHistory ||= []; v.maintenanceHistory.unshift({ ...m, finishedAt: api.now(), exitTaskId: t.id, exitEvidence: safeEvidence }); v.maintenance = null; v.observedAt = api.now(); t.result = '演示已核对 helper 移除与实际挂载 / 写入恢复，维护锁已解除。'; }, origin);
      m.taskId = task.id; ui.dialog = null; return true;
    }
    if (name === 'record-save') {
      const v = getVolume(d.volumeId); const m = v?.maintenance; const task = m && state.tasks.find((t) => t.id === m.taskId);
      if (!v || !m || m.id !== d.maintenanceId || m.mode !== d.type || m.status !== 'active' || task?.status !== 'succeeded') return error(formElement, '需要同一维护窗口的确定成功任务。维护状态已变化，不能把未知执行登记为通过。');
      if (!d.ack) return error(formElement, '请确认这里只登记已经完成的操作与验证证据。');
      const source = m.mode === 'restore' ? backupRecords().find((r) => r.id === m.recordId) : null;
      if (m.mode === 'restore' && (!source || source.volume.id === v.id || source.backupId !== d.backupId)) return error(formElement, '恢复必须固定引用已登记备份，并使用不同的新目标。');
      if (m.mode === 'backup' && backupRecords().some((r) => r.backupId === d.backupId.trim())) return error(formElement, '备份 ID 已登记，请使用新的 ID，旧记录不会覆盖。');
      const start = Date.parse(d.startedAt); const end = Date.parse(d.finishedAt); const dataTime = Date.parse(d.dataAt);
      if (![start, end, dataTime].every(Number.isFinite) || start > end || dataTime > end || end > Date.now() + 60000) return error(formElement, '请核对执行时间顺序；数据时间不能晚于执行结束，结束时间不能在未来。');
      if (!/^[a-fA-F0-9]{64}$/.test(d.sha256) || !Number.isSafeInteger(Number(d.sizeBytes)) || Number(d.sizeBytes) <= 0) return error(formElement, '需要完整的 64 位 SHA256 与正整数文件字节数。');
      if (source && (d.sha256.toLowerCase() !== source.sha256.toLowerCase() || Number(d.sizeBytes) !== Number(source.sizeBytes) || d.version !== source.version || d.format !== source.format)) return error(formElement, '恢复的源备份格式、hash、大小与引擎版本必须与已登记记录一致；Redis AOF 转换等结果请记入验证证据。');
      if (!['passed', 'failed'].includes(d.result) || !['passed', 'failed'].includes(d.integrity)) return error(formElement, '请明确选择结果与完整性状态。');
      if (d.result === 'passed' && d.integrity !== 'passed') return error(formElement, '完整性未通过时不能登记操作通过。');
      if ([d.location, d.verification, d.evidence, d.toolVersion, d.version, d.backupId].some((value) => !value?.trim())) return error(formElement, '请填写离机位置、版本、验证方法和证据，不能只登记成功状态。');
      if (/https?:\/\/[^\s/]+:[^\s/]+@|(?:access_token|password|secret_key)\s*[=:]/i.test(`${d.location} ${d.evidence}`)) return error(formElement, '证据与位置中不要包含访问密钥或内嵌密码，请改为不含秘密的引用。');
      const engine = source?.engine || engineFor(v);
      const record = { id: api.uid('record'), type: m.mode, backupId: d.backupId.trim(), sourceId: source?.volume.id || v.id, targetId: m.mode === 'restore' ? v.id : null, sourceRecordId: source?.id || null, maintenanceId: m.id, engine, version: d.version.trim(), format: d.format, toolVersion: d.toolVersion.trim(), sizeBytes: Number(d.sizeBytes), sha256: d.sha256.toLowerCase(), startedAt: new Date(start).toISOString(), finishedAt: new Date(end).toISOString(), dataAt: new Date(dataTime).toISOString(), location: d.location.trim(), integrity: d.integrity, result: d.result, verification: d.verification.trim(), evidence: d.evidence.trim(), createdAt: api.now() };
      v.records ||= []; v.records.unshift(record); if (m.mode === 'restore' && record.result === 'passed') v.dataEngine = engine;
      finishForm(name, '', `#/volume/${v.id}?tab=records`, '证据已登记。没有执行导出、恢复或实际数据验证；维护锁仍保留。'); return true;
    }
    if (name === 'task-reconcile-save') {
      const t = state.tasks.find((item) => item.id === d.taskId);
      if (!t || t.status !== 'unknown') return error(formElement, '原任务状态已变化，请重新打开核对。');
      if (!d.ack || !d.evidence.trim()) return error(formElement, '请核对原任务与目标，填写独立完成证据。');
      if (!['succeeded', 'failed', 'unknown'].includes(d.observed)) return error(formElement, '请选择明确的观察结果。');
      const text = `演示对账：${d.evidence.trim()}`;
      t.logs.push(text); t.reconciliation = text;
      if (d.observed === 'unknown') { finishForm(name, '', `#/task/${t.id}`, '仍无法确定，原任务与资源锁保持。'); return true; }
      t.status = d.observed; t.outcome = d.observed; t.finishedAt = api.now();
      if (d.observed === 'succeeded') {
        if (!t._onSuccess) { t.status = 'unknown'; t.finishedAt = null; return error(formElement, '此记录缺少可核对的固定操作处理器，不能仅凭状态选择标记完成。'); }
        t._onSuccess(t);
        if (t.status === 'succeeded') { t.stages.forEach((stage) => { stage.status = 'succeeded'; }); t.result ||= '原任务完成证据已核对。'; }
      } else { t.error = '已核对原任务明确失败，允许在保留历史的前提下创建独立重试。'; if (t.stages.length) t.stages[t.stages.length - 1].status = 'failed'; t.onFailure?.(t); }
      finishForm(name, '', `#/task/${t.id}`, '原任务核对结果已记录，未创建新的资源操作。'); return true;
    }
    if (name === 'project-save') {
      const p = state.projects.find((item) => item.id === d.id);
      if (!sameRevision(p, d, formElement)) return true;
      if (!d.name.trim() || d.name.trim().length > 80) return error(formElement, '项目名称需要 1–80 字。');
      if (state.projects.some((item) => item.id !== p.id && item.name.toLowerCase() === d.name.trim().toLowerCase())) return error(formElement, '已有同名项目，请换一个名称。');
      p.name = d.name.trim(); p.description = (d.description || '').trim(); bump(p); delete ui.drafts[draftKey(name, p.id)]; flash(ctx, '项目资料已保存。环境、服务与部署位置保持原归属。'); return true;
    }
    if (name === 'environment-save') {
      const p = state.projects.find((item) => item.id === d.projectId);
      if (!p) return error(formElement, '项目已不存在。');
      const old = d.id ? p.environments.find((env) => env.id === d.id) : null;
      if (d.id && !sameRevision(old, d, formElement)) return true;
      if (!d.name.trim() || !safeSlug(d.slug)) return error(formElement, '环境名称不能为空；标识以小写字母开头，可含数字和短横线，最多 48 字符。');
      if (p.environments.some((env) => env.id !== d.id && (env.name.toLowerCase() === d.name.trim().toLowerCase() || env.slug === d.slug))) return error(formElement, '当前项目已有同名或同标识环境。');
      if (old && old.slug !== d.slug) return error(formElement, '已有环境的稳定标识不能通过资料编辑改变。');
      const env = old || { id: api.uid(`${p.id}-env`), slug: d.slug, revision: 0 };
      env.name = d.name.trim(); env.description = (d.description || '').trim(); bump(env); if (!old) p.environments.push(env); bump(p);
      finishForm(name, d.id, api.projectUrl(p, '/settings', origin.environment?.id || p.lastEnvironmentId), old ? '环境资料已保存。' : '环境已创建。通过“切换”明确进入；没有复制其他环境数据。'); return true;
    }
    return false;
  }

  function change(event, ctx) {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return false;
    if (el.hasAttribute('data-mg-secret')) return true;
    if (el.hasAttribute('data-mg-theme')) {
      if (event.type !== 'change') return true;
      const value = el.value;
      if (!['light', 'dark', 'system'].includes(value)) return true;
      state.theme = value; state.platform.theme = value;
      document.documentElement.dataset.theme = value === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : value;
      try { localStorage.setItem('ozz-v3-prototype-theme', value); } catch {}
      redraw(); return true;
    }
    if (el.dataset.mgFilter) {
      if (event.isComposing || state.composing || (el.tagName === 'SELECT' && event.type !== 'change')) return true;
      const [path, query = ''] = location.hash.split('?');
      const params = new URLSearchParams(query); const key = el.dataset.mgFilter;
      if (el.value) params.set(key, el.value); else params.delete(key);
      params.delete('page');
      if (key === 'project') { params.delete('env'); params.delete('service'); }
      if (key === 'env') params.delete('service');
      const href = path + (params.size ? '?' + params : '');
      if (key === 'q') { history.replaceState(history.state, '', href); api.render(); }
      else api.goto(href);
      return true;
    }
    if (el.dataset.mgGuide) {
      if (event.type === 'change') { ui.drafts[`guide:${el.dataset.mgGuide}`] = { engine: el.value }; redraw(); }
      return true;
    }
    if (!el.hasAttribute('data-mg-field')) return false;
    if (el.tagName === 'SELECT' && event.type !== 'change') return true;
    const fieldName = el.dataset.mgField;
    const formElement = el.closest('form[data-mg-draft]');
    const name = formElement?.dataset.mgDraft;
    const inDialog = el.closest('.dialog') && ui.dialog && state.modal?.type === 'custom';
    if (!formElement && !inDialog) return true;
    const recordId = formElement?.querySelector('[name="id"]')?.value || '';
    const key = draftKey(name, recordId);
    const current = inDialog ? ui.dialog.draft : ui.drafts[key] || {};
    if (fieldName === 'kind' && name === 'credential-save') {
      const dialog = ui.dialog, parent = state.modal;
      const nextKind = el.value, previous = dialog?.draft.kind || 'ssh';
      el.value = previous;
      if (!inDialog || parent.management !== dialog || dialog.kindConfirmation || nextKind === previous || !credentialKinds.some(([kind]) => kind === nextKind)) return true;
      const secrets = secretSnapshot(formElement, dialog, parent);
      const hasInput = [...formElement.querySelectorAll('[data-mg-secret], [name="username"]')].some((input) => input.value.length > 0);
      const apply = () => {
        secrets.clear(); dialog.kindConfirmation = false;
        if (ui.dialog !== dialog || parent.route !== location.hash) return;
        dialog.draft = { ...current, kind: nextKind, username: '' }; dialog.revealSecret = false;
        ui.drafts[key] = { ...dialog.draft }; delete ui.formErrors[name];
        state.modal = parent; api.render();
        requestAnimationFrame(() => { if (state.modal === parent) document.getElementById('mg-credential-save-kind')?.focus({ preventScroll: true }); });
      };
      if (hasInput) {
        dialog.kindConfirmation = true;
        api.confirm({ title: '切换凭证类型？', description: `切换到「${kindName(nextKind)}」会清空当前类型的输入。名称和到期日期会保留。`, confirmText: '清空并切换', pendingLabel: '正在切换类型…', onCancel: () => { dialog.kindConfirmation = false; secrets.restore(); }, onConfirm: apply });
      } else apply();
      return true;
    }
    const draft = { ...current };
    if (formElement) formElement.querySelectorAll('[data-mg-field],input[type="hidden"]').forEach((input) => {
      if (input.hasAttribute('data-mg-secret') || !input.name) return;
      draft[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    });
    else draft[fieldName] = el.type === 'checkbox' ? el.checked : el.value;
    if (fieldName === 'projectId') {
      const project = state.projects.find((p) => p.id === draft.projectId);
      draft.environmentId = project?.environments.length === 1 ? project.environments[0].id : '';
    }
    if (fieldName === 'serviceId') {
      const s = reference(draft.serviceId)?.service;
      draft.serviceRevision = s?.revision;
      if (name === 'domain-create' && !draft.prefix) draft.prefix = s?.draft.slug || '';
      if (name === 'domain-create') draft.portName = publishedHttpPorts(s)[0]?.name || '';
    }
    if (fieldName === 'repository' && ui.dialog?.name === 'github-browse') draft.branch = 'main';
    if (inDialog) ui.dialog.draft = draft;
    if (name) { ui.drafts[key] = draft; delete ui.formErrors[name]; }
    if (['kind', 'projectId', 'environmentId', 'serviceId', 'repository', 'branch', 'entryType', 'portName'].includes(fieldName) && !event.isComposing && !state.composing) redraw();
    return true;
  }

  function init(value) {
    api = value; state = value.state;
    ['servers', 'clusters', 'projects', 'volumes', 'databases', 'domains', 'credentials', 'integrations', 'tasks', 'gitEvents', 'planningRuns'].forEach((key) => { state[key] ||= []; });
    state.platform ||= { suffix: 'ozz.test', email: 'admin@example.test', theme: state.theme || 'light' };
    state.platform.revision ||= 1;
    state.worker ||= { status: 'ready', redis: 'ready', heartbeat: null, queued: 0, pending: 0 };
    state.servers.forEach((s) => {
      s.revision ||= 1; s.address ||= s.host; s.user ||= s.sshUser || 'deploy'; s.port ||= s.sshPort || 22;
      s.fingerprintConfirmed ??= Boolean(s.verified); if (s.verified && !s.fingerprint) s.fingerprint = `SHA256:DEMO-${s.id}-host-fingerprint`;
      if (s.verified) s.os ||= 'Ubuntu 24.04 LTS';
    });
    state.clusters.forEach((c) => {
      c.revision ||= 1; c.capabilities ||= {}; c.nodes ||= [];
      if (c.status === 'ready') {
        c.identity ||= `kube-system-demo-${c.id}`; c.capabilities.rbac ??= true;
        const s = state.servers.find((item) => item.id === c.serverId);
        c.entryType ||= 'ip'; c.entryAddress ||= s?.address || ''; c.email ||= state.platform.email;
        if (!c.credentialId) {
          c.credentialId = `cred-kube-${c.id}`;
          if (!state.credentials.some((cred) => cred.id === c.credentialId)) state.credentials.push({ id: c.credentialId, name: `${c.name} · Kubernetes`, kind: 'kubeconfig', status: 'active', revision: 1 });
        }
        if (!c.nodes.length) c.nodes = [{ id: `node-${c.id}`, name: c.name.toLowerCase(), uid: `node-uid-demo-${c.id}`, architecture: 'amd64', cpu: c.cpu || 2, memory: c.memory || 4, status: 'ready', observedAt: c.observedAt }];
      }
      c.nodeCount = c.nodes.length;
    });
    state.projects.forEach((p) => { p.revision ||= 1; p.environments.forEach((env) => { env.revision ||= 1; }); });
    state.credentials.forEach((c) => { c.revision ||= 1; });
    state.integrations.forEach((i) => { i.revision ||= 1; if (i.kind === 'builder') { i.profile = typeof i.profile === 'object' ? i.profile : { buildkitVersion: 'v0.16.0', frontendDigest: 'sha256:' + 'b'.repeat(64) }; i.profileRevision ||= 1; i.identityPublicKey ||= '-----BEGIN PUBLIC KEY-----\nREVNTy1QVUJMSUMtS0VZLU9OTFk=\n-----END PUBLIC KEY-----'; } if (i.kind === 'registry') { i.authority ||= i.endpoint; i.namespace ||= 'demo'; } });
    state.volumes.forEach((v) => { v.revision ||= 1; v.records ||= []; v.references ||= []; v.maintenance ??= null; if (v.status === 'bound') { v.pvc ||= `pvc-${v.id}`; v.pv ||= `pv-${v.id}`; } });
    state.databases.forEach((db) => { db.revision ||= 1; });
    state.domains.forEach((d) => { d.revision ||= 1; d.name ||= d.hostname; });
  }
  function render(ctx) {
    if (!api) return '';
    const pages = { servers: serversPage, server: serverPage, cluster: clusterPage, settings: settingsPage, resources: resourcesPage, volume: volumePage, database: databasePage, domain: domainPage, activity: activityPage, task: taskPage, 'project-settings': projectSettingsPage, 'project-integrations': projectIntegrationsPage, planning: planningPage };
    const handler = pages[ctx.kind];
    if (!handler) return '';
    if (['resources', 'activity'].includes(ctx.kind) && (ctx.params.has('project') || ctx.params.has('env'))) {
      const project = state.projects.find((p) => p.id === ctx.params.get('project'));
      const badProject = ctx.params.has('project') && !project;
      const badEnvironment = ctx.params.has('env') && (!project || !project.environments.some((env) => env.id === ctx.params.get('env')));
      if (badProject || badEnvironment) return `<main class="content mg-page">${header('请选择有效的资源范围')}${notice(badProject ? '筛选中的项目已不存在。请清空范围后重新选择。' : '筛选中的环境不属于这个项目，或链接缺少项目。不会自动切换到 production。', 'error')}${link('清空项目与环境筛选', queryHref(ctx.kind, { project: '', env: '', service: '', page: '' }, ctx))}</main>`;
    }
    return `<main class="content mg-page">${message(ctx)}${state.scenario === 'page-error' ? notice('刷新失败，保留上次已加载内容与观察时间。可切回正常演示场景后重新查看。', 'error') : ''}${handler(ctx)}</main>`;
  }
  window.OzzManagement = { init, render, action, submit, change, preserveInputs };
})();
