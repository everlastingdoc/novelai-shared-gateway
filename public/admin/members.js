import { initGallery } from './gallery.js';

const $ = id => document.getElementById(id);

const gallery = initGallery({
  api,
  getToken: () => $('adminToken').value,
  notice
});

let state = null;
let upstream = null;
let publicBase = '';
let busy = false;
let editing = false;
let shares = {};
let shareMode = 'equal';
let selectedMember = null;
let confirmTask = null;
let noticeTimer = null;
let transferEntireBalance = false;

const STATUS_META = {
  active: { label: '账号可用', tone: 'ok' },
  cooldown: { label: '请求冷却中', tone: 'warn' },
  pending_opus: { label: '等待接入', tone: 'warn' },
  stale: { label: '等待同步', tone: 'warn' },
  renewal_pending: { label: '确认续期中', tone: 'warn' },
  unknown_balance: { label: '余额未知', tone: 'warn' },
  inactive_opus: { label: '账号已暂停', tone: 'danger' },
  quota_sync_error: { label: '同步失败', tone: 'danger' }
};

const TRANSFER_NAMES = {
  v5: 'V5 余量',
  anlasFixed: '订阅点数',
  anlasPurchased: '购买点数'
};

const number = value => (
  value === null || value === undefined
    ? '—'
    : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 3 })
);

const percent = value => `${number(Number(value || 0) * 100)}%`;

const formatTime = value => (value ? new Date(value).toLocaleString('zh-CN') : '尚未同步');

const memberName = u => u.username || u.note || u.id;

function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function createActivityIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon icon-sm');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', '22 12 18 12 15 21 9 3 6 12 2 12');
  svg.append(poly);
  return svg;
}

function meterTone(ratio, over = false) {
  if (over) return 'is-over';
  if (ratio < 0.15) return 'is-danger';
  if (ratio < 0.35) return 'is-warn';
  if (ratio >= 0.7) return 'is-ok';
  return '';
}

function notice(text, error = false) {
  clearTimeout(noticeTimer);
  const el = $('message');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('error', Boolean(text && error));
  el.classList.toggle('is-ok', Boolean(text && !error));
  if (text && !error) {
    noticeTimer = setTimeout(() => {
      el.hidden = true;
    }, 6000);
  }
}

function modal(id) {
  $(id).showModal();
}

function requireSaved() {
  if (editing) throw new Error('请先保存或取消份额调整。');
}

async function api(path = '/api/admin/member-management', body, method) {
  const response = await fetch(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      'x-admin-token': $('adminToken').value,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('响应异常，请检查管理隧道是否连接。');
  }
  if (!response.ok) {
    throw new Error(result.message || result.error?.message || result.error || '请求失败');
  }
  return result;
}

const manage = body => api('/api/admin/member-management' + (body === undefined ? '?model=single' : ''), body);

function updateButtons() {
  const unavailable = !state || state.migrationPending || busy;
  for (const id of ['newMember', 'editShares']) {
    $(id).disabled = unavailable || editing;
  }
  for (const id of [
    'connectSubmit',
    'saveMember',
    'equalize',
    'cancelShares',
    'confirmAction',
    'refresh',
    'refreshUpstream',
    'toggleUpstream',
    'saveUpstreamPst',
    'syncPeriod'
  ]) {
    $(id).disabled = busy || (Boolean(state) && ['refreshUpstream', 'toggleUpstream', 'saveUpstreamPst'].includes(id) && !upstream);
  }
  $('saveShares').disabled = busy || !validShares();
  $('confirmTransfer').disabled = busy || !validTransfer();
  $('transferAll').disabled = busy || !(transferMaximum() > 0);

  const rowDisabled = busy || editing || Boolean(state?.migrationPending);
  document.querySelectorAll('[data-member-manage], [data-member-action]').forEach(el => {
    const blockedBySingle = el.dataset.memberAction === 'transfer' && (
      !state || state.users.length <= 1 || el.dataset.transferBlocked === 'true'
    );
    el.disabled = rowDisabled || blockedBySingle;
  });
}

function run(fn) {
  return async event => {
    event?.preventDefault();
    if (busy) return;
    busy = true;
    updateButtons();
    notice('');
    try {
      await fn(event);
    } catch (e) {
      notice(e.message, true);
    } finally {
      busy = false;
      updateButtons();
    }
  };
}

function tab(id) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.tab === id));
  });
  for (const panel of ['membersPanel', 'settingsPanel', 'galleryPanel']) {
    $(panel).hidden = panel !== id;
  }
  if (id === 'galleryPanel') gallery.show();
  else gallery.hide();
}

function currentTotals() {
  return state.users.reduce((out, u) => {
    for (const field of ['v5Available', 'anlasFixedAvailable', 'anlasPurchasedAvailable']) {
      out[field] += u.quota?.[field] || 0;
    }
    return out;
  }, { v5Available: 0, anlasFixedAvailable: 0, anlasPurchasedAvailable: 0 });
}

