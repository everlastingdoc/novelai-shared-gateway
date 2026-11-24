const STATUS_META = {
  active: { label: '可用', pill: 'pill-ok', dot: 'dot-ok' },
  cooldown: { label: '限流冷却', pill: 'pill-warn', dot: 'dot-warn' },
  stale: { label: '待刷新', pill: 'pill-warn', dot: 'dot-warn' },
  renewal_pending: { label: '续期确认中', pill: 'pill-warn', dot: 'dot-warn' },
  pending_opus: { label: '等待接入', pill: 'pill-warn', dot: 'dot-warn' },
  unknown_balance: { label: '余额未知', pill: 'pill-warn', dot: 'dot-warn' },
  inactive_opus: { label: '订阅不可用', pill: 'pill-danger', dot: 'dot-danger' },
  quota_sync_error: { label: '同步异常', pill: 'pill-danger', dot: 'dot-danger' },
  disabled: { label: '账户停用', pill: 'pill-danger', dot: 'dot-danger' }
};

let events = null;
let active = false;
let mounted = false;
let connState = 'idle';
let lastData = null;
let lastReceivedAt = null;

const $ = (id) => document.getElementById(id);

function formatNumber(value, maxDigits = 3) {
  if (value == null) return '—';
  const num = Number(value);
  return Number.isFinite(num)
    ? num.toLocaleString('zh-CN', { maximumFractionDigits: maxDigits })
    : '—';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTime(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDateTime(value) {
  if (!value) return '未知';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '未知' : d.toLocaleString('zh-CN');
}

function formatShortDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatCooldownTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '稍后';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay
    ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function createMetric(label, valueId, subId) {
  const item = document.createElement('div');
  item.className = 'status-metric';

  const labelEl = document.createElement('span');
  labelEl.className = 'status-metric-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.id = valueId;
  valueEl.className = 'status-metric-value';
  valueEl.textContent = '—';

  item.append(labelEl, valueEl);

  if (subId) {
    const subEl = document.createElement('span');
    subEl.id = subId;
    subEl.className = 'status-metric-sub';
    subEl.hidden = true;
    item.append(subEl);
  }

  return item;
}

function ensureMounted() {
  if (mounted) return true;
  const host = $('sharedStatusMount');
  if (!host) return false;

  const strip = document.createElement('div');
  strip.className = 'status-strip';

  const head = document.createElement('div');
  head.className = 'status-strip-head';

  const title = document.createElement('div');
  title.className = 'status-strip-title';

  const dot = document.createElement('span');
  dot.id = 'sharedDot';
  dot.className = 'dot dot-muted';
  dot.setAttribute('aria-hidden', 'true');

  const heading = document.createElement('span');
  heading.textContent = '共享池实时状态';

  const statePill = document.createElement('span');
  statePill.id = 'sharedStatePill';
  statePill.className = 'pill pill-sm pill-muted';
  statePill.textContent = '连接中';

  title.append(dot, heading, statePill);

  const meta = document.createElement('span');
  meta.id = 'sharedMeta';
  meta.className = 'faint tabular';
  meta.textContent = '等待连接';

  head.append(title, meta);

  const metrics = document.createElement('div');
  metrics.className = 'status-strip-metrics';
  metrics.append(
    createMetric('公共 V5', 'sharedV5', 'sharedRefill'),
    createMetric('公共订阅点数', 'sharedFixed', 'sharedPurchased'),
    createMetric('队列状态', 'sharedQueue'),
    createMetric('订阅到期', 'sharedExpires')
  );

  const alert = document.createElement('p');
  alert.id = 'sharedAlert';
  alert.className = 'notice notice-warn';
  alert.setAttribute('role', 'alert');
  alert.hidden = true;

  strip.append(head, metrics, alert);
  host.replaceChildren(strip);
  mounted = true;
  return true;
}

function updateHeaderState() {
  if (!ensureMounted()) return;
  const dot = $('sharedDot');
  const pill = $('sharedStatePill');
  const meta = $('sharedMeta');
  const statusInfo = lastData ? (STATUS_META[lastData.status] || {
    label: String(lastData.status || '未知'),
    pill: 'pill-muted',
    dot: 'dot-muted'
  }) : null;

  if (statusInfo) {
    pill.textContent = statusInfo.label;
    pill.className = `pill pill-sm ${statusInfo.pill}`;
  } else if (connState === 'expired') {
    pill.textContent = '会话过期';
    pill.className = 'pill pill-sm pill-danger';
  } else if (connState === 'error') {
    pill.textContent = '数据异常';
    pill.className = 'pill pill-sm pill-danger';
  } else if (connState === 'reconnecting') {
    pill.textContent = '重连中';
    pill.className = 'pill pill-sm pill-warn';
  } else {
    pill.textContent = '连接中';
    pill.className = 'pill pill-sm pill-muted';
  }

  if (connState === 'expired' || connState === 'error' || statusInfo?.dot === 'dot-danger') {
    dot.className = 'dot dot-danger';
  } else if (connState === 'reconnecting' || connState === 'connecting' || statusInfo?.dot === 'dot-warn') {
    dot.className = 'dot dot-warn';
  } else if (connState === 'open' && lastData?.status === 'active') {
    dot.className = 'dot dot-ok dot-pulse';
  } else {
    dot.className = 'dot dot-muted';
  }

  if (connState === 'expired') {
    meta.textContent = '登录已过期';
    meta.title = '登录已过期，请重新登录';
  } else if (connState === 'error') {
    meta.textContent = '数据异常，请刷新';
    meta.title = '';
  } else if (connState === 'reconnecting') {
    meta.textContent = '重连中…';
    meta.title = lastReceivedAt ? `上次更新于 ${formatTime(lastReceivedAt)}` : '';
  } else if (connState === 'connecting' && !lastData) {
    meta.textContent = '连接中…';
    meta.title = '';
  } else if (connState === 'idle') {
    meta.textContent = '未连接';
    meta.title = '';
  } else if (lastData) {
    const shownTime = formatTime(lastData.officialCheckedAt || lastReceivedAt);
    meta.textContent = shownTime ? `更新于 ${shownTime}` : '实时连接';
    const parts = [];
    if (lastData.officialCheckedAt) parts.push(`官方查询：${formatDateTime(lastData.officialCheckedAt)}`);
    if (lastReceivedAt) parts.push(`实时推送：${formatTime(lastReceivedAt)}`);
    meta.title = parts.join(' · ');
  } else {
    meta.textContent = '已连接';
    meta.title = '';
  }
}

function render(s) {
  if (!ensureMounted()) return;
  lastData = s;
  lastReceivedAt = new Date();
  connState = 'open';
  updateHeaderState();

  const v5El = $('sharedV5');
  v5El.textContent = s.v5Percent == null
    ? '—'
    : `${formatNumber(s.v5Percent)}%${s.v5IsNegative ? ' (透支)' : ''}`;

  const refillEl = $('sharedRefill');
  if (s.refillSecondsPerPercent > 0) {
    refillEl.textContent = `约 +${formatNumber(86400 / s.refillSecondsPerPercent, 1)}%/天`;
    refillEl.hidden = false;
  } else {
    refillEl.textContent = '';
    refillEl.hidden = true;
  }

  $('sharedFixed').textContent = formatNumber(s.anlasFixed);

  const purchasedEl = $('sharedPurchased');
  if (Number(s.anlasPurchased) > 0) {
    purchasedEl.textContent = `购买 ${formatNumber(s.anlasPurchased)}`;
    purchasedEl.hidden = false;
  } else {
    purchasedEl.textContent = '';
    purchasedEl.hidden = true;
  }

  const running = formatNumber(s.running ?? 0, 0);
  const limit = formatNumber(s.concurrencyLimit ?? 4, 0);
  const queued = formatNumber(s.queued ?? 0, 0);
  $('sharedQueue').textContent = `运行 ${running}/${limit} · 排队 ${queued}`;

  const expiresEl = $('sharedExpires');
  if (s.subscriptionActive && s.status !== 'inactive_opus') {
    expiresEl.textContent = formatShortDate(s.expiresAt);
    expiresEl.title = s.expiresAt ? `到期时间：${formatDateTime(s.expiresAt)}` : '';
    expiresEl.style.color = '';
  } else if (s.status === 'pending_opus') {
    expiresEl.textContent = '未接入';
    expiresEl.title = '';
    expiresEl.style.color = 'var(--text-muted)';
  } else {
    expiresEl.textContent = '未生效';
    expiresEl.title = '';
    expiresEl.style.color = 'var(--danger)';
  }

  const problems = [];
  if (s.cooldownUntil && new Date(s.cooldownUntil).getTime() > Date.now()) {
    problems.push(`限流冷却至 ${formatCooldownTime(s.cooldownUntil)}`);
  }
  if (s.quotaSyncError) {
    problems.push('官方余额同步异常');
  }
  if (s.stale) {
    problems.push(s.officialCheckedAt ? '官方余额已过期' : '尚无官方余额数据');
  }
  if (Number(s.recentFailures) > 0) {
    problems.push(`近 1 小时失败 ${formatNumber(s.recentFailures, 0)} 次`);
  }

  const alertEl = $('sharedAlert');
  if (problems.length) {
    const isDanger = Boolean(s.quotaSyncError) || s.status === 'inactive_opus' || s.status === 'disabled';
    alertEl.className = isDanger ? 'notice notice-danger' : 'notice notice-warn';
    alertEl.textContent = problems.join(' · ');
    alertEl.hidden = false;
  } else {
    alertEl.textContent = '';
    alertEl.hidden = true;
  }
}

function connect() {
  if (!active || document.hidden || events) return;
  ensureMounted();
  connState = lastData ? 'reconnecting' : 'connecting';
  updateHeaderState();

  events = new EventSource('/api/member/shared-events');
  events.addEventListener('shared-status', (event) => {
    try {
      render(JSON.parse(event.data));
    } catch {
      connState = 'error';
      updateHeaderState();
    }
  });
  events.addEventListener('auth-expired', () => {
    stopSharedStatus({ keepState: 'expired' });
    window.dispatchEvent(new CustomEvent('member-auth-expired'));
  });
  events.onerror = () => {
    if (!active) return;
    connState = 'reconnecting';
    updateHeaderState();
  };
  events.onopen = () => {
    connState = 'open';
    updateHeaderState();
  };
}

export function startSharedStatus() {
  active = true;
  ensureMounted();
  connect();
}

export function stopSharedStatus(options = {}) {
  active = false;
  events?.close();
  events = null;
  connState = options.keepState || 'idle';
  if (connState === 'idle') {
    lastData = null;
    lastReceivedAt = null;
    if (mounted) {
      $('sharedV5').textContent = '—';
      $('sharedRefill').textContent = '';
      $('sharedRefill').hidden = true;
      $('sharedFixed').textContent = '—';
      $('sharedPurchased').textContent = '';
      $('sharedPurchased').hidden = true;
      $('sharedQueue').textContent = '—';
      $('sharedExpires').textContent = '—';
      $('sharedExpires').title = '';
      $('sharedExpires').style.color = '';
      $('sharedAlert').textContent = '';
      $('sharedAlert').hidden = true;
    }
  }
  if (mounted) updateHeaderState();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    events?.close();
    events = null;
  } else {
    connect();
  }
});

window.addEventListener('pagehide', () => {
  events?.close();
  events = null;
});

ensureMounted();
