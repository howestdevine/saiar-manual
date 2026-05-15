/**
 * SAIAR Manual — vanilla custom element (shadow DOM, no dependencies).
 */

import SAIAR_STEPS from './steps.js';
import SAIAR_IMAGE_META from './image-meta.js';

// Throw-ratio calculator: lens catalogue and aspect ratios.
const LENSES = [
  { id: 'g-152-292', label: 'Barco G-lens (1.52 – 2.92 : 1)', min: 1.52, max: 2.92 },
  { id: 'g-075-095', label: 'Barco G-lens (0.75 – 0.95 : 1)', min: 0.75, max: 0.95 },
];

const ASPECT_RATIOS = [
  { id: '16:10', label: '16:10 (WUXGA)', w: 16, h: 10 },
  { id: '16:9', label: '16:9 (HD / 4K UHD)', w: 16, h: 9 },
  { id: '4:3', label: '4:3 (XGA)', w: 4, h: 3 },
];

// Projector light output (Barco G-series used in SAIAR Lab) and the
// reference screen-illuminance thresholds used to colour the lux indicator.
// MIN_LUX is the recommended lower bound for good contrast in typical
// outdoor conditions on a pale projection surface; LUX_BORDERLINE marks
// the "could be better" zone just below it.
const PROJECTOR_LUMENS = 7500;
const MIN_LUX = 100;
const LUX_BORDERLINE = 80;

class SaiarManual extends HTMLElement {
  static version = '1.0.0';