function validShares() {
  const values = Object.values(shares);
  return (
    Boolean(state) &&
    values.length === state.users.length &&
    values.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Math.abs(values.reduce((n, v) => n + v, 0) - 1) <= 1e-6
  );
}

function renderOverview() {
  const s = state.shared || {};
  const rawStatus = s.status || state.status;
  const statusInfo = STATUS_META[rawStatus] || { label: '等待核验', tone: 'warn' };

  $('overviewAnlas').textContent = number(s.anlasFixed);
  $('overviewDate').textContent = s.expiresAt
    ? '续期 ' + new Date(s.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '等待同步';

  const hasPurchased = s.anlasPurchased > 0;
  $('overviewPurchased').hidden = !hasPurchased;
  if (hasPurchased) {
    $('overviewPurchased').textContent = '购买点数 ' + number(s.anlasPurchased);
  }

  const hasV5 = s.v5Percent !== null && s.v5Percent !== undefined;
  const v5Pct = hasV5 ? Math.max(0, Math.min(100, Number(s.v5Percent))) : 0;
  $('overviewV5').textContent = hasV5 ? `${number(s.v5Percent)}%` : '—';
  $('overviewBar').style.width = `${v5Pct}%`;
  $('overviewBar').className = 'meter-fill ' + meterTone(v5Pct / 100);
  $('overviewMeter').setAttribute('aria-valuenow', String(Math.round(v5Pct)));

  const hasRefill = s.refillSecondsPerPercent > 0;
  $('overviewRecovery').hidden = !hasRefill;
  if (hasRefill) {
    $('overviewRecovery').textContent = `1% / ${number(s.refillSecondsPerPercent / 60)} 分钟`;
  }

  $('overviewQueue').textContent = `${s.running || 0} / ${s.queued || 0}`;
  const enabledCount = state.users.filter(u => u.enabled).length;
  $('overviewMembers').textContent = `${enabledCount} 位启用 · 上限 ${s.concurrencyLimit || 4} 并发`;

  $('overviewStatus').className = `pill pill-sm pill-${statusInfo.tone}`;
  $('overviewStatusDot').className = `dot dot-${statusInfo.tone}`;
  $('overviewStatusText').textContent = statusInfo.label;

  $('connectedHint').textContent = '已连接 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });

  $('tabMemberBadge').textContent = String(state.users.length);
  $('tabMemberBadge').hidden = false;

  const isEqual = state.shareMode === 'equal';
  $('shareModeBadge').textContent = isEqual ? '均分' : '自定义份额';
  $('shareModeBadge').className = `pill pill-sm ${isEqual ? 'pill-accent' : 'pill-muted'}`;

  const legacy = state.subscriptionCycle?.legacyPending;
  const renewal = state.status === 'renewal_pending';
  const bad = !['active', 'cooldown'].includes(rawStatus);
  const showNotice = Boolean(state.migrationPending || legacy || renewal || bad);

  const syncEl = $('syncNotice');
  syncEl.hidden = !showNotice;
  const severe = !state.migrationPending && !legacy && ['inactive_opus', 'quota_sync_error'].includes(rawStatus);
  syncEl.classList.toggle('notice-danger', severe);
  syncEl.classList.toggle('notice-warn', !severe);

  $('syncText').textContent = state.migrationPending
    ? '还有请求在处理，完成后刷新即可调整成员额度。'
    : legacy
      ? '旧账本需要同步本期订阅点数（保留本期消费、V5 与购买点数）。'
      : renewal
        ? '正在确认新的订阅周期，完成后自动分配本期点数。'
        : '账号状态需要更新，请向官方刷新额度。';
  $('syncPeriod').hidden = Boolean(state.migrationPending);
  $('syncPeriod').textContent = legacy ? '同步本期点数' : '向官方刷新';
}

function renderTelemetry(summary) {
  const strip = $('telemetryStrip');
  const stats = summary?.jobStats1h || {};
  const done = Number(stats.done || 0);
  const failed = Number(stats.failed || 0);
  const speed = summary?.generationSpeed1h || {};
  const v5 = speed.v5;
  const v45 = speed.v45;

  const hasJobs = done + failed > 0;
  const hasV5 = Boolean(v5 && Number(v5.count) > 0 && Number.isFinite(Number(v5.seconds)));
  const hasV45 = Boolean(v45 && Number(v45.count) > 0 && Number.isFinite(Number(v45.seconds)));

  if (!hasJobs && !hasV5 && !hasV45) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }

  const items = [];
  const label = node('span', undefined, 'telemetry-label');
  label.append(createActivityIcon(), document.createTextNode('近 1h'));
  items.push(label);

  if (hasJobs) {
    const jobChunk = node('span');
    jobChunk.append(
      document.createTextNode('成功 '),
      node('span', String(done), 'telemetry-val is-ok'),
      document.createTextNode(' / 失败 '),
      node('span', String(failed), failed > 0 ? 'telemetry-val is-danger' : 'telemetry-val')
    );
    items.push(jobChunk);
  }

  if (hasV5) {
    if (items.length > 1) items.push(node('span', '·', 'telemetry-sep'));
    const chunk = node('span');
    chunk.append(
      document.createTextNode('V5 均耗时 '),
      node('span', `${Number(v5.seconds).toFixed(1)}s`, 'telemetry-val')
    );
    items.push(chunk);
  }

  if (hasV45) {
    if (items.length > 1) items.push(node('span', '·', 'telemetry-sep'));
    const chunk = node('span');
    chunk.append(
      document.createTextNode('V4.5 均耗时 '),
      node('span', `${Number(v45.seconds).toFixed(1)}s`, 'telemetry-val')
    );
    items.push(chunk);
  }

  strip.replaceChildren(...items);
  strip.hidden = false;
}

