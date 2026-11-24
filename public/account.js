import { startSharedStatus, stopSharedStatus } from '/shared-status.js';

const $ = (id) => document.getElementById(id);

const STATUS_ALERTS = {
  pending_opus: { text: '等待管理员接入有效 Opus 订阅', tone: 'notice-warn' },
  inactive_opus: { text: '共享 Opus 订阅暂不可用', tone: 'notice-danger' },
  stale: { text: '官方余额等待刷新，当前额度可能略有延迟', tone: 'notice-warn' },
  unknown_balance: { text: '官方余额暂未同步，请稍后刷新', tone: 'notice-warn' },
  ambiguous_opus: { text: '等待管理员确认共享上游账户', tone: 'notice-warn' },
  renewal_pending: { text: '正在确认订阅续期，请稍后重试', tone: 'notice-warn' }
};

const MODEL_LABELS = {
  'nai-diffusion-5-full': 'V5 Full',
  'nai-diffusion-5': 'V5 Full',
  'nai-diffusion-5-full-medium': 'V5 Medium',
  'nai-diffusion-5-full-inpainting': 'V5 Full Inpaint',
  'nai-diffusion-5-full-medium-inpainting': 'V5 Medium Inpaint',
  'nai-diffusion-5-curated': 'V5 Curated',
  'nai-diffusion-4-5-full': 'V4.5 Full',
  'nai-diffusion-4-5-full-inpainting': 'V4.5 Full Inpaint',
  'nai-diffusion-4-5-curated': 'V4.5 Curated',
  'nai-diffusion-4-5-curated-inpainting': 'V4.5 Curated Inpaint',
  'nai-diffusion-4-full': 'V4 Full',
  'nai-diffusion-4-full-inpainting': 'V4 Full Inpaint',
  'nai-diffusion-4-curated-preview': 'V4 Curated',
  'nai-diffusion-4-curated-inpainting': 'V4 Curated Inpaint',
  'nai-diffusion-3': 'V3 Anime',
  'nai-diffusion-3-inpainting': 'V3 Inpaint',
  'nai-diffusion-furry-3': 'V3 Furry',
  'nai-diffusion-furry-3-inpainting': 'V3 Furry Inpaint'
};

const JOB_STATUS_META = {
  done: { label: '成功', pill: 'pill-ok' },
  failed: { label: '失败', pill: 'pill-danger' },
  running: { label: '生成中', pill: 'pill-accent', pulse: true },
  queued: { label: '排队', pill: 'pill-warn' }
};

const SETTLEMENT_BADGE = {
  refunded: { label: '已退', pill: 'pill-muted' },
  reserved: { label: '预留', pill: 'pill-warn' }
};

let toastTimer = null;
const copyTimers = new WeakMap();

function formatNumber(value, maxDigits = 3) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: maxDigits });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatJobTime(value) {
  if (!value) return { short: '—', full: '' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { short: '—', full: '' };
  const now = new Date();
  const short = d.getFullYear() === now.getFullYear()
    ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { short, full: d.toLocaleString('zh-CN') };
}

function showToast(text, tone = 'info') {
  const el = $('message');
  clearTimeout(toastTimer);
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const toneClass = tone === 'ok' ? 'is-ok' : tone === 'warn' ? 'is-warn' : tone === 'error' ? 'is-error' : '';
  el.className = toneClass ? `toast ${toneClass}` : 'toast';
  el.textContent = text;
  el.hidden = false;
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, tone === 'error' || tone === 'warn' ? 4800 : 2800);
}

function setLoginError(text) {
  const el = $('loginError');
  el.textContent = text || '';
  el.hidden = !text;
}

function setKeyMask(revealed) {
  const input = $('apiKey');
  const btn = $('toggleKeyMask');
  input.type = revealed ? 'text' : 'password';
  $('eyeShowIcon').hidden = revealed;
  $('eyeHideIcon').hidden = !revealed;
  const label = revealed ? '隐藏 API Key' : '显示 API Key';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.setAttribute('aria-pressed', String(revealed));
}

function hideKeyPanel() {
  $('keyFields').hidden = true;
  $('apiKey').value = '';
  $('apiBaseUrl').value = '';
  setKeyMask(false);
  $('toggleKey').textContent = '查看 API Key';
}

