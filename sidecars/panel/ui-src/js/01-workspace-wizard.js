    const PANEL_AUTH_HEADER = 'antigravity-v38';
    const WORKSPACE_SELECT_STORAGE_KEY = 'ag_tunnel_selected_workspace_v1';
    let _selectedWorkspaceMode = '__auto__';
    try {
      const savedWsMode = localStorage.getItem(WORKSPACE_SELECT_STORAGE_KEY);
      if (savedWsMode && typeof savedWsMode === 'string' && savedWsMode.trim()) {
        _selectedWorkspaceMode = savedWsMode.trim();
      }
    } catch {}
    let _knownWorkspacesList = [];
    let _activeWorkspaceResolved = '';
    let _autoWorkspaceResolved = '';
    let _cachedSidecarOpenWorkspaces = [];
    let _lastOpenWorkspacesPollAt = 0;
    let _openWorkspacesInFlight = null;
    let _sidecarWsSubscribed = false;
    let _sidecarWsRefreshTimer = null;

    function normalizeSidecarWorkspaceUris(res) {
      if (!Array.isArray(res)) return [];
      return res
        .map(function (u) { return String(u || '').trim(); })
        .filter(Boolean)
        .slice(0, 24);
    }

    function ensureSidecarWorkspaceSubscription() {
      if (_sidecarWsSubscribed) return;
      if (window.sidecar && typeof window.sidecar.onWorkspaceChange === 'function') {
        _sidecarWsSubscribed = true;
        try {
          window.sidecar.onWorkspaceChange(function (uris) {
            const nextList = normalizeSidecarWorkspaceUris(uris);
            const prevSig = _cachedSidecarOpenWorkspaces.join('|');
            const nextSig = nextList.join('|');
            _cachedSidecarOpenWorkspaces = nextList;
            _lastOpenWorkspacesPollAt = Date.now();
            if (prevSig !== nextSig && _selectedWorkspaceMode === '__auto__' && lastPayloadCache) {
              if (_sidecarWsRefreshTimer) clearTimeout(_sidecarWsRefreshTimer);
              _sidecarWsRefreshTimer = setTimeout(function () {
                _sidecarWsRefreshTimer = null;
                if (typeof refreshAll === 'function') {
                  void refreshAll({ silent: true });
                }
              }, 25);
            }
          });
        } catch {}
      }
    }

    async function refreshSidecarOpenWorkspacesFast(force) {
      ensureSidecarWorkspaceSubscription();
      const now = Date.now();
      if (!force && _lastOpenWorkspacesPollAt > 0 && now - _lastOpenWorkspacesPollAt < 4000) {
        return _cachedSidecarOpenWorkspaces;
      }
      if (_openWorkspacesInFlight) {
        return _openWorkspacesInFlight;
      }
      const TIMEOUT_MARK = {};
      const timeoutMs = _cachedSidecarOpenWorkspaces.length === 0 ? 900 : 350;
      _openWorkspacesInFlight = (async function () {
        try {
          if (window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
            const rawPromise = Promise.resolve(window.sidecar.getWorkspaceUris()).catch(function () { return null; });
            const res = await Promise.race([
              rawPromise,
              new Promise(function (resolve) { setTimeout(function () { resolve(TIMEOUT_MARK); }, timeoutMs); })
            ]);
            if (res !== TIMEOUT_MARK && Array.isArray(res)) {
              _cachedSidecarOpenWorkspaces = normalizeSidecarWorkspaceUris(res);
              _lastOpenWorkspacesPollAt = Date.now();
            } else if (res === TIMEOUT_MARK) {
              // Preserve late IPC resolution so cold-start open workspaces still sync without waiting for next poll
              rawPromise.then(function (lateRes) {
                if (!Array.isArray(lateRes)) return;
                const nextList = normalizeSidecarWorkspaceUris(lateRes);
                const prevSig = _cachedSidecarOpenWorkspaces.join('|');
                const nextSig = nextList.join('|');
                _cachedSidecarOpenWorkspaces = nextList;
                _lastOpenWorkspacesPollAt = Date.now();
                if (prevSig !== nextSig && _selectedWorkspaceMode === '__auto__' && lastPayloadCache) {
                  if (_sidecarWsRefreshTimer) clearTimeout(_sidecarWsRefreshTimer);
                  _sidecarWsRefreshTimer = setTimeout(function () {
                    _sidecarWsRefreshTimer = null;
                    if (typeof refreshAll === 'function') {
                      void refreshAll({ silent: true });
                    }
                  }, 25);
                }
              });
            }
          }
        } catch {}
        return _cachedSidecarOpenWorkspaces;
      })();
      try {
        return await _openWorkspacesInFlight;
      } finally {
        _openWorkspacesInFlight = null;
      }
    }
    void refreshSidecarOpenWorkspacesFast(true);

    function getEffectivePanelRootParam() {
      return _selectedWorkspaceMode === '__auto__' ? '' : _selectedWorkspaceMode;
    }

    function normalizeWsClientKey(p) {
      return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    function getWorkspaceBasename(wsPath) {
      const clean = String(wsPath || '').trim().replace(/[\\/]+$/, '');
      if (!clean) return '';
      const parts = clean.split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : clean;
    }

    function getWorkspaceDisplayLabel(targetWs) {
      const targetKey = normalizeWsClientKey(targetWs);
      if (!targetKey) return L('Проект', 'Project');
      for (let i = 0; i < _knownWorkspacesList.length; i++) {
        const w = _knownWorkspacesList[i];
        if (w && normalizeWsClientKey(w.workspaceRoot) === targetKey) {
          return w.displayLabel || w.projectName || getWorkspaceBasename(targetWs) || L('Проект', 'Project');
        }
      }
      return getWorkspaceBasename(targetWs) || L('Проект', 'Project');
    }

    function getSelectedWorkspaceDisplayName() {
      if (_selectedWorkspaceMode === '__all__') return L('Все проекты', 'All projects');
      const targetWs = _selectedWorkspaceMode !== '__auto__'
        ? _selectedWorkspaceMode
        : (_activeWorkspaceResolved || _autoWorkspaceResolved || '');
      return getWorkspaceDisplayLabel(targetWs);
    }

    function syncWorkspaceSwitcherBadge() {
      const badgeEl = document.getElementById('agProgressProjectBadge');
      const triggerBtn = document.getElementById('btn-panelWorkspace');
      const resetAutoBtn = document.getElementById('btnResetWorkspaceAuto');
      const scopeBadge = document.getElementById('checkpointsScopeBadge');
      const activeName = getSelectedWorkspaceDisplayName();

      const isAutoMode = _selectedWorkspaceMode === '__auto__';

      if (badgeEl) {
        if (_selectedWorkspaceMode === '__all__') {
          badgeEl.textContent = L('Все проекты', 'All projects');
        } else if (!isAutoMode) {
          badgeEl.textContent = activeName;
        } else {
          const autoTarget = _autoWorkspaceResolved || _activeWorkspaceResolved || '';
          const autoName = autoTarget ? getWorkspaceDisplayLabel(autoTarget) : (activeName || L('Проект', 'Project'));
          badgeEl.textContent = autoName;
        }
      }
      if (triggerBtn) {
        let modeLine = '';
        if (_selectedWorkspaceMode === '__all__') {
          modeLine = L('Режим «Все проекты»: общая лента снимков (остальные блоки используют активный проект)', '"All projects" mode: combined snapshot timeline (other cards use active project)');
        } else if (_selectedWorkspaceMode !== '__auto__') {
          modeLine = L('Выбран проект: ', 'Selected project: ') + _selectedWorkspaceMode;
        } else {
          modeLine = L('Авторежим: ', 'Auto mode: ') + (_autoWorkspaceResolved || _activeWorkspaceResolved || L('активный чат', 'active chat'));
        }
        const profileLbl = (typeof detectedProjectInfo !== 'undefined' && detectedProjectInfo)
          ? (typeof pickText === 'function'
            ? pickText(detectedProjectInfo, 'label', 'labelEn', '')
            : (detectedProjectInfo.label || detectedProjectInfo.labelEn || ''))
          : '';
        const profileLine = profileLbl
          ? (L('Профиль воркспейса: «', 'Workspace profile: "') + profileLbl + L('» · Навыки в Авто-режиме', '" · Skills in Auto mode'))
          : L('ИИ-Пилот активен · Навыки в Авто-режиме', 'AI Pilot Active · Skills in Auto mode');
        const descLine = L(
          'Переключает текущий проект для всех модулей пульта (снимки отката, Git-песочницы, Композер, Дозор, грабли и память).',
          'Switches the active workspace for all panel modules (snapshots, Git sandboxes, Composer, Sentinel, pitfalls, and memory).'
        );
        const fullTip = modeLine + '\n' + profileLine + '\n' + descLine;
        if (typeof setTooltipTitle === 'function') setTooltipTitle(triggerBtn, fullTip);
        else triggerBtn.title = fullTip;
      }
      if (resetAutoBtn) {
        resetAutoBtn.style.display = 'inline-flex';
        resetAutoBtn.classList.toggle('active', isAutoMode);
        resetAutoBtn.setAttribute('aria-pressed', isAutoMode ? 'true' : 'false');
        resetAutoBtn.textContent = L('Авто', 'Auto');
        const autoBtnTip = isAutoMode
          ? L('Авторежим включён: проект определяется по активному чату', 'Auto mode is on: project follows the active chat')
          : L('Авторежим выключен — нажмите, чтобы вернуться к автоопределению активного чата', 'Auto mode is off — click to return to active chat auto-detection');
        if (typeof setTooltipTitle === 'function') setTooltipTitle(resetAutoBtn, autoBtnTip);
        else resetAutoBtn.title = autoBtnTip;
      }
      if (scopeBadge) {
        if (_selectedWorkspaceMode === '__all__') {
          scopeBadge.textContent = L('Все проекты', 'All projects');
          scopeBadge.title = L('Показаны снимки всех проектов', 'Showing snapshots from all projects');
        } else {
          scopeBadge.textContent = activeName;
          scopeBadge.title = _activeWorkspaceResolved ? (L('Проект: ', 'Project: ') + _activeWorkspaceResolved) : (L('Проект: ', 'Project: ') + activeName);
        }
      }
    }

    function renderWorkspaceSwitcher(payload) {
      if (payload && typeof payload === 'object') {
        if (typeof payload.activeWorkspace === 'string' && payload.activeWorkspace) {
          _activeWorkspaceResolved = payload.activeWorkspace;
        }
        if (typeof payload.autoWorkspace === 'string' && payload.autoWorkspace) {
          _autoWorkspaceResolved = payload.autoWorkspace;
        }
        if (Array.isArray(payload.knownWorkspaces)) {
          _knownWorkspacesList = payload.knownWorkspaces;
        }
      }

      const sel = document.getElementById('sel-panelWorkspace');
      if (sel) {
        const autoLabel = getWorkspaceBasename(_autoWorkspaceResolved || _activeWorkspaceResolved);
        const list = Array.isArray(_knownWorkspacesList) ? _knownWorkspacesList.slice() : [];
        if (_selectedWorkspaceMode !== '__auto__' && _selectedWorkspaceMode !== '__all__') {
          const selKey = normalizeWsClientKey(_selectedWorkspaceMode);
          const exists = list.some(function (w) { return w && normalizeWsClientKey(w.workspaceRoot) === selKey; });
          if (!exists) {
            list.unshift({
              workspaceRoot: _selectedWorkspaceMode,
              projectName: getWorkspaceBasename(_selectedWorkspaceMode) || _selectedWorkspaceMode,
              displayLabel: getWorkspaceBasename(_selectedWorkspaceMode) || _selectedWorkspaceMode,
              checkpointsCount: 0,
              status: 'idle',
            });
          }
        }

        const sigParts = [getUiLanguage(), autoLabel, _selectedWorkspaceMode];
        for (let i = 0; i < list.length; i++) {
          const w = list[i];
          sigParts.push([w.workspaceRoot, w.displayLabel || w.projectName, w.checkpointsCount || 0, w.status || ''].join(':'));
        }
        const nextSig = sigParts.join('|');
        if (sel.dataset.wsSig !== nextSig) {
          sel.dataset.wsSig = nextSig;
          sel.innerHTML = '';

          const autoOpt = document.createElement('option');
          autoOpt.value = '__auto__';
          autoOpt.dataset.name = autoLabel
            ? L('Авто (' + autoLabel + ')', 'Auto (' + autoLabel + ')')
            : L('Авто (активный чат)', 'Auto (active chat)');
          autoOpt.dataset.vram = L('Авто', 'Auto');
          autoOpt.textContent = autoOpt.dataset.name;
          sel.appendChild(autoOpt);

          for (let i = 0; i < list.length; i++) {
            const w = list[i];
            if (!w || !w.workspaceRoot) continue;
            const opt = document.createElement('option');
            opt.value = w.workspaceRoot;
            const lbl = w.displayLabel || w.projectName || getWorkspaceBasename(w.workspaceRoot);
            opt.dataset.name = lbl;
            opt.textContent = lbl;
            if (Number(w.checkpointsCount || 0) > 0) {
              opt.dataset.size = Number(w.checkpointsCount) + L(' сн.', ' snap.');
            }
            if (w.status === 'running' || w.status === 'waiting_user') {
              opt.dataset.vram = L('● В работе', '● Active');
            } else if (w.isOpenInIde) {
              opt.dataset.vram = L('● Открыт', '● Open');
            }
            sel.appendChild(opt);
          }

          const allOpt = document.createElement('option');
          allOpt.value = '__all__';
          allOpt.dataset.name = L('Все проекты (общая лента)', 'All projects (combined feed)');
          allOpt.dataset.size = L('Все', 'All');
          allOpt.textContent = allOpt.dataset.name;
          sel.appendChild(allOpt);
        }

        let matchedVal = '__auto__';
        const targetKey = normalizeWsClientKey(_selectedWorkspaceMode);
        for (let i = 0; i < sel.options.length; i++) {
          const ov = sel.options[i].value;
          if (ov === _selectedWorkspaceMode || (targetKey && _selectedWorkspaceMode !== '__auto__' && _selectedWorkspaceMode !== '__all__' && normalizeWsClientKey(ov) === targetKey)) {
            matchedVal = ov;
            break;
          }
        }
        sel.value = matchedVal;
      }
      syncWorkspaceSwitcherBadge();
    }

    async function selectPanelWorkspace(nextVal) {
      const clean = String(nextVal || '').trim() || '__auto__';
      _selectedWorkspaceMode = clean;
      try {
        localStorage.setItem(WORKSPACE_SELECT_STORAGE_KEY, clean);
      } catch {}
      _activeFallbackSidecarConvId = '';
      _activeTurnDiffPreview = null;
      _loadedPanelSections.clear();
      telemetryLastSig = '';
      if (typeof resetSentinelTransientState === 'function') resetSentinelTransientState();
      if (typeof resetGuardDockTransientState === 'function') resetGuardDockTransientState();
      _localRagHistory.length = 0;
      renderLocalRagMessages();
      const shieldBadgeEl = document.getElementById('agentShieldBadge');
      if (shieldBadgeEl) {
        shieldBadgeEl.textContent = L('Не проверено', 'Not checked');
        shieldBadgeEl.className = 'swarm-pill idle';
      }
      const shieldSumEl = document.getElementById('agentShieldSummary');
      if (shieldSumEl) {
        shieldSumEl.hidden = true;
        shieldSumEl.innerHTML = L(
          'Аудит конфигов MCP, хуков и <code>SKILL.md</code> на секреты и prompt-injection.',
          'Audits MCP configs, hooks, and <code>SKILL.md</code> for secrets and prompt injection.'
        );
      }
      const instinctsEl = document.getElementById('projectInstinctsList');
      if (instinctsEl) {
        instinctsEl.textContent = '';
        const hintDiv = document.createElement('div');
        hintDiv.textContent = L(
          'Нажмите «Обновить» для просмотра накопленных паттернов.',
          'Click "Update" to view learned patterns.'
        );
        instinctsEl.appendChild(hintDiv);
      }
      const doctorBoxEl = document.getElementById('setupDoctorBox');
      if (doctorBoxEl) {
        doctorBoxEl.style.display = 'none';
        doctorBoxEl.innerHTML = '';
      }
      const episodesBoxEl = document.getElementById('sessionEpisodesContainer');
      if (episodesBoxEl) {
        episodesBoxEl.style.display = 'none';
        episodesBoxEl.innerHTML = '';
      }
      const gatesBadgeEl = document.getElementById('gatesStatusBadge');
      if (gatesBadgeEl) {
        gatesBadgeEl.textContent = L('GATES.md: не проверен', 'GATES.md: not checked');
        gatesBadgeEl.style.color = 'var(--text-sub)';
      }
      syncWorkspaceSwitcherBadge();
      const label = clean === '__all__'
        ? L('Все проекты', 'All projects')
        : (clean === '__auto__' ? L('Авто (активный чат)', 'Auto (active chat)') : getSelectedWorkspaceDisplayName());
      flashStatus(L('Переключение на «' + label + '»...', 'Switching to "' + label + '"...'));
      await refreshAll({ silent: true });
      loadSmartComposerContext();
      const activeFullTab = document.body ? (document.body.getAttribute('data-full-tab') || 'cockpit') : 'cockpit';
      if (activeFullTab === 'memory' && typeof loadProjectInstincts === 'function') {
        loadProjectInstincts({ silent: true });
      }
      if (activeFullTab === 'bugs' && typeof refreshGatesStatus === 'function') {
        refreshGatesStatus({ silent: true });
      }
    }

    const nativeFetch = window.fetch.bind(window);
    let _exchangedSidecarToken = '';
    const _initialAuthCode = (function () {
      try {
        const sp = new URLSearchParams(window.location.search);
        const code = (sp.get('authCode') || '').trim();
        if (code && window.history && typeof window.history.replaceState === 'function') {
          sp.delete('authCode');
          const nextSearch = sp.toString();
          const nextUrl = window.location.pathname + (nextSearch ? '?' + nextSearch : '') + (window.location.hash || '');
          window.history.replaceState(null, '', nextUrl);
        }
        return code;
      } catch {
        return '';
      }
    })();
    let _authCodeExchangePromise = null;
    function ensureExchangedSidecarToken() {
      if (_exchangedSidecarToken || !_initialAuthCode) return Promise.resolve(_exchangedSidecarToken);
      if (!_authCodeExchangePromise) {
        _authCodeExchangePromise = nativeFetch('/api/project-graph/exchange-auth', {
          method: 'POST',
          headers: { 'X-Router-Panel': PANEL_AUTH_HEADER, 'Content-Type': 'application/json' },
          body: JSON.stringify({ authCode: _initialAuthCode }),
        })
          .then(function (r) { return r && r.ok ? r.json() : null; })
          .then(function (d) {
            if (d && d.ok && typeof d.token === 'string' && d.token) {
              _exchangedSidecarToken = d.token;
            }
            return _exchangedSidecarToken;
          })
          .catch(function () { return ''; });
      }
      return _authCodeExchangePromise;
    }
    if (_initialAuthCode) {
      void ensureExchangedSidecarToken();
    }

    async function panelFetch(url, options) {
      const opts = Object.assign({}, options || {});
      const abortSignal = opts.signal || null;
      let targetUrl = String(url || '');
      if (_initialAuthCode && !_exchangedSidecarToken && targetUrl !== '/api/project-graph/exchange-auth') {
        await ensureExchangedSidecarToken();
      }
      const sidecarToken = (window.sidecar && window.sidecar.token)
        || _exchangedSidecarToken
        || new URLSearchParams(window.location.search).get('token')
        || '';
      const hdrs = Object.assign({ 'X-Router-Panel': PANEL_AUTH_HEADER }, opts.headers || {});
      if (sidecarToken && !hdrs['X-Sidecar-Token'] && !hdrs['x-sidecar-token']) {
        hdrs['X-Sidecar-Token'] = sidecarToken;
      }
      if (opts.body && !hdrs['Content-Type'] && !hdrs['content-type']) {
        hdrs['Content-Type'] = 'application/json';
      }
      const openWsHeaderList = _cachedSidecarOpenWorkspaces.slice(0, 24);
      const openWsQueryList = _cachedSidecarOpenWorkspaces.slice(0, 8);
      const activeConvId = (window.sidecar && typeof window.sidecar.conversationId === 'string')
        ? window.sidecar.conversationId.trim().slice(0, 128)
        : '';
      if (
        openWsHeaderList.length > 0 &&
        !hdrs['X-Open-Workspaces'] &&
        !hdrs['x-open-workspaces'] &&
        targetUrl.indexOf('/api/') === 0
      ) {
        hdrs['X-Open-Workspaces'] = encodeURIComponent(openWsHeaderList.join('|'));
      }
      if (
        activeConvId &&
        !hdrs['X-Active-Conversation-Id'] &&
        !hdrs['x-active-conversation-id'] &&
        targetUrl.indexOf('/api/') === 0
      ) {
        hdrs['X-Active-Conversation-Id'] = activeConvId;
      }
      opts.headers = hdrs;

      if (targetUrl.indexOf('/api/') === 0) {
        const wsParam = getEffectivePanelRootParam();
        if (wsParam === '__all__') {
          if (targetUrl.indexOf('workspaceScope=') === -1) {
            targetUrl += (targetUrl.indexOf('?') === -1 ? '?workspaceScope=' : '&workspaceScope=') + 'all';
          }
        } else if (wsParam) {
          if (targetUrl.indexOf('rootDir=') === -1) {
            targetUrl += (targetUrl.indexOf('?') === -1 ? '?rootDir=' : '&rootDir=') + encodeURIComponent(wsParam);
          }
        }
        // Pass active IDE workspace URIs & conversationId in query params so SidecarApp handlers (which receive only `data`) can read them
        if (openWsQueryList.length > 0 && targetUrl.indexOf('openWorkspaces=') === -1) {
          const encodedOpenWs = encodeURIComponent(openWsQueryList.join('|'));
          if (targetUrl.length + encodedOpenWs.length < 1800) {
            targetUrl += (targetUrl.indexOf('?') === -1 ? '?openWorkspaces=' : '&openWorkspaces=') + encodedOpenWs;
          }
        }
        if (activeConvId && targetUrl.indexOf('activeConversationId=') === -1) {
          targetUrl += (targetUrl.indexOf('?') === -1 ? '?activeConversationId=' : '&activeConversationId=') + encodeURIComponent(activeConvId);
        }
      }

      if (window.sidecar && typeof window.sidecar.fetch === 'function') {
        // Strip AbortSignal before structured-clone postMessage IPC to prevent DataCloneError in webview
        delete opts.signal;
        if (abortSignal) {
          if (abortSignal.aborted) {
            const abortErr = new Error('The operation was aborted.');
            abortErr.name = 'AbortError';
            return Promise.reject(abortErr);
          }
          return new Promise(function (resolve, reject) {
            const onAbort = function () {
              const abortErr = new Error('The operation was aborted.');
              abortErr.name = 'AbortError';
              reject(abortErr);
            };
            abortSignal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(window.sidecar.fetch(targetUrl, opts)).then(
              function (val) {
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
                resolve(val);
              },
              function (err) {
                try { abortSignal.removeEventListener('abort', onAbort); } catch {}
                reject(err);
              }
            );
          });
        }
        return window.sidecar.fetch(targetUrl, opts);
      }
      if (sidecarToken && targetUrl.indexOf('/api/') === 0 && targetUrl.indexOf('token=') === -1) {
        targetUrl += (targetUrl.indexOf('?') === -1 ? '?token=' : '&token=') + encodeURIComponent(sidecarToken);
      }
      return nativeFetch(targetUrl, opts);
    }

    let currentState = {};
    let lastPayloadCache = null;
    let discoveredSkills = [];
    let currentSkillQuery = '';
    let detectedProjectInfo = null;
    let currentHardwareProfile = null;
    let currentHardwareCeilings = null;

    function setUiDesignGate(enabled) {
      updateState({ uiDesignPreviewGate: !!enabled });
    }

    function setUiInspirationMode(mode) {
      updateState({ uiInspirationMode: mode });
    }

    function setGrillMode(mode) {
      updateState({ grillMode: mode });
    }

    function setAutoSpecMode(mode) {
      updateState({ autoSpecMode: mode });
    }

    function setAutoSpecOutput(mode) {
      updateState({ autoSpecOutput: mode });
    }

    function setLeanMode(mode) {
      updateState({ leanMode: mode });
    }

    function setTerseMode(mode) {
      updateState({ terseMode: mode });
    }

    function selectCuratedSkillPreset(repo, slug) {
      const srcInp = document.getElementById('extSkillSourceInput');
      const slugInp = document.getElementById('extSkillSlugInput');
      if (srcInp) srcInp.value = String(repo || '').trim();
      if (slugInp) slugInp.value = String(slug || '').trim();
      flashStatus(L('Пресет выбран — нажмите «Проверить и импортировать»', 'Preset selected — click "Audit & import"'));
    }

    function resetAllSkillsToAuto() {
      const searchEl = document.getElementById('skillSearchInput');
      if (searchEl) searchEl.value = '';
      currentSkillQuery = '';
      updateState({
        skillModes: {},
        replaceSkillModes: true
      });
    }

    function filterSkillsView(query) {
      currentSkillQuery = String(query || '').trim().toLowerCase();
      const container = document.getElementById('skillsContainer');
      if (container && container.querySelector('.skill-item')) {
        applySkillsFilterDom();
        return;
      }
      renderSkills(discoveredSkills, currentState.skillModes);
    }

    function normalizePanelViewMode() {
      return 'full';
    }

    function applyPanelViewModeDomPreviewOnly() {
      if (document.body) {
        document.body.setAttribute('data-panel-view', 'full');
      }
      if (typeof syncSmartComposerSizeAndScroll === 'function') {
        syncSmartComposerSizeAndScroll();
      }
    }

    function normalizeUiTheme() {
      return 'glass_teal';
    }
