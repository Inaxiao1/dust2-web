import {
  LAYOUT_KEY,
  TOUCH_BUTTON_LABELS,
  TOUCH_PRESETS,
  TOUCH_REQUIRED_IDS,
  normalizeLayout,
  parseLayout,
  layoutRect,
  buildTouchPresetLayout,
} from '../shared/touch-layout.js';
import './touch-layout-editor.css';

const STYLE_FIELDS = ['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'min-width', 'min-height', 'opacity', 'transform', 'display'];

function viewportDims() {
  return {
    width: Math.max(1, Math.round(globalThis.visualViewport?.width || innerWidth)),
    height: Math.max(1, Math.round(globalThis.visualViewport?.height || innerHeight)),
  };
}

export function mountTouchLayout(panel, modal, touch) {
  let saved = normalizeLayout(touch.storage.readJSON(LAYOUT_KEY));
  let draft = null;
  let selected = 'fireLeft';
  let bases = new Map();
  let inspectorCollapsed = false;

  const controls = [...touch.element.querySelectorAll('[data-layout-id],[data-action],[data-touch-command=room],[data-touch-command=fullscreen],.touch-joystick')]
    .filter((el, idx, arr) => arr.indexOf(el) === idx);
  const idOf = (el) => el.dataset.layoutId || el.dataset.action || el.dataset.touchCommand || 'move';
  const labelOf = (key, el) => TOUCH_BUTTON_LABELS[key] || el?.textContent?.trim() || key;

  function measure() {
    const { width, height } = viewportDims();
    const wasHidden = touch.element.hidden;
    const hadTouchBody = document.body.classList.contains('touch-device');
    const hadSpectator = document.body.classList.contains('touch-spectator');
    if (!hadTouchBody) document.body.classList.add('touch-device');
    if (hadSpectator) document.body.classList.remove('touch-spectator');
    touch.element.hidden = false;
    for (const el of controls) {
      for (const f of STYLE_FIELDS) el.style.removeProperty(f);
    }
    bases = new Map(controls.map((el) => {
      const b = el.getBoundingClientRect();
      const w = Math.max(32, b.width || 44);
      const h = Math.max(32, b.height || 44);
      return [idOf(el), {
        width: w,
        height: h,
        x: Math.min(1, Math.max(0, (b.x + w / 2) / width)),
        y: Math.min(1, Math.max(0, (b.y + h / 2) / height)),
        round: el.classList.contains('touch-joystick') || el.classList.contains('touch-fire') || el.classList.contains('touch-fire-left') || el.classList.contains('touch-walk') || Boolean(el.closest('.touch-combat')),
      }];
    }));
    touch.element.hidden = wasHidden;
    if (hadSpectator) document.body.classList.add('touch-spectator');
    if (!hadTouchBody) document.body.classList.remove('touch-device');
  }

  function apply() {
    measure();
    const { width, height } = viewportDims();
    for (const el of controls) {
      const key = idOf(el);
      const b = saved.buttons[key];
      const base = bases.get(key);
      if (!b || !base) continue;
      if (b.hidden === true && !TOUCH_REQUIRED_IDS.has(key)) {
        el.style.setProperty('display', 'none', 'important');
        continue;
      }
      const r = layoutRect(b, base, width, height);
      for (const [k, v] of Object.entries({
        position: 'fixed',
        left: r.left + 'px',
        top: r.top + 'px',
        right: 'auto',
        bottom: 'auto',
        width: r.width + 'px',
        height: r.height + 'px',
        'min-width': '0',
        'min-height': '0',
        opacity: String(b.opacity),
        transform: 'none',
      })) {
        el.style.setProperty(k, v, 'important');
      }
    }
  }

  const editor = document.createElement('div');
  editor.id = 'touch-layout-editor';
  editor.hidden = true;
  editor.setAttribute('role', 'dialog');
  editor.setAttribute('aria-modal', 'true');
  editor.setAttribute('aria-label', '自定义移动端按键布局');
  editor.innerHTML = `
    <div class="layout-grid-guide" aria-hidden="true">
      <i class="layout-crosshair-h"></i>
      <i class="layout-crosshair-v"></i>
      <span class="layout-center-hint">中央瞄准区 · 拖动任意按键调整位置</span>
    </div>
    <div class="layout-stage"></div>
    <div class="layout-chrome">
      <header class="layout-toolbar">
        <div class="layout-presets" role="group" aria-label="快捷指法预设">
          ${TOUCH_PRESETS.map((p) => `<button type="button" class="layout-preset-btn" data-preset="${p.id}" title="${p.hint}">${p.label}</button>`).join('')}
          <button type="button" data-reset>恢复默认</button>
        </div>
        <div class="layout-actions">
          <button type="button" data-toggle-inspector>属性栏</button>
          <button type="button" data-code>代码</button>
          <button type="button" data-cancel>取消</button>
          <button type="button" class="layout-save-btn" data-save>保存布局</button>
        </div>
      </header>
      <aside class="layout-inspector">
        <div class="layout-inspector-head">
          <strong data-name>左侧开火</strong>
          <label class="layout-hide-toggle" data-hide-wrap><input type="checkbox" data-hidden-check><span>隐藏此按键</span></label>
        </div>
        <div class="layout-inspector-sliders">
          <label><span>大小</span><input data-size type="range" min="0.65" max="1.5" step="0.05"><output data-size-out>100%</output></label>
          <label><span>透明</span><input data-opacity type="range" min="0.25" max="1" step="0.05"><output data-opacity-out>80%</output></label>
        </div>
        <div class="layout-share-box" data-share hidden>
          <textarea aria-label="布局代码" spellcheck="false" placeholder="粘贴或复制自定义布局 JSON 代码"></textarea>
          <button type="button" data-import>导入代码</button>
        </div>
        <p class="layout-status" role="status">拖动按钮自由摆放；左侧开火键可拖至左上角供三指 / 四指使用。</p>
      </aside>
    </div>`;
  document.body.append(editor);

  const $ = (s) => editor.querySelector(s);
  const stage = $('.layout-stage');
  const inspector = $('.layout-inspector');

  let modifiedKeys = new Set();

  function syncDraftDefaults() {
    draft = normalizeLayout(saved);
    modifiedKeys = new Set(Object.keys(draft.buttons));
    for (const [key, b] of bases) {
      draft.buttons[key] ??= { x: b.x, y: b.y, size: 1, opacity: 0.8 };
    }
  }

  function draw() {
    if (!draft) return;
    const { width, height } = viewportDims();
    for (const node of stage.children) {
      const key = node.dataset.id;
      const b = draft.buttons[key];
      const base = bases.get(key);
      if (!b || !base) continue;
      const r = layoutRect(b, base, width, height);
      Object.assign(node.style, {
        left: r.left + 'px',
        top: r.top + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
        opacity: b.hidden ? '0.26' : String(b.opacity),
      });
      node.classList.toggle('selected', selected === key);
      node.classList.toggle('is-hidden-btn', Boolean(b.hidden));
    }
  }

  function choose(key) {
    if (!draft?.buttons[key]) key = [...bases.keys()][0] || 'fireLeft';
    selected = key;
    const b = draft.buttons[key];
    $('[data-name]').textContent = labelOf(key);
    $('[data-size]').value = String(b.size);
    $('[data-opacity]').value = String(b.opacity);
    $('[data-size-out]').textContent = Math.round(b.size * 100) + '%';
    $('[data-opacity-out]').textContent = Math.round(b.opacity * 100) + '%';
    const canHide = !TOUCH_REQUIRED_IDS.has(key);
    $('[data-hide-wrap]').hidden = !canHide;
    $('[data-hidden-check]').checked = Boolean(b.hidden);
    draw();
  }

  function applyPresetToDraft(presetId) {
    const { width, height } = viewportDims();
    const presetLayout = buildTouchPresetLayout(presetId, bases, width, height);
    modifiedKeys = new Set(Object.keys(presetLayout.buttons));
    draft = { version: 1, buttons: { ...presetLayout.buttons } };
    for (const [key, b] of bases) {
      draft.buttons[key] ??= { x: b.x, y: b.y, size: 1, opacity: 0.8 };
    }
    const presetMeta = TOUCH_PRESETS.find((p) => p.id === presetId);
    if (presetMeta) {
      $('.layout-status').textContent = `已套用「${presetMeta.label}」：${presetMeta.hint}。仍可继续微调后点击保存。`;
    }
    choose(selected);
  }

  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('[data-id]');
    if (!node) return;
    e.preventDefault();
    choose(node.dataset.id);
    drag = {
      pointer: e.pointerId,
      key: selected,
      x: e.clientX,
      y: e.clientY,
      start: { ...draft.buttons[selected] },
    };
    node.setPointerCapture?.(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (drag?.pointer !== e.pointerId) return;
    e.preventDefault();
    const { width, height } = viewportDims();
    const b = draft.buttons[drag.key];
    modifiedKeys.add(drag.key);
    b.x = Math.min(1, Math.max(0, drag.start.x + (e.clientX - drag.x) / width));
    b.y = Math.min(1, Math.max(0, drag.start.y + (e.clientY - drag.y) / height));
    draw();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stage.addEventListener(event, () => { drag = null; });
  }

  $('[data-size]').oninput = (e) => {
    if (!selected || !draft?.buttons[selected]) return;
    modifiedKeys.add(selected);
    draft.buttons[selected].size = Number(e.target.value);
    $('[data-size-out]').textContent = Math.round(draft.buttons[selected].size * 100) + '%';
    draw();
  };
  $('[data-opacity]').oninput = (e) => {
    if (!selected || !draft?.buttons[selected]) return;
    modifiedKeys.add(selected);
    draft.buttons[selected].opacity = Number(e.target.value);
    $('[data-opacity-out]').textContent = Math.round(draft.buttons[selected].opacity * 100) + '%';
    draw();
  };
  $('[data-hidden-check]').onchange = (e) => {
    if (!selected || !draft?.buttons[selected] || TOUCH_REQUIRED_IDS.has(selected)) return;
    modifiedKeys.add(selected);
    if (e.target.checked) draft.buttons[selected].hidden = true;
    else delete draft.buttons[selected].hidden;
    draw();
  };

  for (const btn of editor.querySelectorAll('[data-preset]')) {
    btn.onclick = () => applyPresetToDraft(btn.dataset.preset);
  }
  $('[data-toggle-inspector]').onclick = () => {
    inspectorCollapsed = !inspectorCollapsed;
    inspector.classList.toggle('is-collapsed', inspectorCollapsed);
  };

  function close() {
    editor.hidden = true;
    touch.clear();
    modal.hidden = false;
    openBtn.focus();
  }

  function buildPersistableDraft() {
    const out = { version: 1, buttons: {} };
    for (const key of modifiedKeys) {
      if (draft?.buttons?.[key]) out.buttons[key] = draft.buttons[key];
    }
    return normalizeLayout(out);
  }

  $('[data-save]').onclick = () => {
    saved = buildPersistableDraft();
    const ok = touch.storage.setItem(LAYOUT_KEY, JSON.stringify(saved));
    apply();
    if (!ok) {
      $('.layout-status').textContent = '存储空间不足，本次布局已应用，请导出代码备份后再退出。';
      return;
    }
    syncLauncherStatus(Object.keys(saved.buttons).length ? '已保存自定义按键布局' : '已恢复自适应默认布局');
    close();
  };
  $('[data-cancel]').onclick = close;
  $('[data-reset]').onclick = () => {
    modifiedKeys = new Set();
    draft = {
      version: 1,
      buttons: Object.fromEntries([...bases].map(([key, b]) => [key, { x: b.x, y: b.y, size: 1, opacity: 0.8 }])),
    };
    $('.layout-status').textContent = '已恢复当前屏幕默认布局，点击「保存布局」生效。';
    choose(selected);
  };
  $('[data-code]').onclick = () => {
    const share = $('[data-share]');
    share.hidden = !share.hidden;
    if (!share.hidden) {
      inspectorCollapsed = false;
      inspector.classList.remove('is-collapsed');
      $('textarea').value = JSON.stringify(buildPersistableDraft());
    }
  };
  $('[data-import]').onclick = () => {
    try {
      const imported = parseLayout($('textarea').value);
      for (const k of Object.keys(imported.buttons)) modifiedKeys.add(k);
      draft.buttons = { ...draft.buttons, ...imported.buttons };
      choose(selected);
      $('.layout-status').textContent = '布局代码已载入，点击「保存布局」立即生效。';
    } catch (e) {
      $('.layout-status').textContent = e.message;
    }
  };
  editor.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    if (e.code === 'Tab') {
      const nodes = [...editor.querySelectorAll('button,input,textarea')].filter((el) => el.getClientRects().length);
      const index = nodes.indexOf(document.activeElement);
      e.preventDefault();
      nodes[(index + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus();
    }
  });

  function openEditor(initialPreset = null) {
    touch.clear();
    touch.onCancel?.();
    measure();
    syncDraftDefaults();
    if (initialPreset) {
      const { width, height } = viewportDims();
      const presetLayout = buildTouchPresetLayout(initialPreset, bases, width, height);
      modifiedKeys = new Set(Object.keys(presetLayout.buttons));
      draft = { version: 1, buttons: { ...presetLayout.buttons } };
      for (const [key, b] of bases) {
        draft.buttons[key] ??= { x: b.x, y: b.y, size: 1, opacity: 0.8 };
      }
    }
    stage.replaceChildren();
    for (const el of controls) {
      const key = idOf(el);
      const base = bases.get(key);
      const node = document.createElement('button');
      node.type = 'button';
      node.dataset.id = key;
      node.className = 'layout-handle' + (base?.round ? ' is-round' : '') + (key === 'fireLeft' || key === 'fire' ? ' is-fire' : '') + (key === 'move' ? ' is-move' : '');
      node.textContent = labelOf(key, el);
      stage.append(node);
    }
    modal.hidden = true;
    editor.hidden = false;
    $('[data-share]').hidden = true;
    inspectorCollapsed = false;
    inspector.classList.remove('is-collapsed');
    choose('fireLeft');
    $('[data-save]').focus();
  }

  // Mount rich launcher UI inside Settings panel (open editor + instant 2/3/4-finger presets + reset)
  const launcher = panel.querySelector('[data-layout-launcher]') || panel;
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'touch-layout-open-btn';
  openBtn.textContent = '自定义按键位置与大小 →';
  openBtn.onclick = () => openEditor(null);

  const presetRow = document.createElement('div');
  presetRow.className = 'touch-layout-quick-presets';
  for (const preset of TOUCH_PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'preset-chip';
    chip.innerHTML = `<b>${preset.label}</b><span>${preset.id === 'two-finger' ? '双指' : preset.id === 'three-finger' ? '三指' : '四指'}</span>`;
    chip.onclick = () => {
      measure();
      const { width, height } = viewportDims();
      saved = buildTouchPresetLayout(preset.id, bases, width, height);
      touch.storage.setItem(LAYOUT_KEY, JSON.stringify(saved));
      apply();
      syncLauncherStatus(`已切换为「${preset.label}」并保存，点击上方按钮可继续拖动微调`);
    };
    presetRow.append(chip);
  }
  const resetQuick = document.createElement('button');
  resetQuick.type = 'button';
  resetQuick.className = 'preset-chip';
  resetQuick.innerHTML = '<b>恢复默认</b><span>重置</span>';
  resetQuick.onclick = () => {
    saved = { version: 1, buttons: {} };
    touch.storage.setItem(LAYOUT_KEY, JSON.stringify(saved));
    apply();
    syncLauncherStatus('已恢复自适应默认布局');
  };
  presetRow.append(resetQuick);

  const launcherStatus = document.createElement('p');
  launcherStatus.className = 'touch-layout-launcher-status';
  launcherStatus.setAttribute('role', 'status');
  function syncLauncherStatus(msg) {
    const count = Object.keys(saved.buttons || {}).length;
    launcherStatus.textContent = msg || (count ? `已启用自定义按键布局（已配置 ${count} 个按键）` : '当前使用自适应默认布局（含左侧独立开火键）');
  }
  syncLauncherStatus();

  launcher.append(openBtn, presetRow, launcherStatus);

  const onResize = () => {
    apply();
    if (!editor.hidden) draw();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 180));
  globalThis.visualViewport?.addEventListener('resize', onResize);
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'touch-size') apply();
  });
  touch._applyCustomLayout = () => {
    saved = normalizeLayout(touch.storage.readJSON(LAYOUT_KEY));
    apply();
  };
  apply();
  return { openEditor, apply };
}