function enterLoggedOutState() {
  stopSharedStatus();
  hideKeyPanel();
  $('account').hidden = true;
  $('login').hidden = false;
}

async function api(path, body) {
  const response = await fetch('/api/member/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    if (response.status === 401) enterLoggedOutState();
    throw new Error(data.message || data.error || '请求失败');
  }
  return data;
}

function renderStatusNotice(q) {
  const el = $('statusNotice');
  let alert = null;

  if (!q) {
    alert = { text: '共享账本尚未启用，请联系管理员', tone: 'notice-warn' };
  } else if (!q.member) {
    alert = { text: '尚未分配额度，请联系管理员', tone: 'notice-warn' };
  } else if (q.status !== 'active') {
    alert = STATUS_ALERTS[q.status] || { text: `当前额度状态异常：${q.status}`, tone: 'notice-warn' };
  }

  if (!alert) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.className = `notice ${alert.tone}`;
  el.textContent = alert.text;
  el.hidden = false;
}

function renderReservedBadge(el, amount, suffix = '') {
  const numeric = Number(amount || 0);
  if (numeric > 0) {
    el.textContent = `预留 ${formatNumber(numeric)}${suffix}`;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

function formatRefillLine(q) {
  if (!q?.member) return '尚未分配额度';
  if (q.v5FullRefillSeconds === 0) return '已满额';
  if (q.v5RefillLimited) return '恢复同步中';
  if (q.v5RefillPerDay > 0) {
    const rate = `每日约 +${formatNumber(q.v5RefillPerDay, 2)}%`;
    const secs = q.v5FullRefillSeconds;
    if (secs != null && Number.isFinite(secs) && secs > 0) {
      if (secs < 3600) {
        return `${rate} · 约 ${Math.max(1, Math.round(secs / 60))} 分钟满`;
      }
      return `${rate} · 约 ${formatNumber(secs / 3600, 1)} 小时满`;
    }
    return rate;
  }
  return '恢复同步中';
}

function renderQuota(q) {
  $('fallbackBadge').hidden = !q?.autoAnlasFallback;

  const isMember = Boolean(q?.member);
  const avail = Number(q?.v5Available || 0);
  const cap = Number(q?.v5Capacity || 0);

  $('v5Available').textContent = isMember ? `${formatNumber(avail)}%` : '—';
  $('v5Capacity').textContent = isMember ? `/ ${formatNumber(cap)}%` : '';
  renderReservedBadge($('v5ReservedBadge'), q?.v5Reserved, '%');

  const ratio = cap > 0 ? avail / cap : 0;
  const pct = isMember ? Math.max(0, Math.min(100, ratio * 100)) : 0;
  const meter = $('v5Meter');
  const fill = $('v5MeterFill');
  meter.setAttribute('aria-valuemax', String(cap > 0 ? cap : 100));
  meter.setAttribute('aria-valuenow', String(isMember ? Math.max(0, Number(avail.toFixed(3))) : 0));
  fill.style.width = `${pct.toFixed(2)}%`;

  let fillClass = 'meter-fill';
  if (isMember && cap > 0) {
    if (avail > cap + 1e-6) fillClass += ' is-over';
    else if (ratio >= 0.999) fillClass += ' is-ok';
    else if (avail <= 0) fillClass += ' is-danger';
    else if (ratio <= 0.15) fillClass += ' is-warn';
  }
  fill.className = fillClass;
  $('v5Refill').textContent = formatRefillLine(q);

  $('fixed').textContent = isMember ? formatNumber(q.anlasFixedAvailable) : '—';
  renderReservedBadge($('fixedReservedBadge'), q?.anlasFixedReserved);

  const purchasedAvail = Number(q?.anlasPurchasedAvailable || 0);
  const purchasedRes = Number(q?.anlasPurchasedReserved || 0);
  const purchasedEl = $('purchased');
  purchasedEl.textContent = isMember ? formatNumber(purchasedAvail) : '—';
  purchasedEl.style.color = !isMember || (purchasedAvail <= 0 && purchasedRes <= 0) ? 'var(--text-faint)' : '';
  renderReservedBadge($('purchasedReservedBadge'), purchasedRes);
}

function buildChargeCell(charge) {
  const td = document.createElement('td');
  td.setAttribute('data-label', '额度记录');

  if (!charge) {
    td.textContent = '—';
    return td;
  }

  const wrap = document.createElement('span');
  wrap.style.display = 'inline-flex';
  wrap.style.alignItems = 'center';
  wrap.style.justifyContent = 'flex-end';
  wrap.style.gap = '6px';
  wrap.style.flexWrap = 'wrap';

  const amountEl = document.createElement('span');
  amountEl.className = 'tabular';
  if (charge.resource === 'free') {
    amountEl.textContent = '免费';
  } else if (charge.billingMode === 'anlas_fallback') {
    amountEl.textContent = `${formatNumber(charge.amount)} Anlas (转扣)`;
  } else if (charge.resource === 'v5') {
    amountEl.textContent = `${formatNumber(charge.amount)}% V5`;
  } else if (charge.resource === 'anlas') {
    amountEl.textContent = `${formatNumber(charge.amount)} Anlas`;
  } else {
    amountEl.textContent = `${formatNumber(charge.amount)} ${charge.resource || ''}`.trim();
  }
  wrap.append(amountEl);

  if (charge.status && charge.status !== 'settled') {
    const badgeInfo = SETTLEMENT_BADGE[charge.status] || { label: charge.status, pill: 'pill-muted' };
    const badge = document.createElement('span');
    badge.className = `pill pill-sm ${badgeInfo.pill}`;
    badge.textContent = badgeInfo.label;
    wrap.append(badge);
  }

  td.append(wrap);
  return td;
}

function buildEmptyJobsRow() {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 4;
  cell.className = 'empty';

  const box = document.createElement('div');
  box.className = 'empty-state';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'empty-icon';
  iconWrap.setAttribute('aria-hidden', 'true');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'icon icon-lg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  const rect = document.createElementNS(svgNS, 'rect');
  rect.setAttribute('x', '3');
  rect.setAttribute('y', '4');
  rect.setAttribute('width', '18');
  rect.setAttribute('height', '16');
  rect.setAttribute('rx', '2');

  const line1 = document.createElementNS(svgNS, 'path');
  line1.setAttribute('d', 'M7 9h10');
  const line2 = document.createElementNS(svgNS, 'path');
  line2.setAttribute('d', 'M7 13h6');

  svg.append(rect, line1, line2);
  iconWrap.append(svg);

  const title = document.createElement('div');
  title.className = 'empty-title';
  title.textContent = '暂无调用记录';

  box.append(iconWrap, title);
  cell.append(box);
  row.append(cell);
  return row;
}

function renderJobs(jobsList) {
  const jobs = Array.isArray(jobsList) ? jobsList : [];
  const tbody = $('jobs');
  tbody.replaceChildren();
  $('jobsCount').textContent = jobs.length ? `最近 ${jobs.length} 条` : '0 条';

  if (!jobs.length) {
    tbody.append(buildEmptyJobsRow());
    return;
  }

  for (const job of jobs) {
    const row = document.createElement('tr');

    const timeInfo = formatJobTime(job.createdAt);
    const timeTd = document.createElement('td');
    timeTd.setAttribute('data-label', '时间');
    timeTd.className = 'tabular';
    timeTd.textContent = timeInfo.short;
    if (timeInfo.full) timeTd.title = timeInfo.full;

    const modelTd = document.createElement('td');
    modelTd.setAttribute('data-label', '模型');
    const rawModel = String(job.model || '');
    const mapped = MODEL_LABELS[rawModel];
    if (mapped) {
      const tag = document.createElement('span');
      tag.className = 'pill pill-sm pill-muted';
      tag.textContent = mapped;
      tag.title = rawModel;
      modelTd.append(tag);
    } else if (rawModel) {
      const code = document.createElement('span');
      code.className = 'cell-mono';
      code.textContent = rawModel;
      modelTd.append(code);
    } else {
      modelTd.textContent = '—';
    }

    const statusTd = document.createElement('td');
    statusTd.setAttribute('data-label', '状态');
    const statusMeta = JOB_STATUS_META[job.status] || { label: String(job.status || '未知'), pill: 'pill-muted' };
    const statusPill = document.createElement('span');
    statusPill.className = `pill pill-sm ${statusMeta.pill}`;
    if (statusMeta.pulse) {
      const dot = document.createElement('span');
      dot.className = 'dot dot-accent dot-pulse';
      dot.setAttribute('aria-hidden', 'true');
      statusPill.append(dot);
    }
    statusPill.append(document.createTextNode(statusMeta.label));
    statusTd.append(statusPill);

    row.append(timeTd, modelTd, statusTd, buildChargeCell(job.charge));
    tbody.append(row);
  }
}

async function load() {
  const data = await api('me');
  const q = data.quota;
  startSharedStatus();

  setLoginError('');
  $('login').hidden = true;
  $('account').hidden = false;

  const username = data.username || '';
  $('userName').textContent = username;
  $('userShare').textContent = q?.member ? `· ${formatNumber(q.share * 100)}%` : '';
  $('userPill').hidden = !username;

  renderStatusNotice(q);
  renderQuota(q);
  renderJobs(data.jobs);
}

async function copyText(text) {
  if (!text) throw new Error('暂无可复制内容');
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand fallback for non-HTTPS or unfocused contexts.
    }
  }
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.append(helper);
  try {
    helper.select();
    if (!document.execCommand('copy')) throw new Error('复制失败，请手动复制');
  } finally {
    helper.remove();
  }
}

