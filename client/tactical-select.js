/**
 * Replaces native <select> dropdowns with Valorant-style chamfered tactical controls
 * (segmented pills, visual squad slot stepper, or scrollable card grid) while keeping
 * the underlying <select> element synchronized in DOM for full JS & test compatibility.
 */

export function upgradeSelect(select, { variant = 'pills', compact = false } = {}) {
  if (!select || select.dataset.tacticalUpgraded === '1') return select?._tacticalControl || null;
  select.dataset.tacticalUpgraded = '1';
  select.hidden = true;
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;

  const host = document.createElement('div');
  host.className = `tac-control tac-${variant}${compact ? ' tac-compact' : ''}`;
  host.setAttribute('role', 'group');
  if (select.getAttribute('aria-label')) host.setAttribute('aria-label', select.getAttribute('aria-label'));
  select.after(host);

  const emitChange = () => {
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  function renderStepper() {
    const options = [...select.options];
    const currentIndex = Math.max(0, options.findIndex(o => o.value === select.value));
    const current = options[currentIndex] || options[0];
    const maxVal = options.length - 1;
    const disabled = select.disabled;

    host.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'tac-stepper-bar';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'tac-step-btn';
    minus.textContent = '−';
    minus.disabled = disabled || currentIndex <= 0;
    minus.setAttribute('aria-label', '减少');
    minus.onclick = () => {
      if (currentIndex > 0) {
        select.value = options[currentIndex - 1].value;
        emitChange();
        sync();
      }
    };

    const readout = document.createElement('div');
    readout.className = 'tac-stepper-readout';
    const pips = document.createElement('div');
    pips.className = 'tac-stepper-pips';
    for (let i = 1; i <= maxVal; i++) {
      const pip = document.createElement('i');
      pip.className = i <= currentIndex ? 'filled' : '';
      pip.onclick = () => {
        if (disabled) return;
        select.value = options[i].value;
        emitChange();
        sync();
      };
      pips.append(pip);
    }
    const text = document.createElement('span');
    text.textContent = current ? current.textContent : '';
    readout.append(text, pips);

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'tac-step-btn';
    plus.textContent = '+';
    plus.disabled = disabled || currentIndex >= maxVal;
    plus.setAttribute('aria-label', '增加');
    plus.onclick = () => {
      if (currentIndex < maxVal) {
        select.value = options[currentIndex + 1].value;
        emitChange();
        sync();
      }
    };

    row.append(minus, readout, plus);
    host.append(row);

    const quickRow = document.createElement('div');
    quickRow.className = 'tac-stepper-quick';
    for (const [val, label] of [['0', '0 名 · 纯真人'], ['5', '5 名 · 3v3'], ['9', '9 名 · 5v5 满员']]) {
      if (!options.some(o => o.value === val)) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tac-quick-chip' + (select.value === val ? ' active' : '');
      chip.disabled = disabled;
      chip.textContent = label;
      chip.onclick = () => {
        select.value = val;
        emitChange();
        sync();
      };
      quickRow.append(chip);
    }
    host.append(quickRow);
  }

  function renderButtons() {
    const options = [...select.options];
    const disabled = select.disabled;
    host.innerHTML = '';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tac-opt' + (opt.value === select.value ? ' active' : '');
      btn.disabled = disabled || opt.disabled;
      btn.dataset.value = opt.value;
      btn.setAttribute('aria-pressed', String(opt.value === select.value));
      const parts = opt.textContent.split(' · ');
      if (parts.length > 1 && variant === 'cards') {
        const title = document.createElement('strong');
        title.textContent = parts[0];
        const sub = document.createElement('small');
        sub.textContent = parts.slice(1).join(' · ');
        btn.append(title, sub);
      } else {
        btn.textContent = opt.textContent;
      }
      btn.onclick = () => {
        if (select.value === opt.value) return;
        select.value = opt.value;
        emitChange();
        sync();
      };
      host.append(btn);
    }
  }

  function sync() {
    if (variant === 'stepper') renderStepper();
    else renderButtons();
  }

  select.addEventListener('change', sync);
  const observer = new MutationObserver(sync);
  observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

  // Intercept programmatic .value = ... writes so custom UI always reflects external sync() calls.
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (desc?.set && desc?.get) {
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) {
        desc.set.call(this, v);
        sync();
      },
    });
  }

  const api = { element: host, sync, dispose() { observer.disconnect(); host.remove(); } };
  select._tacticalControl = api;
  sync();
  return api;
}

export function upgradeAllSelects(root, overrides = {}) {
  const controls = [];
  for (const select of root.querySelectorAll('select')) {
    if (select.hidden || select.dataset.tacticalUpgraded === '1') continue;
    const key = select.id || select.dataset.motion || '';
    const opts = overrides[key] || (select.options.length > 6 ? { variant: 'grid' } : { variant: 'pills' });
    controls.push(upgradeSelect(select, opts));
  }
  return controls;
}