function shareSummary() {
  const values = Object.values(shares);
  const allFinite = values.length === state.users.length && values.every(v => Number.isFinite(v) && v >= 0 && v <= 1);
  const sum = allFinite ? values.reduce((n, v) => n + v, 0) : NaN;
  const totalEl = $('shareTotal');

  if (validShares()) {
    totalEl.textContent = '已分配 100%';
    totalEl.className = 'pill pill-ok tabular';
  } else if (!allFinite) {
    totalEl.textContent = '请填写有效份额（0–100%）';
    totalEl.className = 'pill pill-danger tabular';
  } else if (sum < 1) {
    totalEl.textContent = `已分配 ${number(sum * 100)}% · 还差 ${number((1 - sum) * 100)}%`;
    totalEl.className = 'pill pill-warn tabular';
  } else {
    totalEl.textContent = `已分配 ${number(sum * 100)}% · 超出 ${number((sum - 1) * 100)}%`;
    totalEl.className = 'pill pill-danger tabular';
  }

  const amounts = currentTotals();
  for (const u of state.users) {
    const share = shares[u.id];
    const valid = Number.isFinite(share) && share >= 0 && share <= 1;
    const preview = $('preview-' + u.id);
    if (!preview) continue;
    if (valid) {
      const purchasedPart = amounts.anlasPurchasedAvailable > 0
        ? ` · 购 ${number(amounts.anlasPurchasedAvailable * share)}`
        : '';
      preview.textContent = `→ V5 ${number(amounts.v5Available * share)}% · ${number(amounts.anlasFixedAvailable * share)} 点${purchasedPart}`;
      preview.className = 'pill pill-sm pill-accent share-preview tabular';
    } else {
      preview.textContent = '份额无效';
      preview.className = 'pill pill-sm pill-danger share-preview';
    }
  }
  updateButtons();
}

