const $ = id => document.getElementById(id);

const bytes = value => (
  value >= 1073741824
    ? (value / 1073741824).toFixed(2) + ' GiB'
    : value >= 1048576
      ? (value / 1048576).toFixed(1) + ' MiB'
      : (value / 1024).toFixed(1) + ' KiB'
);

const formatTime = value => (value ? new Date(value).toLocaleString('zh-CN') : '—');

const shortTime = value => (
  value
    ? new Date(value).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    : '—'
);

function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function createImageIcon() {
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

  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '3');
  rect.setAttribute('y', '3');
  rect.setAttribute('width', '18');
  rect.setAttribute('height', '18');
  rect.setAttribute('rx', '2');
  rect.setAttribute('ry', '2');

  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('cx', '8.5');
  circle.setAttribute('cy', '8.5');
  circle.setAttribute('r', '1.5');

  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', '21 15 16 10 5 21');

  svg.append(rect, circle, poly);
  return svg;
}

export function initGallery({ api, getToken, notice }) {
  if (!document.querySelector('link[href="/admin/gallery.css"]')) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/admin/gallery.css';
    document.head.append(stylesheet);
  }

  let visible = false;
  let busy = false;
  let offset = 0;
  let total = 0;
  let pending = null;
  let confirming = false;
  let epoch = 0;
  let imageController = null;
  let imageTicket = 0;
  const selected = new Set();
  const urls = new Map();
  let pageImages = [];

  const endpoint = '/api/admin/gallery';
  const act = body => api(endpoint, body);

  const filters = () => {
    const value = {
      keyId: $('galleryKey').value,
      expiredOnly: $('galleryExpired').checked
    };
    if ($('galleryFrom').value) {
      value.from = new Date($('galleryFrom').value + 'T00:00:00').toISOString();
    }
    if ($('galleryBefore').value) {
      const end = new Date($('galleryBefore').value + 'T00:00:00');
      end.setDate(end.getDate() + 1);
      value.before = end.toISOString();
    }
    return value;
  };

  const filtered = () => {
    const f = filters();
    return Boolean(f.keyId || f.from || f.before || f.expiredOnly);
  };

  function buttons() {
    for (const id of [
      'galleryRefresh',
      'galleryFilter',
      'gallerySavePolicy',
      'galleryPrev',
      'galleryNext',
      'galleryDeleteSelected',
      'galleryDeleteFiltered',
      'gallerySelectPage'
    ]) {
      $(id).disabled = busy;
    }
    $('galleryPrev').disabled ||= offset === 0;
    $('galleryNext').disabled ||= offset + 24 >= total;
    $('galleryDeleteSelected').disabled ||= selected.size === 0;
    $('galleryDeleteFiltered').disabled ||= !filtered();
    $('gallerySelectPage').disabled ||= pageImages.length === 0;
    $('gallerySelected').textContent = `已选 ${selected.size} 张`;
    $('gallerySelected').className = `pill pill-sm tabular ${selected.size > 0 ? 'pill-accent' : 'pill-muted'}`;
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    buttons();
    notice('');
    try {
      await fn();
    } catch (cause) {
      if (visible) notice(cause.message, true);
    } finally {
      busy = false;
      buttons();
    }
  }

  function clearImageView() {
    imageTicket++;
    imageController?.abort();
    imageController = null;
    $('galleryFullImage').removeAttribute('src');
    $('galleryFullImage').hidden = true;
    $('galleryDownload').removeAttribute('href');
    $('galleryDownload').hidden = true;
    $('galleryImageLoading').hidden = true;
    $('galleryImageLoading').classList.remove('is-error');
    $('galleryImageRetry').hidden = true;
    $('galleryPrompt').value = '';
  }

  function releaseImages() {
    epoch++;
    clearImageView();
    if ($('galleryImageDialog').open) $('galleryImageDialog').close();
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  }

  async function imageUrl(image, ticket, signal) {
    if (urls.has(image.id)) return urls.get(image.id);
    const response = await fetch(
      `${endpoint}/images/${encodeURIComponent(image.id)}/content`,
      { headers: { 'x-admin-token': getToken() }, signal, cache: 'no-store' }
    );
    if (!response.ok) throw new Error('图片已清理或暂时无法读取');
    const blob = await response.blob();
    if (ticket !== epoch || !visible) throw new Error('页面已切换');
    const url = URL.createObjectURL(blob);
    if (urls.has(image.id)) URL.revokeObjectURL(url);
    else urls.set(image.id, url);
    return urls.get(image.id);
  }

  async function showImage(image) {
    clearImageView();
    const ticket = epoch;
    const view = imageTicket;
    imageController = new AbortController();
    const current = () => ticket === epoch && view === imageTicket && visible && $('galleryImageDialog').open;

    $('galleryImageTitle').textContent = image.filename;
    $('galleryImageMeta').replaceChildren(
      node('span', `${image.name} · ${image.maskedKey}`, 'pill pill-sm pill-accent'),
      node('span', image.model || '未知模型', 'pill pill-sm pill-muted'),
      node('span', `${image.width}×${image.height}`, 'pill pill-sm pill-muted tabular'),
      node('span', `${image.steps ?? '—'} 步`, 'pill pill-sm pill-muted tabular'),
      node('span', bytes(image.bytes), 'pill pill-sm pill-muted tabular'),
      node('span', formatTime(image.createdAt), 'pill pill-sm pill-muted tabular')
    );

    $('galleryPrompt').value = image.prompt || '未记录提示词';
    $('galleryImageLoading').classList.remove('is-error');
    $('galleryImageLoadingText').textContent = '正在加载原图…';
    $('galleryImageLoading').hidden = false;
    $('galleryImageRetry').onclick = () => showImage(image);
    if (!$('galleryImageDialog').open) $('galleryImageDialog').showModal();

    try {
      const url = await imageUrl(image, ticket, imageController.signal);
      if (!current()) return;
      $('galleryFullImage').src = url;
      $('galleryFullImage').hidden = false;
      $('galleryDownload').href = url;
      $('galleryDownload').download = image.filename;
      $('galleryDownload').hidden = false;
      $('galleryImageLoading').hidden = true;
    } catch (cause) {
      if (!current()) return;
      $('galleryImageLoading').classList.add('is-error');
      $('galleryImageLoadingText').textContent = cause.message;
      $('galleryImageRetry').hidden = false;
    }
  }

  function renderPage(result) {
    releaseImages();
    pageImages = result.images;
    selected.clear();
    total = result.total;
    $('gallerySelectPage').checked = false;

    const grid = $('galleryGrid');
    grid.replaceChildren();

    for (const image of pageImages) {
      const card = node('article', undefined, 'gallery-card');
      card.dataset.imageId = image.id;

      const check = node('input');
      check.type = 'checkbox';
      check.dataset.imageId = image.id;
      check.setAttribute('aria-label', '选择 ' + image.filename);
      check.onchange = () => {
        if (check.checked) selected.add(image.id);
        else selected.delete(image.id);
        card.classList.toggle('is-selected', check.checked);
        $('gallerySelectPage').checked = pageImages.length > 0 && selected.size === pageImages.length;
        buttons();
      };
      const selectLabel = node('label', undefined, 'gallery-card-select');
      selectLabel.append(check);

      const details = node('div', undefined, 'gallery-card-details');
      const head = node('div', undefined, 'gallery-card-head');

      const nameBtn = node('button', undefined, 'gallery-image');
      nameBtn.type = 'button';
      nameBtn.dataset.id = image.id;
      nameBtn.setAttribute('aria-label', '查看 ' + image.filename);
      nameBtn.disabled = Boolean(image.missing || image.unreadable);
      nameBtn.append(createImageIcon(), node('span', image.filename));
      nameBtn.onclick = () => showImage(image);

      const ownerPill = node('span', image.name, 'pill pill-sm pill-muted');
      ownerPill.title = image.maskedKey;
      head.append(nameBtn, ownerPill);

      const meta = node('div', undefined, 'gallery-card-meta');
      const metaParts = [
        `${image.width}×${image.height}`,
        `${image.steps ?? '—'} 步`,
        bytes(image.bytes),
        shortTime(image.createdAt)
      ];
      metaParts.forEach((part, index) => {
        if (index > 0) meta.append(node('span', '·', 'gallery-meta-dot'));
        meta.append(node('span', part));
      });
      if (image.missing) {
        meta.append(node('span', '文件缺失', 'pill pill-sm pill-danger'));
      } else if (image.unreadable) {
        meta.append(node('span', '不可读取', 'pill pill-sm pill-danger'));
      }

      details.append(head, meta);

      const removeBtn = node('button', '删除', 'danger btn-sm');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', '删除 ' + image.filename);
      removeBtn.onclick = () => run(() => previewDelete({ mode: 'selected', ids: [image.id] }));

      card.append(selectLabel, details, removeBtn);
      grid.append(card);
    }

    if (!pageImages.length) {
      grid.append(node('p', '当前条件下没有图片。', 'empty'));
    }

    $('galleryPageInfo').textContent = total
      ? `${offset + 1}–${Math.min(offset + 24, total)} / ${total} 张`
      : '0 张';
    buttons();
  }

  async function loadPage() {
    const ticket = epoch;
    const query = new URLSearchParams({ ...filters(), offset });
    const result = await api(endpoint + '?' + query);
    if (!visible || ticket !== epoch) return;
    if (offset && offset >= result.total) {
      offset = Math.max(0, Math.floor((result.total - 1) / 24) * 24);
      return loadPage();
    }
    renderPage(result);
  }

  function renderSummary(result) {
    const count = Number(result.count || 0);
    const expired = Number(result.expired || 0);
    const abnormal = Number(result.missing || 0) + Number(result.unreadable || 0);
    $('galleryTotal').textContent = `${count.toLocaleString('zh-CN')} 张`;
    $('galleryBytes').textContent = bytes(Number(result.bytes || 0));
    $('galleryExpiredCount').textContent = `${expired.toLocaleString('zh-CN')} 张`;
    $('galleryMissing').textContent = `${abnormal.toLocaleString('zh-CN')} 张`;

    $('galleryExpiredCard').classList.toggle('is-warn', expired > 0);
    $('galleryMissingCard').classList.toggle('is-danger', abnormal > 0);

    $('galleryDays').value = result.retentionDays;
    $('galleryPolicyBadge').textContent = result.retentionDays ? `保留 ${result.retentionDays} 天` : '永久保留';
    $('galleryPolicyBadge').className = `pill pill-sm ${result.retentionDays ? 'pill-accent' : 'pill-muted'}`;

    const lc = result.lastCleanup;
    const lastCleanupEl = $('galleryLastCleanup');
    lastCleanupEl.hidden = !lc;
    if (lc) {
      const failedText = lc.failed ? ` · ${lc.failed} 失败` : '';
      lastCleanupEl.textContent = `最近清理 ${shortTime(lc.at)} · ${lc.source === 'automatic' ? '自动' : '手动'} ${lc.deleted} 张 (${bytes(lc.bytes)})${failedText}`;
    }

    const currentKey = $('galleryKey').value;
    $('galleryKey').replaceChildren(
      new Option('全部 Key', ''),
      ...result.keys.map(key => new Option(`${key.name} · ${key.maskedKey}`, key.keyId))
    );
    $('galleryKey').value = result.keys.some(key => key.keyId === currentKey) ? currentKey : '';

    $('galleryKeyCountBadge').hidden = result.keys.length === 0;
    $('galleryKeyCountBadge').textContent = `${result.keys.length} 个`;

    const keyRows = $('galleryKeyRows');
    keyRows.replaceChildren();
    for (const key of result.keys) {
      const row = node('tr');
      const nameCell = node('td');
      nameCell.append(
        node('span', key.name, 'cell-primary'),
        node('span', key.maskedKey, 'cell-sub cell-mono')
      );

      const actionCell = node('td', undefined, 'cell-actions');
      const filterBtn = node('button', '筛选', 'secondary btn-sm');
      filterBtn.type = 'button';
      filterBtn.onclick = () => run(async () => {
        $('galleryKey').value = key.keyId;
        offset = 0;
        await loadPage();
        $('galleryFilters').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      actionCell.append(filterBtn);

      row.append(
        nameCell,
        node('td', String(key.count)),
        node('td', bytes(key.bytes)),
        node('td', String(key.expired)),
        node('td', String(key.missing + key.unreadable)),
        actionCell
      );
      keyRows.append(row);
    }

    if (!result.keys.length) {
      const row = node('tr');
      const td = node('td', '暂无 Key 数据', 'empty');
      td.colSpan = 6;
      row.append(td);
      keyRows.append(row);
    }
  }

  async function refresh() {
    const ticket = epoch;
    $('galleryLoading').hidden = false;
    try {
      const result = await api(endpoint + '?view=summary');
      if (!visible || ticket !== epoch) return;
      renderSummary(result);
      await loadPage();
    } finally {
      $('galleryLoading').hidden = true;
    }
  }

  function showConfirmation(plan, kind) {
    pending = { ...plan, kind };
    $('galleryConfirmError').hidden = true;
    $('galleryConfirmTitle').textContent = kind === 'policy' ? '确认保存期限' : '确认删除图片';
    $('galleryConfirmText').textContent = kind === 'policy'
      ? plan.retentionDays
        ? `将统一改为保留 ${plan.retentionDays} 天。现有 ${plan.total} 张、约 ${bytes(plan.bytes)} 的图片会被视为过期；保存后后台将按新规则分批清理。`
        : '将统一改为永久保留，并停止自动清理图片。'
      : `本次将删除 ${plan.total} 张图片，预计释放 ${bytes(plan.bytes)}。文件删除后无法恢复，生成和额度消费历史保留。`;

    const keysList = $('galleryConfirmKeys');
    keysList.replaceChildren(...plan.keys.map(
      key => node('li', `${key.name} · ${key.maskedKey}：${key.count} 张 / ${bytes(key.bytes)}`)
    ));
    keysList.hidden = plan.keys.length === 0;

    const actionBtn = $('galleryConfirmAction');
    actionBtn.textContent = kind === 'policy' ? '保存期限' : '确认删除';
    actionBtn.className = kind === 'delete' ? 'btn-danger-solid' : '';
    actionBtn.disabled = kind === 'delete' && plan.total === 0;

    $('galleryConfirmDialog').showModal();
  }

  async function previewDelete(target) {
    showConfirmation(await act({ action: 'preview-delete', ...target }), 'delete');
  }

  // Event Bindings
  $('galleryRefresh').onclick = () => run(refresh);

  $('galleryFilters').onsubmit = event => {
    event.preventDefault();
    run(async () => {
      offset = 0;
      await loadPage();
    });
  };

  $('galleryKey').onchange = buttons;
  $('galleryExpired').onchange = buttons;
  $('galleryFrom').onchange = buttons;
  $('galleryBefore').onchange = buttons;

  $('galleryPrev').onclick = () => run(async () => {
    offset = Math.max(0, offset - 24);
    await loadPage();
  });

  $('galleryNext').onclick = () => run(async () => {
    offset += 24;
    await loadPage();
  });

  $('gallerySelectPage').onchange = () => {
    const checked = $('gallerySelectPage').checked;
    selected.clear();
    for (const card of $('galleryGrid').querySelectorAll('.gallery-card')) {
      const check = card.querySelector('input[type="checkbox"]');
      if (!check) continue;
      check.checked = checked;
      card.classList.toggle('is-selected', checked);
      if (checked && check.dataset.imageId) selected.add(check.dataset.imageId);
    }
    buttons();
  };

  $('galleryDeleteSelected').onclick = () => run(() => previewDelete({
    mode: 'selected',
    ids: [...selected]
  }));

  $('galleryDeleteFiltered').onclick = () => run(() => previewDelete({
    mode: 'filtered',
    filters: filters()
  }));

  $('galleryPolicyForm').onsubmit = event => {
    event.preventDefault();
    run(async () => {
      const days = Number($('galleryDays').value);
      if (!Number.isInteger(days) || days < 0 || days > 3650) {
        throw new Error('请输入 0–3650 的整数天数');
      }
      showConfirmation(await act({ action: 'preview-policy', retentionDays: days }), 'policy');
    });
  };

  $('galleryConfirmAction').onclick = () => run(async () => {
    if (!pending) return;
    const plan = pending;
    confirming = true;
    $('galleryConfirmAction').disabled = true;
    $('galleryConfirmCancel').disabled = true;
    try {
      if (plan.kind === 'policy') {
        await act({ action: 'save-policy', planId: plan.planId });
        notice('保存期限已更新。');
      } else {
        let result;
        do {
          if (!visible) break;
          result = await act({ action: 'delete', planId: plan.planId });
          $('galleryConfirmText').textContent =
            `已处理 ${result.total - result.remaining} / ${result.total} 张；已删除 ${result.deleted} 张，释放 ${bytes(result.freedBytes)}。`;
        } while (!result.done);
        if (result) {
          notice(
            `已删除 ${result.deleted} 张，释放 ${bytes(result.freedBytes)}。${result.failed ? `另有 ${result.failed} 张未能删除，记录保留，请检查文件权限后重试。` : ''}`,
            result.failed > 0
          );
        }
      }
      pending = null;
      $('galleryConfirmDialog').close();
      if (visible) await refresh();
    } catch (cause) {
      $('galleryConfirmError').textContent = cause.message + '；请核对最新统计，必要时重新预览。';
      $('galleryConfirmError').hidden = false;
    } finally {
      confirming = false;
      $('galleryConfirmCancel').disabled = false;
      $('galleryConfirmAction').disabled = false;
    }
  });

  $('galleryConfirmDialog').addEventListener('cancel', event => {
    if (confirming) event.preventDefault();
  });

  $('galleryConfirmCancel').onclick = () => {
    if (!confirming) $('galleryConfirmDialog').close();
  };

  $('galleryConfirmDialog').addEventListener('close', () => {
    if (pending && !confirming) {
      const id = pending.planId;
      pending = null;
      act({ action: 'cancel', planId: id }).catch(() => {});
    }
  });

  $('galleryImageClose').onclick = () => $('galleryImageDialog').close();
  $('galleryImageDialog').addEventListener('close', clearImageView);

  $('galleryCopyPrompt').onclick = () => {
    navigator.clipboard.writeText($('galleryPrompt').value)
      .then(() => notice('提示词已复制。'))
      .catch(() => notice('复制失败，请手动选择提示词复制。', true));
  };

  buttons();

  return {
    show() {
      visible = true;
      return run(refresh);
    },
    hide() {
      visible = false;
      releaseImages();
    },
    reset() {
      if (pending) act({ action: 'cancel', planId: pending.planId }).catch(() => {});
      visible = false;
      releaseImages();
      pending = null;
      selected.clear();
      offset = 0;
      pageImages = [];
      $('galleryGrid').replaceChildren();
      $('galleryKeyRows').replaceChildren();
      $('galleryPrompt').value = '';
    }
  };
}