  static get observedAttributes() {
    return [
      'data-src',
      'data-image-base',
      'data-cover-logo',
      'data-cover-title',
      'data-show-toc',
      'data-persist',
      'data-theme',
      'data-start-step',
      'data-lang',
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open', delegatesFocus: true });
    /** @type {any[]} */
    this._steps = null;
    /** @type {Record<string, { width?: number; height?: number }>} */
    this._imgMeta = {};
    this._loadError = null;
    /** @type {string | null} */
    this._splash = null; // 'pending' | null | 'dismissed' — 'pending' = show overlay
    this._completeView = false;
    /** @type {Set<number>} */
    this._done = new Set();
    this._suppressHash = false;
    this._touch = { active: false, x: 0, y: 0, dead: 48 };
    /** @type {HTMLLinkElement[]} */
    this._preloadLinks = [];
    this._onHash = this._onHash.bind(this);
    this._onHostKey = this._onHostKey.bind(this);
    this._onShadowKey = this._onShadowKey.bind(this);
    this._onLightboxKey = this._onLightboxKey.bind(this);
    this._persistWriteScheduled = false;
    this._renderScheduled = false;
    /** @type {number} */
    this._index = 0;
    // Throw-ratio calculator state
    this._calcOpen = false;
    this._calcLensId = LENSES[0].id;
    this._calcAspectId = ASPECT_RATIOS[0].id;
    /** @type {'size'|'distance'} */
    this._calcView = 'size';
    /** @type {{ width: number|null, height: number|null, distance: number|null, sizeDriver: 'width'|'height' }} */
    this._calc = { width: 10.0, height: 6.25, distance: 15.0, sizeDriver: 'width' };
    this._onCalcKey = this._onCalcKey.bind(this);
  }

  connectedCallback() {
    window.addEventListener('hashchange', this._onHash);
    this.tabIndex = this.tabIndex >= 0 ? this.tabIndex : 0;
    this.setAttribute('role', 'region');
    this.setAttribute('aria-label', this._t('manualLabel'));
    this.shadowRoot.addEventListener('keydown', this._onShadowKey, true);
    this.addEventListener('keydown', this._onHostKey);
    this.renderSkeleton();
    this._boot();
  }

  disconnectedCallback() {
    window.removeEventListener('hashchange', this._onHash);
    this.shadowRoot.removeEventListener('keydown', this._onShadowKey, true);
    this.removeEventListener('keydown', this._onHostKey);
    this._clearPreloads();
    if (this._textResizeObserver) {
      try { this._textResizeObserver.disconnect(); } catch { /* */ }
      this._textResizeObserver = null;
    }
  }

  attributeChangedCallback() {
    if (!this.shadowRoot.firstChild) return;
    this.setAttribute('aria-label', this._t('manualLabel'));
    this._applyThemeFromAttr();
    this.scheduleRender();
  }

  // ——— Public API ———

  next() {
    if (!this._steps?.length || this._splash === 'pending') return;
    if (this._completeView) return;
    const max = this._steps.length - 1;
    if (this._index < max) this._setIndex(this._index + 1);
    else this._showCompleteView();
  }

  prev() {
    if (!this._steps?.length || this._splash === 'pending') return;
    if (this._completeView) {
      this._completeView = false;
      this._setIndex(this._steps.length - 1);
      return;
    }
    if (this._index > 0) this._setIndex(this._index - 1);
  }

  /** @param {number} n 1-based step */
  goToStep(n) {
    if (!this._steps?.length || this._splash === 'pending') return;
    const i = Math.max(0, Math.min(this._steps.length - 1, Math.floor(n) - 1));
    this._completeView = false;
    this._setIndex(i);
  }

  complete() {
    if (!this._steps?.length) return;
    this._splash = null;
    this._completeView = true;
    this.scheduleRender();
    this._persist();
    this.dispatchEvent(
      new CustomEvent('saiar:complete', {
        bubbles: true,
        composed: true,
        detail: {
          total: this._steps.length,
          done: Array.from(this._done.values()).sort((a, b) => a - b),
        },
      })
    );
  }

  // ——— Internals ———

  _persistMode() {
    const v = (this.getAttribute('data-persist') || 'both').toLowerCase();
    if (v === 'hash' || v === 'localstorage' || v === 'both' || v === 'none') return v;
    return 'both';
  }

  _themeMode() {
    const v = (this.getAttribute('data-theme') || 'auto').toLowerCase();
    if (v === 'auto' || v === 'dark' || v === 'light') return v;
    return 'auto';
  }

  _showToc() {
    const a = this.getAttribute('data-show-toc');
    if (a === null || a === '' || a === 'true') return true;
    return a !== 'false';
  }

  _lang() {
    return (this.getAttribute('data-lang') || 'nl').toLowerCase();
  }

  /** @param {string} key */
  _t(key) {
    const L = STRINGS[this._lang()] || STRINGS.nl;
    return L[key] || STRINGS.nl[key] || key;
  }

  _storageKey() {
    const src = this.getAttribute('data-src') || 'inline';
    let h = 0;
    for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
    return `saiar-manual:${h}`;
  }

  _langStorageKey() {
    return 'saiar-manual:lang';
  }

  _readLangPref() {
    if (this._persistMode() === 'none' || this._persistMode() === 'hash') return null;
    try {
      const v = localStorage.getItem(this._langStorageKey());
      if (v && (STRINGS[v] || v === 'nl' || v === 'en')) return v;
      return null;
    } catch {
      return null;
    }
  }

  _writeLangPref(lang) {
    if (this._persistMode() === 'none' || this._persistMode() === 'hash') return;
    try {
      localStorage.setItem(this._langStorageKey(), lang);
    } catch {
      /* */
    }
  }

  _setLanguage(lang) {
    if (!lang || lang === this._lang()) return;
    if (!STRINGS[lang] && lang !== 'nl' && lang !== 'en') return;
    this._writeLangPref(lang);
    this.setAttribute('data-lang', lang);
  }

  _readStorage() {
    if (this._persistMode() === 'none' || this._persistMode() === 'hash') {
      return { index: 0, done: [] };
    }
    try {
      const raw = localStorage.getItem(this._storageKey());
      if (!raw) return { index: 0, done: [] };
      const o = JSON.parse(raw);
      return {
        index: Number.isFinite(o.index) ? o.index : 0,
        done: Array.isArray(o.done) ? o.done.filter((x) => Number.isInteger(x)) : [],
      };
    } catch {
      return { index: 0, done: [] };
    }
  }

  _persist() {
    if (this._persistMode() === 'none') return;
    if (this._persistWriteScheduled) return;
    this._persistWriteScheduled = true;
    requestAnimationFrame(() => {
      this._persistWriteScheduled = false;
      if (this._persistMode() === 'hash' || this._persistMode() === 'both') {
        this._syncHash();
      }
      if (this._persistMode() === 'localstorage' || this._persistMode() === 'both') {
        try {
          localStorage.setItem(
            this._storageKey(),
            JSON.stringify({
              index: this._index,
              done: Array.from(this._done.values()).sort((a, b) => a - b),
            })
          );
        } catch {
          /* quota / private mode */
        }
      }
    });
  }

  _parseStepHash() {
    const m = /^#step-(\d+)$/.exec(window.location.hash || '');
    if (!m) return null;
    return Math.max(1, parseInt(m[1], 10));
  }

  _syncHash() {
    if (this._suppressHash) return;
    if (this._persistMode() === 'localstorage' || this._persistMode() === 'none') return;
    if (!this._steps?.length || this._splash === 'pending' || this._completeView) return;
    const want = `#step-${this._index + 1}`;
    if (window.location.hash !== want) {
      this._suppressHash = true;
      try {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}${want}`);
      } finally {
        queueMicrotask(() => {
          this._suppressHash = false;
        });
      }
    }
  }

  _onHash() {
    if (this._suppressHash) return;
    const n = this._parseStepHash();
    if (n != null && this._steps?.length) {
      this._splash = null;
      this._completeView = false;
      this._setIndex(n - 1, true);
    }
  }

  _explicitStartStep() {
    const raw = this.getAttribute('data-start-step');
    if (raw === null || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async _boot() {
    this._loadError = null;

    const langPref = this._readLangPref();
    if (langPref && langPref !== this._lang()) {
      this.setAttribute('data-lang', langPref);
    }

    this._steps = await this._loadSteps();
    if (!Array.isArray(this._steps)) this._steps = [];

    this._imgMeta = {};
    try {
      this._imgMeta = await this._loadImageMeta();
    } catch {
      this._imgMeta = {};
    }

    const st = this._readStorage();
    st.done.forEach((i) => this._done.add(i));

    const hashN = this._parseStepHash();
    const startN = this._explicitStartStep();
    const coverLogo = this.getAttribute('data-cover-logo');
    const coverTitle = this.getAttribute('data-cover-title');
    const wantsCover = !!(coverLogo || coverTitle);
    const skipSplash = hashN != null || startN != null;

    if (skipSplash) {
      this._splash = null;
      if (hashN != null) this._index = Math.min(this._steps.length - 1, hashN - 1);
      else this._index = Math.min(this._steps.length - 1, startN - 1);
    } else if (wantsCover) {
      this._splash = 'pending';
      this._index = Math.min(Math.max(0, st.index), Math.max(0, this._steps.length - 1));
    } else {
      this._splash = null;
      this._index = Math.min(Math.max(0, st.index), Math.max(0, this._steps.length - 1));
    }

    this._applyThemeFromAttr();
    this.scheduleRender();
    this._syncHash();
  }

  async _loadSteps() {
    if (Array.isArray(SAIAR_STEPS) && SAIAR_STEPS.length) {
      return SAIAR_STEPS;
    }
    const src = this.getAttribute('data-src');
    if (!src) return [];
    try {
      const res = await fetch(src, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      this._loadError = e instanceof Error ? e.message : String(e);
      return [];
    }
  }

  async _loadImageMeta() {
    if (SAIAR_IMAGE_META && typeof SAIAR_IMAGE_META === 'object') {
      return SAIAR_IMAGE_META;
    }
    const base = this.getAttribute('data-image-base');
    if (!base) return {};
    const url = this._assetHref('index.json');
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return {};
      const j = await res.json();
      if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') {
        return j.entries;
      }
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  _imageBaseUrl() {
    const b = this.getAttribute('data-image-base') || '';
    if (!b) return '';
    return b.endsWith('/') ? b : `${b}/`;
  }

  /** @param {string} file */
  _assetHref(file) {
    const base = this._imageBaseUrl();
    if (!base) return file;
    try {
      return new URL(file, new URL(base, document.baseURI)).href;
    } catch {
      return `${base}${file}`;
    }
  }

  /** @param {string} filename */
  _basename(filename) {
    if (!filename) return '';
    const base = filename.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '');
    return base;
  }

  /** @param {string} filename */
  _dimsFor(filename) {
    const base = this._basename(filename);
    const ext = filename.replace(/^.*[/\\]/, '');
    const m =
      this._imgMeta[base] ||
      this._imgMeta[ext] ||
      this._imgMeta[`${base}.jpg`] ||
      this._imgMeta[`${base}.webp`];
    if (m && typeof m === 'object') {
      const variant =
        m.variants?.['1200.jpg'] ||
        m.variants?.['1200.webp'] ||
        m.variants?.['1800.webp'] ||
        m.variants?.['800.webp'] ||
        m;
      const w = Number(variant.width);
      const h = Number(variant.height);
      return {
        width: Number.isFinite(w) ? w : undefined,
        height: Number.isFinite(h) ? h : undefined,
      };
    }
    return { width: undefined, height: undefined };
  }

  _shouldPreloadLinks() {
    const c = navigator.connection;
    if (!c) return true;
    if (c.saveData) return false;
    const t = c.effectiveType || '';
    return t !== 'slow-2g' && t !== '2g' && t !== '3g';
  }

  _clearPreloads() {
    for (const l of this._preloadLinks) {
      try {
        l.remove();
      } catch {
        /* */
      }
    }
    this._preloadLinks = [];
  }

  /** @param {string} href */
  _preloadImage(href) {
    if (!href || !this._shouldPreloadLinks()) return;
    const l = document.createElement('link');
    l.rel = 'preload';
    l.as = 'image';
    l.href = href;
    l.setAttribute('data-saiar-preload', '');
    document.head.appendChild(l);
    this._preloadLinks.push(l);
  }

  _updateNeighborPreloads() {
    this._clearPreloads();
    if (!this._steps?.length || this._completeView || this._splash === 'pending') return;
    const base = this._imageBaseUrl();
    if (!base) return;
    const indices = [this._index, this._index - 1, this._index + 1].filter(
      (i) => i >= 0 && i < this._steps.length
    );
    for (const i of indices) {
      const im = this._steps[i]?.image;
      if (!im) continue;
      const b = this._basename(im);
      const webp800 = this._assetHref(`${b}-800.webp`);
      this._preloadImage(webp800);
    }
  }

  _applyThemeFromAttr() {
    const mode = this._themeMode();
    const root = this.shadowRoot?.querySelector('.root');
    if (!root) return;
    root.classList.remove('theme-dark', 'theme-light');
    if (mode === 'light') root.classList.add('theme-light');
    else root.classList.add('theme-dark');
  }

  /** Matches:focus within shadow or on host */
  _isFocusedInComponent() {
    const ae = document.activeElement;
    if (ae === this) return true;
    if (!this.shadowRoot) return false;
    const inner = this.shadowRoot.activeElement;
    if (inner) return true;
    return false;
  }

  _onHostKey(e) {
    if (e.key === 'Tab' || e.key === 'Shift') return;
    if (this._isFocusedInComponent()) this._handleNavKeys(e);
  }

  _onShadowKey(e) {
    if (!this._isFocusedInComponent()) return;
    this._handleNavKeys(e);
  }

  _handleNavKeys(e) {
    const confirmModal = this.shadowRoot?.querySelector('.confirm-modal');
    if (confirmModal && !confirmModal.hidden) return;
    if (this._lightboxOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeLightbox();
      }
      return;
    }
    if (this._calcOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeCalc();
      }
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      if (t && (t.closest?.('input, textarea, [contenteditable="true"]'))) return;
      e.preventDefault();
      const searches = [...this.shadowRoot.querySelectorAll('.toc-search')];
      const inp = searches.find((el) => el.offsetParent !== null) || searches[0];
      if (inp) {
        inp.focus();
        inp.select?.();
      }
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      const t = e.target;
      if (t && t.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (t && t.closest?.('button, a')) {
        if (e.key === 'Enter') return;
      }
      e.preventDefault();
      this.next();
    } else if (e.key === 'ArrowLeft') {
      const t = e.target;
      if (t && t.closest?.('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      this.prev();
    }
  }

  _lightboxOpen() {
    const lb = this.shadowRoot?.querySelector('.lightbox');
    return !!(lb && lb.hidden === false);
  }

  _onLightboxKey(e) {
    if (e.key !== 'Tab') return;
    const trap = this.shadowRoot.querySelector('.lightbox');
    if (!trap || trap.hidden) return;
    const f = trap.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const list = Array.from(f).filter((el) => !el.hasAttribute('disabled'));
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const ae = this.shadowRoot?.activeElement;
    if (e.shiftKey) {
      if (ae === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (ae === last) {
      e.preventDefault();
      first.focus();
    }
  }

  _setIndex(i, emit = true) {
    const max = Math.max(0, (this._steps?.length || 1) - 1);
    const next = Math.max(0, Math.min(max, i));
    const prev = this._index;
    this._index = next;
    if (emit && prev !== next && this._steps?.length) {
      const step = this._steps[next];
      this.dispatchEvent(
        new CustomEvent('saiar:stepchange', {
          bubbles: true,
          composed: true,
          detail: {
            step: next + 1,
            stepIndex: next,
            total: this._steps.length,
            id: step?.id,
            section: step?.section,
            title: step?.title,
          },
        })
      );
    }
    this.scheduleRender();
    this._persist();
    this._updateNeighborPreloads();
  }

  _showCompleteView() {
    this._completeView = true;
    this.scheduleRender();
    this._persist();
    this.dispatchEvent(
      new CustomEvent('saiar:complete', {
        bubbles: true,
        composed: true,
        detail: {
          total: this._steps.length,
          done: Array.from(this._done.values()).sort((a, b) => a - b),
        },
      })
    );
  }

  _toggleDone(idx, checked) {
    if (checked) this._done.add(idx);
    else this._done.delete(idx);
    this.scheduleRender();
    this._persist();
  }

  _openResetConfirm() {
    const modal = this.shadowRoot?.querySelector('.confirm-modal');
    if (!modal) return;
    this._confirmReturnFocus = this.shadowRoot.activeElement;
    modal.hidden = false;
    queueMicrotask(() => {
      const cancelBtn = modal.querySelector('.confirm-cancel');
      cancelBtn?.focus?.();
    });
  }

  _resetProgress() {
    this._done = new Set();
    this._completeView = false;
    this._tocQuery = '';
    this._index = 0;
    this._persist();
    this.scheduleRender();
    this._syncHash();
    this.dispatchEvent(
      new CustomEvent('saiar:stepchange', {
        bubbles: true,
        composed: true,
        detail: {
          step: 1,
          stepIndex: 0,
          total: this._steps?.length || 0,
          id: this._steps?.[0]?.id,
          section: this._steps?.[0]?.section,
          title: this._steps?.[0]?.title,
        },
      })
    );
  }

  _filterSteps(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return this._steps.map((_, i) => i);
    return this._steps
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s }) =>
          (s.title && String(s.title).toLowerCase().includes(q)) ||
          (s.section && String(s.section).toLowerCase().includes(q)) ||
          (s.intro && String(s.intro).toLowerCase().includes(q))
      )
      .map((x) => x.i);
  }

  _groupedToc(filteredIndices) {
    const map = new Map();
    const order = [];
    for (const idx of filteredIndices) {
      const sec = this._steps[idx]?.section || this._t('uncategorized');
      if (!map.has(sec)) {
        map.set(sec, []);
        order.push(sec);
      }
      map.get(sec).push(idx);
    }
    return order.map((sec) => ({ section: sec, indices: map.get(sec) }));
  }

  scheduleRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this._render();
    });
  }

  renderSkeleton() {
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="root" part="root">
        <div class="loading">${esc(this._t('loading'))}</div>
      </div>
    `;
    this._applyThemeFromAttr();
  }

  _render() {
    const root = this.shadowRoot.querySelector('.root') || this.shadowRoot;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (this._loadError && !this._steps?.length) {
      root.innerHTML = `
        <div class="error" role="alert">
          <strong>${esc(this._t('loadError'))}</strong>
          <p>${esc(this._loadError)}</p>
        </div>`;
      this._applyThemeFromAttr();
      return;
    }

    const total = this._steps?.length || 0;
    const step = total ? this._steps[this._index] : null;
    const progress = total ? Math.round(((this._index + 1) / total) * 100) : 0;
    const coverTitle = this.getAttribute('data-cover-title') || '';
    const titleTop = coverTitle || 'SAIAR Manual';
    const logoTop = this.getAttribute('data-cover-logo') || '';

    const tocVisible = this._showToc() && total > 0 && !this._completeView && this._splash !== 'pending';

    const navLabel = this._t('tocNav');

    const hasProgress = this._index > 0 || this._done.size > 0;
    const resumeLabel = this._t('resumeFrom').replace('{n}', String(this._index + 1));
    const resumeStep = hasProgress && this._steps?.[this._index];
    const resumeMetaHtml = resumeStep
      ? `<p class="splash-resume-meta">${esc(this._t('stepLabel').replace('{n}', String(this._index + 1)))}${resumeStep.section ? ' &middot; ' + esc(resumeStep.section) : ''}<br><strong>${esc(resumeStep.title || '')}</strong></p>`
      : '';

    const splashHtml =
      this._splash === 'pending'
        ? `
      <div class="splash" role="dialog" aria-modal="true" aria-labelledby="splash-heading">
        <div class="splash-inner">
          ${logoTop ? `<img class="splash-logo" src="${escAttr(logoTop)}" alt="" />` : ''}
          <h1 id="splash-heading" class="splash-title">${esc(titleTop)}</h1>
          <div class="splash-divider" aria-hidden="true"></div>
          ${resumeMetaHtml}
          ${hasProgress
            ? `
          <div class="splash-actions">
            <button type="button" class="start-btn splash-start" autofocus>${esc(resumeLabel)} &rarr;</button>
            <button type="button" class="splash-restart" aria-label="${escAttr(this._t('restart'))}">${esc(this._t('restart'))}</button>
          </div>`
            : `<button type="button" class="start-btn splash-start" autofocus>${esc(this._t('start'))} &rarr;</button>`}
          <button type="button" class="splash-calc" aria-label="${escAttr(this._t('calcTitle'))}">
            <span class="splash-calc-icon" aria-hidden="true">▦</span>
            <span class="splash-calc-text">
              <span class="splash-calc-title">${esc(this._t('calcTitle'))}</span>
              <span class="splash-calc-sub">${esc(this._t('calcSplashSub'))}</span>
            </span>
          </button>
        </div>
      </div>`
        : '';

    const completeHtml = this._completeView
      ? this._renderComplete()
      : this._renderStepCard(step, reduceMotion);

    const tocHtml = this._renderToc(navLabel);
    const showTocBtn = this._showToc() && total > 0 && this._splash !== 'pending';

    root.innerHTML = `
<div class="app ${reduceMotion ? 'reduce-motion' : ''}">
  ${splashHtml}
  <div class="lightbox" hidden tabindex="-1" role="dialog" aria-modal="true" aria-label="${escAttr(this._t('lightboxLabel'))}">
    <button type="button" class="lightbox-backdrop" aria-label="${escAttr(this._t('close'))}"></button>
    <div class="lightbox-panel">
      <button type="button" class="btn icon lightbox-close" aria-label="${escAttr(this._t('close'))}">×</button>
      <img class="lightbox-img" alt="" />
    </div>
  </div>

  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        ${logoTop ? `<button class="logo-button" type="button" aria-label="${escAttr(this._t('backToStart'))}"><img class="top-logo" src="${escAttr(logoTop)}" alt="" /></button>` : ''}
        <div class="manual-meta">
          <div class="manual-kicker">${esc(this._t('kicker'))}</div>
          <div class="manual-title">${esc(titleTop)}</div>
        </div>
      </div>
      <div class="topbar-end">
        <div class="progress-wrap">
          <span class="sr-only" aria-live="polite" aria-atomic="true">${esc(this._t('progressLive').replace('{n}', String(this._index + 1)).replace('{t}', String(total)))}</span>
          <span class="progress-text" aria-hidden="true">${this._completeView ? esc(this._t('done')) : `${esc(this._t('stepLabel').replace('{n}', String(this._index + 1)))} / ${total}`}</span>
          <div class="progress-bar" aria-hidden="true"><div class="progress-fill" style="width:${this._completeView ? 100 : progress}%"></div></div>
        </div>
        <div class="lang-toggle" role="group" aria-label="${escAttr(this._t('languageSelector'))}">
          <button type="button" class="lang-btn${this._lang() === 'nl' ? ' is-active' : ''}" data-set-lang="nl" aria-pressed="${this._lang() === 'nl' ? 'true' : 'false'}" aria-label="Nederlands" title="Nederlands">NL</button>
          <button type="button" class="lang-btn${this._lang() === 'en' ? ' is-active' : ''}" data-set-lang="en" aria-pressed="${this._lang() === 'en' ? 'true' : 'false'}" aria-label="English" title="English">EN</button>
        </div>
        ${total > 0 && this._splash !== 'pending' ? `<button type="button" class="btn-ghost reset-btn" aria-label="${escAttr(this._t('confirmReset'))}" title="${escAttr(this._t('confirmReset'))}"><span class="reset-icon" aria-hidden="true">↺</span><span class="reset-label">${esc(this._t('reset'))}</span></button>` : ''}
        <button type="button" class="btn-ghost calc-toggle" aria-expanded="${this._calcOpen ? 'true' : 'false'}" aria-controls="calc-modal" title="${escAttr(this._t('calcTitle'))}">
          <span class="calc-toggle-icon" aria-hidden="true">▦</span>
          <span class="calc-toggle-label">${esc(this._t('calc'))}</span>
        </button>
        ${showTocBtn ? `<button type="button" class="btn-ghost toc-toggle" aria-expanded="false" aria-controls="drawer">${esc(this._t('toc'))}</button>` : ''}
      </div>
    </div>
  </header>

  <div class="layout">
    ${tocVisible ? `<aside class="sidebar" aria-label="${escAttr(navLabel)}">${tocHtml}</aside>` : ''}
    <main class="page">
      ${this._loadError && total ? `<div class="banner-warn" role="status">${esc(this._t('partialLoad'))}</div>` : ''}
      ${completeHtml}
    </main>
  </div>

  <div class="drawer" id="drawer" hidden>
    <div class="drawer-overlay" tabindex="-1"></div>
    <div class="drawer-panel" role="dialog" aria-modal="true" aria-label="${escAttr(navLabel)}">
      <div class="drawer-head">
        <span>${esc(this._t('toc'))}</span>
        <button type="button" class="btn-ghost drawer-close" aria-label="${escAttr(this._t('close'))}">×</button>
      </div>
      <div class="drawer-body">${tocHtml}</div>
    </div>
  </div>

  ${this._renderCalculator()}

  <div class="confirm-modal" id="confirm-modal" hidden role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
    <button type="button" class="confirm-backdrop" tabindex="-1" aria-label="${escAttr(this._t('cancel'))}"></button>
    <div class="confirm-panel">
      <h3 class="confirm-title" id="confirm-title">${esc(this._t('resetTitle'))}</h3>
      <p class="confirm-body" id="confirm-body">${esc(this._t('resetBody'))}</p>
      <div class="confirm-actions">
        <button type="button" class="btn-secondary confirm-cancel">${esc(this._t('cancel'))}</button>
        <button type="button" class="btn-primary is-danger confirm-ok">${esc(this._t('confirmReset'))}</button>
      </div>
    </div>
  </div>

  <div class="print-root" aria-hidden="true">${this._renderPrintAll()}</div>
</div>
`;

    this._applyThemeFromAttr();
    this._wire(root);
    this._updateNeighborPreloads();
    this._updateOverflowState();
  }

  _updateOverflowState() {
    const card = this.shadowRoot?.querySelector('.step-card');
    const text = this.shadowRoot?.querySelector('.text-col');
    if (!card || !text) return;
    const update = () => {
      const overflow = text.scrollHeight - text.clientHeight > 1
        && text.scrollTop + text.clientHeight < text.scrollHeight - 1;
      card.classList.toggle('has-overflow', overflow);
    };
    if (this._textScrollHandler) text.removeEventListener('scroll', this._textScrollHandler);
    this._textScrollHandler = update;
    text.addEventListener('scroll', update, { passive: true });
    if (this._textResizeObserver) {
      try { this._textResizeObserver.disconnect(); } catch { /* */ }
    }
    if (typeof ResizeObserver !== 'undefined') {
      this._textResizeObserver = new ResizeObserver(() => update());
      this._textResizeObserver.observe(text);
    }
    requestAnimationFrame(update);
  }

  /** @param {any} step */
  _renderStepCard(step, reduceMotion) {
    if (!step)
      return `<section class="step-card empty"><div class="text-col"><p>${esc(this._t('noSteps'))}</p></div></section>`;

    const dims = this._dimsFor(step.image || '');
    const imgHtml = step.image ? this._renderPicture(step, dims) : '';
    const warn = step.warning
      ? `<aside class="warning-box" role="note"><div class="warning-title">${esc(this._t('warning'))}</div><div class="warning-text">${esc(step.warning)}</div></aside>`
      : '';

    const done = this._done.has(this._index);
    const isLast = this._index >= this._steps.length - 1;
    const stepNumLabel = esc(this._t('stepLabel').replace('{n}', String(this._index + 1)));
    const kicker = step.section
      ? `<span class="step-kicker-num">${stepNumLabel}</span><span class="step-kicker-sep" aria-hidden="true"></span><span class="step-kicker-sec">${esc(step.section)}</span>`
      : `<span class="step-kicker-num">${stepNumLabel}</span>`;

    let nextLabel;
    if (done) nextLabel = isLast ? this._t('finish') : this._t('goNext');
    else nextLabel = isLast ? this._t('checkFinish') : this._t('checkNext');

    return `
      <section class="step-card" aria-current="step" data-step-index="${this._index}">
        <div class="step-grid">
          <div class="text-col">
            <div class="step-kicker">${kicker}</div>
            <h1 class="step-title">${esc(step.title || '')}</h1>
            ${step.intro ? `<p class="step-intro">${esc(step.intro)}</p>` : ''}
            <div class="content-block">
              <div class="content-label">${esc(this._t('instruction'))}</div>
              <div class="body-text">${step.body || ''}</div>
            </div>
            ${warn}
          </div>
          <div class="image-col" data-swipe-zone>
            ${imgHtml || `<div class="image-placeholder">${esc(this._t('noImage'))}</div>`}
          </div>
          <div class="nav">
            <div class="nav-left">
              <button type="button" class="btn-secondary nav-prev" ${this._index === 0 ? 'disabled' : ''}>&larr; ${esc(this._t('prev'))}</button>
            </div>
            <div class="nav-right">
              ${done ? `<button type="button" class="btn-ghost nav-undo" aria-label="${escAttr(this._t('undoStep').replace('{n}', String(this._index + 1)))}">${esc(this._t('undo'))}</button>` : ''}
              <button type="button" class="btn-primary nav-next${done ? ' is-done' : ''}" aria-pressed="${done ? 'true' : 'false'}">
                <span class="check-pill" aria-hidden="true">✓</span>
                <span class="nav-next-label">${esc(nextLabel)} &rarr;</span>
              </button>
            </div>
          </div>
        </div>
      </section>`;
  }

  _renderComplete() {
    const rows = this._steps
      .map(
        (s, i) =>
          `<li class="overview-item${this._done.has(i) ? ' is-done' : ''}"><span class="oi-num">${String(i + 1).padStart(2, '0')}</span><div class="oi-meta"><strong>${esc(s.title || '')}</strong><span class="oi-sec">${esc(s.section || '')}</span></div></li>`
      )
      .join('');
    return `
      <section class="end-card" aria-labelledby="complete-title">
        <div class="end-kicker">${esc(this._t('endKicker'))}</div>
        <h2 id="complete-title" class="end-title">${esc(this._t('completeTitle'))}</h2>
        <p class="end-text">${esc(this._t('completeBody'))}</p>
        <ol class="overview-list">${rows}</ol>
        <div class="end-actions">
          <button type="button" class="btn-primary nav-restart">${esc(this._t('backToStart'))}</button>
          <button type="button" class="btn-secondary end-reset">${esc(this._t('confirmReset'))}</button>
        </div>
      </section>`;
  }

  _renderToc(navLabel) {
    const q = this._tocQuery || '';
    const filtered = this._filterSteps(q);
    const groups = this._groupedToc(filtered);
    const parts = groups
      .map(
        (g) =>
          `<section class="toc-group"><h3 class="toc-sec">${esc(g.section)}</h3><ul class="toc-list">${g.indices
            .map((idx) => {
              const s = this._steps[idx];
              const isCurrent = idx === this._index && !this._completeView;
              const isDone = this._done.has(idx);
              const cur = isCurrent ? ' aria-current="step"' : '';
              const cls = ['toc-item'];
              if (isCurrent) cls.push('is-current');
              if (isDone) cls.push('is-done');
              const num = String(idx + 1).padStart(2, '0');
              const safeTitle = esc(s.title || '');
              const markLabel = isDone
                ? this._t('undoStep').replace('{n}', String(idx + 1))
                : this._t('markStepDone').replace('{n}', String(idx + 1));
              return `<li class="toc-row${isCurrent ? ' is-current' : ''}${isDone ? ' is-done' : ''}"><button type="button" class="toc-mark-btn" data-toggle="${idx}" aria-label="${escAttr(markLabel)}" aria-pressed="${isDone ? 'true' : 'false'}"><span class="toc-mark" aria-hidden="true"></span></button><button type="button" class="${cls.join(' ')}" data-goto="${idx + 1}"${cur}><span class="toc-num">${num}</span><span class="toc-text" title="${safeTitle}">${safeTitle}</span></button></li>`;
            })
            .join('')}</ul></section>`
      )
      .join('');
    return `
      <div role="navigation" aria-label="${escAttr(navLabel)}" class="toc-wrap">
        <label class="toc-search-label"><span class="sr-only">${esc(this._t('search'))}</span>
          <input class="toc-search" type="search" placeholder="${escAttr(this._t('searchPh'))}" aria-label="${escAttr(this._t('search'))}" autocomplete="off" value="${escAttr(q)}" />
        </label>
        <div class="toc-scroll">${parts || `<p class="muted">${esc(this._t('noResults'))}</p>`}</div>
      </div>`;
  }

  _renderPrintAll() {
    if (!this._steps?.length) return '';
    return this._steps
      .map((s, i) => {
        const dims = this._dimsFor(s.image || '');
        const pic = s.image ? this._renderPicture(s, dims, true) : '';
        const warn = s.warning
          ? `<div class="print-warn">${esc(this._t('warning'))}: ${esc(s.warning)}</div>`
          : '';
        return `
          <section class="print-step">
            <header class="print-head">
              <span class="print-check">☐</span>
              <span class="print-num">${i + 1}.</span>
              <span class="print-sec">${esc(s.section || '')}</span>
              <h3 class="print-title">${esc(s.title || '')}</h3>
            </header>
            ${s.intro ? `<p class="print-intro">${esc(s.intro)}</p>` : ''}
            <div class="print-body">${s.body || ''}</div>
            ${warn}
            ${pic ? `<div class="print-img">${pic}</div>` : ''}
          </section>`;
      })
      .join('');
  }

  /**
   * @param {any} step
   * @param {{ width?: number; height?: number }} dims
   * @param {boolean} printMode
   */
  _renderPicture(step, dims, printMode = false) {
    const base = this._imageBaseUrl();
    const b = this._basename(step.image);
    if (!base || !b) return '';

    const w800 = this._assetHref(`${b}-800.webp`);
    const w1200w = this._assetHref(`${b}-1200.webp`);
    const w1800w = this._assetHref(`${b}-1800.webp`);
    const j1200 = this._assetHref(`${b}-1200.jpg`);

    const alt = escAttr(step.imageAlt || step.title || '');
    const wh =
      dims.width && dims.height
        ? ` width="${dims.width}" height="${dims.height}"`
        : '';
    const fitClass = printMode ? 'step-img print-img-el' : 'step-img';
    const sizes = printMode
      ? '100vw'
      : '(max-width: 520px) 100vw, (max-width: 960px) 90vw, 880px';

    return `
      <picture>
        <source type="image/webp" srcset="${escAttr(w800)} 800w, ${escAttr(w1200w)} 1200w, ${escAttr(w1800w)} 1800w" sizes="${escAttr(sizes)}" />
        <img class="${fitClass}" src="${escAttr(j1200)}" alt="${alt}" srcset="${escAttr(j1200)} 1200w" sizes="${escAttr(sizes)}" loading="lazy" decoding="async"${wh} data-full-webp="${escAttr(w1800w)}" data-fallback-jpg="${escAttr(j1200)}" />
      </picture>`;
  }

  /** @param {HTMLElement} root */
  _wire(root) {
    const dismissSplashAt = (idx) => {
      this._splash = null;
      this._index = Math.min(Math.max(0, idx), Math.max(0, this._steps.length - 1));
      this.scheduleRender();
      this._syncHash();
      this.dispatchEvent(
        new CustomEvent('saiar:stepchange', {
          bubbles: true,
          composed: true,
          detail: {
            step: this._index + 1,
            stepIndex: this._index,
            total: this._steps.length,
            id: this._steps[this._index]?.id,
            section: this._steps[this._index]?.section,
            title: this._steps[this._index]?.title,
          },
        })
      );
    };

    const splashStart = root.querySelector('.splash-start');
    if (splashStart) {
      splashStart.addEventListener('click', () => {
        const st = this._readStorage();
        dismissSplashAt(st.index);
      });
    }

    const splashRestart = root.querySelector('.splash-restart');
    if (splashRestart) {
      splashRestart.addEventListener('click', () => {
        this._done = new Set();
        this._completeView = false;
        this._persist();
        dismissSplashAt(0);
      });
    }

    root.querySelector('.splash-calc')?.addEventListener('click', () => this._openCalc());

    const drawer = root.querySelector('.drawer');
    const tocToggle = root.querySelector('.toc-toggle');
    const drawerClose = root.querySelector('.drawer-close');
    const overlay = root.querySelector('.drawer-overlay');
    const setDrawer = (open) => {
      if (!drawer) return;
      drawer.hidden = !open;
      tocToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) drawer.querySelector('.toc-search')?.focus?.();
    };
    tocToggle?.addEventListener('click', () => setDrawer(drawer?.hidden !== false));
    drawerClose?.addEventListener('click', () => setDrawer(false));
    overlay?.addEventListener('click', () => setDrawer(false));

    root.querySelector('.nav-prev')?.addEventListener('click', () => this.prev());
    root.querySelector('.nav-next')?.addEventListener('click', () => {
      if (this._steps?.length && !this._completeView) {
        if (!this._done.has(this._index)) {
          this._done.add(this._index);
          this._persist();
        }
      }
      this.next();
    });
    root.querySelector('.nav-undo')?.addEventListener('click', () => {
      this._toggleDone(this._index, false);
    });
    root.querySelector('.nav-restart')?.addEventListener('click', () => {
      this._completeView = false;
      this._setIndex(0);
    });
    root.querySelector('.end-reset')?.addEventListener('click', () => this._openResetConfirm());
    root.querySelector('.reset-btn')?.addEventListener('click', () => this._openResetConfirm());

    root.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const el = e.currentTarget;
        const lang = el.getAttribute('data-set-lang');
        if (lang) this._setLanguage(lang);
      });
    });
    root.querySelector('.logo-button')?.addEventListener('click', () => {
      this._completeView = false;
      this._setIndex(0);
    });

    const confirmModal = root.querySelector('.confirm-modal');
    const confirmCancel = root.querySelector('.confirm-cancel');
    const confirmOk = root.querySelector('.confirm-ok');
    const confirmBackdrop = root.querySelector('.confirm-backdrop');
    const closeConfirm = () => {
      if (!confirmModal) return;
      confirmModal.hidden = true;
      this._confirmReturnFocus?.focus?.();
      this._confirmReturnFocus = null;
    };
    confirmCancel?.addEventListener('click', closeConfirm);
    confirmBackdrop?.addEventListener('click', closeConfirm);
    confirmOk?.addEventListener('click', () => {
      closeConfirm();
      this._resetProgress();
    });
    confirmModal?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeConfirm();
      }
    });

    const bindTocAfterFilter = () => {
      root.querySelectorAll('.toc-item').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const el = e.currentTarget;
          const g = el.getAttribute('data-goto');
          if (g) this.goToStep(parseInt(g, 10));
          setDrawer(false);
        });
      });
      root.querySelectorAll('.toc-mark-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const el = e.currentTarget;
          const idx = parseInt(el.getAttribute('data-toggle'), 10);
          if (Number.isInteger(idx)) {
            this._toggleDone(idx, !this._done.has(idx));
          }
        });
      });
    };

    const onSearch = (e) => {
      const t = e.target;
      this._tocQuery = t.value || '';
      const navLabel = this._t('tocNav');
      const html = this._renderToc(navLabel);
      const aside = root.querySelector('.sidebar');
      const drawerBody = root.querySelector('.drawer-body');
      if (aside) aside.innerHTML = html;
      if (drawerBody) drawerBody.innerHTML = html;
      bindTocAfterFilter();
      const refocusDrawer = !!t.closest('.drawer-body');
      const searches = root.querySelectorAll('.toc-search');
      searches.forEach((inp) => {
        inp.addEventListener('input', onSearch);
        inp.value = this._tocQuery;
      });
      const focusEl = refocusDrawer ? drawerBody?.querySelector('.toc-search') : aside?.querySelector('.toc-search');
      focusEl?.focus();
      try {
        focusEl?.setSelectionRange(this._tocQuery.length, this._tocQuery.length);
      } catch {
        /* */
      }
    };
    bindTocAfterFilter();
    root.querySelectorAll('.toc-search').forEach((inp) => {
      inp.addEventListener('input', onSearch);
    });

    root.querySelectorAll('.step-img').forEach((img) => {
      img.addEventListener('click', () => this._openLightbox(img));
      img.setAttribute('role', 'button');
      if (!img.getAttribute('tabindex')) img.tabIndex = 0;
      img.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._openLightbox(img);
        }
      });
    });

    const swipeZone = root.querySelector('[data-swipe-zone]');
    if (swipeZone) this._bindSwipe(swipeZone);

    const lb = root.querySelector('.lightbox');
    const lbImg = root.querySelector('.lightbox-img');
    const closeLb = () => this._closeLightbox();
    root.querySelector('.lightbox-close')?.addEventListener('click', closeLb);
    root.querySelector('.lightbox-backdrop')?.addEventListener('click', closeLb);
    lb?.addEventListener('keydown', this._onLightboxKey);

    this._lightboxImgEl = lbImg;

    this._wireCalc(root);
  }

  /** @param {HTMLImageElement} thumb */
  _openLightbox(thumb) {
    const lb = this.shadowRoot.querySelector('.lightbox');
    const img = this.shadowRoot.querySelector('.lightbox-img');
    if (!lb || !img) return;
    const webp = thumb.getAttribute('data-full-webp');
    const jpg = thumb.getAttribute('data-fallback-jpg');
    img.alt = thumb.alt || '';
    lb.hidden = false;
    const tryJpg = () => {
      if (jpg) {
        img.onerror = null;
        img.src = jpg;
      }
    };
    img.onerror = tryJpg;
    img.src = webp || jpg || '';
    const closeBtn = lb.querySelector('.lightbox-close');
    queueMicrotask(() => closeBtn?.focus());
  }

  _closeLightbox() {
    const lb = this.shadowRoot.querySelector('.lightbox');
    if (lb) lb.hidden = true;
    const img = this.shadowRoot.querySelector('.lightbox-img');
    if (img) {
      img.src = '';
      img.removeAttribute('src');
    }
  }

  // ——— Throw-ratio calculator ———

  _calcLens() {
    return LENSES.find((l) => l.id === this._calcLensId) || LENSES[0];
  }

  _calcAspect() {
    return ASPECT_RATIOS.find((a) => a.id === this._calcAspectId) || ASPECT_RATIOS[0];
  }

  /**
   * Parse a numeric string entered by the user. Accepts both the European
   * comma and the dot as decimal separator (e.g. "10,5" and "10.5" both
   * parse to 10.5). Strips surrounding whitespace.
   * @param {string} str
   * @returns {number} parsed float, or NaN
   */
  _parseNum(str) {
    if (typeof str !== 'string') return NaN;
    const cleaned = str.trim().replace(',', '.');
    return parseFloat(cleaned);
  }

  /**
   * Format a number for display, using the comma as decimal separator in
   * Dutch and the dot in English. Trailing zeros are kept (so "6,25" and
   * "6,30", not "6,3").
   * @param {number} v
   * @param {number} decimals
   */
  _fmtNum(v, decimals = 2) {
    if (!Number.isFinite(v)) return '';
    const s = v.toFixed(decimals);
    return this._lang() === 'nl' ? s.replace('.', ',') : s;
  }

  _fmtMeters(v) {
    if (!Number.isFinite(v) || v <= 0) return '—';
    return `${this._fmtNum(v)} m`;
  }

  _calcResults() {
    const lens = this._calcLens();
    const aspect = this._calcAspect();
    const ratio = aspect.h / aspect.w;
    const w = Number(this._calc.width);
    const h = Number(this._calc.height);
    const d = Number(this._calc.distance);

    const sizeWidth = this._calc.sizeDriver === 'height'
      ? (Number.isFinite(h) && h > 0 ? h / ratio : NaN)
      : (Number.isFinite(w) && w > 0 ? w : NaN);
    const sizeHeight = Number.isFinite(sizeWidth) ? sizeWidth * ratio : NaN;

    let distMin = NaN;
    let distMax = NaN;
    if (Number.isFinite(sizeWidth) && sizeWidth > 0) {
      distMin = lens.min * sizeWidth;
      distMax = lens.max * sizeWidth;
    }

    let widthMin = NaN;
    let widthMax = NaN;
    let heightMin = NaN;
    let heightMax = NaN;
    if (Number.isFinite(d) && d > 0) {
      widthMin = d / lens.max;
      widthMax = d / lens.min;
      heightMin = widthMin * ratio;
      heightMax = widthMax * ratio;
    }

    // Illuminance on screen (lx = lm / m²). For a fixed image size the lux is
    // a single value; for a distance-driven range the lux varies with image
    // area: smallest image -> highest lux, largest image -> lowest lux.
    const sizeArea = (Number.isFinite(sizeWidth) && Number.isFinite(sizeHeight) && sizeWidth > 0 && sizeHeight > 0)
      ? sizeWidth * sizeHeight
      : NaN;
    const lux = Number.isFinite(sizeArea) && sizeArea > 0
      ? PROJECTOR_LUMENS / sizeArea
      : NaN;

    let luxAtSmallSize = NaN; // brightest case (smallest area)
    let luxAtLargeSize = NaN; // dimmest case (largest area)
    if (
      Number.isFinite(widthMin) && widthMin > 0
      && Number.isFinite(widthMax) && widthMax > 0
      && Number.isFinite(heightMin) && Number.isFinite(heightMax)
    ) {
      luxAtSmallSize = PROJECTOR_LUMENS / (widthMin * heightMin);
      luxAtLargeSize = PROJECTOR_LUMENS / (widthMax * heightMax);
    }

    return {
      lens,
      aspect,
      sizeWidth,
      sizeHeight,
      distMin,
      distMax,
      widthMin,
      widthMax,
      heightMin,
      heightMax,
      lux,
      luxAtSmallSize,
      luxAtLargeSize,
    };
  }

  /**
   * Three-tier lux status, classified on the worst-case (lowest) value.
   * - ok        : luxLow >= MIN_LUX             (>= 100 lx)
   * - borderline: LUX_BORDERLINE <= luxLow < MIN_LUX  (80 – 100 lx)
   * - low       : luxLow < LUX_BORDERLINE       (< 80 lx)
   * @param {number} luxLow lowest illuminance in the range (or single value)
   * @returns {{ id: 'ok'|'borderline'|'low', label: string } | null}
   */
  _luxStatus(luxLow) {
    if (!Number.isFinite(luxLow)) return null;
    if (luxLow >= MIN_LUX) return { id: 'ok', label: this._t('luxOk') };
    if (luxLow >= LUX_BORDERLINE) return { id: 'borderline', label: this._t('luxBorderline') };
    return { id: 'low', label: this._t('luxLow') };
  }

  _fmtLux(v) {
    if (!Number.isFinite(v) || v <= 0) return '—';
    const rounded = v >= 1000 ? Math.round(v / 10) * 10 : Math.round(v);
    return `${this._fmtNum(rounded, 0)} lx`;
  }

  _renderLuxRow(luxLow, luxHigh, isRange) {
    const labelHtml = `${esc(this._t('luxLabel'))} <span class="calc-unit">(${PROJECTOR_LUMENS} ANSI lm)</span>`;

    if (!Number.isFinite(luxLow)) {
      return `
        <div class="calc-result calc-result-lux">
          <span class="calc-result-label">${labelHtml}</span>
          <span class="calc-result-value"><span class="lux-value">—</span></span>
        </div>`;
    }

    const sameValue = !isRange || Math.abs(luxHigh - luxLow) < 0.5;
    const valueText = sameValue
      ? `≈ ${this._fmtLux(luxLow)}`
      : `≈ ${this._fmtLux(luxLow)} – ${this._fmtLux(luxHigh)}`;

    // Meter scale: linear 0 → 4 × MIN_LUX. Anything beyond is clipped to the
    // right edge with a "+" suffix on the end-of-scale label.
    const meterMax = MIN_LUX * 4; // 400 lx
    const lowPct = (LUX_BORDERLINE / meterMax) * 100;
    const okPct = (MIN_LUX / meterMax) * 100;
    const startPct = Math.max(0, Math.min(100, (luxLow / meterMax) * 100));
    const endPct = Math.max(0, Math.min(100, (luxHigh / meterMax) * 100));
    const overflowHigh = luxHigh > meterMax;

    const statusLow = this._luxStatus(luxLow);
    const statusHigh = this._luxStatus(luxHigh);

    let badgesHtml = '';
    if (sameValue || statusLow.id === statusHigh.id) {
      badgesHtml = `
        <span class="lux-badge lux-badge-${statusLow.id}">
          <span class="lux-dot" aria-hidden="true"></span>${esc(statusLow.label)}
        </span>`;
    } else {
      badgesHtml = `
        <span class="lux-badge lux-badge-${statusLow.id}">
          <span class="lux-dot" aria-hidden="true"></span>
          <span class="lux-badge-prefix">${esc(this._t('luxAtLargest'))}:</span>
          ${esc(statusLow.label)}
        </span>
        <span class="lux-badge lux-badge-${statusHigh.id}">
          <span class="lux-dot" aria-hidden="true"></span>
          <span class="lux-badge-prefix">${esc(this._t('luxAtSmallest'))}:</span>
          ${esc(statusHigh.label)}
        </span>`;
    }

    // Colored "pin" markers above the bar — chevron + stem in the lux
    // status colour. For ranges we also draw a thin bridge line connecting
    // the two pins so it reads as "from … to …" instead of two unrelated
    // points. The pin colour matches the badge for that endpoint.
    const pin = (pct, statusId) =>
      `<span class="lux-pin lux-pin-${statusId}" style="left: ${pct}%">
        <span class="lux-pin-chevron"></span>
        <span class="lux-pin-stem"></span>
      </span>`;
    const markersHtml = sameValue
      ? pin(startPct, statusLow.id)
      : `
        <span class="lux-bridge" style="left: ${startPct}%; right: ${100 - endPct}%"></span>
        ${pin(startPct, statusLow.id)}
        ${pin(endPct, statusHigh.id)}
      `;

    const endLabel = `${meterMax}${overflowHigh ? '+' : ''} lx`;

    return `
      <div class="calc-result calc-result-lux calc-result-lux-stack">
        <div class="lux-row-top">
          <span class="calc-result-label">${labelHtml}</span>
          <span class="lux-value">${esc(valueText)}</span>
        </div>

        <div class="lux-meter" role="img" aria-label="${escAttr(valueText)}">
          <div class="lux-meter-pins">${markersHtml}</div>
          <div class="lux-meter-track">
            <div class="lux-meter-zone lux-zone-low" style="width: ${lowPct}%"></div>
            <div class="lux-meter-zone lux-zone-borderline" style="width: ${okPct - lowPct}%"></div>
            <div class="lux-meter-zone lux-zone-ok" style="width: ${100 - okPct}%"></div>
          </div>
          <div class="lux-meter-scale">
            <span class="lux-scale-tick lux-scale-tick-start" style="left: 0%">0</span>
            <span class="lux-scale-tick lux-scale-tick-thresh" style="left: ${lowPct}%">${LUX_BORDERLINE}</span>
            <span class="lux-scale-tick lux-scale-tick-thresh" style="left: ${okPct}%">${MIN_LUX}</span>
            <span class="lux-scale-tick lux-scale-tick-end" style="left: 100%">${esc(endLabel)}</span>
          </div>
        </div>

        <div class="lux-badges">${badgesHtml}</div>
      </div>`;
  }

  _diagDefsAndMarkers() {
    return `<defs>
      <marker id="diagArrowEnd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L10,5 L0,10 Z" class="diag-arrow-head"/>
      </marker>
      <marker id="diagArrowStart" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M10,0 L0,5 L10,10 Z" class="diag-arrow-head"/>
      </marker>
    </defs>`;
  }

  _renderCalcDiagram(r, mode = 'size') {
    return mode === 'distance'
      ? this._renderCalcDiagramDistance(r)
      : this._renderCalcDiagramSize(r);
  }

  _renderDiagramEmpty(W, H) {
    return `<svg class="calc-diagram-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="diag-empty">${esc(this._t('calcDiagramEmpty'))}</text>
    </svg>`;
  }

  _renderCalcDiagramSize(r) {
    const W = 600;
    const H = 240;
    const pad = { l: 18, r: 110, t: 28, b: 64 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;

    const width = r.sizeWidth;
    const distMin = r.distMin;
    const distMax = r.distMax;
    const hasGeometry = Number.isFinite(width) && width > 0
      && Number.isFinite(distMin) && distMin > 0
      && Number.isFinite(distMax) && distMax > 0;

    if (!hasGeometry) return this._renderDiagramEmpty(W, H);

    const scale = Math.min(innerW / distMax, innerH / width);
    const distMaxPx = distMax * scale;
    const distMinPx = distMin * scale;
    const widthPx = width * scale;
    const xOffset = Math.max(0, (innerW - distMaxPx) / 2);

    const projW = 24;
    const projH = 16;
    const projMaxX = pad.l + xOffset;
    const screenX = projMaxX + distMaxPx;
    const projMinX = projMaxX + (distMaxPx - distMinPx);
    const cy = pad.t + innerH / 2;
    const screenTop = cy - widthPx / 2;
    const screenBottom = cy + widthPx / 2;
    const lensMaxX = projMaxX + projW;
    const lensMinX = projMinX + projW;

    const conePathMax = `M ${lensMaxX} ${cy} L ${screenX} ${screenTop} L ${screenX} ${screenBottom} Z`;
    const conePathMin = `M ${lensMinX} ${cy} L ${screenX} ${screenTop} L ${screenX} ${screenBottom} Z`;

    const widthLabelX = screenX + 14;
    const minDimY = screenBottom + 22;
    const maxDimY = screenBottom + 44;
    const floorY = Math.min(H - 4, Math.max(cy + widthPx / 2 + 4, cy + projH / 2 + 4));

    // Hide projector mini-labels when the two projectors overlap horizontally.
    const projsOverlap = (projMinX - projMaxX) < projW + 8;

    return `<svg class="calc-diagram-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escAttr(this._t('calcDiagramAlt'))}">
      ${this._diagDefsAndMarkers()}

      <text x="${pad.l}" y="${pad.t - 10}" class="diag-caption">${esc(this._t('calcDiagramTopView'))}</text>

      <line x1="${pad.l - 4}" y1="${floorY}" x2="${screenX + 90}" y2="${floorY}" class="diag-floor"/>

      <path d="${conePathMax}" class="diag-cone diag-cone-max"/>
      <path d="${conePathMin}" class="diag-cone diag-cone-min"/>

      <line x1="${screenX}" y1="${pad.t - 4}" x2="${screenX}" y2="${floorY}" class="diag-wall"/>
      <line x1="${screenX}" y1="${screenTop}" x2="${screenX}" y2="${screenBottom}" class="diag-screen"/>
      <circle cx="${screenX}" cy="${screenTop}" r="2.5" class="diag-screen-end"/>
      <circle cx="${screenX}" cy="${screenBottom}" r="2.5" class="diag-screen-end"/>

      <g class="diag-proj-group diag-proj-max">
        <rect x="${projMaxX}" y="${cy - projH / 2}" width="${projW}" height="${projH}" rx="2" class="diag-proj"/>
        <rect x="${projMaxX + projW}" y="${cy - 3}" width="3" height="6" class="diag-proj-lens"/>
        ${projsOverlap ? '' : `<text x="${projMaxX + projW / 2}" y="${cy - projH / 2 - 5}" text-anchor="middle" class="diag-proj-label">${esc(this._t('calcDiagramMaxDist'))}</text>`}
      </g>
      <g class="diag-proj-group diag-proj-min">
        <rect x="${projMinX}" y="${cy - projH / 2}" width="${projW}" height="${projH}" rx="2" class="diag-proj"/>
        <rect x="${projMinX + projW}" y="${cy - 3}" width="3" height="6" class="diag-proj-lens"/>
        ${projsOverlap ? '' : `<text x="${projMinX + projW / 2}" y="${cy - projH / 2 - 5}" text-anchor="middle" class="diag-proj-label">${esc(this._t('calcDiagramMinDist'))}</text>`}
      </g>

      <line x1="${screenX}" y1="${screenTop}" x2="${widthLabelX + 4}" y2="${screenTop}" class="diag-tick"/>
      <line x1="${screenX}" y1="${screenBottom}" x2="${widthLabelX + 4}" y2="${screenBottom}" class="diag-tick"/>
      <line x1="${widthLabelX}" y1="${screenTop}" x2="${widthLabelX}" y2="${screenBottom}" class="diag-dim" marker-start="url(#diagArrowStart)" marker-end="url(#diagArrowEnd)"/>
      <text x="${widthLabelX + 8}" y="${cy - 2}" class="diag-label diag-label-width">${esc(this._fmtNum(width))} m</text>
      ${Number.isFinite(r.lux) ? `<text x="${widthLabelX + 8}" y="${cy + 14}" class="diag-lux diag-lux-${this._luxStatus(r.lux).id}">≈ ${esc(this._fmtLux(r.lux))}</text>` : ''}

      <line x1="${lensMinX}" y1="${minDimY}" x2="${screenX}" y2="${minDimY}" class="diag-dim diag-dim-min" marker-start="url(#diagArrowStart)" marker-end="url(#diagArrowEnd)"/>
      <text x="${(lensMinX + screenX) / 2}" y="${minDimY - 5}" text-anchor="middle" class="diag-label diag-label-min">${esc(this._t('calcDiagramMinDist'))}: ${esc(this._fmtNum(distMin))} m</text>

      <line x1="${lensMaxX}" y1="${maxDimY}" x2="${screenX}" y2="${maxDimY}" class="diag-dim diag-dim-max" marker-start="url(#diagArrowStart)" marker-end="url(#diagArrowEnd)"/>
      <text x="${(lensMaxX + screenX) / 2}" y="${maxDimY + 12}" text-anchor="middle" class="diag-label diag-label-max">${esc(this._t('calcDiagramMaxDist'))}: ${esc(this._fmtNum(distMax))} m</text>
    </svg>`;
  }

  _renderCalcDiagramDistance(r) {
    const W = 600;
    const H = 240;
    // Wider right padding (220) to fit the two stacked width labels
    // ("maximumbreedte: NN,NN m") on the right of the screen without
    // running into the cone or overflowing the viewBox.
    const pad = { l: 18, r: 220, t: 28, b: 64 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;

    const distance = Number(this._calc.distance);
    const widthMin = r.widthMin;
    const widthMax = r.widthMax;
    const hasGeometry = Number.isFinite(distance) && distance > 0
      && Number.isFinite(widthMin) && widthMin > 0
      && Number.isFinite(widthMax) && widthMax > 0;

    if (!hasGeometry) return this._renderDiagramEmpty(W, H);

    const scale = Math.min(innerW / distance, innerH / widthMax);
    const distancePx = distance * scale;
    const widthMinPx = widthMin * scale;
    const widthMaxPx = widthMax * scale;
    const xOffset = Math.max(0, (innerW - distancePx) / 2);

    const projW = 24;
    const projH = 16;
    const projX = pad.l + xOffset;
    const screenX = projX + distancePx;
    const lensX = projX + projW;
    const cy = pad.t + innerH / 2;

    const screenMaxTop = cy - widthMaxPx / 2;
    const screenMaxBottom = cy + widthMaxPx / 2;
    const screenMinTop = cy - widthMinPx / 2;
    const screenMinBottom = cy + widthMinPx / 2;

    const conePathMax = `M ${lensX} ${cy} L ${screenX} ${screenMaxTop} L ${screenX} ${screenMaxBottom} Z`;
    const conePathMin = `M ${lensX} ${cy} L ${screenX} ${screenMinTop} L ${screenX} ${screenMinBottom} Z`;

    // Two nested dimension arrows on the right of the screen: inner one for
    // the minimum width, outer one for the maximum width.
    const widthMinDimX = screenX + 22;
    const widthMaxDimX = screenX + 46;

    // Both label blocks (width line + lux line) start at the same x (just
    // past the outer dim line) but are offset vertically — min above the
    // centre line, max below — so they never collide with each other or
    // with the cone.
    const labelX = widthMaxDimX + 14;
    const minLabelY = cy - 18;       // line 1: width
    const minLuxY = minLabelY + 14;  // line 2: lux
    const maxLabelY = cy + 18;       // line 1: width
    const maxLuxY = maxLabelY + 14;  // line 2: lux

    const distDimY = Math.min(H - 14, screenMaxBottom + 30);
    const floorY = Math.min(H - 4, Math.max(cy + widthMaxPx / 2 + 4, cy + projH / 2 + 4));

    return `<svg class="calc-diagram-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escAttr(this._t('calcDiagramAlt'))}">
      ${this._diagDefsAndMarkers()}

      <text x="${pad.l}" y="${pad.t - 10}" class="diag-caption">${esc(this._t('calcDiagramTopView'))}</text>

      <line x1="${pad.l - 4}" y1="${floorY}" x2="${labelX + 170}" y2="${floorY}" class="diag-floor"/>

      <path d="${conePathMax}" class="diag-cone diag-cone-max"/>
      <path d="${conePathMin}" class="diag-cone diag-cone-min"/>

      <line x1="${screenX}" y1="${pad.t - 4}" x2="${screenX}" y2="${floorY}" class="diag-wall"/>
      <line x1="${screenX}" y1="${screenMaxTop}" x2="${screenX}" y2="${screenMaxBottom}" class="diag-screen diag-screen-max"/>
      <line x1="${screenX}" y1="${screenMinTop}" x2="${screenX}" y2="${screenMinBottom}" class="diag-screen diag-screen-min"/>
      <circle cx="${screenX}" cy="${screenMaxTop}" r="2.5" class="diag-screen-end"/>
      <circle cx="${screenX}" cy="${screenMaxBottom}" r="2.5" class="diag-screen-end"/>

      <g class="diag-proj-group">
        <rect x="${projX}" y="${cy - projH / 2}" width="${projW}" height="${projH}" rx="2" class="diag-proj"/>
        <rect x="${projX + projW}" y="${cy - 3}" width="3" height="6" class="diag-proj-lens"/>
      </g>

      <line x1="${screenX}" y1="${screenMinTop}" x2="${widthMinDimX + 4}" y2="${screenMinTop}" class="diag-tick"/>
      <line x1="${screenX}" y1="${screenMinBottom}" x2="${widthMinDimX + 4}" y2="${screenMinBottom}" class="diag-tick"/>
      <line x1="${widthMinDimX}" y1="${screenMinTop}" x2="${widthMinDimX}" y2="${screenMinBottom}" class="diag-dim diag-dim-min" marker-start="url(#diagArrowStart)" marker-end="url(#diagArrowEnd)"/>

      <line x1="${screenX}" y1="${screenMaxTop}" x2="${widthMaxDimX + 4}" y2="${screenMaxTop}" class="diag-tick"/>
      <line x1="${screenX}" y1="${screenMaxBottom}" x2="${widthMaxDimX + 4}" y2="${screenMaxBottom}" class="diag-tick"/>
      <line x1="${widthMaxDimX}" y1="${screenMaxTop}" x2="${widthMaxDimX}" y2="${screenMaxBottom}" class="diag-dim diag-dim-max" marker-start="url(#diagArrowStart)" marker-end="url(#diagArrowEnd)"/>

      <text x="${labelX}" y="${minLabelY}" text-anchor="start" class="diag-label diag-label-width-min">${esc(this._t('calcDiagramMinWidth'))}: ${esc(this._fmtNum(widthMin))} m</text>
      ${Number.isFinite(r.luxAtSmallSize) ? `<text x="${labelX}" y="${minLuxY}" text-anchor="start" class="diag-lux diag-lux-${this._luxStatus(r.luxAtSmallSize).id}">≈ ${esc(this._fmtLux(r.luxAtSmallSize))}</text>` : ''}

      <text x="${labelX}" y="${maxLabelY}" text-anchor="start" class="diag-label diag-label-width-max">${esc(this._t('calcDiagramMaxWidth'))}: ${esc(this._fmtNum(widthMax))} m</text>
      ${Number.isFinite(r.luxAtLargeSize) ? `<text x="${labelX}" y="${maxLuxY}" text-anchor="start" class="diag-lux diag-lux-${this._luxStatus(r.luxAtLargeSize).id}">≈ ${esc(this._fmtLux(r.luxAtLargeSize))}</text>` : ''}

      <line x1="${lensX}" y1="${distDimY}" x2="${screenX}" y2="${distDimY}" class="diag-dim" marker-start="url(#diagArrowStart)" marker-end="url(#diagArrowEnd)"/>
      <text x="${(lensX + screenX) / 2}" y="${distDimY + 12}" text-anchor="middle" class="diag-label">${esc(this._t('calcDistance'))}: ${esc(this._fmtNum(distance))} m</text>
    </svg>`;
  }

  _renderCalculator() {
    if (!this._calcOpen) return '';
    const r = this._calcResults();
    const widthVal = Number.isFinite(r.sizeWidth) ? this._fmtNum(r.sizeWidth) : '';
    const heightVal = Number.isFinite(r.sizeHeight) ? this._fmtNum(r.sizeHeight) : '';
    const distVal = Number.isFinite(Number(this._calc.distance)) ? this._fmtNum(Number(this._calc.distance)) : '';

    const distRangeText = (Number.isFinite(r.distMin) && Number.isFinite(r.distMax))
      ? `${this._fmtMeters(r.distMin)} – ${this._fmtMeters(r.distMax)}`
      : '—';
    const widthRangeText = (Number.isFinite(r.widthMin) && Number.isFinite(r.widthMax))
      ? `${this._fmtMeters(r.widthMin)} – ${this._fmtMeters(r.widthMax)}`
      : '—';
    const heightRangeText = (Number.isFinite(r.heightMin) && Number.isFinite(r.heightMax))
      ? `${this._fmtMeters(r.heightMin)} – ${this._fmtMeters(r.heightMax)}`
      : '—';

    const lensOpts = LENSES.map(
      (l) => `<option value="${escAttr(l.id)}"${l.id === r.lens.id ? ' selected' : ''}>${esc(l.label)}</option>`
    ).join('');
    const aspectOpts = ASPECT_RATIOS.map(
      (a) => `<option value="${escAttr(a.id)}"${a.id === r.aspect.id ? ' selected' : ''}>${esc(a.label)}</option>`
    ).join('');

    return `
      <div class="calc-modal" id="calc-modal" role="dialog" aria-modal="true" aria-labelledby="calc-heading">
        <button type="button" class="calc-backdrop" aria-label="${escAttr(this._t('close'))}"></button>
        <div class="calc-panel">
          <div class="calc-head">
            <div class="calc-head-meta">
              <div class="calc-kicker">${esc(this._t('calcKicker'))}</div>
              <h2 id="calc-heading" class="calc-title">${esc(this._t('calcTitle'))}</h2>
            </div>
            <button type="button" class="calc-close" aria-label="${escAttr(this._t('close'))}">×</button>
          </div>

          <div class="calc-body">
            <div class="calc-row calc-row-shared">
              <label class="calc-field">
                <span class="calc-label">${esc(this._t('calcLens'))}</span>
                <select class="calc-input calc-lens">${lensOpts}</select>
              </label>
              <label class="calc-field">
                <span class="calc-label">${esc(this._t('calcAspect'))}</span>
                <select class="calc-input calc-aspect">${aspectOpts}</select>
              </label>
            </div>

            <div class="calc-tabs" role="tablist" aria-label="${escAttr(this._t('calcModeLabel'))}">
              <button type="button" role="tab" class="calc-tab${this._calcView === 'size' ? ' is-active' : ''}" data-mode="size" aria-selected="${this._calcView === 'size' ? 'true' : 'false'}">${esc(this._t('calcModeSize'))}</button>
              <button type="button" role="tab" class="calc-tab${this._calcView === 'distance' ? ' is-active' : ''}" data-mode="distance" aria-selected="${this._calcView === 'distance' ? 'true' : 'false'}">${esc(this._t('calcModeDistance'))}</button>
            </div>

            <div class="calc-diagram-wrap">${this._renderCalcDiagram(r, this._calcView)}</div>

            ${this._calcView === 'size' ? `
            <section class="calc-card">
              <header class="calc-card-head">
                <div>
                  <h3 class="calc-card-title">${esc(this._t('calcSizeTitle'))}</h3>
                  <p class="calc-card-sub">${esc(this._t('calcSizeSub'))}</p>
                </div>
              </header>
              <div class="calc-row">
                <label class="calc-field">
                  <span class="calc-label">${esc(this._t('calcWidth'))} <span class="calc-unit">(m)</span></span>
                  <input class="calc-input calc-width" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${escAttr(widthVal)}" />
                </label>
                <label class="calc-field">
                  <span class="calc-label">${esc(this._t('calcHeight'))} <span class="calc-unit">(m)</span></span>
                  <input class="calc-input calc-height" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${escAttr(heightVal)}" />
                </label>
              </div>
              <div class="calc-result">
                <span class="calc-result-label">${esc(this._t('calcDistanceRange'))}</span>
                <span class="calc-result-value calc-out-distance">${esc(distRangeText)}</span>
              </div>
              <div class="calc-lux-slot calc-lux-slot-size">${this._renderLuxRow(r.lux, r.lux, false)}</div>
              <p class="calc-hint">${esc(this._t('calcSizeHint'))}</p>
            </section>` : `
            <section class="calc-card">
              <header class="calc-card-head">
                <div>
                  <h3 class="calc-card-title">${esc(this._t('calcDistTitle'))}</h3>
                  <p class="calc-card-sub">${esc(this._t('calcDistSub'))}</p>
                </div>
              </header>
              <div class="calc-row">
                <label class="calc-field">
                  <span class="calc-label">${esc(this._t('calcDistance'))} <span class="calc-unit">(m)</span></span>
                  <input class="calc-input calc-distance" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${escAttr(distVal)}" />
                </label>
              </div>
              <div class="calc-result">
                <span class="calc-result-label">${esc(this._t('calcWidthRange'))}</span>
                <span class="calc-result-value calc-out-width">${esc(widthRangeText)}</span>
              </div>
              <div class="calc-result">
                <span class="calc-result-label">${esc(this._t('calcHeightRange'))}</span>
                <span class="calc-result-value calc-out-height">${esc(heightRangeText)}</span>
              </div>
              <div class="calc-lux-slot calc-lux-slot-dist">${this._renderLuxRow(r.luxAtLargeSize, r.luxAtSmallSize, true)}</div>
              <p class="calc-hint">${esc(this._t('calcDistHint'))}</p>
            </section>`}

            <p class="calc-lux-note"><strong>${esc(this._t('luxNoteTitle'))}</strong> ${esc(this._t('luxNote'))}</p>

            <p class="calc-disclaimer">${esc(this._t('calcDisclaimer'))}</p>
          </div>
        </div>
      </div>`;
  }

  _openCalc() {
    this._calcOpen = true;
    this.scheduleRender();
    queueMicrotask(() => {
      const close = this.shadowRoot.querySelector('.calc-close');
      close?.focus();
    });
  }

  _closeCalc() {
    this._calcOpen = false;
    this.scheduleRender();
    queueMicrotask(() => {
      const btn = this.shadowRoot.querySelector('.calc-toggle');
      btn?.focus();
    });
  }

  _onCalcKey(e) {
    if (e.key === 'Escape' && this._calcOpen) {
      e.stopPropagation();
      e.preventDefault();
      this._closeCalc();
    }
  }

  _updateCalcOutputs() {
    const root = this.shadowRoot;
    if (!root) return;
    const r = this._calcResults();
    const distEl = root.querySelector('.calc-out-distance');
    const widthEl = root.querySelector('.calc-out-width');
    const heightEl = root.querySelector('.calc-out-height');
    if (distEl) {
      distEl.textContent = (Number.isFinite(r.distMin) && Number.isFinite(r.distMax))
        ? `${this._fmtMeters(r.distMin)} – ${this._fmtMeters(r.distMax)}`
        : '—';
    }
    if (widthEl) {
      widthEl.textContent = (Number.isFinite(r.widthMin) && Number.isFinite(r.widthMax))
        ? `${this._fmtMeters(r.widthMin)} – ${this._fmtMeters(r.widthMax)}`
        : '—';
    }
    if (heightEl) {
      heightEl.textContent = (Number.isFinite(r.heightMin) && Number.isFinite(r.heightMax))
        ? `${this._fmtMeters(r.heightMin)} – ${this._fmtMeters(r.heightMax)}`
        : '—';
    }
    const diagWrap = root.querySelector('.calc-diagram-wrap');
    if (diagWrap) {
      diagWrap.innerHTML = this._renderCalcDiagram(r, this._calcView);
    }
    const luxSize = root.querySelector('.calc-lux-slot-size');
    if (luxSize) luxSize.innerHTML = this._renderLuxRow(r.lux, r.lux, false);
    const luxDist = root.querySelector('.calc-lux-slot-dist');
    if (luxDist) luxDist.innerHTML = this._renderLuxRow(r.luxAtLargeSize, r.luxAtSmallSize, true);
  }

  _wireCalc(root) {
    const toggle = root.querySelector('.calc-toggle');
    toggle?.addEventListener('click', () => {
      if (this._calcOpen) this._closeCalc();
      else this._openCalc();
    });

    if (!this._calcOpen) return;

    const modal = root.querySelector('.calc-modal');
    modal?.addEventListener('keydown', this._onCalcKey);
    root.querySelector('.calc-close')?.addEventListener('click', () => this._closeCalc());
    root.querySelector('.calc-backdrop')?.addEventListener('click', () => this._closeCalc());

    root.querySelectorAll('.calc-tab').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        const m = e.currentTarget.getAttribute('data-mode');
        if (m === 'size' || m === 'distance') {
          if (this._calcView !== m) {
            this._calcView = m;
            this.scheduleRender();
          }
        }
      });
    });

    const lensSel = root.querySelector('.calc-lens');
    lensSel?.addEventListener('change', (e) => {
      this._calcLensId = e.target.value;
      this._updateCalcOutputs();
    });

    const aspectSel = root.querySelector('.calc-aspect');
    aspectSel?.addEventListener('change', (e) => {
      this._calcAspectId = e.target.value;
      const aspect = this._calcAspect();
      const ratio = aspect.h / aspect.w;
      // Recompute the linked dimension from the current driver, then update inputs.
      if (this._calc.sizeDriver === 'height' && Number.isFinite(this._calc.height) && this._calc.height > 0) {
        this._calc.width = this._calc.height / ratio;
      } else if (Number.isFinite(this._calc.width) && this._calc.width > 0) {
        this._calc.height = this._calc.width * ratio;
      }
      const wIn = root.querySelector('.calc-width');
      const hIn = root.querySelector('.calc-height');
      if (wIn && Number.isFinite(this._calc.width)) wIn.value = this._fmtNum(this._calc.width);
      if (hIn && Number.isFinite(this._calc.height)) hIn.value = this._fmtNum(this._calc.height);
      this._updateCalcOutputs();
    });

    const widthIn = root.querySelector('.calc-width');
    const heightIn = root.querySelector('.calc-height');
    const distIn = root.querySelector('.calc-distance');

    widthIn?.addEventListener('input', (e) => {
      const v = this._parseNum(e.target.value);
      this._calc.sizeDriver = 'width';
      this._calc.width = Number.isFinite(v) ? v : NaN;
      const ratio = this._calcAspect().h / this._calcAspect().w;
      if (Number.isFinite(this._calc.width) && this._calc.width > 0) {
        this._calc.height = this._calc.width * ratio;
        if (heightIn) heightIn.value = this._fmtNum(this._calc.height);
      } else {
        this._calc.height = NaN;
        if (heightIn) heightIn.value = '';
      }
      this._updateCalcOutputs();
    });

    heightIn?.addEventListener('input', (e) => {
      const v = this._parseNum(e.target.value);
      this._calc.sizeDriver = 'height';
      this._calc.height = Number.isFinite(v) ? v : NaN;
      const ratio = this._calcAspect().h / this._calcAspect().w;
      if (Number.isFinite(this._calc.height) && this._calc.height > 0) {
        this._calc.width = this._calc.height / ratio;
        if (widthIn) widthIn.value = this._fmtNum(this._calc.width);
      } else {
        this._calc.width = NaN;
        if (widthIn) widthIn.value = '';
      }
      this._updateCalcOutputs();
    });

    distIn?.addEventListener('input', (e) => {
      const v = this._parseNum(e.target.value);
      this._calc.distance = Number.isFinite(v) ? v : NaN;
      this._updateCalcOutputs();
    });
  }

  /** @param {HTMLElement} el */
  _bindSwipe(el) {
    const dead = this._touch.dead;
    el.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        this._touch.active = true;
        this._touch.x = e.touches[0].clientX;
        this._touch.y = e.touches[0].clientY;
      },
      { passive: true }
    );
    el.addEventListener(
      'touchmove',
      (e) => {
        if (!this._touch.active || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - this._touch.x;
        const dy = e.touches[0].clientY - this._touch.y;
        if (Math.abs(dx) > dead && Math.abs(dx) > Math.abs(dy)) e.preventDefault();
      },
      { passive: false }
    );
    el.addEventListener(
      'touchcancel',
      () => {
        this._touch.active = false;
      },
      { passive: true }
    );
    el.addEventListener(
      'touchend',
      (e) => {
        if (!e.changedTouches.length) return;
        const wasActive = this._touch.active;
        this._touch.active = false;
        if (!wasActive) return;
        const dx = e.changedTouches[0].clientX - this._touch.x;
        const dy = e.changedTouches[0].clientY - this._touch.y;
        if (Math.abs(dx) < 56 || Math.abs(dy) > dead) return;
        if (dx < 0) this.next();
        else this.prev();
      },
      { passive: true }
    );
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(s) {
  return esc(s).replace(/'/g, '&#39;');
}

const STRINGS = {
  nl: {
    manualLabel: 'Handleiding',
    kicker: 'Stap-voor-stap handleiding',
    loading: 'Bezig met laden…',
    loadError: 'De stappen konden niet worden geladen.',
    partialLoad: 'Offline of fout bij het laden van de stappen. Controleer data-src.',
    noSteps: 'Geen stappen beschikbaar.',
    noImage: 'Geen foto voor deze stap.',
    instruction: 'Instructie',
    toc: 'Inhoud',
    tocNav: 'Stappen — inhoudsopgave',
    stepNav: 'Stapnavigatie',
    search: 'Zoeken',
    searchPh: 'Zoek in stappen…',
    noResults: 'Geen resultaten.',
    prev: 'Vorige',
    next: 'Volgende',
    finish: 'Afronden',
    done: 'Voltooid',
    start: 'Start handleiding',
    splashHint: 'Druk op Start om verder te gaan. Indien beschikbaar wordt je laatste positie hersteld.',
    stepLabel: 'Stap {n}',
    markDone: 'Stap afgevinkt',
    checkNext: 'Gecontroleerd & volgende',
    checkFinish: 'Gecontroleerd & afronden',
    goNext: 'Volgende stap',
    resumeFrom: 'Verder vanaf stap {n}',
    restart: 'Opnieuw beginnen',
    undo: 'Ongedaan maken',
    undoStep: 'Markeer stap {n} als niet voltooid',
    markStepDone: 'Markeer stap {n} als voltooid',
    reset: 'Reset',
    resetTitle: 'Voortgang resetten?',
    resetBody: 'Alle afgevinkte stappen worden gewist en je begint opnieuw bij stap 1. Dit kan niet ongedaan gemaakt worden.',
    cancel: 'Annuleren',
    confirmReset: 'Reset voortgang',
    languageSelector: 'Taal',
    switchToDutch: 'Wissel naar Nederlands',
    switchToEnglish: 'Switch to English',
    warning: 'Let op',
    uncategorized: 'Overig',
    endKicker: 'Handleiding voltooid',
    completeTitle: 'Alle stappen doorlopen',
    completeBody: 'Dit scherm betekent enkel dat alle stappen doorlopen zijn. De installatie is pas correct wanneer de opstelling ter plaatse is gecontroleerd.',
    backToStart: 'Terug naar stap 1',
    lightboxLabel: 'Vergrote afbeelding',
    close: 'Sluiten',
    progressLive: 'Voortgang: stap {n} van {t}',
    calc: 'Calculator',
    calcKicker: 'Hulpmiddel',
    calcTitle: 'Throw ratio calculator',
    calcLens: 'Lens',
    calcAspect: 'Beeldverhouding',
    calcSizeTitle: 'Vanuit gewenste projectiemaat',
    calcSizeSub: 'Vul de breedte óf hoogte in. De andere dimensie volgt automatisch.',
    calcWidth: 'Breedte',
    calcHeight: 'Hoogte',
    calcDistance: 'Afstand projector',
    calcDistanceRange: 'Benodigde afstand projector',
    calcDistTitle: 'Vanuit projector-afstand',
    calcDistSub: 'Vul de afstand projector–scherm in om de mogelijke beeldmaat te zien.',
    calcWidthRange: 'Mogelijke breedte',
    calcHeightRange: 'Mogelijke hoogte',
    calcSizeHint: 'De zoom-lens dekt een bereik. Plaats de projector ergens binnen dit afstandsbereik.',
    calcDistHint: 'Op deze afstand kan de projector de beeldmaat instellen ergens binnen dit bereik.',
    calcDisclaimer: 'Indicatieve waarden op basis van de throw ratio van de lens. Controleer altijd ter plaatse.',
    calcDiagramTopView: 'Bovenaanzicht (geschaald)',
    calcDiagramAlt: 'Schematische tekening van de projectie-opstelling',
    calcDiagramEmpty: 'Vul een breedte of hoogte in om de tekening te tonen.',
    calcDiagramMinDist: 'kortste afstand',
    calcDiagramMaxDist: 'langste afstand',
    calcDiagramMinWidth: 'minimumbreedte',
    calcDiagramMaxWidth: 'maximumbreedte',
    luxLabel: 'Geschatte lichtsterkte op scherm',
    luxOk: 'Goed contrast',
    luxBorderline: 'Net voldoende',
    luxLow: 'Te flauw',
    luxAtLargest: 'Bij grootste beeld',
    luxAtSmallest: 'Bij kleinste beeld',
    luxNoteTitle: 'Richtwaarde:',
    luxNote: 'minimaal 100 lx voor goed contrast bij typische outdoor-omstandigheden en een bleek projectievlak. Onder 80 lx wordt het beeld te flauw.',
    calcModeLabel: 'Wat wil je berekenen?',
    calcModeSize: 'Ik weet de beeldmaat',
    calcModeDistance: 'Ik weet de projector-afstand',
    calcSplashSub: 'Beeldmaat & afstand snel uitrekenen',
  },
  en: {
    manualLabel: 'Manual',
    kicker: 'Step-by-step manual',
    loading: 'Loading…',
    loadError: 'Could not load steps.',
    partialLoad: 'Issue loading steps JSON. Check data-src.',
    noSteps: 'No steps available.',
    noImage: 'No photo for this step.',
    instruction: 'Instruction',
    toc: 'Contents',
    tocNav: 'Steps — table of contents',
    stepNav: 'Step navigation',
    search: 'Search',
    searchPh: 'Search steps…',
    noResults: 'No results.',
    prev: 'Back',
    next: 'Next',
    finish: 'Finish',
    done: 'Done',
    start: 'Start manual',
    splashHint: 'Press Start to continue. Your last position will be restored if available.',
    stepLabel: 'Step {n}',
    markDone: 'Step done',
    checkNext: 'Mark done & next',
    checkFinish: 'Mark done & finish',
    goNext: 'Next step',
    resumeFrom: 'Continue from step {n}',
    restart: 'Start over',
    undo: 'Mark not done',
    undoStep: 'Mark step {n} as not done',
    markStepDone: 'Mark step {n} as done',
    reset: 'Reset',
    resetTitle: 'Reset all progress?',
    resetBody: 'All checked steps will be cleared and you will start over from step 1. This cannot be undone.',
    cancel: 'Cancel',
    confirmReset: 'Reset progress',
    languageSelector: 'Language',
    switchToDutch: 'Wissel naar Nederlands',
    switchToEnglish: 'Switch to English',
    warning: 'Warning',
    uncategorized: 'Other',
    endKicker: 'Manual complete',
    completeTitle: 'All steps reviewed',
    completeBody: 'Reaching this screen only means every step has been seen. The install is only correct once the setup is verified on-site.',
    backToStart: 'Back to step 1',
    lightboxLabel: 'Enlarged image',
    close: 'Close',
    progressLive: 'Progress: step {n} of {t}',
    calc: 'Calculator',
    calcKicker: 'Tool',
    calcTitle: 'Throw ratio calculator',
    calcLens: 'Lens',
    calcAspect: 'Aspect ratio',
    calcSizeTitle: 'From desired projection size',
    calcSizeSub: 'Enter width or height. The other dimension follows the aspect ratio.',
    calcWidth: 'Width',
    calcHeight: 'Height',
    calcDistance: 'Projector distance',
    calcDistanceRange: 'Required projector distance',
    calcDistTitle: 'From projector distance',
    calcDistSub: 'Enter the projector-to-screen distance to see the possible image size.',
    calcWidthRange: 'Possible width',
    calcHeightRange: 'Possible height',
    calcSizeHint: 'The zoom lens covers a range. Place the projector anywhere inside this distance range.',
    calcDistHint: 'At this distance the projector can set the image size anywhere inside this range.',
    calcDisclaimer: 'Indicative values based on the lens throw ratio. Always verify on site.',
    calcDiagramTopView: 'Top-down view (to scale)',
    calcDiagramAlt: 'Schematic drawing of the projection setup',
    calcDiagramEmpty: 'Enter a width or height to show the drawing.',
    calcDiagramMinDist: 'closest',
    calcDiagramMaxDist: 'furthest',
    calcDiagramMinWidth: 'minimum width',
    calcDiagramMaxWidth: 'maximum width',
    luxLabel: 'Estimated screen illuminance',
    luxOk: 'Good contrast',
    luxBorderline: 'Borderline',
    luxLow: 'Too dim',
    luxAtLargest: 'At largest image',
    luxAtSmallest: 'At smallest image',
    luxNoteTitle: 'Reference:',
    luxNote: 'at least 100 lx for good contrast in typical outdoor conditions on a pale projection surface. Below 80 lx the image becomes too dim.',
    calcModeLabel: 'What do you want to calculate?',
    calcModeSize: 'I know the projection size',
    calcModeDistance: 'I know the projector distance',
    calcSplashSub: 'Quickly calculate size & distance',
  },
};

const STYLES = `
:host {
  display: block;
  --saiar-bg: #0a0a0c;
  --saiar-bg-elev: #101013;
  --saiar-panel: #15151a;
  --saiar-panel-2: #1c1c22;
  --saiar-panel-3: #25252d;
  --saiar-text: #f3f3f5;
  --saiar-text-strong: #ffffff;
  --saiar-muted: #a8a8b2;
  --saiar-muted-2: #6e6e78;
  --saiar-line: #26262d;
  --saiar-line-strong: #34343d;
  --saiar-accent: #ffffff;
  --saiar-accent-text: #0b0b0d;
  --saiar-accent-soft: rgba(255,255,255,0.08);
  --saiar-success: #4ade80;
  --saiar-success-strong: #22c55e;
  --saiar-success-text: #052e16;
  --saiar-success-bg: rgba(74,222,128,0.12);
  --saiar-shadow: 0 24px 60px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.3);
  --saiar-shadow-sm: 0 1px 3px rgba(0,0,0,0.2), 0 4px 14px rgba(0,0,0,0.18);
  --saiar-warning-bg: #2a2112;
  --saiar-warning-text: #f6ddb0;
  --saiar-warning-line: #5b4520;
  --saiar-radius: 16px;
  --saiar-radius-sm: 10px;
  --saiar-radius-lg: 22px;
  --saiar-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --saiar-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  --saiar-topbar-h: 60px;
  --saiar-focus-ring: 0 0 0 3px rgba(255,255,255,0.2), 0 0 0 1px var(--saiar-accent);
  font-family: var(--saiar-font);
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11', 'ss01';
  color: var(--saiar-text);
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
*, *::before, *::after { box-sizing: border-box; }

:where(button, [role="button"]):focus { outline: none; }
:where(button, [role="button"], a, input, [tabindex]):focus-visible {
  outline: none;
  box-shadow: var(--saiar-focus-ring);
  border-radius: var(--saiar-radius-sm);
}

.app {
  min-height: 100vh;
  background: var(--saiar-bg);
  color: var(--saiar-text);
  position: relative;
  display: flex;
  flex-direction: column;
}

.theme-light {
  --saiar-bg: #f7f7f8;
  --saiar-bg-elev: #ffffff;
  --saiar-panel: #ffffff;
  --saiar-panel-2: #f1f1f4;
  --saiar-panel-3: #e7e7eb;
  --saiar-text: #111114;
  --saiar-text-strong: #000000;
  --saiar-muted: #5e5e68;
  --saiar-muted-2: #8a8a93;
  --saiar-line: #e2e2e6;
  --saiar-line-strong: #c8c8cf;
  --saiar-accent: #111114;
  --saiar-accent-text: #ffffff;
  --saiar-accent-soft: rgba(0,0,0,0.05);
  --saiar-success: #16a34a;
  --saiar-success-strong: #15803d;
  --saiar-success-text: #ffffff;
  --saiar-success-bg: rgba(22,163,74,0.12);
  --saiar-shadow: 0 24px 60px rgba(15,15,30,0.08), 0 4px 14px rgba(15,15,30,0.05);
  --saiar-shadow-sm: 0 1px 2px rgba(15,15,30,0.06), 0 4px 12px rgba(15,15,30,0.04);
  --saiar-warning-bg: #fff5e1;
  --saiar-warning-text: #614000;
  --saiar-warning-line: #f0c36a;
  --saiar-focus-ring: 0 0 0 3px rgba(17,17,20,0.18), 0 0 0 1px var(--saiar-accent);
}

::selection { background: var(--saiar-accent); color: var(--saiar-accent-text); }

.root .loading { padding: 40px 24px; color: var(--saiar-muted); font-size: 14px; }
.error { padding: 18px 22px; background: var(--saiar-warning-bg); border: 1px solid var(--saiar-warning-line); color: var(--saiar-warning-text); border-radius: var(--saiar-radius); margin: 24px; }

/* Topbar */
.topbar {
  position: sticky;
  top: 0;
  z-index: 3;
  background: color-mix(in srgb, var(--saiar-bg) 88%, transparent);
  -webkit-backdrop-filter: saturate(140%) blur(14px);
  backdrop-filter: saturate(140%) blur(14px);
  border-bottom: 1px solid var(--saiar-line);
  height: var(--saiar-topbar-h);
  display: flex;
  align-items: center;
}
.topbar-inner {
  width: 100%;
  margin: 0 auto;
  padding: 0 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.logo-button {
  appearance: none; border: 0; background: transparent; padding: 4px; margin: -4px;
  cursor: pointer; line-height: 0;
  border-radius: var(--saiar-radius-sm);
  opacity: 0.92;
  transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease;
}
.logo-button:hover { opacity: 1; background: var(--saiar-accent-soft); }
.logo-button:active { transform: translateY(1px); }
.top-logo { height: 26px; width: auto; display: block; object-fit: contain; }
.manual-meta { min-width: 0; padding-left: 14px; border-left: 1px solid var(--saiar-line); }
.manual-kicker {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--saiar-muted-2); margin-bottom: 2px;
  font-weight: 500;
}
.manual-title {
  font-size: 14px; font-weight: 600; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  color: var(--saiar-text);
  letter-spacing: -0.005em;
}
.topbar-end { display: flex; align-items: center; gap: 14px; min-width: 0; }
.progress-wrap {
  display: flex; align-items: center; gap: 12px;
  min-width: min(320px, 42vw);
}
.progress-text {
  font-size: 12px; color: var(--saiar-muted); white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.progress-bar {
  flex: 1; height: 4px; border-radius: 999px;
  background: var(--saiar-panel-2);
  overflow: hidden;
  min-width: 80px;
}
.progress-fill {
  height: 100%; width: 0%;
  background: var(--saiar-accent);
  border-radius: 999px;
  transition: width 0.35s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.reduce-motion .progress-fill { transition: none; }

/* Page + cards */
.layout {
  flex: 1;
  display: flex;
  align-items: stretch;
  min-height: 0;
}
.sidebar {
  flex: 0 0 296px;
  background: var(--saiar-bg-elev);
  border-right: 1px solid var(--saiar-line);
  position: sticky;
  top: var(--saiar-topbar-h);
  align-self: flex-start;
  max-height: calc(100vh - var(--saiar-topbar-h));
  max-height: calc(100dvh - var(--saiar-topbar-h));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sidebar .toc-wrap { height: 100%; }
.page {
  flex: 1;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 18px 28px 0;
  min-width: 0;
}
.step-card, .end-card {
  width: 100%;
  max-width: 1240px;
  background: var(--saiar-panel);
  border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius-lg);
  box-shadow: var(--saiar-shadow);
  overflow: hidden;
}
.step-card {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--saiar-topbar-h) - 18px);
  height: calc(100dvh - var(--saiar-topbar-h) - 18px);
  border-bottom: 0;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.end-card {
  margin-bottom: 28px;
}
.step-grid {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    "text image"
    "nav nav";
  min-height: 0;
}
.text-col {
  grid-area: text;
  padding: 40px 40px 28px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.text-col::after {
  content: "";
  display: block;
  height: 8px;
  flex-shrink: 0;
}
.image-col {
  grid-area: image;
  background: var(--saiar-bg-elev);
  border-left: 1px solid var(--saiar-line);
  display: flex;
  align-items: stretch;
  justify-content: center;
  min-height: 380px;
  position: relative;
  overflow: hidden;
}
.image-col::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
}
.theme-light .image-col::after { box-shadow: inset 0 0 0 1px rgba(0,0,0,0.04); }
.image-col picture, .image-col img {
  width: 100%;
  height: 100%;
  display: block;
}
.image-col img {
  object-fit: cover;
  cursor: zoom-in;
  transition: transform 0.6s cubic-bezier(0.22,0.61,0.36,1);
}
.image-col:hover img { transform: scale(1.015); }
.reduce-motion .image-col:hover img { transform: none; }
.image-placeholder {
  align-self: center;
  padding: 24px;
  color: var(--saiar-muted-2);
  font-size: 13px;
  text-align: center;
  max-width: 32ch;
  line-height: 1.5;
}

.step-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
  padding: 5px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--saiar-muted);
  background: var(--saiar-panel-2);
  border: 1px solid var(--saiar-line);
  border-radius: 999px;
  font-weight: 600;
  width: fit-content;
}
.step-kicker-num { color: var(--saiar-text); }
.step-kicker-sep {
  width: 3px; height: 3px; border-radius: 50%;
  background: var(--saiar-muted-2);
  display: inline-block;
}
.step-kicker-sec { color: var(--saiar-muted); }
.step-title {
  margin: 0 0 14px;
  font-size: clamp(28px, 3.2vw, 44px);
  line-height: 1.05;
  max-width: 18ch;
  letter-spacing: -0.02em;
  font-weight: 700;
  color: var(--saiar-text-strong);
}
.step-intro {
  margin: 0 0 28px;
  color: var(--saiar-muted);
  font-size: 17px;
  line-height: 1.55;
  max-width: 58ch;
}
.content-block { margin-bottom: 22px; }
.content-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--saiar-muted-2); margin-bottom: 12px;
  font-weight: 600;
}
.body-text { font-size: 16px; line-height: 1.65; color: var(--saiar-text); max-width: 64ch; }
.body-text p { margin: 0 0 14px; }
.body-text p:last-child { margin-bottom: 0; }
.body-text ul, .body-text ol { margin: 0 0 14px; padding-left: 22px; }
.body-text li { margin-bottom: 8px; }
.body-text li::marker { color: var(--saiar-muted-2); }
.body-text strong { color: var(--saiar-text-strong); font-weight: 700; }
.body-text code {
  font-family: var(--saiar-font-mono);
  font-size: 0.92em;
  padding: 2px 6px;
  background: var(--saiar-panel-2);
  border: 1px solid var(--saiar-line);
  border-radius: 6px;
  color: var(--saiar-text-strong);
}

.warning-box {
  margin-top: 24px;
  padding: 14px 16px 14px 18px;
  border-radius: var(--saiar-radius);
  background: var(--saiar-warning-bg);
  border: 1px solid var(--saiar-warning-line);
  color: var(--saiar-warning-text);
  position: relative;
}
.warning-box::before {
  content: "";
  position: absolute;
  left: 0; top: 14px; bottom: 14px;
  width: 3px;
  background: var(--saiar-warning-line);
  border-radius: 2px;
}
.warning-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em;
  margin-bottom: 6px; opacity: 0.9;
  font-weight: 600;
}
.warning-text { font-size: 14.5px; line-height: 1.55; }

/* Nav */
.nav {
  grid-area: nav;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 32px 24px;
  border-top: 1px solid var(--saiar-line);
  background: var(--saiar-panel);
  position: relative;
}
.nav::before {
  content: "";
  position: absolute;
  left: 0; right: 0; bottom: 100%;
  height: 24px;
  pointer-events: none;
  background: linear-gradient(to top, color-mix(in srgb, var(--saiar-panel) 92%, transparent), transparent);
  opacity: 0;
  transition: opacity 0.2s ease;
}
.step-card.has-overflow .nav::before { opacity: 1; }
.nav-left, .nav-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }

.btn-primary, .btn-secondary, .btn-ghost, .start-btn {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border-radius: 999px;
  padding: 12px 20px;
  border: 1px solid transparent;
  transition:
    transform 0.12s ease,
    background 0.18s ease,
    border-color 0.18s ease,
    color 0.18s ease,
    box-shadow 0.18s ease;
  font-size: 14.5px;
  line-height: 1;
  font-weight: 500;
  letter-spacing: -0.005em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  user-select: none;
}
.btn-primary:hover, .start-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,0.25); }
.btn-secondary:hover { transform: translateY(-1px); border-color: var(--saiar-line-strong); }
.btn-primary:active, .btn-secondary:active, .start-btn:active { transform: translateY(0); }
.reduce-motion .btn-primary,
.reduce-motion .btn-secondary,
.reduce-motion .start-btn { transition: none; }
.reduce-motion .btn-primary:hover,
.reduce-motion .btn-secondary:hover,
.reduce-motion .start-btn:hover { transform: none; }

.btn-primary, .start-btn {
  background: var(--saiar-accent);
  color: var(--saiar-accent-text);
  font-weight: 600;
}
.btn-primary:hover, .start-btn:hover {
  background: color-mix(in srgb, var(--saiar-accent) 92%, var(--saiar-bg));
}
.btn-secondary {
  background: var(--saiar-panel-2);
  color: var(--saiar-text);
  border-color: var(--saiar-line);
}
.btn-secondary:hover { background: var(--saiar-panel-3); }
.btn-secondary:disabled { opacity: 0.4; cursor: default; transform: none; box-shadow: none; }
.btn-secondary:disabled:hover { background: var(--saiar-panel-2); border-color: var(--saiar-line); }

.btn-primary.nav-next { padding-left: 14px; }
.btn-primary.nav-next .check-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  background: transparent;
  opacity: 0.85;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease, opacity 0.18s ease;
}
.btn-primary.nav-next.is-done {
  background: var(--saiar-success);
  color: var(--saiar-success-text);
  font-weight: 600;
}
.btn-primary.nav-next.is-done:hover {
  background: var(--saiar-success-strong);
}
.btn-primary.nav-next.is-done .check-pill {
  background: var(--saiar-success-text);
  color: var(--saiar-success);
  border-color: var(--saiar-success-text);
  opacity: 1;
}

.btn-ghost {
  background: transparent;
  border-color: var(--saiar-line);
  color: var(--saiar-text);
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 500;
}
.btn-ghost:hover { background: var(--saiar-panel-2); border-color: var(--saiar-line-strong); }
.btn.icon, .btn-ghost.icon { padding: 6px 12px; font-size: 1.25rem; line-height: 1; border-radius: 999px; gap: 0; }

.reset-btn { padding: 8px 12px; }
.reset-icon {
  display: inline-block;
  font-size: 14px;
  line-height: 1;
  transform: translateY(-1px);
}

.lang-toggle {
  display: inline-flex;
  align-items: center;
  background: var(--saiar-panel-2);
  border: 1px solid var(--saiar-line);
  border-radius: 999px;
  padding: 2px;
  gap: 0;
}
.lang-btn {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 4px 10px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--saiar-muted);
  cursor: pointer;
  border-radius: 999px;
  text-transform: uppercase;
  transition: background 0.15s ease, color 0.15s ease;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  min-width: 30px;
}
.lang-btn:hover { color: var(--saiar-text); }
.lang-btn.is-active {
  background: var(--saiar-panel);
  color: var(--saiar-text-strong);
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
.theme-light .lang-btn.is-active {
  background: var(--saiar-bg-elev);
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}
.btn-primary.is-danger {
  background: #dc2626;
  color: #ffffff;
}
.btn-primary.is-danger:hover {
  background: #b91c1c;
}
.theme-light .btn-primary.is-danger { background: #dc2626; color: #ffffff; }
.theme-light .btn-primary.is-danger:hover { background: #b91c1c; }

.nav-undo {
  padding: 9px 14px;
  font-size: 13px;
  color: var(--saiar-muted);
  background: transparent;
  border: 1px dashed var(--saiar-line-strong);
}
.nav-undo:hover {
  color: var(--saiar-text);
  background: var(--saiar-panel-2);
  border-color: var(--saiar-muted-2);
  border-style: solid;
}

.end-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

/* Confirm modal */
.confirm-modal {
  position: fixed; inset: 0; z-index: 30;
  display: grid; place-items: center;
  padding: 24px;
}
.confirm-modal[hidden] { display: none !important; }
.confirm-backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.6);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  border: 0; padding: 0; cursor: pointer;
}
.confirm-panel {
  position: relative;
  width: 100%;
  max-width: 440px;
  background: var(--saiar-panel);
  border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius);
  box-shadow: var(--saiar-shadow);
  padding: 26px 26px 22px;
  animation: saiar-fade-in 0.2s ease;
}
.reduce-motion .confirm-panel { animation: none; }
.confirm-title {
  margin: 0 0 10px;
  font-size: 19px;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--saiar-text-strong);
}
.confirm-body {
  margin: 0 0 22px;
  color: var(--saiar-muted);
  font-size: 14px;
  line-height: 1.55;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

/* TOC: split row with toggle-mark + nav button */
.toc-row {
  list-style: none;
  display: flex;
  align-items: stretch;
  gap: 2px;
  margin: 1px 0;
  border-radius: var(--saiar-radius-sm);
  position: relative;
  transition: background 0.12s ease;
}
.toc-row:hover { background: var(--saiar-panel-2); }
.toc-row.is-current {
  background: var(--saiar-accent-soft);
}
.toc-row.is-current::before {
  content: "";
  position: absolute;
  left: -8px;
  top: 6px;
  bottom: 6px;
  width: 3px;
  background: var(--saiar-accent);
  border-radius: 0 3px 3px 0;
}
.toc-mark-btn {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 8px 4px 8px 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  border-radius: var(--saiar-radius-sm);
  color: inherit;
}
.toc-mark-btn:hover .toc-mark {
  border-color: var(--saiar-muted-2);
}
.toc-row.is-done .toc-mark-btn:hover .toc-mark {
  border-color: var(--saiar-success-strong);
  background: color-mix(in srgb, var(--saiar-success) 22%, transparent);
}

/* End card */
.end-card { max-width: 980px; padding: 48px 44px; }
.end-kicker {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--saiar-success); text-transform: uppercase; letter-spacing: 0.09em;
  margin-bottom: 14px; font-weight: 600;
  padding: 5px 11px;
  background: var(--saiar-success-bg);
  border: 1px solid color-mix(in srgb, var(--saiar-success) 35%, transparent);
  border-radius: 999px;
}
.end-title {
  margin: 0 0 14px;
  font-size: clamp(32px, 4.4vw, 52px);
  line-height: 1.05;
  letter-spacing: -0.022em;
  color: var(--saiar-text-strong);
  font-weight: 700;
}
.end-text { margin: 0 0 32px; color: var(--saiar-muted); font-size: 17px; line-height: 1.55; max-width: 58ch; }
.overview-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px; margin: 0 0 32px; padding: 0; list-style: none;
}
.overview-item {
  display: flex; align-items: flex-start; gap: 14px;
  background: var(--saiar-panel-2);
  border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius);
  padding: 14px 16px;
  font-size: 14px; line-height: 1.45;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.overview-item:hover { border-color: var(--saiar-line-strong); }
.overview-item.is-done { border-color: color-mix(in srgb, var(--saiar-success) 45%, var(--saiar-line)); }
.overview-item.is-done .oi-num {
  color: var(--saiar-success);
  background: var(--saiar-success-bg);
}
.oi-num {
  font-family: var(--saiar-font-mono);
  color: var(--saiar-muted);
  font-size: 12px;
  padding: 4px 8px;
  background: var(--saiar-panel-3);
  border-radius: 6px;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.oi-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.oi-meta strong { color: var(--saiar-text-strong); font-weight: 600; }
.oi-sec { font-size: 11px; color: var(--saiar-muted-2); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }

/* Banner */
.banner-warn {
  width: 100%;
  max-width: 1240px;
  margin: 0 auto 16px;
  padding: 12px 16px;
  border-radius: var(--saiar-radius-sm);
  border: 1px solid var(--saiar-warning-line);
  background: var(--saiar-warning-bg);
  color: var(--saiar-warning-text);
  font-size: 13px;
}

/* Splash */
.splash {
  position: fixed; inset: 0; z-index: 8;
  display: grid; place-items: center;
  background:
    radial-gradient(ellipse at top, color-mix(in srgb, var(--saiar-accent) 4%, transparent), transparent 60%),
    var(--saiar-bg);
  padding: 40px 24px;
  animation: saiar-fade-in 0.4s ease;
}
.reduce-motion .splash { animation: none; }
@keyframes saiar-fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.splash-inner { text-align: center; max-width: 640px; width: 100%; display: flex; flex-direction: column; align-items: center; }
.splash-logo {
  width: min(360px, 70vw);
  height: auto;
  margin-bottom: 40px;
  opacity: 0.95;
}
.splash-title {
  margin: 0;
  font-size: clamp(32px, 4.6vw, 56px);
  line-height: 1.05;
  letter-spacing: -0.025em;
  font-weight: 700;
  color: var(--saiar-text-strong);
}
.splash-divider {
  width: 56px; height: 2px;
  background: var(--saiar-line-strong);
  margin: 28px auto;
  border-radius: 2px;
}
.splash-resume-meta {
  margin: 0 0 24px;
  color: var(--saiar-muted);
  font-size: 14.5px;
  line-height: 1.5;
  max-width: 42ch;
}
.splash-resume-meta strong { color: var(--saiar-text-strong); font-weight: 600; }
.splash-start {
  margin-top: 8px;
  padding: 14px 24px;
  font-weight: 600;
  font-size: 15px;
  min-width: 220px;
}
.splash-actions {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  width: min(320px, 88vw);
}
.splash-actions .splash-start { margin-top: 0; min-width: 0; }
.splash-restart {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border-radius: 999px;
  padding: 12px 20px;
  background: transparent;
  color: var(--saiar-muted);
  border: 1px solid var(--saiar-line);
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  font-size: 13.5px;
  font-weight: 500;
}
.splash-restart:hover { background: var(--saiar-panel-2); color: var(--saiar-text); border-color: var(--saiar-line-strong); }

/* Lightbox */
.lightbox { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; }
.lightbox[hidden] { display: none !important; }
.lightbox-backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.82);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  border: 0; padding: 0; cursor: zoom-out;
}
.lightbox-panel {
  position: relative; z-index: 1; max-width: min(96vw, 1400px); max-height: 92vh; padding: 14px;
  background: var(--saiar-panel); border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius); box-shadow: var(--saiar-shadow);
}
.lightbox-img { max-width: 100%; max-height: 80vh; object-fit: contain; display: block; margin: 0 auto; border-radius: 6px; }
.lightbox-close {
  position: absolute; top: 10px; right: 10px;
  appearance: none; border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.55); color: #fff;
  width: 36px; height: 36px; border-radius: 999px; font-size: 18px; cursor: pointer;
  line-height: 1;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.lightbox-close:hover { background: rgba(0,0,0,0.75); border-color: rgba(255,255,255,0.25); }

/* Drawer (TOC) */
.drawer { position: fixed; inset: 0; z-index: 10; }
.drawer[hidden] { display: none !important; }
.drawer-overlay {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.5);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}
.drawer-panel {
  position: absolute; top: 0; right: 0; width: min(92vw, 380px); height: 100%;
  background: var(--saiar-bg-elev);
  border-left: 1px solid var(--saiar-line);
  display: flex; flex-direction: column;
  box-shadow: -8px 0 32px rgba(0,0,0,0.5);
}
.drawer-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--saiar-line);
  font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--saiar-muted-2);
}
.drawer-close { padding: 4px 12px; font-size: 1.2rem; }
.drawer-body { padding: 0; overflow: hidden; flex: 1; display: flex; flex-direction: column; }
.drawer-body .toc-wrap { height: 100%; }

.toc-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.toc-search-label {
  padding: 14px 16px;
  border-bottom: 1px solid var(--saiar-line);
  display: block;
  position: relative;
}
.toc-search-label::before {
  content: "";
  position: absolute;
  left: 28px;
  top: 50%;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  background: currentColor;
  color: var(--saiar-muted-2);
  -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='7'/><path d='M21 21l-4.3-4.3'/></svg>") center / contain no-repeat;
  mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='7'/><path d='M21 21l-4.3-4.3'/></svg>") center / contain no-repeat;
  pointer-events: none;
}
.toc-search {
  width: 100%; padding: 9px 12px 9px 34px;
  border-radius: var(--saiar-radius-sm);
  border: 1px solid var(--saiar-line);
  background: var(--saiar-panel-2);
  color: var(--saiar-text);
  font: inherit;
  font-size: 13px;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.toc-search::placeholder { color: var(--saiar-muted-2); }
.toc-search:hover { border-color: var(--saiar-line-strong); }
.toc-search:focus-visible {
  outline: none;
  border-color: var(--saiar-line-strong);
  background: var(--saiar-panel-3);
  box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
}
.toc-scroll {
  overflow: auto;
  padding: 8px 8px 24px;
  flex: 1;
}

/* Themed scrollbars (Firefox + WebKit) */
.text-col, .toc-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--saiar-line-strong) transparent;
}
.text-col::-webkit-scrollbar,
.toc-scroll::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.text-col::-webkit-scrollbar-track,
.toc-scroll::-webkit-scrollbar-track {
  background: transparent;
  margin: 6px 0;
}
.text-col::-webkit-scrollbar-thumb,
.toc-scroll::-webkit-scrollbar-thumb {
  background: var(--saiar-line-strong);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
  min-height: 36px;
  transition: background-color 0.18s ease;
}
.text-col::-webkit-scrollbar-thumb:hover,
.toc-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--saiar-muted-2);
  background-clip: padding-box;
}
.text-col::-webkit-scrollbar-thumb:active,
.toc-scroll::-webkit-scrollbar-thumb:active {
  background: var(--saiar-muted);
  background-clip: padding-box;
}
.text-col::-webkit-scrollbar-corner,
.toc-scroll::-webkit-scrollbar-corner {
  background: transparent;
}

.toc-group { margin-bottom: 10px; }
.toc-sec {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--saiar-muted-2); margin: 14px 12px 6px;
  font-weight: 600;
}
.toc-group:first-child .toc-sec { margin-top: 6px; }
.toc-list { list-style: none; padding: 0; margin: 0; }
.toc-item {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  padding: 8px 10px 8px 4px;
  border: 0; border-radius: var(--saiar-radius-sm);
  background: transparent; color: var(--saiar-text);
  font: inherit; font-size: 13px;
  cursor: pointer; line-height: 1.35;
  display: flex; align-items: center; gap: 10px;
  transition: color 0.12s ease;
}
.toc-row.is-current .toc-item {
  color: var(--saiar-text-strong);
  font-weight: 600;
}

.toc-mark {
  flex: 0 0 16px;
  width: 16px; height: 16px;
  border-radius: 50%;
  border: 1.5px solid var(--saiar-line-strong);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1;
  color: transparent;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.toc-row.is-done .toc-mark {
  background: var(--saiar-success-bg);
  border-color: var(--saiar-success);
  color: var(--saiar-success);
}
.toc-row.is-done .toc-mark::before { content: "✓"; font-weight: 700; }
.toc-num {
  font-family: var(--saiar-font-mono);
  font-size: 10.5px;
  color: var(--saiar-muted-2);
  flex: 0 0 auto;
  min-width: 22px;
  font-variant-numeric: tabular-nums;
}
.toc-row.is-current .toc-num { color: var(--saiar-muted); }
.toc-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;
}
.muted { color: var(--saiar-muted); font-size: 13px; padding: 12px 16px; }

.print-root { display: none; }

/* Throw-ratio calculator */
.calc-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding-left: 12px;
  padding-right: 14px;
}
.calc-toggle .calc-toggle-icon {
  font-size: 14px;
  line-height: 1;
  opacity: 0.85;
  transform: translateY(-0.5px);
}
.calc-toggle[aria-expanded="true"] {
  background: var(--saiar-panel-2);
  border-color: var(--saiar-line-strong);
}

.calc-modal {
  position: fixed; inset: 0; z-index: 12;
  display: grid; place-items: center;
  padding: 24px;
}
.calc-modal[hidden] { display: none !important; }
.calc-backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.6);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  border: 0; padding: 0; cursor: pointer;
}
.calc-panel {
  position: relative; z-index: 1;
  width: min(880px, 100%);
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
  display: flex; flex-direction: column;
  background: var(--saiar-panel);
  border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius-lg);
  box-shadow: var(--saiar-shadow);
  overflow: hidden;
  animation: saiar-fade-in 0.2s ease;
}
.reduce-motion .calc-panel { animation: none; }

.calc-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px;
  padding: 22px 22px 16px;
  border-bottom: 1px solid var(--saiar-line);
}
.calc-head-meta { min-width: 0; }
.calc-kicker {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--saiar-muted-2); margin-bottom: 4px;
  font-weight: 600;
}
.calc-title {
  margin: 0;
  font-size: 20px; line-height: 1.2;
  letter-spacing: -0.012em;
  font-weight: 700;
  color: var(--saiar-text-strong);
}
.calc-close {
  appearance: none; border: 1px solid var(--saiar-line);
  background: var(--saiar-panel-2); color: var(--saiar-text);
  width: 32px; height: 32px; border-radius: 999px;
  font-size: 18px; line-height: 1; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.calc-close:hover { background: var(--saiar-panel-3); border-color: var(--saiar-line-strong); }

.calc-body {
  padding: 18px 22px 22px;
  overflow-y: auto;
  display: flex; flex-direction: column;
  gap: 16px;
}

.calc-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.calc-row-shared {
  padding: 14px;
  background: var(--saiar-panel-2);
  border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius);
}

.calc-field {
  display: flex; flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.calc-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--saiar-muted-2);
  font-weight: 600;
  display: flex; align-items: baseline; gap: 6px;
}
.calc-unit {
  font-size: 10px; text-transform: none; letter-spacing: 0;
  color: var(--saiar-muted-2);
  font-weight: 500;
  opacity: 0.8;
}
.calc-input {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--saiar-radius-sm);
  border: 1px solid var(--saiar-line);
  background: var(--saiar-bg-elev);
  color: var(--saiar-text);
  font: inherit;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.calc-input:hover { border-color: var(--saiar-line-strong); }
.calc-input:focus-visible {
  outline: none;
  border-color: var(--saiar-line-strong);
  background: var(--saiar-panel);
  box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
}
.theme-light .calc-input:focus-visible {
  box-shadow: 0 0 0 3px rgba(17,17,20,0.08);
}
select.calc-input {
  appearance: none;
  -webkit-appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--saiar-muted) 50%),
    linear-gradient(135deg, var(--saiar-muted) 50%, transparent 50%);
  background-position:
    calc(100% - 18px) calc(50% - 2px),
    calc(100% - 13px) calc(50% - 2px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 32px;
}
input.calc-input::-webkit-outer-spin-button,
input.calc-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input.calc-input[type="number"] { -moz-appearance: textfield; }

.calc-card {
  border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius);
  padding: 16px;
  display: flex; flex-direction: column;
  gap: 12px;
  background: var(--saiar-bg-elev);
}
.calc-card-head {
  display: flex; align-items: flex-start; gap: 12px;
}
.calc-card-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--saiar-text-strong);
  letter-spacing: -0.005em;
}
.calc-card-sub {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: var(--saiar-muted);
  line-height: 1.45;
}

.calc-result {
  display: flex; align-items: center; justify-content: space-between;
  gap: 14px;
  padding: 11px 14px;
  background: var(--saiar-panel-2);
  border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius-sm);
}
.calc-result-label {
  font-size: 12px;
  color: var(--saiar-muted);
  font-weight: 500;
}
.calc-result-value {
  font-size: 15px;
  font-weight: 700;
  color: var(--saiar-text-strong);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  text-align: right;
}
.calc-hint {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--saiar-muted-2);
  line-height: 1.5;
}
.calc-disclaimer {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--saiar-muted-2);
  text-align: center;
  line-height: 1.5;
}

.calc-diagram-wrap {
  border: 1px solid var(--saiar-line);
  border-radius: var(--saiar-radius);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--saiar-bg-elev) 95%, transparent), var(--saiar-bg-elev));
  padding: 10px 14px 14px;
  overflow: hidden;
}
.calc-diagram-svg {
  display: block;
  width: 100%;
  height: auto;
  font-family: var(--saiar-font);
}
.diag-empty {
  fill: var(--saiar-muted-2);
  font-size: 12px;
}
.diag-caption {
  fill: var(--saiar-muted-2);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
}
.diag-floor {
  stroke: var(--saiar-line);
  stroke-width: 1;
  stroke-dasharray: 2 4;
}
.diag-wall {
  stroke: var(--saiar-line-strong);
  stroke-width: 1.25;
}
.diag-screen {
  stroke: var(--saiar-accent);
  stroke-width: 4;
  stroke-linecap: round;
}
.diag-screen-end {
  fill: var(--saiar-accent);
}
.diag-cone {
  stroke: none;
}
.diag-cone-max {
  fill: color-mix(in srgb, var(--saiar-accent) 8%, transparent);
}
.diag-cone-min {
  fill: color-mix(in srgb, var(--saiar-accent) 16%, transparent);
}
.diag-proj {
  fill: var(--saiar-panel-3);
  stroke: var(--saiar-line-strong);
  stroke-width: 1;
}
.diag-proj-lens {
  fill: var(--saiar-text-strong);
}
.diag-proj-group.diag-proj-max .diag-proj {
  fill: var(--saiar-panel-2);
  stroke-dasharray: 3 2;
  opacity: 0.85;
}
.diag-proj-label {
  fill: var(--saiar-muted-2);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}
.diag-dim {
  stroke: var(--saiar-muted);
  stroke-width: 1;
}
.diag-tick {
  stroke: var(--saiar-muted);
  stroke-width: 0.75;
  stroke-dasharray: 2 2;
}
.diag-arrow-head {
  fill: var(--saiar-muted);
}
.diag-label {
  fill: var(--saiar-text);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.diag-label-width {
  fill: var(--saiar-text-strong);
  font-size: 12px;
}
.diag-label-min,
.diag-label-max {
  fill: var(--saiar-muted);
  font-size: 10.5px;
  font-weight: 500;
}
.diag-label-width-min {
  fill: var(--saiar-text-strong);
  font-size: 11.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.diag-label-width-max {
  fill: var(--saiar-muted);
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/* Inline lux readout printed next to the screen in the diagram, colour
   coded with the same scale as the lux gauge below the diagram. */
.diag-lux {
  font-size: 10.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}
.diag-lux-ok { fill: var(--saiar-success); }
.diag-lux-borderline { fill: #f59e0b; }
.diag-lux-low { fill: #ef4444; }
.theme-light .diag-lux-ok { fill: #15803d; }
.theme-light .diag-lux-borderline { fill: #b45309; }
.theme-light .diag-lux-low { fill: #b91c1c; }

.calc-result-lux .calc-result-value {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.calc-result-lux-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: stretch;
  padding: 14px 16px;
}
.lux-row-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
}
.lux-row-top .calc-result-label { font-weight: 500; }
.lux-value {
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  font-size: 15px;
  font-weight: 700;
  color: var(--saiar-text-strong);
  white-space: nowrap;
}

/* Lux gauge */
.lux-meter {
  position: relative;
  margin: 4px 0 2px;
}
.lux-meter-track {
  position: relative;
  display: flex;
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--saiar-panel-3);
  box-shadow: inset 0 1px 0 rgba(0,0,0,0.2);
}
.theme-light .lux-meter-track {
  box-shadow: inset 0 1px 0 rgba(0,0,0,0.05);
}
.lux-meter-zone { height: 100%; }
.lux-zone-low {
  background: rgba(248, 113, 113, 0.55);
}
.lux-zone-borderline {
  background: rgba(245, 158, 11, 0.6);
}
.lux-zone-ok {
  background: color-mix(in srgb, var(--saiar-success) 55%, transparent);
}
.theme-light .lux-zone-low { background: rgba(220, 38, 38, 0.45); }
.theme-light .lux-zone-borderline { background: rgba(217, 119, 6, 0.55); }
.theme-light .lux-zone-ok { background: color-mix(in srgb, var(--saiar-success) 50%, transparent); }

/* Coloured chevron pins above the track. The pin colour matches the
   lux status badge for that endpoint, so the meter and the badges below
   read the same story at a glance. For a range we draw a thin bridge
   line that connects the two pins. */
.lux-meter-pins {
  position: relative;
  height: 14px;
  margin-bottom: 4px;
  overflow: visible;
}
.lux-pin {
  position: absolute;
  top: 0;
  width: 0;
  height: 100%;
  pointer-events: none;
}
.lux-pin-chevron {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 7px solid currentColor;
  transform: translateX(-50%);
  filter: drop-shadow(0 1px 1px rgba(0,0,0,0.35));
}
.lux-pin-stem {
  position: absolute;
  top: 7px;
  left: 0;
  width: 2px;
  height: 8px;
  background: currentColor;
  border-radius: 0 0 1px 1px;
  transform: translateX(-50%);
}
.lux-pin-low { color: #ef4444; }
.lux-pin-borderline { color: #f59e0b; }
.lux-pin-ok { color: var(--saiar-success); }
.theme-light .lux-pin-low { color: #b91c1c; }
.theme-light .lux-pin-borderline { color: #b45309; }
.theme-light .lux-pin-ok { color: #15803d; }

.lux-bridge {
  position: absolute;
  top: 2px;
  height: 2px;
  background: var(--saiar-text);
  opacity: 0.55;
  border-radius: 1px;
  pointer-events: none;
}
.theme-light .lux-bridge { opacity: 0.6; }

.lux-meter-scale {
  position: relative;
  height: 14px;
  margin-top: 4px;
  pointer-events: none;
}
.lux-scale-tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-size: 9.5px;
  font-weight: 600;
  color: var(--saiar-muted-2);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  white-space: nowrap;
  padding-top: 1px;
}
.lux-scale-tick::before {
  content: "";
  position: absolute;
  left: 50%;
  top: -4px;
  width: 1px;
  height: 4px;
  background: var(--saiar-line-strong);
}
.lux-scale-tick-thresh {
  color: var(--saiar-text);
}
.lux-scale-tick-thresh::before {
  background: var(--saiar-text);
  height: 6px;
  top: -6px;
}
.lux-scale-tick-start { transform: translateX(0); }
.lux-scale-tick-start::before { left: 0; }
.lux-scale-tick-end { transform: translateX(-100%); }
.lux-scale-tick-end::before { left: auto; right: 0; }

.lux-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.lux-badge-prefix {
  font-weight: 500;
  opacity: 0.85;
  margin-right: 2px;
}
.lux-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  border: 1px solid transparent;
  white-space: nowrap;
}
.lux-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
  flex-shrink: 0;
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 18%, transparent);
}
.lux-badge-ok {
  color: var(--saiar-success);
  background: var(--saiar-success-bg);
  border-color: color-mix(in srgb, var(--saiar-success) 35%, transparent);
}
.lux-badge-borderline {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.14);
  border-color: rgba(245, 158, 11, 0.45);
}
.theme-light .lux-badge-borderline {
  color: #b45309;
  background: rgba(245, 158, 11, 0.18);
  border-color: rgba(180, 83, 9, 0.45);
}
.lux-badge-low {
  color: #f87171;
  background: rgba(248, 113, 113, 0.14);
  border-color: rgba(248, 113, 113, 0.45);
}
.theme-light .lux-badge-low {
  color: #b91c1c;
  background: rgba(248, 113, 113, 0.18);
  border-color: rgba(185, 28, 28, 0.45);
}
.calc-lux-note {
  margin: 2px 0 0;
  padding: 10px 14px;
  background: var(--saiar-panel-2);
  border: 1px dashed var(--saiar-line-strong);
  border-radius: var(--saiar-radius-sm);
  font-size: 11.5px;
  color: var(--saiar-muted);
  line-height: 1.55;
}
.calc-lux-note strong {
  color: var(--saiar-text);
  font-weight: 700;
  margin-right: 4px;
}

/* Mode tabs */
.calc-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 4px;
  background: var(--saiar-panel-2);
  border: 1px solid var(--saiar-line);
  border-radius: 999px;
}
.calc-tab {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 0;
  background: transparent;
  color: var(--saiar-muted);
  padding: 9px 14px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.005em;
  transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.calc-tab:hover { color: var(--saiar-text); }
.calc-tab.is-active {
  background: var(--saiar-bg-elev);
  color: var(--saiar-text-strong);
  box-shadow: var(--saiar-shadow-sm);
}

/* Distance diagram: outer (max) screen line is more subtle */
.diag-screen-min {
  stroke: var(--saiar-accent);
}
.diag-screen-max {
  stroke: color-mix(in srgb, var(--saiar-accent) 55%, transparent);
  stroke-width: 3;
}

/* Splash shortcut to the calculator */
.splash-calc {
  margin-top: 28px;
  appearance: none;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 10px 18px 10px 14px;
  border-radius: 999px;
  background: transparent;
  color: var(--saiar-muted);
  border: 1px solid var(--saiar-line);
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
}
.splash-calc:hover {
  background: var(--saiar-panel-2);
  color: var(--saiar-text);
  border-color: var(--saiar-line-strong);
  transform: translateY(-1px);
}
.reduce-motion .splash-calc { transition: none; }
.reduce-motion .splash-calc:hover { transform: none; }
.splash-calc-icon {
  font-size: 16px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--saiar-panel-2);
  color: var(--saiar-text-strong);
  flex-shrink: 0;
}
.splash-calc-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  gap: 2px;
}
.splash-calc-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--saiar-text);
}
.splash-calc-sub {
  font-size: 11px;
  color: var(--saiar-muted-2);
  font-weight: 500;
}

@media (max-width: 720px) {
  .calc-toggle .calc-toggle-label { display: none; }
  .calc-toggle { padding-left: 10px; padding-right: 12px; }
  .calc-modal { padding: 12px; }
  .calc-panel { max-height: calc(100dvh - 24px); }
  .calc-head { padding: 16px 16px 12px; }
  .calc-body { padding: 14px 16px 18px; gap: 14px; }
  .calc-row { grid-template-columns: 1fr; gap: 10px; }
  .calc-card { padding: 14px; }
  .calc-tabs { grid-template-columns: 1fr; border-radius: var(--saiar-radius); }
  .calc-tab { padding: 11px 14px; }
  .splash-calc { margin-top: 22px; }
}

@media print {
  .calc-toggle, .calc-modal { display: none !important; }
}

/* Responsive */
@media (min-width: 1200px) {
  .toc-toggle { display: none; }
}
@media (max-width: 1199px) {
  .sidebar { display: none; }
}

@media (max-width: 980px) {
  .page { padding: 16px 16px 24px; }
  .step-card {
    height: auto;
    min-height: 0;
    max-height: none;
    border-bottom: 1px solid var(--saiar-line);
    border-radius: var(--saiar-radius);
  }
  .step-grid {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto auto;
    grid-template-areas:
      "text"
      "image"
      "nav";
    min-height: 0;
  }
  .image-col {
    border-left: 0;
    border-top: 1px solid var(--saiar-line);
    min-height: 240px;
    aspect-ratio: 4/3;
  }
  .text-col {
    padding: 28px 22px 22px;
    overflow: visible;
    scrollbar-gutter: auto;
  }
  .text-col::after { display: none; }
  .nav { padding: 18px 22px 22px; }
  .step-title { max-width: none; }
  .end-card { padding: 36px 28px; }
  .overview-list { gap: 8px; }
}

@media (max-width: 720px) {
  :host { --saiar-topbar-h: 84px; }
  .topbar { height: auto; min-height: var(--saiar-topbar-h); }
  .topbar-inner { flex-direction: column; align-items: stretch; gap: 10px; padding: 10px 16px; }
  .topbar-end { width: 100%; }
  .manual-meta { padding-left: 0; border-left: 0; }
  .brand { gap: 12px; }
  .progress-wrap { width: 100%; min-width: 0; }
  .page { padding: 16px 14px 36px; }
  .overview-list { grid-template-columns: 1fr; }
  .nav { flex-direction: column; align-items: stretch; gap: 12px; padding: 16px 18px 22px; }
  .nav-left, .nav-right { width: 100%; justify-content: center; }
  .btn-primary, .btn-secondary { width: 100%; }
  .btn-primary.nav-next { justify-content: center; }
  .splash-logo { width: min(260px, 65vw); margin-bottom: 28px; }
  .step-card, .end-card { border-radius: var(--saiar-radius); }
  .text-col { padding: 24px 20px 20px; }
}

@media print {
  .splash, .topbar, .drawer, .lightbox, .nav, .toc-toggle, .banner-warn, .sidebar { display: none !important; }
  .app { background: white; color: black; }
  .page { display: block !important; padding: 0 !important; }
  .page .step-card { display: none !important; }
  .print-root {
    display: block !important;
    position: static !important;
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
  }
  .print-step { break-inside: avoid; page-break-inside: avoid; margin: 0 0 18px; padding: 12px 0; border-bottom: 1px solid #ccc; }
  .print-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .print-check { font-size: 14pt; line-height: 1; }
  .print-num { font-weight: 700; }
  .print-sec { font-size: 10pt; color: #444; text-transform: uppercase; }
  .print-title { font-size: 14pt; margin: 0; flex: 1 1 100%; }
  .print-body { font-size: 11pt; }
  .print-warn { border: 1px solid #999; padding: 6px 8px; margin-top: 8px; background: #fff8e6; }
  .print-img { margin-top: 8px; }
  .print-img-el { max-width: 100%; height: auto; }
}
`;

customElements.define('saiar-manual', SaiarManual);