function renderMembers() {
  const query = editing ? '' : $('search').value.trim().toLowerCase();
  const users = state.users.filter(u => memberName(u).toLowerCase().includes(query));

  $('memberCount').textContent = query
    ? `${users.length} / ${state.users.length} 位`
    : `${state.users.length} 位成员`;
  $('memberFilters').hidden = editing;
  $('shareActions').hidden = !editing;
  $('memberTableWrap').classList.toggle('is-editing', editing);

  const tbody = $('members');
  tbody.replaceChildren();

  for (const u of users) {
    const row = node('tr');
    if (!u.enabled) row.className = 'is-disabled';

    // Col 1: Member identity
    const nameCell = node('td');
    const identity = node('div', undefined, 'member-identity');
    identity.append(node('span', memberName(u), 'member-name'));
    if (!u.enabled) {
      identity.append(node('span', '已停用', 'pill pill-sm pill-warn'));
    }
    nameCell.append(identity);

    // Col 2: Share
    const shareCell = node('td');
    const q = u.quota || {};
    if (editing) {
      const editWrap = node('div', undefined, 'share-edit-cell');
      const inputWrap = node('div', undefined, 'share-input-wrap');
      const input = node('input', undefined, 'member-share-input input-sm');
      input.type = 'number';
      input.min = '0';
      input.max = '100';
      input.step = 'any';
      input.value = Number(((shares[u.id] || 0) * 100).toFixed(6));
      input.setAttribute('aria-label', `${memberName(u)} 的份额百分比`);
      input.oninput = () => {
        shares[u.id] = input.value === '' ? NaN : Number(input.value) / 100;
        shareMode = 'custom';
        shareSummary();
      };
      inputWrap.append(input, node('span', '%', 'muted'));
      const preview = node('span', '', 'pill pill-sm pill-accent share-preview tabular');
      preview.id = 'preview-' + u.id;
      editWrap.append(inputWrap, preview);
      shareCell.append(editWrap);
    } else {
      shareCell.append(node('span', percent(q.share), 'tabular'));
    }

    // Col 3: V5 Available / Capacity
    const v5Cell = node('td');
    const v5Wrap = node('div', undefined, 'v5-cell');
    const v5Head = node('div', undefined, 'v5-cell-head');
    v5Head.append(
      node('span', `${number(q.v5Available)}%`, 'cell-primary tabular'),
      node('span', `/ ${number(q.v5Capacity)}%`, 'faint tabular')
    );
    const overCap = (q.v5Available || 0) > (q.v5Capacity || 0) + 1e-9;
    if (overCap) {
      v5Head.append(node('span', '转入超额', 'pill pill-sm pill-accent'));
    }
    const meter = node('div', undefined, 'meter meter-sm v5-meter');
    const cap = Math.max(q.v5Capacity || 0, 1e-9);
    const ratio = (q.v5Available || 0) / cap;
    const fill = node('div', undefined, 'meter-fill ' + meterTone(ratio, overCap));
    fill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
    meter.append(fill);
    v5Wrap.append(v5Head, meter);
    v5Cell.append(v5Wrap);

    // Col 4: Subscription Points (+ optional purchased badge)
    const pointsCell = node('td');
    const pointsWrap = node('div', undefined, 'points-cell');
    pointsWrap.append(node('span', number(q.anlasFixedAvailable), 'cell-primary tabular'));
    if (q.anlasPurchasedAvailable > 0) {
      pointsWrap.append(node('span', `购买 ${number(q.anlasPurchasedAvailable)}`, 'pill pill-sm pill-muted tabular'));
    }
    pointsCell.append(pointsWrap);

    // Col 5: Direct row actions
    const actionsCell = node('td', undefined, 'cell-actions');
    const actionRow = node('div', undefined, 'row-actions');

    const transferBtn = node('button', '转移', 'secondary btn-sm');
    transferBtn.type = 'button';
    transferBtn.dataset.memberAction = 'transfer';
    transferBtn.dataset.transferBlocked = String(!q.member);
    transferBtn.onclick = run(() => openTransfer(u));

    const deliverBtn = node('button', '分发', 'secondary btn-sm');
    deliverBtn.type = 'button';
    deliverBtn.dataset.memberAction = 'deliver';
    deliverBtn.onclick = run(() => delivery(u));

    const manageBtn = node('button', '管理', 'ghost btn-sm');
    manageBtn.type = 'button';
    manageBtn.dataset.memberManage = u.id;
    manageBtn.onclick = run(() => openManage(u));

    actionRow.append(transferBtn, deliverBtn, manageBtn);
    actionsCell.append(actionRow);

    row.append(nameCell, shareCell, v5Cell, pointsCell, actionsCell);
    tbody.append(row);
  }

  if (!users.length) {
    const row = node('tr');
    const td = node('td', '没有符合条件的成员', 'empty');
    td.colSpan = 5;
    row.append(td);
    tbody.append(row);
  }

  if (editing) shareSummary();
  else updateButtons();
}

async function refresh() {
  state = await manage();
  state.users.sort((a, b) => memberName(a).localeCompare(memberName(b)));
  $('autoFallback').checked = state.autoAnlasFallback === true;

  $('authShell').hidden = true;
  $('topbar').hidden = false;
  $('dashboard').hidden = false;

  renderOverview();
  renderMembers();

  try {
    await loadUpstream();
  } catch (e) {
    notice('成员信息已更新；官方账号状态暂时读取失败：' + e.message, true);
  }
}

