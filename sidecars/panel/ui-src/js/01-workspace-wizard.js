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
          'Нажмите «Инстинкты проекта» для просмотра накопленных паттернов.',
          'Click "Project Instincts" to view learned workspace patterns.'
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
    let wizAutoOpenedOnce = false;
    let wizHwLoading = false;
    let wizSubTierPreviewDirty = false;
    let wizLangPreviewDirty = false;
    let wizViewModePreviewDirty = false;
    let wizStep = 1;
    let wizDraft = {
      uiLanguage: 'en',
      panelViewMode: 'full',
      subscriptionTier: 'pro',
      useRam: true,
      ramMaxBudgetMb: 4096,
      useCpu: true,
      cpuMaxThreads: 6,
      useGpu: false,
      gpuMaxVramMb: 4096,
      gpuChatModel: 'qwen3:4b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuContextTokens: 8192,
      gpuOllamaDir: '',
      gpuModelsDir: '',
      gpuPreferHfMirror: false,
      autoInstallOllama: true,
      gpuAutoDistillLogs: false,
      gpuSemanticSearch: false,
      gpuPullMode: 'cascade',
      modePreset: 'advisor_m',
      uiDesignPreviewGate: true,
      uiInspirationMode: 'ask',
      safetyBundle: true,
      sentinelBundle: true
    };

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

    function syncWizDraftFromStateAndHardware() {
      const hw = currentHardwareProfile || {};
      const rec = (hw.recommendation && hw.recommendation.recommendedPatch) || {};
      const gpuPre = (hw.recommendation && hw.recommendation.gpuEnabledPreset) || {};
      const isFresh = currentState.onboardingCompleted === false;

      wizDraft.uiLanguage = normalizeUiLanguage(currentState.uiLanguage || 'en');
      wizDraft.panelViewMode = normalizePanelViewMode(currentState.panelViewMode || 'full');
      wizDraft.subscriptionTier = currentState.subscriptionTier === 'ultra' ? 'ultra' : 'pro';
      wizDraft.useRam = isFresh && rec.ramCacheEnabled !== undefined
        ? !!rec.ramCacheEnabled
        : currentState.ramCacheEnabled !== false;
      wizDraft.ramMaxBudgetMb = Number(
        (isFresh && rec.ramMaxBudgetMb) ? rec.ramMaxBudgetMb : (currentState.ramMaxBudgetMb || rec.ramMaxBudgetMb || 4096)
      );
      wizDraft.useCpu = isFresh && rec.cpuMulticoreEnabled !== undefined
        ? !!rec.cpuMulticoreEnabled
        : currentState.cpuMulticoreEnabled !== false;
      wizDraft.cpuMaxThreads = Number(
        (isFresh && rec.cpuMaxThreads) ? rec.cpuMaxThreads : (currentState.cpuMaxThreads || rec.cpuMaxThreads || 6)
      );
      wizDraft.useGpu = isFresh && rec.gpuEnabled !== undefined
        ? !!rec.gpuEnabled
        : Boolean(currentState.gpuEnabled);
      wizDraft.gpuMaxVramMb = Number(
        (isFresh && rec.gpuMaxVramMb) ? rec.gpuMaxVramMb : (currentState.gpuMaxVramMb || gpuPre.gpuMaxVramMb || 4096)
      );
      wizDraft.gpuChatModel = String(
        (isFresh && rec.gpuChatModel) ? rec.gpuChatModel : (currentState.gpuChatModel || gpuPre.gpuChatModel || 'gemma4:12b')
      );
      wizDraft.gpuEmbedModel = String(
        (isFresh && rec.gpuEmbedModel) ? rec.gpuEmbedModel : (currentState.gpuEmbedModel || gpuPre.gpuEmbedModel || 'qwen3-embedding:0.6b')
      );
      wizDraft.gpuContextTokens = Number(
        (isFresh && rec.gpuContextTokens) ? rec.gpuContextTokens : (currentState.gpuContextTokens || gpuPre.gpuContextTokens || 4096)
      );
      wizDraft.gpuOllamaDir = String(currentState.gpuOllamaDir || '').trim();
      wizDraft.gpuModelsDir = String(
        currentState.gpuModelsDir || (wizDraft.gpuOllamaDir ? (wizDraft.gpuOllamaDir.replace(/[\\/]+$/, '') + '\\models') : '')
      ).trim();
      wizDraft.gpuPreferHfMirror = Boolean(currentState.gpuPreferHfMirror);
      wizDraft.autoInstallOllama = true;
      wizDraft.gpuAutoDistillLogs = Boolean(
        gpuPre.gpuAutoDistillLogs !== undefined ? gpuPre.gpuAutoDistillLogs : (currentState.gpuAutoDistillLogs !== false)
      );
      wizDraft.gpuSemanticSearch = Boolean(
        gpuPre.gpuSemanticSearch !== undefined ? gpuPre.gpuSemanticSearch : (currentState.gpuSemanticSearch !== false)
      );
      wizDraft.gpuPullMode = isFresh ? 'cascade' : 'skip';
      wizDraft.uiInspirationMode = (currentState.uiInspirationMode === 'showroom' || currentState.uiInspirationMode === 'web_refs')
        ? currentState.uiInspirationMode
        : 'ask';
      wizDraft.sentinelBundle = currentState.sentinelEnabled !== false && currentState.shadowWorktreeEnabled !== false;
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

    function openOnboardingWizard(stepNum) {
      wizStep = Math.max(1, Math.min(2, Number(stepNum || 1)));
      const isFresh = currentState.onboardingCompleted === false;
      const isAdvisor = currentState.confirmBeforeRun !== false;
      if (isAdvisor) {
        wizDraft.modePreset = (!isFresh && (currentState.confirmThreshold === 'ALL' || currentState.orchestratorSmartSynergy === false))
          ? 'advisor_all'
          : 'advisor_m';
      } else if (currentState.strategy === 'flash_dispatcher') {
        wizDraft.modePreset = 'flash_economy';
      } else {
        wizDraft.modePreset = 'autopilot_balance';
      }
      wizDraft.uiDesignPreviewGate = currentState.uiDesignPreviewGate !== false;
      wizDraft.safetyBundle = currentState.shadowCheckpoints !== false && currentState.selfVerify !== false;
      syncWizDraftFromStateAndHardware();

      const launchBadge = document.getElementById('wizLaunchBadge');
      if (launchBadge) {
        launchBadge.textContent = isFresh ? L('Первый запуск', 'First Run') : L('Быстрая настройка', 'Quick Setup');
      }

      const modal = document.getElementById('onboardingWizardModal');
      if (modal) {
        if (typeof animateModalOverlayState === 'function') {
          animateModalOverlayState(modal, true, { useVisibleClass: true });
        } else {
          modal.classList.add('visible');
        }
      }
      wizSubTierPreviewDirty = false;
      wizLangPreviewDirty = false;
      wizViewModePreviewDirty = false;
      wizHwLoading = !currentHardwareProfile;
      renderWizardStep();

      if (!currentHardwareProfile) {
        const loadHwPromise = typeof ensurePanelSectionsLoaded === 'function'
          ? ensurePanelSectionsLoaded(['hw'])
          : Promise.resolve();
        loadHwPromise
          .then(async function () {
            if (!currentHardwareProfile) {
              try {
                const res = await panelFetch('/api/hardware', {
                  method: 'POST',
                  body: JSON.stringify({ action: 'scan', subscriptionTier: wizDraft.subscriptionTier })
                });
                const data = await res.json();
                if (data && data.ok && data.hardwareProfile) {
                  currentHardwareProfile = data.hardwareProfile;
                }
              } catch {}
            }
          })
          .finally(function () {
            wizHwLoading = false;
            const curModal = document.getElementById('onboardingWizardModal');
            if (curModal && curModal.classList.contains('visible')) {
              syncWizDraftFromStateAndHardware();
              renderWizardStep();
            }
          });
      }
    }

    function closeOnboardingWizard() {
      const modal = document.getElementById('onboardingWizardModal');
      if (modal) {
        if (typeof animateModalOverlayState === 'function') {
          animateModalOverlayState(modal, false, { useVisibleClass: true });
        } else {
          modal.classList.remove('visible');
        }
      }
      wizSubTierPreviewDirty = false;
      wizLangPreviewDirty = false;
      wizViewModePreviewDirty = false;
      applyPanelViewModeDomPreviewOnly(currentState.panelViewMode);
      if (typeof applyUiLanguageDom === 'function') {
        applyUiLanguageDom(currentState.uiLanguage);
      }
      if (typeof applySubscriptionTierDom === 'function') {
        applySubscriptionTierDom(currentState.subscriptionTier === 'ultra' ? 'ultra' : 'pro');
      }
      if (currentState.onboardingCompleted === false) {
        void updateState({ onboardingCompleted: true, hardwareProfiled: true });
        flashStatus(L(
          'Стартовая настройка отложена · Открыть снова можно кнопкой «Настройка»',
          'First-run setup postponed · Reopen anytime via the "Setup" button'
        ));
      }
    }

    function wizGoStep(s) {
      wizStep = Math.max(1, Math.min(2, Number(s || 1)));
      renderWizardStep();
    }

    function wizPrevStep() {
      if (wizStep > 1) {
        wizStep -= 1;
        renderWizardStep();
      } else {
        closeOnboardingWizard();
      }
    }

    function wizNextStep() {
      if (wizStep < 2) {
        wizStep += 1;
        renderWizardStep();
      } else {
        void finishOnboardingWizard();
      }
    }

    function wizSelectMode(presetKey) {
      wizDraft.modePreset = presetKey;
      renderWizardStep();
    }

    function wizSetDesignGate(val) {
      wizDraft.uiDesignPreviewGate = !!val;
      renderWizardStep();
    }

    function wizSetInspirationMode(mode) {
      wizDraft.uiInspirationMode = (mode === 'showroom' || mode === 'web_refs') ? mode : 'ask';
      renderWizardStep();
    }

    function wizSetSubTier(tier) {
      wizDraft.subscriptionTier = tier === 'ultra' ? 'ultra' : 'pro';
      wizSubTierPreviewDirty = true;
      if (typeof applySubscriptionTierDom === 'function') {
        applySubscriptionTierDom(wizDraft.subscriptionTier);
      }
      if (wizDraft.subscriptionTier === 'pro' && wizDraft.modePreset === 'autopilot_balance') {
        wizDraft.modePreset = 'advisor_m';
      }
      renderWizardStep();
    }

    function normalizeUiTheme() {
      return 'glass_teal';
    }

    function wizSetLanguage(lang) {
      const valid = normalizeUiLanguage(lang);
      wizDraft.uiLanguage = valid;
      wizLangPreviewDirty = true;
      if (typeof applyUiLanguageDom === 'function') {
        applyUiLanguageDom(valid);
      }
      const launchBadge = document.getElementById('wizLaunchBadge');
      if (launchBadge) {
        const isFresh = currentState.onboardingCompleted === false;
        launchBadge.textContent = isFresh ? L('Первый запуск', 'First Run') : L('Быстрая настройка', 'Quick Setup');
      }
      renderWizardStep();
    }

    function wizSetViewMode(mode) {
      const valid = normalizePanelViewMode(mode);
      wizDraft.panelViewMode = valid;
      wizViewModePreviewDirty = true;
      applyPanelViewModeDomPreviewOnly(valid);
      renderWizardStep();
    }

    async function wizRescanHw() {
      try {
        flashStatus(L('Сканирование процессора, ОЗУ и видеокарты...', 'Scanning CPU, RAM, and GPU...'));
        const res = await panelFetch('/api/hardware', {
          method: 'POST',
          body: JSON.stringify({ action: 'scan', subscriptionTier: wizDraft.subscriptionTier })
        });
        const data = await res.json();
        if (data && data.ok && data.hardwareProfile) {
          currentHardwareProfile = data.hardwareProfile;
          const rec = (data.hardwareProfile.recommendation && data.hardwareProfile.recommendation.recommendedPatch) || {};
          const gpuPre = (data.hardwareProfile.recommendation && data.hardwareProfile.recommendation.gpuEnabledPreset) || {};
          wizDraft.useRam = rec.ramCacheEnabled !== false;
          wizDraft.ramMaxBudgetMb = Number(rec.ramMaxBudgetMb || 4096);
          wizDraft.useCpu = rec.cpuMulticoreEnabled !== false;
          wizDraft.cpuMaxThreads = Number(rec.cpuMaxThreads || 6);
          wizDraft.useGpu = Boolean(rec.gpuEnabled);
          wizDraft.gpuMaxVramMb = Number(rec.gpuMaxVramMb || gpuPre.gpuMaxVramMb || 4096);
          wizDraft.gpuChatModel = String(rec.gpuChatModel || gpuPre.gpuChatModel || 'gemma4:12b');
          wizDraft.gpuEmbedModel = String(rec.gpuEmbedModel || gpuPre.gpuEmbedModel || 'qwen3-embedding:0.6b');
          wizDraft.gpuContextTokens = Number(rec.gpuContextTokens || gpuPre.gpuContextTokens || 4096);
          wizDraft.gpuAutoDistillLogs = Boolean(gpuPre.gpuAutoDistillLogs);
          wizDraft.gpuSemanticSearch = Boolean(gpuPre.gpuSemanticSearch);
          renderWizardStep();
          flashStatus(L('Система просканирована · Подобраны оптимальные лимиты ✓', 'System scanned · Optimal limits applied ✓'));
        }
      } catch (e) {
        flashStatus(L('Ошибка сканирования системы', 'System scan error'));
      }
    }

    function wizToggleFlag(flagKey) {
      wizDraft[flagKey] = !wizDraft[flagKey];
      if (flagKey === 'useGpu' && wizDraft.useGpu && currentHardwareProfile && currentHardwareProfile.recommendation) {
        const gpuPre = currentHardwareProfile.recommendation.gpuEnabledPreset || {};
        if (gpuPre.gpuMaxVramMb) wizDraft.gpuMaxVramMb = gpuPre.gpuMaxVramMb;
        if (gpuPre.gpuChatModel) wizDraft.gpuChatModel = gpuPre.gpuChatModel;
        if (gpuPre.gpuEmbedModel) wizDraft.gpuEmbedModel = gpuPre.gpuEmbedModel;
        if (gpuPre.gpuContextTokens) wizDraft.gpuContextTokens = gpuPre.gpuContextTokens;
        wizDraft.gpuAutoDistillLogs = Boolean(gpuPre.gpuAutoDistillLogs);
        wizDraft.gpuSemanticSearch = Boolean(gpuPre.gpuSemanticSearch !== false);
        if (wizDraft.gpuPullMode === 'skip') wizDraft.gpuPullMode = 'cascade';
      }
      renderWizardStep();
    }

    function wizSetGpuPullMode(mode) {
      wizDraft.gpuPullMode = (mode === 'active_only' || mode === 'skip') ? mode : 'cascade';
      renderWizardStep();
    }

    function renderWizardStep() {
      [1, 2].forEach((i) => {
        const p = document.getElementById('wizPill' + i);
        if (p) p.classList.toggle('active', i === wizStep);
      });
      const backBtn = document.getElementById('wizBackBtn');
      const quickSaveBtn = document.getElementById('wizQuickSaveBtn');
      const nextBtn = document.getElementById('wizNextBtn');
      const hintEl = document.getElementById('wizStepHint');
      const bodyEl = document.getElementById('wizBodyContent');
      if (!bodyEl) return;

      if (backBtn) backBtn.textContent = wizStep === 1 ? L('Позже', 'Later') : L('← Назад', '← Back');
      if (nextBtn) nextBtn.textContent = wizStep === 2 ? L('✓ Сохранить и начать', '✓ Save & Start') : L('Далее →', 'Next →');
      if (quickSaveBtn) {
        const showQuickSave = wizStep === 1 && currentState.onboardingCompleted !== false;
        quickSaveBtn.style.display = showQuickSave ? 'inline-flex' : 'none';
        quickSaveBtn.textContent = L('✓ Сохранить', '✓ Save');
      }

      if (wizStep === 1) {
        if (hintEl) hintEl.textContent = L('Шаг 1 из 2 · Язык, тариф и ПК', 'Step 1 of 2 · Language, tier & PC');
        const hw = currentHardwareProfile || {};
        const sys = hw.system || {};
        const gpu = hw.gpu || {};
        const oll = hw.ollama || {};
        const recInfo = hw.recommendation || {};
        const isScanning = wizHwLoading && !sys.cpuModel && !sys.totalRamMb;
        const rawCpu = sys.cpuModel ? sys.cpuModel.replace(/\(R\)|\(TM\)|Processor|CPU/gi, '').trim() : '';
        const shortCpu = rawCpu ? rawCpu.replace(/^(?:AMD|Intel)\s+/i, '') : '';
        const cpuText = isScanning
          ? L('Сканируем...', 'Scanning...')
          : (shortCpu
              ? (shortCpu + ' · ' + (sys.logicalCores || 4) + L(' п.', ' thr.'))
              : L('Авто CPU', 'Auto CPU'));
        const ramGb = sys.totalRamGb || Math.round((sys.totalRamMb || 8192) / 1024);
        const recRamGb = Math.max(1, Math.round((wizDraft.ramMaxBudgetMb || 4096) / 1024));
        const ramText = isScanning
          ? L('ОЗУ...', 'RAM...')
          : (ramGb + L(' ГБ · кэш ', ' GB · ') + recRamGb + L(' ГБ', ' GB'));
        const gpuFull = gpu.name || L('Встроенная графика / CPU', 'Integrated GPU / CPU');
        const gpuShort = gpuFull.replace(/^NVIDIA\s+GeForce\s+/i, '').replace(/^AMD\s+Radeon\s+/i, '');
        const gpuVramText = gpu.totalMb > 0 ? (' · ' + Math.round(gpu.totalMb / 1024) + L(' ГБ', ' GB')) : '';
        const gpuTileText = isScanning ? L('GPU...', 'GPU...') : (gpuShort + gpuVramText);
        const ollStatus = isScanning
          ? L('Проверка...', 'Checking...')
          : (oll.running ? L('Запущена', 'Running') : (oll.installed ? L('Установлена', 'Installed') : L('Не найдена', 'Not found')));
        const passportTip = isScanning
          ? L('Считываем характеристики ПК для безопасного расчёта потоков и памяти', 'Reading hardware specs to calculate safe thread and memory budgets')
          : (isRu()
              ? (recInfo.vendorTipRu || 'Лимиты автоматически адаптированы под ваш компьютер без риска зависаний.')
              : (recInfo.vendorTipEn || 'Limits are automatically calibrated for your machine to prevent freezes.'));
        const sub = wizDraft.subscriptionTier;
        const lang = normalizeUiLanguage(wizDraft.uiLanguage || getUiLanguage());

        bodyEl.innerHTML =
          '<div class="wiz-top-split">' +
            '<div class="wiz-seg-col">' +
              '<div class="wiz-sec-head">' + L('Язык / Language', 'Language') + '</div>' +
              '<div class="wiz-seg-group">' +
                '<button type="button" class="wiz-seg-chip' + (lang === 'en' ? ' selected' : '') + '" data-action="wizSetLanguage" data-arg="en" title="English panel UI, setup wizard, hooks and AI replies.">English</button>' +
                '<button type="button" class="wiz-seg-chip' + (lang === 'ru' ? ' selected' : '') + '" data-action="wizSetLanguage" data-arg="ru" title="Русский интерфейс пульта, мастера, хуков и ответов ИИ.">Русский</button>' +
              '</div>' +
            '</div>' +
            '<div class="wiz-seg-col">' +
              '<div class="wiz-sec-head">' + L('Подписка', 'Subscription') + '</div>' +
              '<div class="wiz-seg-group">' +
                '<button type="button" class="wiz-seg-chip' + (sub === 'pro' ? ' selected' : '') + '" data-action="wizSetSubTier" data-arg="pro" title="' + escHtml(L('Hydrogen на S/M и Orchestrator (Neon) на L/XL. Недоступные на Pro модели Ultra (Carbon) скрыты.', 'Hydrogen on S/M and Orchestrator (Neon) on L/XL. Ultra-only models (Carbon) are hidden.')) + '">Pro <span class="wiz-chip-tag">' + L('квота', 'quota') + '</span></button>' +
                '<button type="button" class="wiz-seg-chip' + (sub === 'ultra' ? ' selected' : '') + '" data-action="wizSetSubTier" data-arg="ultra" title="' + escHtml(L('Полная версия: Orchestrator (Carbon/Neon), расширенные воркеры Роя и повышенный лимит квот.', 'Full features: Orchestrator (Carbon/Neon), extended Swarm workers and higher quota limits.')) + '">Ultra <span class="wiz-chip-tag is-ok">' + L('макс.', 'max') + '</span></button>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="hw-passport-card is-compact" title="' + escHtml(passportTip) + '">' +
            '<div class="wiz-passport-head">' +
              '<span class="wiz-passport-title">' + L('Паспорт ПК', 'PC Passport') + '</span>' +
              '<div class="wiz-passport-actions">' +
                '<button type="button" class="win-btn wiz-mini-action" data-action="sendHardwareTunePrompt" title="' + escHtml(L('Собрать промпт по моему железу и подобрать самые свежие модели в чате', 'Generate hardware passport & pick latest local models in chat')) + '">' + L('Подбор в чате', 'AI Tune') + '</button>' +
                '<button type="button" class="win-btn wiz-mini-action" data-action="wizRescanHw" title="' + escHtml(L('Пересканировать процессор, ОЗУ, GPU и Ollama', 'Rescan CPU, RAM, GPU & Ollama')) + '">' + L('↻ ПК', '↻ Scan') + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="hw-spec-grid is-compact">' +
              '<div class="hw-spec-tile"><div class="hw-spec-k">CPU</div><div class="hw-spec-v" title="' + escHtml(sys.cpuModel || cpuText) + '">' + escHtml(cpuText) + '</div></div>' +
              '<div class="hw-spec-tile"><div class="hw-spec-k">RAM</div><div class="hw-spec-v" title="' + escHtml(ramText) + '">' + escHtml(ramText) + '</div></div>' +
              '<div class="hw-spec-tile"><div class="hw-spec-k">GPU (' + escHtml((gpu.vendor || 'cpu').toUpperCase()) + ')</div><div class="hw-spec-v" title="' + escHtml(gpuFull + gpuVramText) + '">' + escHtml(gpuTileText) + '</div></div>' +
              '<div class="hw-spec-tile"><div class="hw-spec-k">Ollama</div><div class="hw-spec-v">' + ollStatus + '</div></div>' +
            '</div>' +
          '</div>' +

          '<div class="wiz-sec-head">' + L('Локальное ускорение (0 облачных токенов)', 'Local Acceleration (0 cloud tokens)') + '</div>' +
          '<div class="wiz-res-grid">' +
            '<button type="button" class="wiz-compact-card' + (wizDraft.useRam ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="useRam" title="' + escHtml(L('Мгновенно выдаёт ИИ точные срезы строк за <1 мс без повторного чтения файлов с диска.', 'Delivers exact code slices to AI in <1 ms without re-reading full files from disk.')) + '">' +
              '<div class="wiz-compact-head"><span>' + (wizDraft.useRam ? '✓ ' : '') + L('In-RAM кэш', 'In-RAM Cache') + '</span><span class="wiz-chip-tag' + (wizDraft.useRam ? ' is-ok' : '') + '">' + (wizDraft.useRam ? (recRamGb + L(' ГБ', ' GB')) : L('ВЫКЛ', 'OFF')) + '</span></div>' +
              '<div class="wiz-compact-sub">' + L('Срезы кода <1 мс', 'Code slices <1 ms') + '</div>' +
            '</button>' +
            '<button type="button" class="wiz-compact-card' + (wizDraft.useCpu ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="useCpu" title="' + escHtml(L('Локальный триграммный индекс и быстрая фоновая проверка синтаксиса на ядрах CPU (спит в простое).', 'Local trigram search index and fast background syntax verification on CPU cores (sleeps when idle).')) + '">' +
              '<div class="wiz-compact-head"><span>' + (wizDraft.useCpu ? '✓ ' : '') + L('CPU-пул', 'CPU Pool') + '</span><span class="wiz-chip-tag' + (wizDraft.useCpu ? ' is-ok' : '') + '">' + (wizDraft.useCpu ? (wizDraft.cpuMaxThreads + L(' пот.', ' thr.')) : L('1 пот.', '1 thr.')) + '</span></div>' +
              '<div class="wiz-compact-sub">' + L('Индекс и синтаксис', 'Index & syntax') + '</div>' +
            '</button>' +
            '<button type="button" class="wiz-compact-card' + (wizDraft.useGpu ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="useGpu" title="' + escHtml(L('Бесплатное сжатие больших логов, умное автодополнение в Композере и смысловой поиск через Ollama.', 'Free distillation of huge logs, smart Composer autocomplete and semantic search via Ollama.')) + '">' +
              '<div class="wiz-compact-head"><span>' + (wizDraft.useGpu ? '✓ ' : '') + 'GPU · Ollama</span><span class="wiz-chip-tag' + (wizDraft.useGpu ? ' is-ok' : '') + '">' + (wizDraft.useGpu ? escHtml(wizDraft.gpuChatModel) : L('ВЫКЛ', 'OFF')) + '</span></div>' +
              '<div class="wiz-compact-sub">' + L('Логи и умный поиск', 'Logs & search') + '</div>' +
            '</button>' +
          '</div>' +

          (wizDraft.useGpu
            ? (function () {
                const cb = recInfo.cascadeBundle || {};
                const allModels = Array.isArray(cb.models) ? cb.models : [];
                const namesList = allModels.length > 0
                  ? allModels.map(function (m) { return (m.alreadyDownloaded ? '✓ ' : '↓ ') + m.name; }).join(', ')
                  : (wizDraft.gpuChatModel + ', ' + wizDraft.gpuEmbedModel);
                const missingGbTxt = Number(cb.approxMissingDiskGb || 0) > 0
                  ? (' · ~' + Number(cb.approxMissingDiskGb).toFixed(1) + L(' ГБ к загрузке', ' GB to download'))
                  : L(' · ✓ скачаны', ' · ✓ ready');
                const pm = wizDraft.gpuPullMode || 'cascade';
                const joinWizModelsSubdir = function (baseDir) {
                  const clean = String(baseDir || '').trim().replace(/[\\/]+$/, '');
                  return clean ? (clean + (clean.indexOf('/') !== -1 && clean.indexOf('\\') === -1 ? '/models' : '\\models')) : '';
                };
                const effectiveDir = String(wizDraft.gpuOllamaDir || '').trim();
                const derivedModelsDir = String(wizDraft.gpuModelsDir || joinWizModelsSubdir(effectiveDir) || '').trim();
                const ollNeedsInstall = !isScanning && !oll.installed && !oll.running;
                const advOpen = Boolean(effectiveDir || wizDraft.gpuPreferHfMirror);
                const dirHintLine = effectiveDir
                  ? ('<div class="wiz-dir-hint">' + L('Модели: ', 'Models: ') + '<code>' + escHtml(derivedModelsDir) + '</code></div>')
                  : '<div class="wiz-dir-hint">' + L('По умолчанию: ~/.ollama (можно оставить пустым)', 'Default: ~/.ollama (optional)') + '</div>';
                const ollInstallBlock = ollNeedsInstall
                  ? '<label class="wiz-mini-check-row" data-action="wizToggleFlag" data-arg="autoInstallOllama" title="' + escHtml(L('Скачает и установит Ollama после завершения мастера, затем сразу начнёт загрузку моделей.', 'Downloads and installs Ollama on finish, then immediately starts model downloads.')) + '">' +
                      '<input type="checkbox"' + (wizDraft.autoInstallOllama !== false ? ' checked' : '') + ' tabindex="-1" style="pointer-events:none;" />' +
                      '<span>' + L('Установить Ollama автоматически', 'Auto-install Ollama') + '</span>' +
                    '</label>'
                  : '';
                return '<div class="wiz-gpu-cascade-box is-compact">' +
                  '<div class="wiz-gpu-line" title="' + escHtml(namesList) + '">' +
                    '<strong>' + escHtml(wizDraft.gpuChatModel + ' + ' + wizDraft.gpuEmbedModel) + '</strong>' +
                    '<span class="wiz-gpu-meta">' + escHtml(missingGbTxt) + '</span>' +
                  '</div>' +
                  '<div class="wiz-gpu-cascade-pills">' +
                    '<button type="button" class="wiz-gpu-cascade-pill' + (pm === 'cascade' ? ' selected' : '') + '" data-action="wizSetGpuPullMode" data-arg="cascade">' + L('↓ Весь каскад', '↓ Full cascade') + '</button>' +
                    '<button type="button" class="wiz-gpu-cascade-pill' + (pm === 'active_only' ? ' selected' : '') + '" data-action="wizSetGpuPullMode" data-arg="active_only">' + L('Текущий лимит', 'Active limit') + '</button>' +
                    '<button type="button" class="wiz-gpu-cascade-pill' + (pm === 'skip' ? ' selected' : '') + '" data-action="wizSetGpuPullMode" data-arg="skip">' + L('Пропустить', 'Skip') + '</button>' +
                  '</div>' +
                  ollInstallBlock +
                  '<details class="wiz-adv-details"' + (advOpen ? ' open' : '') + '>' +
                    '<summary>' + L('Папка моделей и зеркало HF', 'Models folder & HF mirror') + '</summary>' +
                    '<div class="wiz-adv-body">' +
                      '<div class="wiz-dir-row">' +
                        '<input type="text" id="wizGpuInstallDir" class="lg-input" data-input-action="wizSetGpuInstallDir" value="' + escHtml(effectiveDir) + '" placeholder="' + escHtml(L('По умолчанию (AppData / ~/.ollama)', 'Default (AppData / ~/.ollama)')) + '" />' +
                        '<button type="button" class="win-btn wiz-dir-pick-btn" id="wizBtnPickGpuDir" data-action="wizPickGpuInstallDir">' + L('Выбрать…', 'Browse…') + '</button>' +
                      '</div>' +
                      dirHintLine +
                      '<label class="wiz-mini-check-row" data-action="wizToggleFlag" data-arg="gpuPreferHfMirror">' +
                        '<input type="checkbox"' + (wizDraft.gpuPreferHfMirror ? ' checked' : '') + ' tabindex="-1" style="pointer-events:none;" />' +
                        '<span>' + L('Зеркало Hugging Face (GGUF с hf.co)', 'Hugging Face mirror (GGUF from hf.co)') + '</span>' +
                      '</label>' +
                    '</div>' +
                  '</details>' +
                '</div>';
              })()
            : '');
      } else {
        if (hintEl) hintEl.textContent = L('Шаг 2 из 2 · Поведение и защита', 'Step 2 of 2 · Workflow & safety');
        const m = wizDraft.modePreset;
        const g = wizDraft.uiDesignPreviewGate;
        const insp = wizDraft.uiInspirationMode || 'ask';
        const sf = wizDraft.safetyBundle;
        const sn = wizDraft.sentinelBundle !== false;
        const modeLabelMap = {
          advisor_m: L('Советник M+', 'Advisor M+'),
          advisor_all: L('Строгий контроль', 'Strict Control'),
          autopilot_balance: L('Автопилот', 'Autopilot'),
          flash_economy: L('Эконом', 'Economy')
        };
        const recRamGb = Math.max(1, Math.round((wizDraft.ramMaxBudgetMb || 4096) / 1024));
        const hwSummary = (wizDraft.useRam ? ('RAM ' + recRamGb + L(' ГБ', ' GB')) : L('RAM выкл', 'RAM off'))
          + ' · ' + (wizDraft.useCpu ? ('CPU ' + wizDraft.cpuMaxThreads + L(' пот.', ' thr.')) : L('CPU 1 п.', 'CPU 1 thr.'))
          + ' · ' + (wizDraft.useGpu ? ('GPU ' + wizDraft.gpuChatModel) : L('без GPU', 'no GPU'));
        const langSummary = normalizeUiLanguage(wizDraft.uiLanguage) === 'ru' ? 'Русский' : 'English';

        bodyEl.innerHTML =
          '<div class="wiz-sec-head" style="margin-top:0;">' + L('Уровень контроля ИИ', 'AI Control Level') + '</div>' +
          '<div class="wiz-mode-grid">' +
            '<button type="button" class="wiz-compact-card' + (m === 'advisor_m' ? ' selected' : '') + '" data-action="wizSelectMode" data-arg="advisor_m" title="' + escHtml(L('Мелкие правки (S) делает сразу, а перед заметными задачами (M/L/XL) кратко показывает план, рекомендуемую модель и спрашивает «Запускаем?».', 'Executes small S edits right away; for medium/large tasks (M/L/XL) shows a brief plan, recommended model and asks "Proceed?".')) + '">' +
              '<div class="wiz-compact-head"><span>' + L('Умный советник', 'Smart Advisor') + '</span><span class="wiz-chip-tag is-ok">M+</span></div>' +
              '<div class="wiz-compact-sub">' + L('Мелочи сразу, план от M+', 'S fast, confirm M+') + '</div>' +
            '</button>' +
            '<button type="button" class="wiz-compact-card' + (m === 'advisor_all' ? ' selected' : '') + '" data-action="wizSelectMode" data-arg="advisor_all" title="' + escHtml(L('Перед любым изменением кода (даже небольшим S) сначала показывает объём, затронутые файлы и ждёт вашего подтверждения.', 'Before any code edit (even small S), always shows scope, affected files and waits for your approval.')) + '">' +
              '<div class="wiz-compact-head"><span>' + L('Строгий контроль', 'Strict Control') + '</span><span class="wiz-chip-tag">' + L('Все', 'All') + '</span></div>' +
              '<div class="wiz-compact-sub">' + L('Одобрять любую правку', 'Confirm every edit') + '</div>' +
            '</button>' +
            '<button type="button" class="wiz-compact-card' + (m === 'autopilot_balance' ? ' selected' : '') + '" data-action="wizSelectMode" data-arg="autopilot_balance" title="' + escHtml(L('Не переспрашивает план перед рутиной — сам находит нужные модули, вносит правки и запускает самопроверку.', 'Skips confirmation prompts — scouts modules, applies edits and runs self-verification automatically.')) + '">' +
              '<div class="wiz-compact-head"><span>' + L('Полный автопилот', 'Full Autopilot') + '</span><span class="wiz-chip-tag">' + L('Авто', 'Auto') + '</span></div>' +
              '<div class="wiz-compact-sub">' + L('В код без пауз', 'Run without prompts') + '</div>' +
            '</button>' +
            '<button type="button" class="wiz-compact-card' + (m === 'flash_economy' ? ' selected' : '') + '" data-action="wizSelectMode" data-arg="flash_economy" title="' + escHtml(L('Выполняет рутину на быстрой модели Hydrogen / Flash, советуя старшие модели только для самых сложных архитектурных задач XL.', 'Handles routine work on fast Hydrogen / Flash, recommending heavier models only for complex XL architecture tasks.')) + '">' +
              '<div class="wiz-compact-head"><span>' + L('Экономный', 'Economy') + '</span><span class="wiz-chip-tag">-80%</span></div>' +
              '<div class="wiz-compact-sub">' + L('Максимум на Hydrogen', 'Routine on Hydrogen') + '</div>' +
            '</button>' +
          '</div>' +

          '<div class="wiz-sec-head">' + L('Вёрстка и дизайн UI', 'UI Design Workflow') + '</div>' +
          '<div class="wiz-two-col">' +
            '<button type="button" class="wiz-compact-card' + (g ? ' selected' : '') + '" data-action="wizSetDesignGate" data-arg="true" title="' + escHtml(L('Защищает от шаблонных ИИ-интерфейсов: сначала уточнит направление или покажет интерактивную витрину A/B/C.', 'Prevents generic AI UI: clarifies visual direction or builds an interactive A/B/C showroom first.')) + '">' +
              '<div class="wiz-compact-head"><span>' + L('Превью перед вёрсткой', 'Preview before UI code') + '</span><span class="wiz-chip-tag is-ok">A/B/C</span></div>' +
              '<div class="wiz-compact-sub">' + L('Защита от шаблонов', 'Anti-template check') + '</div>' +
            '</button>' +
            '<button type="button" class="wiz-compact-card' + (!g ? ' selected' : '') + '" data-action="wizSetDesignGate" data-arg="false" title="' + escHtml(L('ИИ сам подберёт гармоничную палитру под ваш проект и сразу обновит вёрстку без лишних вопросов.', 'AI picks a cohesive palette matching your project and updates layout right away without extra prompts.')) + '">' +
              '<div class="wiz-compact-head"><span>' + L('Сразу в код', 'Direct to code') + '</span><span class="wiz-chip-tag">' + L('Быстро', 'Fast') + '</span></div>' +
              '<div class="wiz-compact-sub">' + L('Без превью-витрины', 'Skip UI preview') + '</div>' +
            '</button>' +
          '</div>' +
          (g
            ? '<div class="wiz-sub-pills">' +
                '<span class="wiz-sub-label">' + L('Источник идей:', 'Refs:') + '</span>' +
                '<div class="wiz-gpu-cascade-pills" style="margin-top:0;">' +
                  '<button type="button" class="wiz-gpu-cascade-pill' + (insp === 'ask' ? ' selected' : '') + '" data-action="wizSetInspirationMode" data-arg="ask">' + L('По задаче', 'Ask') + '</button>' +
                  '<button type="button" class="wiz-gpu-cascade-pill' + (insp === 'showroom' ? ' selected' : '') + '" data-action="wizSetInspirationMode" data-arg="showroom">' + L('Витрина A/B/C', 'A/B/C Showroom') + '</button>' +
                  '<button type="button" class="wiz-gpu-cascade-pill' + (insp === 'web_refs' ? ' selected' : '') + '" data-action="wizSetInspirationMode" data-arg="web_refs">' + L('Веб-рефы', 'Web Refs') + '</button>' +
                '</div>' +
              '</div>'
            : '') +

          '<div class="wiz-sec-head">' + L('Страховка кода', 'Code Safety') + '</div>' +
          '<div class="wiz-two-col">' +
            '<button type="button" class="wiz-compact-card' + (sf ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="safetyBundle" title="' + escHtml(L('Сохраняет резервную копию файла перед каждой правкой (откат в 1 клик) и проверяет затронутые тесты и синтаксис.', 'Saves a backup before every edit (1-click rollback) and automatically verifies syntax and impacted tests.')) + '">' +
              '<div class="wiz-compact-head"><span>' + (sf ? '✓ ' : '') + L('Бэкапы и проверка', 'Snapshots & Verify') + '</span><span class="wiz-chip-tag' + (sf ? ' is-ok' : '') + '">' + (sf ? L('ВКЛ', 'ON') : L('ВЫКЛ', 'OFF')) + '</span></div>' +
              '<div class="wiz-compact-sub">' + L('Откат в 1 клик + тесты', '1-click rollback + tests') + '</div>' +
            '</button>' +
            '<button type="button" class="wiz-compact-card' + (sn ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="sentinelBundle" title="' + escHtml(L('В простое тихо проверяет изменённые файлы на скрытые ошибки и позволяет изолировать рискованные эксперименты.', 'Silently checks edited files during idle pauses for hidden bugs and lets you isolate risky experiments.')) + '">' +
              '<div class="wiz-compact-head"><span>' + (sn ? '✓ ' : '') + L('Дозор и песочницы', 'Sentinel & Sandboxes') + '</span><span class="wiz-chip-tag' + (sn ? ' is-ok' : '') + '">' + (sn ? L('ВКЛ', 'ON') : L('ВЫКЛ', 'OFF')) + '</span></div>' +
              '<div class="wiz-compact-sub">' + L('Фоновый поиск багов', 'Idle bug & git guard') + '</div>' +
            '</button>' +
          '</div>' +

          '<div class="wiz-summary-strip" title="' + escHtml(L('Все навыки ИИ (скиллы) работают в режиме «Умный Авто» и подключаются под вашу задачу.', 'All AI skills run in "Smart Auto" mode and activate when relevant.')) + '">' +
            '<span class="wiz-sum-pill">' + langSummary + ' · ' + (wizDraft.subscriptionTier === 'ultra' ? 'Ultra' : 'Pro') + '</span>' +
            '<span class="wiz-sum-pill">' + escHtml(modeLabelMap[wizDraft.modePreset] || L('Советник M+', 'Advisor M+')) + '</span>' +
            '<span class="wiz-sum-pill">' + escHtml(hwSummary) + '</span>' +
            '<span class="wiz-sum-pill is-accent">' + L('Навыки: Авто', 'Skills: Auto') + '</span>' +
          '</div>';
      }
      if (bodyEl && bodyEl.classList) {
        bodyEl.classList.remove('is-step-enter');
        if (typeof bodyEl.offsetWidth === 'number') void bodyEl.offsetWidth;
        bodyEl.classList.add('is-step-enter');
      }
    }

    function wizSetGpuInstallDir(val) {
      const clean = String(val || '').trim();
      wizDraft.gpuOllamaDir = clean;
      if (clean) {
        const sep = clean.indexOf('/') !== -1 && clean.indexOf('\\') === -1 ? '/' : '\\';
        wizDraft.gpuModelsDir = clean.replace(/[\\/]+$/, '') + sep + 'models';
      } else {
        wizDraft.gpuModelsDir = '';
      }
    }

    async function wizPickGpuInstallDir() {
      const btn = document.getElementById('wizBtnPickGpuDir');
      if (btn) btn.disabled = true;
      try {
        flashStatus(L('Открываем выбор папки для Ollama и моделей…', 'Opening folder picker for Ollama and models…'));
        const res = await panelFetch('/api/gpu/pick-folder', {
          method: 'POST',
          body: JSON.stringify({ mode: 'ollama', initialDir: wizDraft.gpuOllamaDir || '' }),
        });
        const data = await res.json();
        if (!data || !data.ok) {
          flashStatus((data && data.error) || L('Не удалось выбрать папку', 'Failed to pick folder'));
          return;
        }
        const chosen = data.dir || data.workspaceRoot || '';
        if (data.cancelled || !chosen) return;
        wizSetGpuInstallDir(chosen);
        renderWizardStep();
        flashStatus(L('Папка установки выбрана ✓', 'Installation folder selected ✓'));
      } catch {
        flashStatus(L('Ошибка диалога выбора папки', 'Folder picker error'));
      } finally {
        const b2 = document.getElementById('wizBtnPickGpuDir');
        if (b2) b2.disabled = false;
      }
    }

    async function finishOnboardingWizard() {
      const subTier = wizDraft.subscriptionTier === 'ultra' ? 'ultra' : 'pro';
      const chosenLang = normalizeUiLanguage(wizDraft.uiLanguage || getUiLanguage());
      const chosenViewMode = normalizePanelViewMode(wizDraft.panelViewMode || currentState.panelViewMode);
      const gpuInstallDirClean = String(wizDraft.gpuOllamaDir || '').trim();
      const gpuModelsDirClean = String(
        wizDraft.gpuModelsDir || (gpuInstallDirClean ? (gpuInstallDirClean.replace(/[\\/]+$/, '') + '\\models') : '')
      ).trim();
      const patch = {
        onboardingCompleted: true,
        hardwareProfiled: true,
        uiLanguage: chosenLang,
        panelViewMode: chosenViewMode,
        subscriptionTier: subTier,
        swarmWorkerTier: subTier === 'ultra' ? 'neon_auto' : 'hydrogen_auto',
        panelTheme: 'glass_teal',
        ramCacheEnabled: !!wizDraft.useRam,
        ramMaxBudgetMb: Number(wizDraft.ramMaxBudgetMb || 4096),
        cpuMulticoreEnabled: !!wizDraft.useCpu,
        cpuMaxThreads: Number(wizDraft.cpuMaxThreads || 6),
        gpuEnabled: !!wizDraft.useGpu,
        gpuMaxVramMb: Number(wizDraft.gpuMaxVramMb || 4096),
        gpuChatModel: String(wizDraft.gpuChatModel || 'gemma4:12b'),
        gpuEmbedModel: String(wizDraft.gpuEmbedModel || 'qwen3-embedding:0.6b'),
        gpuContextTokens: Number(wizDraft.gpuContextTokens || 4096),
        gpuOllamaDir: gpuInstallDirClean,
        gpuModelsDir: gpuModelsDirClean,
        gpuPreferHfMirror: Boolean(wizDraft.gpuPreferHfMirror),
        gpuAutoDistillLogs: wizDraft.useGpu ? !!wizDraft.gpuAutoDistillLogs : false,
        gpuSemanticSearch: wizDraft.useGpu ? !!wizDraft.gpuSemanticSearch : false,
        uiDesignPreviewGate: !!wizDraft.uiDesignPreviewGate,
        uiInspirationMode: (wizDraft.uiInspirationMode === 'showroom' || wizDraft.uiInspirationMode === 'web_refs')
          ? wizDraft.uiInspirationMode
          : 'ask',
        shadowCheckpoints: !!wizDraft.safetyBundle,
        selfVerify: !!wizDraft.safetyBundle,
        testImpactVerify: !!wizDraft.safetyBundle,
        sentinelEnabled: wizDraft.sentinelBundle !== false,
        shadowWorktreeEnabled: wizDraft.sentinelBundle !== false
      };

      if (wizDraft.modePreset === 'advisor_all') {
        patch.confirmBeforeRun = true;
        patch.confirmThreshold = 'ALL';
        patch.orchestratorSmartSynergy = false;
        patch.strategy = subTier === 'ultra' ? 'auto_balance' : 'flash_dispatcher';
        patch.heavyThreshold = subTier === 'ultra' ? 'M' : 'L';
      } else if (wizDraft.modePreset === 'advisor_m') {
        patch.confirmBeforeRun = true;
        patch.confirmThreshold = 'M';
        patch.orchestratorSmartSynergy = true;
        patch.strategy = subTier === 'ultra' ? 'auto_balance' : 'flash_dispatcher';
        patch.heavyThreshold = subTier === 'ultra' ? 'M' : 'L';
      } else if (wizDraft.modePreset === 'autopilot_balance') {
        patch.confirmBeforeRun = false;
        patch.orchestratorSmartSynergy = true;
        patch.strategy = 'auto_balance';
        patch.heavyThreshold = subTier === 'ultra' ? 'M' : 'L';
      } else {
        patch.confirmBeforeRun = false;
        patch.orchestratorSmartSynergy = true;
        patch.strategy = 'flash_dispatcher';
        patch.heavyThreshold = 'XL';
      }

      const modal = document.getElementById('onboardingWizardModal');
      if (modal) {
        if (typeof animateModalOverlayState === 'function') {
          animateModalOverlayState(modal, false, { useVisibleClass: true });
        } else {
          modal.classList.remove('visible');
        }
      }
      wizSubTierPreviewDirty = false;
      wizLangPreviewDirty = false;
      wizViewModePreviewDirty = false;
      try {
        localStorage.setItem('ag_panel_view_mode_v1', chosenViewMode);
      } catch {}
      const preHwSnap = currentHardwareProfile;
      await updateState(patch);
      const hwSnap = preHwSnap || currentHardwareProfile || {};
      const ollInfo = hwSnap.ollama || {};
      const ollAlreadyPresent = Boolean(ollInfo.installed || ollInfo.running);
      const pullModeSelected = wizDraft.gpuPullMode || 'cascade';
      const mirrorSelected = patch.gpuPreferHfMirror ? 'huggingface' : 'auto';
      if (wizDraft.useGpu && wizDraft.autoInstallOllama !== false && !ollAlreadyPresent && typeof startOllamaInstall === 'function') {
        void startOllamaInstall({
          installDir: patch.gpuOllamaDir,
          modelsDir: patch.gpuModelsDir,
          pullModeAfter: pullModeSelected !== 'skip' ? pullModeSelected : '',
          selectedCapMb: patch.gpuMaxVramMb,
          mirrorMode: mirrorSelected,
        });
        flashStatus(L('Настройка сохранена · Устанавливаем Ollama в выбранную папку ✓', 'Setup saved · Installing Ollama into chosen folder ✓'));
      } else if (wizDraft.useGpu && pullModeSelected && pullModeSelected !== 'skip') {
        startGpuCascadePull(pullModeSelected, patch.gpuMaxVramMb, mirrorSelected);
        flashStatus(L('Настройка завершена · Запущена фоновая загрузка моделей ✓', 'Setup complete · Background model download started ✓'));
      } else {
        flashStatus(L('Калибровка ПК и настройка завершены ✓', 'PC calibration and setup complete ✓'));
      }
    }

