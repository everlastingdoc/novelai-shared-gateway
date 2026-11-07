const $ = id => document.getElementById(id);
const bytes = value => value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GiB' : value >= 1048576 ? (value / 1048576).toFixed(1) + ' MiB' : (value / 1024).toFixed(1) + ' KiB';
const time = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }

export function initGallery({ api, getToken, notice }) {
  const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/admin/gallery.css'; document.head.append(stylesheet);
  let visible = false, busy = false, offset = 0, total = 0, pending = null, confirming = false, epoch = 0;
  let controller = new AbortController(), observer;
  const selected = new Set(), urls = new Map();
  let pageImages = [], previewQueue = [], activePreviews = 0;
  const endpoint = '/api/admin/gallery';
  const act = body => api(endpoint, body);
  const filters = () => {
    const value = { keyId: $('galleryKey').value, expiredOnly: $('galleryExpired').checked };
    if ($('galleryFrom').value) value.from = new Date($('galleryFrom').value + 'T00:00:00').toISOString();
    if ($('galleryBefore').value) { const end = new Date($('galleryBefore').value + 'T00:00:00'); end.setDate(end.getDate() + 1); value.before = end.toISOString(); }
    return value;
  };
  const filtered = () => { const f = filters(); return Boolean(f.keyId || f.from || f.before || f.expiredOnly); };
  function buttons() {
    for (const id of ['galleryRefresh', 'galleryFilter', 'gallerySavePolicy', 'galleryPrev', 'galleryNext', 'galleryDeleteSelected', 'galleryDeleteFiltered', 'gallerySelectPage']) $(id).disabled = busy;
    $('galleryPrev').disabled ||= offset === 0;
    $('galleryNext').disabled ||= offset + 24 >= total;
    $('galleryDeleteSelected').disabled ||= selected.size === 0;
    $('galleryDeleteFiltered').disabled ||= !filtered();
    $('gallerySelectPage').disabled ||= pageImages.length === 0;
    $('gallerySelected').textContent = `已选 ${selected.size} 张（当前页）`;
  }
  async function run(fn) {
    if (busy) return;
    busy = true; buttons(); notice('');
    try { await fn(); } catch (cause) { if (visible) notice(cause.message, true); }
    finally { busy = false; buttons(); }
  }
  function releaseImages() {
    epoch++; controller.abort(); controller = new AbortController(); observer?.disconnect(); previewQueue = [];
    $('galleryImageDialog').close();
    $('galleryFullImage').removeAttribute('src');
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  }
  function pumpPreviews() {
    while (previewQueue.length && activePreviews < 3) {
      const job = previewQueue.shift(); activePreviews++;
      job().catch(() => {}).finally(() => { activePreviews--; pumpPreviews(); });
    }
  }
  async function imageUrl(image, ticket = epoch) {
    if (urls.has(image.id)) return urls.get(image.id);
    const response = await fetch(`${endpoint}/images/${encodeURIComponent(image.id)}/content`, { headers: { 'x-admin-token': getToken() }, signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('图片已清理或暂时无法读取');
    const blob = await response.blob();
    if (ticket !== epoch || !visible) throw new Error('页面已切换');
    const url = URL.createObjectURL(blob);
    if (urls.has(image.id)) URL.revokeObjectURL(url);
    else urls.set(image.id, url);
    return urls.get(image.id);
  }
  async function showImage(image) {
    const ticket = epoch;
    try {
      const url = await imageUrl(image, ticket);
      if (ticket !== epoch) return;
      $('galleryFullImage').src = url;
      $('galleryImageTitle').textContent = image.name + ' · ' + image.maskedKey;
      $('galleryImageInfo').textContent = `${time(image.createdAt)} · ${image.model || '未知模型'} · ${image.width}×${image.height} · ${image.steps ?? '—'} 步 · ${bytes(image.bytes)}`;
      $('galleryPrompt').value = image.prompt || '未记录提示词';
      $('galleryDownload').href = url; $('galleryDownload').download = image.id + (image.mimeType === 'image/jpeg' ? '.jpg' : image.mimeType === 'image/webp' ? '.webp' : '.png');
      $('galleryImageDialog').showModal();
    } catch (cause) { if (ticket === epoch) notice(cause.message, true); }
  }
  function renderPage(result) {
    releaseImages(); pageImages = result.images; selected.clear(); total = result.total;
    $('gallerySelectPage').checked = false;
    $('galleryGrid').replaceChildren();
    const ticket = epoch;
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        const button = entry.target, image = pageImages.find(item => item.id === button.dataset.id);
        previewQueue.push(async () => {
          if (ticket !== epoch) return;
          try { const url = await imageUrl(image, ticket); if (ticket === epoch) { const img = node('img'); img.src = url; img.alt = image.name + ' 的生成图片'; button.replaceChildren(img); } }
          catch { if (ticket === epoch) button.textContent = '图片无法读取'; }
        });
      }
      pumpPreviews();
    }, { rootMargin: '180px' });
    for (const image of pageImages) {
      const card = node('article', undefined, 'gallery-card');
      const check = node('input'); check.type = 'checkbox'; check.setAttribute('aria-label', '选择 ' + image.id);
      check.onchange = () => { if (check.checked) selected.add(image.id); else selected.delete(image.id); $('gallerySelectPage').checked = selected.size === pageImages.length; buttons(); };
      const label = node('label', image.name + ' · ' + image.maskedKey, 'gallery-card-label'); label.prepend(check);
      const button = node('button', image.missing ? '文件已缺失' : image.unreadable ? '文件不可读取' : '加载预览…', 'gallery-image');
      button.type = 'button'; button.dataset.id = image.id; button.setAttribute('aria-label', '查看 ' + image.id); button.disabled = image.missing || image.unreadable;
      button.onclick = () => showImage(image);
      card.append(label, button, node('p', time(image.createdAt), 'muted'), node('p', `${image.width}×${image.height} · ${image.steps ?? '—'} 步 · ${bytes(image.bytes)}`, 'muted'));
      const remove = node('button', '删除此图', 'secondary danger'); remove.type = 'button'; remove.onclick = () => run(() => previewDelete({ mode: 'selected', ids: [image.id] })); card.append(remove);
      $('galleryGrid').append(card); if (!button.disabled) observer.observe(button);
    }
    if (!pageImages.length) $('galleryGrid').append(node('p', '当前条件下没有图片。', 'empty'));
    $('galleryPageInfo').textContent = total ? `${offset + 1}–${Math.min(offset + 24, total)} / ${total} 张` : '0 张';
    buttons();
  }
  async function loadPage() {
    const ticket = epoch;
    const query = new URLSearchParams({ ...filters(), offset });
    const result = await api(endpoint + '?' + query);
    if (!visible || ticket !== epoch) return;
    if (offset && offset >= result.total) { offset = Math.max(0, Math.floor((result.total - 1) / 24) * 24); return loadPage(); }
    renderPage(result);
  }
  function renderSummary(result) {
    for (const [id, value] of [['galleryTotal', result.count + ' 张'], ['galleryBytes', bytes(result.bytes)], ['galleryExpiredCount', result.expired + ' 张'], ['galleryMissing', result.missing + result.unreadable + ' 张']]) $(id).textContent = value;
    $('galleryDays').value = result.retentionDays;
    $('galleryPolicyHint').textContent = result.retentionDays ? `当前保留 ${result.retentionDays} 天；按生成时间计算，每小时检查一次。` : '当前永久保留，不自动清理。';
    $('galleryLastCleanup').textContent = result.lastCleanup ? `最近清理：${time(result.lastCleanup.at)} · ${result.lastCleanup.source === 'automatic' ? '自动' : '手动'} · ${result.lastCleanup.deleted} 张 · 释放 ${bytes(result.lastCleanup.bytes)}${result.lastCleanup.failed ? ` · ${result.lastCleanup.failed} 张未能清理` : ''}` : '尚无清理记录';
    const current = $('galleryKey').value;
    $('galleryKey').replaceChildren(new Option('全部 Key', ''), ...result.keys.map(key => new Option(key.name + ' · ' + key.maskedKey, key.keyId)));
    $('galleryKey').value = result.keys.some(key => key.keyId === current) ? current : '';
    $('galleryKeyRows').replaceChildren();
    for (const key of result.keys) {
      const row = node('tr'), name = node('td', key.name); name.append(node('span', key.maskedKey, 'cell-sub'));
      row.append(name, node('td', key.count), node('td', bytes(key.bytes)), node('td', key.expired), node('td', key.missing + key.unreadable));
      const cell = node('td'), button = node('button', '查看', 'secondary'); button.onclick = () => run(async () => { $('galleryKey').value = key.keyId; offset = 0; await loadPage(); }); cell.append(button); row.append(cell); $('galleryKeyRows').append(row);
    }
  }
  async function refresh() {
    const ticket = epoch;
    $('galleryLoading').hidden = false;
    try {
      const result = await api(endpoint + '?view=summary');
      if (!visible || ticket !== epoch) return;
      renderSummary(result); await loadPage();
    } finally { $('galleryLoading').hidden = true; }
  }
  function showConfirmation(plan, kind) {
    pending = { ...plan, kind };
    $('galleryConfirmError').hidden = true;
    $('galleryConfirmTitle').textContent = kind === 'policy' ? '确认保存期限' : '确认删除图片';
    $('galleryConfirmText').textContent = kind === 'policy'
      ? plan.retentionDays ? `将统一改为保留 ${plan.retentionDays} 天。现有 ${plan.total} 张、约 ${bytes(plan.bytes)} 的图片会被视为过期；保存后后台将按新规则分批清理。` : '将统一改为永久保留，并停止自动清理图片。'
      : `本次将删除 ${plan.total} 张图片，预计释放 ${bytes(plan.bytes)}。文件删除后无法恢复，生成和额度消费历史保留。`;
    $('galleryConfirmKeys').replaceChildren(...plan.keys.map(key => node('li', `${key.name} · ${key.maskedKey}：${key.count} 张 / ${bytes(key.bytes)}`)));
    $('galleryConfirmAction').textContent = kind === 'policy' ? '保存期限' : '确认删除';
    $('galleryConfirmAction').disabled = kind === 'delete' && plan.total === 0;
    $('galleryConfirmDialog').showModal();
  }
  async function previewDelete(target) { showConfirmation(await act({ action: 'preview-delete', ...target }), 'delete'); }
  $('galleryRefresh').onclick = () => run(refresh);
  $('galleryFilters').onsubmit = event => { event.preventDefault(); run(async () => { offset = 0; await loadPage(); }); };
  $('galleryKey').onchange = buttons; $('galleryExpired').onchange = buttons; $('galleryFrom').onchange = buttons; $('galleryBefore').onchange = buttons;
  $('galleryPrev').onclick = () => run(async () => { offset = Math.max(0, offset - 24); await loadPage(); });
  $('galleryNext').onclick = () => run(async () => { offset += 24; await loadPage(); });
  $('gallerySelectPage').onchange = () => { const checked = $('gallerySelectPage').checked; for (const check of $('galleryGrid').querySelectorAll('input[type=checkbox]')) { check.checked = checked; check.onchange(); } buttons(); };
  $('galleryDeleteSelected').onclick = () => run(() => previewDelete({ mode: 'selected', ids: [...selected] }));
  $('galleryDeleteFiltered').onclick = () => run(() => previewDelete({ mode: 'filtered', filters: filters() }));
  $('galleryPolicyForm').onsubmit = event => { event.preventDefault(); run(async () => {
    const days = Number($('galleryDays').value);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('请输入 0–3650 的整数天数');
    showConfirmation(await act({ action: 'preview-policy', retentionDays: days }), 'policy');
  }); };
  $('galleryConfirmAction').onclick = () => run(async () => {
    if (!pending) return;
    const plan = pending; confirming = true;
    $('galleryConfirmAction').disabled = true; $('galleryConfirmCancel').disabled = true;
    try {
      if (plan.kind === 'policy') { await act({ action: 'save-policy', planId: plan.planId }); notice('保存期限已更新。'); }
      else {
        let result;
        do {
          if (!visible) break;
          result = await act({ action: 'delete', planId: plan.planId });
          $('galleryConfirmText').textContent = `已处理 ${result.total - result.remaining} / ${result.total} 张；已删除 ${result.deleted} 张，释放 ${bytes(result.freedBytes)}。`;
        } while (!result.done);
        if (result) notice(`已删除 ${result.deleted} 张，释放 ${bytes(result.freedBytes)}。${result.failed ? `另有 ${result.failed} 张未能删除，记录保留，请检查文件权限后重试。` : ''}`, result.failed > 0);
      }
      pending = null; $('galleryConfirmDialog').close(); if (visible) await refresh();
    } catch (cause) { $('galleryConfirmError').textContent = cause.message + '；请核对最新统计，必要时重新预览。'; $('galleryConfirmError').hidden = false; }
    finally { confirming = false; $('galleryConfirmCancel').disabled = false; $('galleryConfirmAction').disabled = false; }
  });
  $('galleryConfirmDialog').addEventListener('cancel', event => { if (confirming) event.preventDefault(); });
  $('galleryConfirmCancel').onclick = () => { if (!confirming) $('galleryConfirmDialog').close(); };
  $('galleryConfirmDialog').addEventListener('close', () => { if (pending && !confirming) { const id = pending.planId; pending = null; act({ action: 'cancel', planId: id }).catch(() => {}); } });
  $('galleryImageClose').onclick = () => $('galleryImageDialog').close();
  $('galleryCopyPrompt').onclick = () => navigator.clipboard.writeText($('galleryPrompt').value).then(() => notice('提示词已复制。')).catch(() => notice('复制失败，请手动选择提示词复制。', true));
  buttons();
  return {
    show() { visible = true; return run(refresh); },
    hide() { visible = false; releaseImages(); },
    reset() { if (pending) act({ action: 'cancel', planId: pending.planId }).catch(() => {}); visible = false; releaseImages(); pending = null; selected.clear(); offset = 0; pageImages = []; $('galleryGrid').replaceChildren(); $('galleryKeyRows').replaceChildren(); $('galleryPrompt').value = ''; },
  };
}