async function loadUpstream() {
  const summary = await api('/api/admin/summary');
  renderTelemetry(summary);

  const boundId = state.users.find(u => u.quota?.boundAccountId)?.quota.boundAccountId;
  const account = summary.accounts?.find(item => item.id === boundId);
  publicBase = String(state.publicBaseUrl || summary.settings?.publicBaseUrl || location.origin).replace(/\/+$/, '');

  upstream = account
    ? {
      id: boundId,
      enabled: account.enabled === true,
      tier: account.quotaTier,
      inFlight: Number(account.inFlight || 0),
      fixed: account.quotaFixed,
      purchased: account.quotaPurchased,
      v5: account.v5UsagePercent,
      checked: account.quotaCheckedAt,
      error: Boolean(account.quotaError)
    }
    : null;

  if (!upstream) {
    $('upstreamStatePill').textContent = '等待绑定';
    $('upstreamStatePill').className = 'pill pill-sm pill-muted';
    $('upstreamTierPill').hidden = true;
    $('upstreamErrorPill').hidden = true;
    $('upstreamV5').textContent = '—';
    $('upstreamFixed').textContent = '—';
    $('upstreamPurchasedItem').hidden = true;
    $('upstreamUpdated').textContent = '—';
    updateButtons();
    return;
  }

  $('upstreamStatePill').textContent = upstream.enabled ? '已启用' : '已暂停';
  $('upstreamStatePill').className = `pill pill-sm ${upstream.enabled ? 'pill-ok' : 'pill-danger'}`;

  const isOpus = upstream.tier === 3;
  $('upstreamTierPill').hidden = false;
  $('upstreamTierPill').textContent = isOpus ? 'Opus' : '订阅待核验';
  $('upstreamTierPill').className = `pill pill-sm ${isOpus ? 'pill-accent' : 'pill-warn'}`;

  $('upstreamErrorPill').hidden = !upstream.error;
  $('upstreamV5').textContent = upstream.v5 === null || upstream.v5 === undefined ? '—' : `${number(upstream.v5)}%`;
  $('upstreamFixed').textContent = number(upstream.fixed);

  const hasPurchased = upstream.purchased > 0;
  $('upstreamPurchasedItem').hidden = !hasPurchased;
  if (hasPurchased) {
    $('upstreamPurchased').textContent = number(upstream.purchased);
  }

  $('upstreamUpdated').textContent = formatTime(upstream.checked);
  $('toggleUpstream').textContent = upstream.enabled ? '暂停使用' : '恢复使用';
  updateButtons();
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  $('password').value = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function updateCreateHint() {
  if ($('editingId').value) return;
  const n = state.users.length + 1;
  const share = state.shareMode === 'equal' ? 1 / n : Number($('newShare').value) / 100;
  const totals = currentTotals();
  if (!Number.isFinite(share) || share < 0 || share > 1) {
    $('credentialHint').textContent = '请输入 0–100 之间的有效份额百分比。';
    return;
  }
  const prefix = state.shareMode === 'equal' ? `加入后 ${n} 人均分` : '按新份额重分当前额度';
  const purchasedText = totals.anlasPurchasedAvailable > 0
    ? ` · 购买点数 ${number(totals.anlasPurchasedAvailable * share)}`
    : '';
  $('credentialHint').textContent = `${prefix} · 预计 V5 ${number(totals.v5Available * share)}%（容量 ${number(100 * share)}%）· 订阅点数 ${number(totals.anlasFixedAvailable * share)}${purchasedText}`;
}

function editMember(user) {
  requireSaved();
  $('manageDialog').close();
  $('editingId').value = user?.id || '';
  $('username').value = user?.username || '';
  $('username').readOnly = Boolean(user);
  $('password').value = '';
  $('password').required = Boolean(user);
  $('password').type = 'password';
  $('showPassword').textContent = '显示';
  $('passwordDetails').open = Boolean(user);
  $('passwordSummary').textContent = user ? '设置新的登录密码' : '自行设置密码（留空自动生成）';
  $('newShareLabel').hidden = Boolean(user) || state.shareMode === 'equal';
  $('newShare').required = !user && state.shareMode === 'custom';
  $('newShare').value = Number((100 / (state.users.length + 1)).toFixed(6));
  $('memberDialogTitle').textContent = user ? `重置密码 · ${memberName(user)}` : '新增成员';
  $('saveMember').textContent = user ? '保存新密码' : '创建并分配额度';
  if (user) {
    $('credentialHint').textContent = '原个人 Key 和余额保留，旧登录会话将失效。';
  } else {
    updateCreateHint();
  }
  modal('memberDialog');
}

async function delivery(user, password) {
  const key = await manage({ action: 'member-key', userId: user.id });
  const portal = String(state.publicBaseUrl || publicBase || location.origin).replace(/\/+$/, '');
  $('deliveryText').value = [
    `成员入口：${portal}/`,
    `用户名：${user.username}`,
    `密码：${password || '使用原密码，忘记请联系管理员重置'}`,
    `API Base：${portal}/v1`,
    `API Key：${key.apiKey}`
  ].join('\n');
  modal('deliveryDialog');
}

function openManage(user) {
  selectedMember = user;
  const q = user.quota || {};
  $('manageName').textContent = memberName(user);
  $('manageStatusPill').textContent = user.enabled ? '已启用' : '已停用';
  $('manageStatusPill').className = `pill pill-sm ${user.enabled ? 'pill-ok' : 'pill-warn'}`;

  const pills = [
    node('span', `份额 ${percent(q.share)}`, 'pill pill-sm pill-muted tabular'),
    node('span', `V5 ${number(q.v5Available)}% / ${number(q.v5Capacity)}%`, 'pill pill-sm pill-accent tabular'),
    node('span', `订阅点数 ${number(q.anlasFixedAvailable)}`, 'pill pill-sm pill-muted tabular')
  ];
  if (q.anlasPurchasedAvailable > 0) {
    pills.push(node('span', `购买点数 ${number(q.anlasPurchasedAvailable)}`, 'pill pill-sm pill-muted tabular'));
  }
  $('managePills').replaceChildren(...pills);

  $('toggleMember').textContent = user.enabled ? '停用成员' : '恢复成员';
  $('resetPassword').disabled = !user.enabled;
  $('removeMember').disabled = state.users.length <= 1;
  modal('manageDialog');
}

function transferParties() {
  return {
    from: state?.users.find(u => u.id === $('transferFrom').value),
    to: state?.users.find(u => u.id === $('transferTo').value),
    resource: $('transferResource').value,
    amount: transferEntireBalance ? transferMaximum() : Number($('transferAmount').value)
  };
}

function transferMaximum() {
  const from = state?.users.find(u => u.id === $('transferFrom').value);
  const resource = $('transferResource').value;
  const balance = from?.quota?.[resource + 'Available'] || 0;
  return resource === 'v5' ? balance : Math.floor(balance);
}

function validTransfer() {
  const { from, to, resource, amount } = transferParties();
  return Boolean(
    from &&
    to &&
    from.id !== to.id &&
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= transferMaximum() &&
    (resource === 'v5' || Number.isInteger(amount))
  );
}

function transferHint() {
  const { from, to, resource, amount } = transferParties();
  const v5 = resource === 'v5';
  const maximum = transferMaximum();
  const unit = v5 ? '%' : ' 点';
  const value = Number.isFinite(amount) && amount >= 0 ? amount : 0;
  const source = from?.quota?.[resource + 'Available'] || 0;
  const target = to?.quota?.[resource + 'Available'] || 0;

  $('transferAmountLabel').textContent = v5 ? '转移数量（V5 %）' : '转移数量（整数点数）';
  $('transferAmount').min = v5 ? '0.000001' : '1';
  $('transferAmount').step = v5 ? 'any' : '1';
  $('transferAmount').max = String(maximum);

  const preview = $('transferHint');
  preview.replaceChildren();
  if (from && to) {
    const lineFrom = node('div', undefined, 'transfer-preview-line');
    lineFrom.append(
      node('span', memberName(from)),
      node('strong', `${number(source)}${unit} → ${number(Math.max(0, source - value))}${unit}`)
    );
    const lineTo = node('div', undefined, 'transfer-preview-line');
    lineTo.append(
      node('span', memberName(to)),
      node('strong', `${number(target)}${unit} → ${number(target + value)}${unit}`)
    );
    preview.append(lineFrom, lineTo);

    if (v5 && target + value > (to.quota?.v5Capacity || 0) + 1e-9) {
      preview.append(node('div', '接收方超出 V5 容量期间暂不恢复', 'transfer-preview-note'));
    }
  }
  $('transferError').hidden = true;
  updateButtons();
}

function openTransfer(user = selectedMember) {
  requireSaved();
  if (!user) return;
  const recipients = state.users.filter(u => u.id !== user.id && u.quota?.member);
  if (!recipients.length) throw new Error('至少需要两位成员才能转移额度。');

  $('manageDialog').close();
  $('transferFrom').value = user.id;
  $('transferFromName').textContent = memberName(user);
  $('transferTo').replaceChildren(...recipients.map(u => {
    const option = node('option', memberName(u) + (u.enabled ? '' : '（已停用）'));
    option.value = u.id;
    return option;
  }));

  transferEntireBalance = false;
  $('transferResource').value = 'v5';
  $('transferResource').querySelector('option[value="anlasPurchased"]').hidden = !state.users.some(
    u => u.quota?.anlasPurchasedAvailable > 0
  );
  $('transferAmount').value = '';
  transferHint();
  modal('transferDialog');
}

function confirmation(title, description, task, { danger = false } = {}) {
  $('confirmTitle').textContent = title;
  $('confirmDescription').textContent = description;
  $('confirmAction').className = danger ? 'btn-danger-solid' : '';
  confirmTask = task;
  modal('confirmDialog');
}

async function refreshOfficial() {
  if (!upstream) throw new Error('尚未绑定官方账号');
  const result = await api('/api/admin/accounts/quota', { ids: [upstream.id] });
  if (result.failed) throw new Error('官方查询失败，请检查账号凭据。');
}

// Event Bindings
$('message').onclick = () => {
  clearTimeout(noticeTimer);
  $('message').hidden = true;
};

$('connect').onsubmit = run(async () => {
  await refresh();
  if ($('remember').checked) {
    sessionStorage.setItem('nai.adminSession', $('adminToken').value);
  } else {
    sessionStorage.removeItem('nai.adminSession');
  }
});

$('disconnect').onclick = () => {
  gallery.reset();
  tab('membersPanel');
  sessionStorage.removeItem('nai.adminSession');
  localStorage.removeItem('nai.adminToken');
  $('adminToken').value = '';
  $('deliveryText').value = '';
  $('password').value = '';
  $('upstreamPst').value = '';
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  state = null;
  upstream = null;
  editing = false;
  shares = {};
  selectedMember = null;
  $('telemetryStrip').hidden = true;
  $('dashboard').hidden = true;
  $('topbar').hidden = true;
  $('authShell').hidden = false;
  notice('已退出管理。');
};

for (const button of document.querySelectorAll('[data-tab]')) {
  button.onclick = () => tab(button.dataset.tab);
}

for (const button of document.querySelectorAll('[data-close]')) {
  button.onclick = () => $(button.dataset.close).close();
}

$('refresh').onclick = run(async () => {
  requireSaved();
  await refresh();
  notice('状态已刷新。');
});

$('search').oninput = () => {
  if (state) renderMembers();
};

$('editShares').onclick = run(() => {
  editing = true;
  shareMode = state.shareMode;
  shares = Object.fromEntries(state.users.map(u => [u.id, u.quota?.share || 0]));
  renderMembers();
});

$('equalize').onclick = () => {
  if (busy || !state?.users.length) return;
  shareMode = 'equal';
  shares = Object.fromEntries(state.users.map(u => [u.id, 1 / state.users.length]));
  renderMembers();
};

$('cancelShares').onclick = run(async () => {
  editing = false;
  shares = {};
  await refresh();
});

$('saveShares').onclick = run(async () => {
  if (!validShares()) throw new Error('请把成员份额合计调整为 100%。');
  await manage({
    action: 'allocation',
    shareMode,
    shares,
    expectedConfigVersion: state.configVersion
  });
  editing = false;
  shares = {};
  try {
    await refresh();
    notice('V5 和点数已按新份额分配。');
  } catch {
    renderMembers();
    notice('分配已保存，页面刷新失败；请刷新查看，勿重复提交。', true);
  }
});

$('newMember').onclick = run(() => editMember());
$('generatePassword').onclick = randomPassword;
$('showPassword').onclick = () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('showPassword').textContent = show ? '隐藏' : '显示';
};
$('newShare').oninput = updateCreateHint;

