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

    async function refreshSidecarOpenWorkspacesFast(force) {
      const now = Date.now();
      if (!force && _lastOpenWorkspacesPollAt > 0 && now - _lastOpenWorkspacesPollAt < 4000) {
        return _cachedSidecarOpenWorkspaces;
      }
      _lastOpenWorkspacesPollAt = now;
      try {
        if (window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
          const res = await Promise.race([
            window.sidecar.getWorkspaceUris(),
            new Promise(function (resolve) { setTimeout(function () { resolve([]); }, 350); })
          ]);
          if (Array.isArray(res)) {
            _cachedSidecarOpenWorkspaces = res
              .map(function (u) { return String(u || '').trim(); })
              .filter(Boolean)
              .slice(0, 24);
          }
        }
      } catch {}
      return _cachedSidecarOpenWorkspaces;
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

      if (badgeEl) {
        if (_selectedWorkspaceMode === '__all__') {
          badgeEl.textContent = L('Все проекты', 'All projects');
        } else if (_selectedWorkspaceMode !== '__auto__') {
          badgeEl.textContent = activeName;
        } else {
          const autoTarget = _autoWorkspaceResolved || _activeWorkspaceResolved || '';
          const autoName = autoTarget ? getWorkspaceDisplayLabel(autoTarget) : (activeName || L('Проект', 'Project'));
          badgeEl.textContent = L('Авто · ', 'Auto · ') + autoName;
        }
      }
      if (triggerBtn) {
        if (_selectedWorkspaceMode === '__all__') {
          triggerBtn.title = L('Режим «Все проекты»: общая лента снимков (остальные блоки используют активный проект)', '"All projects" mode: combined snapshot timeline (other cards use active project)');
        } else if (_selectedWorkspaceMode !== '__auto__') {
          triggerBtn.title = L('Выбран проект: ', 'Selected project: ') + _selectedWorkspaceMode;
        } else {
          triggerBtn.title = L('Авторежим: ', 'Auto mode: ') + (_autoWorkspaceResolved || _activeWorkspaceResolved || L('активный чат', 'active chat'));
        }
      }
      if (resetAutoBtn) {
        resetAutoBtn.style.display = _selectedWorkspaceMode !== '__auto__' ? 'inline-flex' : 'none';
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
      const expBox = document.getElementById('expertDetailsBox');
      if (expBox && expBox.open) {
        if (typeof loadProjectInstincts === 'function') loadProjectInstincts({ silent: true });
        if (typeof refreshGatesStatus === 'function') refreshGatesStatus({ silent: true });
      }
    }

    const nativeFetch = window.fetch.bind(window);
    function panelFetch(url, options) {
      const opts = Object.assign({}, options || {});
      const abortSignal = opts.signal || null;
      const sidecarToken = (window.sidecar && window.sidecar.token)
        || new URLSearchParams(window.location.search).get('token')
        || '';
      const hdrs = Object.assign({ 'X-Router-Panel': PANEL_AUTH_HEADER }, opts.headers || {});
      if (sidecarToken && !hdrs['X-Sidecar-Token'] && !hdrs['x-sidecar-token']) {
        hdrs['X-Sidecar-Token'] = sidecarToken;
      }
      if (opts.body && !hdrs['Content-Type'] && !hdrs['content-type']) {
        hdrs['Content-Type'] = 'application/json';
      }
      let targetUrl = String(url || '');
      if (
        _cachedSidecarOpenWorkspaces.length > 0 &&
        !hdrs['X-Open-Workspaces'] &&
        !hdrs['x-open-workspaces'] &&
        (targetUrl.indexOf('/api/state') === 0 ||
          targetUrl.indexOf('/api/telemetry') === 0 ||
          targetUrl.indexOf('/api/project-graph/workspaces') === 0)
      ) {
        hdrs['X-Open-Workspaces'] = encodeURIComponent(_cachedSidecarOpenWorkspaces.join('|'));
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

    function normalizePanelViewMode(rawMode) {
      return String(rawMode || '').trim().toLowerCase() === 'lite' ? 'lite' : 'full';
    }

    function applyPanelViewModeDomPreviewOnly(mode) {
      const valid = normalizePanelViewMode(mode);
      if (document.body) {
        document.body.setAttribute('data-panel-view', valid);
      }
      document.querySelectorAll('#panelViewModeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === valid);
      });
      if (typeof syncSmartComposerSizeAndScroll === 'function') {
        syncSmartComposerSizeAndScroll();
      }
    }

    function openOnboardingWizard(stepNum) {
      wizStep = Math.max(1, Math.min(4, Number(stepNum || 1)));
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
      if (modal) modal.classList.add('visible');
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
      if (modal) modal.classList.remove('visible');
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
      wizStep = Math.max(1, Math.min(4, Number(s || 1)));
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
      if (wizStep < 4) {
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
      [1, 2, 3, 4].forEach((i) => {
        const p = document.getElementById('wizPill' + i);
        if (p) p.classList.toggle('active', i === wizStep);
      });
      const backBtn = document.getElementById('wizBackBtn');
      const nextBtn = document.getElementById('wizNextBtn');
      const hintEl = document.getElementById('wizStepHint');
      const bodyEl = document.getElementById('wizBodyContent');
      if (!bodyEl) return;

      if (backBtn) backBtn.textContent = wizStep === 1 ? L('Позже', 'Later') : L('← Назад', '← Back');
      if (nextBtn) nextBtn.textContent = wizStep === 4 ? L('✓ Сохранить и начать', '✓ Save & Start') : L('Далее →', 'Next →');

      if (wizStep === 1) {
        if (hintEl) hintEl.textContent = L('Шаг 1 из 4 · Язык, калибровка ПК и подписка', 'Step 1 of 4 · Language, PC calibration & tier');
        const hw = currentHardwareProfile || {};
        const sys = hw.system || {};
        const gpu = hw.gpu || {};
        const oll = hw.ollama || {};
        const recInfo = hw.recommendation || {};
        const isScanning = wizHwLoading && !sys.cpuModel && !sys.totalRamMb;
        const cpuText = isScanning
          ? L('Сканируем процессор...', 'Scanning CPU...')
          : (sys.cpuModel
              ? (sys.cpuModel.replace(/\(R\)|\(TM\)|Processor|CPU/gi, '').trim() + ' · ' + (sys.logicalCores || 4) + L(' пот.', ' thr.'))
              : L('Авто-определение CPU', 'Auto-detect CPU'));
        const ramGb = sys.totalRamGb || Math.round((sys.totalRamMb || 8192) / 1024);
        const recRamGb = Math.max(1, Math.round((wizDraft.ramMaxBudgetMb || 4096) / 1024));
        const ramText = isScanning
          ? L('Определяем объём ОЗУ...', 'Detecting RAM...')
          : (ramGb + L(' ГБ ОЗУ (буфер: ', ' GB RAM (cache: ') + recRamGb + L(' ГБ)', ' GB)'));
        const gpuName = gpu.name || L('Встроенная графика / CPU', 'Integrated GPU / CPU');
        const gpuVramText = gpu.totalMb > 0 ? (' · ' + Math.round(gpu.totalMb / 1024) + L(' ГБ', ' GB')) : '';
        const gpuTileText = isScanning ? L('Проверяем видеокарту...', 'Detecting GPU...') : (gpuName + gpuVramText);
        const ollStatus = isScanning
          ? L('Проверка Ollama...', 'Checking Ollama...')
          : (oll.running ? L('Запущена', 'Running') : (oll.installed ? L('Установлена', 'Installed') : L('Не найдена', 'Not found')));
        const sub = wizDraft.subscriptionTier;
        const lang = normalizeUiLanguage(wizDraft.uiLanguage || getUiLanguage());
        const viewMode = normalizePanelViewMode(wizDraft.panelViewMode || currentState.panelViewMode);

        bodyEl.innerHTML =
          '<div class="wiz-group-title" style="margin-top:0;">Language / Язык интерфейса и ответов ИИ</div>' +
          '<div class="wiz-two-col" style="margin-bottom:10px;">' +
            '<div class="wiz-choice-card' + (lang === 'en' ? ' selected' : '') + '" style="margin-bottom:0;" data-action="wizSetLanguage" data-arg="en">' +
              '<div class="wiz-choice-head"><span>English</span><span style="font-size:10px;color:var(--accent-cyan);">Default</span></div>' +
              '<div class="wiz-choice-desc">English panel UI, setup wizard, hooks and AI replies.</div>' +
            '</div>' +
            '<div class="wiz-choice-card' + (lang === 'ru' ? ' selected' : '') + '" style="margin-bottom:0;" data-action="wizSetLanguage" data-arg="ru">' +
              '<div class="wiz-choice-head"><span>Русский</span><span style="font-size:10px;color:var(--status-ok);">RU</span></div>' +
              '<div class="wiz-choice-desc">Русский интерфейс пульта, мастера, хуков и ответов ИИ.</div>' +
            '</div>' +
          '</div>' +
          '<div class="wiz-group-title">' + L('Режим интерфейса панели', 'Panel Interface Mode') + '</div>' +
          '<div class="wiz-two-col" style="margin-bottom:10px;">' +
            '<div class="wiz-choice-card' + (viewMode === 'full' ? ' selected' : '') + '" style="margin-bottom:0;" data-action="wizSetViewMode" data-arg="full">' +
              '<div class="wiz-choice-head"><span>Full</span><span style="font-size:10px;color:var(--accent-cyan);">' + L('По умолчанию', 'Default') + '</span></div>' +
              '<div class="wiz-choice-desc">' + L('Все блоки настроек, телеметрия Роя, графики RAM/GPU, Дозор и экспертные спойлеры.', 'All setting blocks, Swarm telemetry, RAM/GPU charts, Sentinel & expert spoilers.') + '</div>' +
            '</div>' +
            '<div class="wiz-choice-card' + (viewMode === 'lite' ? ' selected' : '') + '" style="margin-bottom:0;" data-action="wizSetViewMode" data-arg="lite">' +
              '<div class="wiz-choice-head"><span>Lite</span><span style="font-size:10px;color:var(--status-ok);">' + L('Компактно', 'Compact') + '</span></div>' +
              '<div class="wiz-choice-desc">' + L('Краткий пульт: прогресс, Стек, Карта, компактный Композер, порог, дизайн, Рой, Дозор и RAM+GPU.', 'Compact panel: progress, Stack, Map, slim Composer, confirm threshold, design, Swarm, Sentinel & RAM+GPU.') + '</div>' +
            '</div>' +
          '</div>' +

          '<div class="hw-passport-card">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">' +
              '<span style="font-weight:700;font-size:11px;">' + L('Паспорт и авто-калибровка вашей системы', 'Hardware Passport & Auto-Calibration') + '</span>' +
              '<button type="button" class="win-btn" style="font-size:9.5px;padding:2px 7px;" data-action="wizRescanHw">' + L('↻ Пересканировать ПК', '↻ Rescan PC') + '</button>' +
            '</div>' +
            '<div class="hw-spec-grid">' +
              '<div class="hw-spec-tile"><div class="hw-spec-k">' + L('Процессор', 'CPU') + '</div><div class="hw-spec-v" title="' + escHtml(sys.cpuModel || '') + '">' + escHtml(cpuText) + '</div></div>' +
              '<div class="hw-spec-tile"><div class="hw-spec-k">' + L('Оперативная память', 'System Memory') + '</div><div class="hw-spec-v">' + escHtml(ramText) + '</div></div>' +
              '<div class="hw-spec-tile"><div class="hw-spec-k">' + L('Видеокарта', 'GPU') + ' (' + escHtml((gpu.vendor || 'cpu').toUpperCase()) + ')</div><div class="hw-spec-v" title="' + escHtml(gpuTileText) + '">' + escHtml(gpuTileText) + '</div></div>' +
              '<div class="hw-spec-tile"><div class="hw-spec-k">' + L('Локальный ИИ Ollama', 'Local AI Ollama') + '</div><div class="hw-spec-v">' + ollStatus + '</div></div>' +
            '</div>' +
            '<div style="font-size:10px;color:var(--text-sub);margin-top:5px;line-height:1.35;">' + escHtml(isScanning
              ? L('Считываем характеристики вашего ПК для безопасного расчёта потоков и памяти...', 'Reading your hardware specs to calculate safe thread and memory budgets...')
              : (isRu()
                  ? (recInfo.vendorTipRu || 'Лимиты автоматически адаптированы под ваш компьютер без риска зависаний.')
                  : (recInfo.vendorTipEn || 'Limits are automatically calibrated for your machine to prevent freezes.'))) + '</div>' +
          '</div>' +

          '<div class="wiz-group-title">' + L('1) Какой у вас тариф подписки Antigravity?', '1) Which Antigravity subscription tier do you use?') + '</div>' +
          '<div class="wiz-two-col">' +
            '<div class="wiz-choice-card' + (sub === 'pro' ? ' selected' : '') + '" style="margin-bottom:0;" data-action="wizSetSubTier" data-arg="pro">' +
              '<div class="wiz-choice-head"><span>' + L('Подписка Pro', 'Pro Tier') + '</span><span style="font-size:10px;color:var(--accent-cyan);">' + L('Беречь квоту', 'Save quota') + '</span></div>' +
              '<div class="wiz-choice-desc">' + L('Hydrogen на S/M и Orchestrator (Neon) на L/XL. Недоступные на Pro модели Ultra (Carbon) автоматически скрыты.', 'Hydrogen on S/M and Orchestrator (Neon) on L/XL. Ultra-only models (Carbon) are hidden automatically.') + '</div>' +
            '</div>' +
            '<div class="wiz-choice-card' + (sub === 'ultra' ? ' selected' : '') + '" style="margin-bottom:0;" data-action="wizSetSubTier" data-arg="ultra">' +
              '<div class="wiz-choice-head"><span>Ultra / Max</span><span style="font-size:10px;color:var(--status-ok);">' + L('Полный доступ', 'Full access') + '</span></div>' +
              '<div class="wiz-choice-desc">' + L('Полная версия расширения: Orchestrator (Carbon/Neon), расширенные воркеры Роя и повышенный лимит квот.', 'Full extension features: Orchestrator (Carbon/Neon), extended Swarm workers and higher quota limits.') + '</div>' +
            '</div>' +
          '</div>' +

          '<div class="wiz-group-title">' + L('2) Использовать ресурсы ПК для экономии облачных токенов?', '2) Use local PC resources to save cloud tokens?') + '</div>' +
          '<div class="wiz-choice-card' + (wizDraft.useRam ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="useRam">' +
            '<div class="wiz-choice-head">' +
              '<span>' + (wizDraft.useRam ? '✓ ' : '') + L('Оперативная память (In-RAM кэш кода)', 'System RAM (In-RAM Code Cache)') + '</span>' +
              '<span>' + (wizDraft.useRam ? (L('ВКЛ · до ', 'ON · up to ') + recRamGb + L(' ГБ', ' GB')) : L('ВЫКЛ', 'OFF')) + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Мгновенно выдаёт ИИ точные срезы строк за &lt;1 мс без повторного чтения файлов с диска.', 'Delivers exact code slices to AI in &lt;1 ms without re-reading full files from disk.') + '</div>' +
          '</div>' +

          '<div class="wiz-choice-card' + (wizDraft.useCpu ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="useCpu">' +
            '<div class="wiz-choice-head">' +
              '<span>' + (wizDraft.useCpu ? '✓ ' : '') + L('Многопоточный процессор (CPU-пул, 0 VRAM)', 'Multi-Core CPU Pool (0 VRAM)') + '</span>' +
              '<span>' + (wizDraft.useCpu ? (L('ВКЛ · до ', 'ON · up to ') + wizDraft.cpuMaxThreads + L(' пот.', ' thr.')) : L('Тихий режим (1 пот.)', 'Quiet mode (1 thr.)')) + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Локальный триграммный индекс и быстрая фоновая проверка синтаксиса на ядрах CPU (спит в простое).', 'Local trigram search index and fast background syntax verification on CPU cores (sleeps when idle).') + '</div>' +
          '</div>' +

          '<div class="wiz-choice-card' + (wizDraft.useGpu ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="useGpu">' +
            '<div class="wiz-choice-head">' +
              '<span>' + (wizDraft.useGpu ? '✓ ' : '') + L('Видеокарта (локальный ИИ через Ollama)', 'Local GPU (Ollama Copilot)') + '</span>' +
              '<span>' + (wizDraft.useGpu ? (L('ВКЛ · ', 'ON · ') + escHtml(wizDraft.gpuChatModel + ' + ' + wizDraft.gpuEmbedModel)) : L('ВЫКЛ (без GPU)', 'OFF (no GPU)')) + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Бесплатное сжатие больших логов, умное автодополнение в Композере и смысловой поиск (0 облачных токенов).', 'Free distillation of huge logs, smart Composer autocomplete and semantic search (0 cloud tokens).') + '</div>' +
          '</div>' +
          (wizDraft.useGpu
            ? (function () {
                const cb = recInfo.cascadeBundle || {};
                const allModels = Array.isArray(cb.models) ? cb.models : [];
                const namesList = allModels.length > 0
                  ? allModels.map(function (m) { return (m.alreadyDownloaded ? '✓ ' : '↓ ') + m.name; }).join(', ')
                  : (wizDraft.gpuChatModel + ', ' + wizDraft.gpuEmbedModel);
                const missingGbTxt = Number(cb.approxMissingDiskGb || 0) > 0
                  ? (' (~' + Number(cb.approxMissingDiskGb).toFixed(1) + L(' ГБ к загрузке)', ' GB to download)'))
                  : L(' (все модели каскада уже скачаны ✓)', ' (all cascade models already downloaded ✓)');
                const pm = wizDraft.gpuPullMode || 'cascade';
                const joinWizModelsSubdir = function (baseDir) {
                  const clean = String(baseDir || '').trim().replace(/[\\/]+$/, '');
                  return clean ? (clean + (clean.indexOf('/') !== -1 && clean.indexOf('\\') === -1 ? '/models' : '\\models')) : '';
                };
                const effectiveDir = String(wizDraft.gpuOllamaDir || '').trim();
                const derivedModelsDir = String(wizDraft.gpuModelsDir || joinWizModelsSubdir(effectiveDir) || '').trim();
                const ollNeedsInstall = !isScanning && !oll.installed && !oll.running;
                const ollInstallBlock = ollNeedsInstall
                  ? '<div class="wiz-gpu-install-box">' +
                      '<label class="wiz-mini-check-row" data-action="wizToggleFlag" data-arg="autoInstallOllama">' +
                        '<input type="checkbox"' + (wizDraft.autoInstallOllama !== false ? ' checked' : '') + ' tabindex="-1" style="pointer-events:none;" />' +
                        '<span><strong>' + L('Установить Ollama автоматически', 'Auto-install Ollama') + '</strong> — ' +
                          L('скачает и установит Ollama после завершения мастера, затем сразу начнёт загрузку моделей.', 'downloads and installs Ollama on finish, then immediately starts model downloads.') +
                        '</span>' +
                      '</label>' +
                    '</div>'
                  : '<div style="font-size:9.5px;color:var(--status-ok);margin-top:4px;">✓ ' + L('Ollama обнаружена в системе — модели можно скачать сразу после мастера.', 'Ollama detected on this PC — models can download right after finish.') + '</div>';
                const dirHintLine = effectiveDir
                  ? ('<div style="font-size:9px;color:var(--text-sub);margin-top:3px;word-break:break-all;">' + L('Модели сохранятся в: ', 'Models folder: ') + '<code>' + escHtml(derivedModelsDir) + '</code></div>')
                  : '<div style="font-size:9px;color:var(--text-sub);margin-top:3px;">' + L('Если не указывать — используются стандартные пути системы (~/.ollama).', 'Leave empty to use default system paths (~/.ollama).') + '</div>';
                return '<div class="wiz-gpu-cascade-box">' +
                  '<div style="font-size:10.5px;font-weight:600;">' + L('Модели под ступени вашей видеопамяти', 'Models matched to your VRAM tiers') + escHtml(missingGbTxt) + '</div>' +
                  '<div style="font-size:9.5px;color:var(--text-sub);margin-top:2px;line-height:1.35;">' + escHtml(namesList) + '</div>' +
                  '<div style="margin-top:6px;">' +
                    '<div style="font-size:9.5px;font-weight:600;margin-bottom:3px;color:var(--text-main);">' + L('Папка установки Ollama и моделей:', 'Folder for Ollama & models:') + '</div>' +
                    '<div class="wiz-dir-row">' +
                      '<input type="text" id="wizGpuInstallDir" class="lg-input" data-input-action="wizSetGpuInstallDir" value="' + escHtml(effectiveDir) + '" placeholder="' + escHtml(L('По умолчанию (AppData / ~/.ollama)', 'Default (AppData / ~/.ollama)')) + '" />' +
                      '<button type="button" class="win-btn wiz-dir-pick-btn" id="wizBtnPickGpuDir" data-action="wizPickGpuInstallDir">' + L('Выбрать…', 'Browse…') + '</button>' +
                    '</div>' +
                    dirHintLine +
                  '</div>' +
                  ollInstallBlock +
                  '<label class="wiz-mini-check-row" style="margin-top:5px;" data-action="wizToggleFlag" data-arg="gpuPreferHfMirror">' +
                    '<input type="checkbox"' + (wizDraft.gpuPreferHfMirror ? ' checked' : '') + ' tabindex="-1" style="pointer-events:none;" />' +
                    '<span>' + L('Предпочитать зеркало Hugging Face (GGUF напрямую с hf.co)', 'Prefer Hugging Face mirror (GGUF directly from hf.co)') + '</span>' +
                  '</label>' +
                  '<div class="wiz-gpu-cascade-pills">' +
                    '<button type="button" class="wiz-gpu-cascade-pill' + (pm === 'cascade' ? ' selected' : '') + '" data-action="wizSetGpuPullMode" data-arg="cascade">' + L('↓ Скачать весь каскад (Рекомендуется)', '↓ Download full cascade (Recommended)') + '</button>' +
                    '<button type="button" class="wiz-gpu-cascade-pill' + (pm === 'active_only' ? ' selected' : '') + '" data-action="wizSetGpuPullMode" data-arg="active_only">' + L('Только текущий лимит', 'Active limit only') + '</button>' +
                    '<button type="button" class="wiz-gpu-cascade-pill' + (pm === 'skip' ? ' selected' : '') + '" data-action="wizSetGpuPullMode" data-arg="skip">' + L('Пропустить сейчас', 'Skip for now') + '</button>' +
                  '</div>' +
                '</div>';
              })()
            : '') +

          '<button type="button" class="hw-ai-tune-btn" data-action="sendHardwareTunePrompt">' +
            L('Собрать промпт по моему железу и подобрать самые свежие модели в чате', 'Generate hardware passport & pick latest local models in chat') +
          '</button>';
      } else if (wizStep === 2) {
        if (hintEl) hintEl.textContent = L('Шаг 2 из 4 · Когда ИИ должен советоваться с вами?', 'Step 2 of 4 · When should AI confirm plans with you?');
        const m = wizDraft.modePreset;
        bodyEl.innerHTML =
          '<div style="font-size:10.5px;color:var(--text-sub);margin-bottom:8px;">' + L('Вы пишете задачи обычным разговорным языком — ИИ сам изучает файлы проекта. Выберите комфортный уровень контроля:', 'Describe tasks in plain language — AI scouts project files automatically. Choose your preferred level of control:') + '</div>' +
          '<div class="wiz-choice-card' + (m === 'advisor_m' ? ' selected' : '') + '" data-action="wizSelectMode" data-arg="advisor_m">' +
            '<div class="wiz-choice-head">' +
              '<span>' + L('Умный советник (Smart-Synergy · от M+)', 'Smart Advisor (Smart-Synergy · M+)') + '</span>' +
              '<span style="color:var(--status-ok);">' + L('Рекомендуется', 'Recommended') + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Мелкие правки (S) делает сразу, а перед заметными задачами (M/L/XL) кратко показывает план, рекомендуемую модель и спрашивает «Запускаем?».', 'Executes small S edits right away; for medium/large tasks (M/L/XL) shows a brief plan, recommended model and asks "Proceed?".') + '</div>' +
          '</div>' +
          '<div class="wiz-choice-card' + (m === 'advisor_all' ? ' selected' : '') + '" data-action="wizSelectMode" data-arg="advisor_all">' +
            '<div class="wiz-choice-head">' +
              '<span>' + L('Строгий контроль (Спрашивать план всегда)', 'Strict Control (Always confirm)') + '</span>' +
              '<span style="color:var(--accent-cyan);">' + L('Полное одобрение', 'Full approval') + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Перед любым изменением кода (даже небольшим S) сначала показывает объём, затронутые файлы и ждёт вашего подтверждения.', 'Before any code edit (even small S), always shows scope, affected files and waits for your approval.') + '</div>' +
          '</div>' +
          '<div class="wiz-choice-card' + (m === 'autopilot_balance' ? ' selected' : '') + '" data-action="wizSelectMode" data-arg="autopilot_balance">' +
            '<div class="wiz-choice-head">' +
              '<span>' + L('Полный автопилот (Делать сразу без вопросов)', 'Full Autopilot (Run without prompts)') + '</span>' +
              '<span style="color:var(--accent-cyan);">' + L('Без лишних кликов', 'Zero extra clicks') + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Не переспрашивает план перед рутиной — сам находит нужные модули, вносит правки и запускает самопроверку.', 'Skips confirmation prompts — scouts modules, applies edits and runs self-verification automatically.') + '</div>' +
          '</div>' +
          '<div class="wiz-choice-card' + (m === 'flash_economy' ? ' selected' : '') + '" data-action="wizSelectMode" data-arg="flash_economy">' +
            '<div class="wiz-choice-head">' +
              '<span>' + L('Экономный автопилот (Максимум экономии квоты)', 'Economy Autopilot (Max quota savings)') + '</span>' +
              '<span>' + L('До 80% выгоднее', 'Up to 80% cheaper') + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Выполняет рутину на быстрой модели Hydrogen / Flash, советуя старшие модели только для самых сложных архитектурных задач XL.', 'Handles routine work on fast Hydrogen / Flash, recommending heavier models only for complex XL architecture tasks.') + '</div>' +
          '</div>';
      } else if (wizStep === 3) {
        if (hintEl) hintEl.textContent = L('Шаг 3 из 4 · Дизайн интерфейсов в проектах', 'Step 3 of 4 · UI design workflow');
        const g = wizDraft.uiDesignPreviewGate;
        const insp = wizDraft.uiInspirationMode || 'ask';
        bodyEl.innerHTML =
          '<div class="wiz-group-title">' + L('Когда вы просите сверстать или обновить UI в вашем проекте:', 'When you ask to design or update UI in your project:') + '</div>' +
          '<div class="wiz-choice-card' + (g ? ' selected' : '') + '" data-action="wizSetDesignGate" data-arg="true">' +
            '<div class="wiz-choice-head">' +
              '<span>' + L('Согласовывать стиль и примеры перед вёрсткой', 'Preview style & prototypes before coding') + '</span>' +
              '<span style="color:var(--status-ok);">' + L('Рекомендуется', 'Recommended') + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Защищает от шаблонных ИИ-интерфейсов: сначала уточнит направление или покажет интерактивную витрину A/B/C.', 'Prevents generic AI UI: clarifies visual direction or builds an interactive A/B/C showroom first.') + '</div>' +
          '</div>' +
          (g
            ? '<div class="wiz-gpu-cascade-box" style="margin-top:-2px;margin-bottom:8px;">' +
                '<div style="font-size:10px;font-weight:600;margin-bottom:4px;">' + L('Как готовить визуальные референсы:', 'How to prepare visual references:') + '</div>' +
                '<div class="wiz-gpu-cascade-pills">' +
                  '<button type="button" class="wiz-gpu-cascade-pill' + (insp === 'ask' ? ' selected' : '') + '" data-action="wizSetInspirationMode" data-arg="ask">' + L('Спрашивать по задаче', 'Ask per task') + '</button>' +
                  '<button type="button" class="wiz-gpu-cascade-pill' + (insp === 'showroom' ? ' selected' : '') + '" data-action="wizSetInspirationMode" data-arg="showroom">' + L('Сразу витрина A/B/C', 'A/B/C Showroom') + '</button>' +
                  '<button type="button" class="wiz-gpu-cascade-pill' + (insp === 'web_refs' ? ' selected' : '') + '" data-action="wizSetInspirationMode" data-arg="web_refs">' + L('Примеры из веба', 'Web References') + '</button>' +
                '</div>' +
              '</div>'
            : '') +
          '<div class="wiz-choice-card' + (!g ? ' selected' : '') + '" data-action="wizSetDesignGate" data-arg="false">' +
            '<div class="wiz-choice-head">' +
              '<span>' + L('Сразу внедрять дизайн в код (без превью)', 'Apply UI edits directly in code (no preview)') + '</span>' +
              '<span style="color:var(--accent-cyan);">' + L('Быстрее', 'Faster') + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('ИИ сам подберёт гармоничную палитру под ваш проект и сразу обновит вёрстку без лишних вопросов.', 'AI picks a cohesive palette matching your project and updates layout right away without extra prompts.') + '</div>' +
          '</div>';
      } else {
        if (hintEl) hintEl.textContent = L('Шаг 4 из 4 · Страховка кода и итоговая сводка', 'Step 4 of 4 · Code safety & final summary');
        const sf = wizDraft.safetyBundle;
        const sn = wizDraft.sentinelBundle !== false;
        const modeLabelMap = {
          advisor_m: L('Советник M+ (Smart-Synergy)', 'Advisor M+ (Smart-Synergy)'),
          advisor_all: L('Строгий контроль (все задачи)', 'Strict Control (all tasks)'),
          autopilot_balance: L('Полный автопилот', 'Full Autopilot'),
          flash_economy: L('Экономный автопилот', 'Economy Autopilot')
        };
        const recRamGb = Math.max(1, Math.round((wizDraft.ramMaxBudgetMb || 4096) / 1024));
        const hwSummary = (wizDraft.useRam ? ('RAM ' + recRamGb + L(' ГБ', ' GB')) : L('RAM выкл', 'RAM off'))
          + ' · ' + (wizDraft.useCpu ? ('CPU ' + wizDraft.cpuMaxThreads + L(' пот.', ' thr.')) : L('CPU 1 пот.', 'CPU 1 thr.'))
          + ' · ' + (wizDraft.useGpu ? ('GPU ' + wizDraft.gpuChatModel) : L('без GPU', 'no GPU'));
        const viewModeSummary = normalizePanelViewMode(wizDraft.panelViewMode) === 'lite' ? 'Lite' : 'Full';
        const langSummary = normalizeUiLanguage(wizDraft.uiLanguage) === 'ru' ? 'Русский' : 'English';

        bodyEl.innerHTML =
          '<div class="wiz-callout-info">' +
            L(
              '<strong>Про скиллы (навыки ИИ):</strong> вам <strong>не нужно</strong> включать их вручную — все навыки работают в режиме <strong>«Умный Авто»</strong> и подключаются ровно под вашу задачу.',
              '<strong>About AI Skills:</strong> you <strong>don\'t need</strong> to toggle them manually — all skills run in <strong>"Smart Auto"</strong> mode and activate only when relevant.'
            ) +
          '</div>' +
          '<div class="wiz-choice-card' + (sf ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="safetyBundle">' +
            '<div class="wiz-choice-head">' +
              '<span>' + (sf ? '✓ ' : '') + L('Теневые снимки отката и автопроверка кода', 'Shadow Rollback Snapshots & Auto-Verify') + '</span>' +
              '<span style="color:var(--status-ok);">' + (sf ? L('ВКЛ (Надёжно)', 'ON (Safe)') : L('ВЫКЛ', 'OFF')) + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('Сохраняет резервную копию файла перед каждой правкой (откат в 1 клик) и проверяет затронутые тесты и синтаксис.', 'Saves a backup before every edit (1-click rollback) and automatically verifies syntax and impacted tests.') + '</div>' +
          '</div>' +
          '<div class="wiz-choice-card' + (sn ? ' selected' : '') + '" data-action="wizToggleFlag" data-arg="sentinelBundle">' +
            '<div class="wiz-choice-head">' +
              '<span>' + (sn ? '✓ ' : '') + L('Фоновый Дозор (Sentinel) и Git-песочницы', 'Background Sentinel & Git Sandboxes') + '</span>' +
              '<span style="color:var(--accent-cyan);">' + (sn ? L('ВКЛ', 'ON') : L('ВЫКЛ', 'OFF')) + '</span>' +
            '</div>' +
            '<div class="wiz-choice-desc">' + L('В простое тихо проверяет изменённые файлы на скрытые ошибки и позволяет изолировать рискованные эксперименты.', 'Silently checks edited files during idle pauses for hidden bugs and lets you isolate risky experiments.') + '</div>' +
          '</div>' +
          '<div class="wiz-summary-card">' +
            '<div style="font-size:10.5px;font-weight:700;">' + L('Итоговая конфигурация перед стартом:', 'Configuration summary:') + '</div>' +
            '<div class="wiz-summary-grid">' +
              '<div class="wiz-summary-item"><div class="wiz-summary-k">' + L('Язык / Тариф', 'Language / Tier') + '</div><div class="wiz-summary-v">' + langSummary + ' · ' + (wizDraft.subscriptionTier === 'ultra' ? 'Ultra' : 'Pro') + '</div></div>' +
              '<div class="wiz-summary-item"><div class="wiz-summary-k">' + L('Режим диалога', 'Workflow Mode') + '</div><div class="wiz-summary-v" title="' + escHtml(modeLabelMap[wizDraft.modePreset] || '') + '">' + escHtml(modeLabelMap[wizDraft.modePreset] || L('Советник M+', 'Advisor M+')) + '</div></div>' +
              '<div class="wiz-summary-item"><div class="wiz-summary-k">' + L('Ресурсы ПК', 'PC Resources') + '</div><div class="wiz-summary-v" title="' + escHtml(hwSummary) + '">' + escHtml(hwSummary) + '</div></div>' +
              '<div class="wiz-summary-item"><div class="wiz-summary-k">' + L('Режим пульта', 'Panel Mode') + '</div><div class="wiz-summary-v">' + escHtml(viewModeSummary) + '</div></div>' +
            '</div>' +
          '</div>' +
          '<div class="wiz-callout-ready">' +
            L(
              'Всё готово! Нажмите <strong>«✓ Сохранить и начать»</strong> — параметры применятся глобально для всех текущих и новых чатов.',
              'All set! Click <strong>"✓ Save & Start"</strong> — settings will apply globally to all current and future chats.'
            ) +
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
      if (modal) modal.classList.remove('visible');
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