function flashCopiedButton(btn) {
  const prev = copyTimers.get(btn);
  if (prev) clearTimeout(prev);
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = '已复制';
  const timer = setTimeout(() => {
    btn.textContent = original;
    copyTimers.delete(btn);
  }, 1500);
  copyTimers.set(btn, timer);
}

$('message').addEventListener('click', () => {
  showToast('');
});

$('username').addEventListener('input', () => setLoginError(''));
$('password').addEventListener('input', () => setLoginError(''));

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitBtn = $('loginSubmit');
  setLoginError('');
  submitBtn.disabled = true;
  submitBtn.textContent = '登录中…';
  try {
    await api('login', {
      username: $('username').value,
      password: $('password').value
    });
    $('password').value = '';
    await load();
  } catch (error) {
    setLoginError(error.message || '登录失败');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '登录';
  }
});

$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  btn.disabled = true;
  try {
    await load();
    showToast('额度已刷新', 'ok');
  } catch (error) {
    showToast(error.message || '刷新失败', 'error');
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  const btn = $('logout');
  btn.disabled = true;
  try {
    await api('logout', {});
    enterLoggedOutState();
    showToast('已退出登录', 'ok');
  } catch (error) {
    showToast(error.message || '退出失败', 'error');
  } finally {
    btn.disabled = false;
  }
});