$('credentials').onsubmit = run(async () => {
  const id = $('editingId').value;
  const password = $('password').value;
  const created = await manage(
    id
      ? { action: 'credentials', userId: id, username: $('username').value, password }
      : {
        action: 'create-member',
        username: $('username').value,
        ...(password ? { password } : {}),
        newMemberShare: Number($('newShare').value) / 100,
        expectedConfigVersion: state.configVersion
      }
  );
  $('memberDialog').close();
  let failed = false;
  try {
    await refresh();
  } catch {
    failed = true;
  }
  notice(
    (id ? '密码已更新，原个人 Key 保留。' : '成员已创建，V5 和点数已分配。') +
    (failed ? ' 页面刷新失败，请稍后刷新。' : ''),
    failed
  );
  try {
    await delivery({ id: created.id, username: created.username }, created.password || password);
  } catch {
    notice('账户已保存，分发信息读取失败。请从成员行重新打开；未保存的密码可重置。', true);
  }
});

$('memberDialog').addEventListener('close', () => {
  $('password').value = '';
});

$('deliveryDialog').addEventListener('close', () => {
  $('deliveryText').value = '';
});

for (const id of ['transferTo', 'transferResource']) {
  $(id).onchange = () => {
    if (id === 'transferResource') {
      transferEntireBalance = false;
      $('transferAmount').value = '';
    }
    transferHint();
  };
}