$('toggleKey').addEventListener('click', async () => {
  const fields = $('keyFields');
  if (!fields.hidden) {
    hideKeyPanel();
    return;
  }
  const btn = $('toggleKey');
  btn.disabled = true;
  btn.textContent = '获取中…';
  try {
    const data = await api('key');
    const baseUrl = data.baseUrl || '';
    $('apiBaseUrl').value = baseUrl;
    $('copyBaseUrl').disabled = !baseUrl;
    $('apiKey').value = data.apiKey || '';
    $('copyKey').disabled = !data.apiKey;
    setKeyMask(false);
    fields.hidden = false;
    btn.textContent = '隐藏';
  } catch (error) {
    btn.textContent = '查看 API Key';
    showToast(error.message || '获取 API Key 失败', 'error');
  } finally {
    btn.disabled = false;
  }
});

$('toggleKeyMask').addEventListener('click', () => {
  setKeyMask($('apiKey').type === 'password');
});

$('copyBaseUrl').addEventListener('click', async () => {
  try {
    await copyText($('apiBaseUrl').value);
    flashCopiedButton($('copyBaseUrl'));
    showToast('已复制 Base URL', 'ok');
  } catch (error) {
    showToast(error.message || '复制失败', 'error');
  }
});

$('copyKey').addEventListener('click', async () => {
  try {
    await copyText($('apiKey').value);
    flashCopiedButton($('copyKey'));
    showToast('已复制 API Key', 'ok');
  } catch (error) {
    showToast(error.message || '复制失败', 'error');
  }
});

window.addEventListener('member-auth-expired', () => {
  enterLoggedOutState();
  showToast('登录已过期，请重新登录', 'warn');
});

load().catch(() => {
  if ($('account').hidden) $('login').hidden = false;
});