$('transferAmount').oninput = () => {
  transferEntireBalance = false;
  transferHint();
};

$('transferAll').onclick = () => {
  if (busy) return;
  transferEntireBalance = true;
  $('transferAmount').value = String(Math.floor(transferMaximum() * 1e6) / 1e6);
  transferHint();
};

$('transferForm').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  updateButtons();
  $('transferError').hidden = true;
  try {
    if (!validTransfer()) throw new Error('请填写有效数量，不能超过转出成员的当前余额。');
    const { from, to, resource, amount } = transferParties();
    await manage({
      action: 'transfer-quota',
      fromUserId: from.id,
      toUserId: to.id,
      resource,
      amount,
      allAvailable: transferEntireBalance,
      expectedConfigVersion: state.configVersion
    });
    $('transferDialog').close();
    selectedMember = null;
    try {
      await refresh();
      notice(`${TRANSFER_NAMES[resource]}已转移，份额与 V5 容量保持不变。`);
    } catch {
      notice('转移已完成，请刷新查看最新余额，勿重复提交。', true);
    }
  } catch (e) {
    $('transferError').textContent = e.message.includes('预留额度的任务')
      ? '还有请求在处理，完成后即可转移。'
      : e.message;
    $('transferError').hidden = false;
  } finally {
    busy = false;
    updateButtons();
  }
};

$('copyDelivery').onclick = run(async () => {
  await navigator.clipboard.writeText($('deliveryText').value);
  notice('已复制该成员的登录信息和个人 Key。');
});

$('resetPassword').onclick = run(() => {
  if (selectedMember) editMember(selectedMember);
});

$('toggleMember').onclick = run(() => {
  const user = selectedMember;
  if (!user) return;
  $('manageDialog').close();
  confirmation(
    (user.enabled ? '停用 ' : '恢复 ') + memberName(user),
    user.enabled
      ? '暂停登录和新的生图请求。原个人 Key、份额和余额保留。'
      : '恢复原个人 Key 和登录，继续使用保留的余额。',
    async () => {
      await manage({ action: 'member-status', userId: user.id, enabled: !user.enabled });
      $('confirmDialog').close();
      await refresh();
      notice('成员状态已更新。');
    }
  );
});

$('removeMember').onclick = run(() => {
  const user = selectedMember;
  if (!user) return;
  const q = user.quota || {};
  $('manageDialog').close();
  const purchasedText = q.anlasPurchasedAvailable > 0
    ? `、购买点数 ${number(q.anlasPurchasedAvailable)}`
    : '';
  confirmation(
    `删除 ${memberName(user)}？`,
    `登录和个人 Key 会立即失效，历史记录保留。剩余 V5 ${number(q.v5Available)}% 和订阅点数 ${number(q.anlasFixedAvailable)}${purchasedText} 将按其余成员的份额分配。`,
    async () => {
      await manage({
        action: 'remove-member',
        userId: user.id,
        expectedConfigVersion: state.configVersion
      });
      $('confirmDialog').close();
      selectedMember = null;
      try {
        await refresh();
        notice('成员已删除，剩余额度已分配给其他成员。');
      } catch {
        notice('成员已删除，请刷新查看最新名单。', true);
      }
    },
    { danger: true }
  );
});

$('confirmAction').onclick = run(async () => {
  if (confirmTask) await confirmTask();
});

$('confirmDialog').addEventListener('close', () => {
  confirmTask = null;
});

$('saveFallback').onclick = run(async () => {
  await manage({ action: 'fallback-policy', enabled: $('autoFallback').checked });
  state.autoAnlasFallback = $('autoFallback').checked;
  notice('设置已保存，之后的请求生效。');
});

$('refreshUpstream').onclick = run(async () => {
  requireSaved();
  await refreshOfficial();
  await refresh();
  notice('已向官方刷新额度。');
});

$('syncPeriod').onclick = run(async () => {
  requireSaved();
  await refreshOfficial();
  await refreshOfficial();
  await refresh();
  if (state.subscriptionCycle?.legacyPending) {
    await manage({ action: 'sync-period', expectedConfigVersion: state.configVersion });
    await refresh();
  }
  notice(state.status === 'renewal_pending' ? '还有请求在处理，完成后再次刷新即可。' : '本期额度已同步。');
});

$('toggleUpstream').onclick = run(async () => {
  requireSaved();
  if (!upstream) throw new Error('尚未绑定官方账号');
  const enabled = !upstream.enabled;
  if (enabled) await refreshOfficial();
  await api('/api/admin/accounts/' + encodeURIComponent(upstream.id), { enabled }, 'PATCH');
  await refresh();
  notice(enabled ? '账号已恢复使用。' : '账号已暂停使用。');
});

$('upstreamCredentials').onsubmit = run(async () => {
  requireSaved();
  if (!upstream) throw new Error('尚未绑定官方账号');
  if (upstream.inFlight) throw new Error('请等待正在生成的请求完成。');
  const token = $('upstreamPst').value.trim();
  if (!/^pst-[A-Za-z0-9_-]+$/.test(token)) throw new Error('请输入完整 PST');
  await api('/api/admin/accounts/' + encodeURIComponent(upstream.id), { token }, 'PATCH');
  $('upstreamPst').value = '';
  await refreshOfficial();
  await refresh();
  notice('PST 已更新，账号保持暂停；核验额度后再恢复使用。');
});

window.addEventListener('beforeunload', event => {
  if (editing) {
    event.preventDefault();
    event.returnValue = '';
  }
});

$('adminToken').value = sessionStorage.getItem('nai.adminSession') || localStorage.getItem('nai.adminToken') || '';
if ($('adminToken').value) {
  busy = true;
  updateButtons();
  refresh()
    .catch(() => notice('请重新登录管理端。', true))
    .finally(() => {
      busy = false;
      updateButtons();
    });
}

setInterval(async () => {
  if (
    !state ||
    busy ||
    editing ||
    document.querySelector('dialog[open]') ||
    document.activeElement?.matches('input,select,textarea')
  ) {
    return;
  }
  busy = true;
  try {
    await refresh();
  } catch {
    // Silent background poll failure; user can refresh manually.
  } finally {
    busy = false;
    updateButtons();
  }
}, 30000);
