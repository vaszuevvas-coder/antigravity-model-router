    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function formatExactInt(num) {
      const n = Math.round(Number(num || 0));
      return n.toLocaleString('ru-RU');
    }

    function formatK(num) {
      const n = Number(num || 0);
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      if (n >= 1000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
      return String(Math.round(n));
    }

    const SWARM_MODE_LABELS = {
      auto_xl: 'Авто XL',
      aggressive_l: 'Командный L+',
      auto_all: 'Авто все',
      always_ask: 'Спрашивать',
      manual_only: 'По /swarm',
      off: 'Рой выкл'
    };

    const SWARM_TIER_HINTS = {
      hydrogen_auto: 'авторы правок автоматически сядут на быстрый Gemini 4 Hydrogen в ветках share',
      neon_auto: 'авторы правок будут работать на мощной кодинг-модели Gemini 4 Neon в ветках share',
      argon_auto: 'авторы правок будут работать на сбалансированном Gemini 4 Argon в ветках share',
      carbon_auto: 'авторы правок будут работать на старшем архитекторе Gemini 4 Carbon в ветках share',
      inherit: 'все воркеры Роя будут наследовать выбранную в селекторе модель'
    };

    function renderSwarmTelemetry(sw, s) {
      const dotEl = document.getElementById('swarmStatusDot');
      const headEl = document.getElementById('swarmStatusHeadline');
      const badgeEl = document.getElementById('swarmStatusBadge');
      const detailsEl = document.getElementById('swarmStatusDetails');
      const chipsBar = document.getElementById('swarmMembersBar');
      if (!dotEl || !headEl || !badgeEl || !detailsEl || !chipsBar) return;

      const activeSub = s && s.subscriptionTier === 'ultra' ? 'ultra' : 'pro';
      const modeKey = (s && s.swarmMode) ? s.swarmMode : 'auto_xl';
      const rawTierKey = (s && s.swarmWorkerTier) ? s.swarmWorkerTier : 'hydrogen_auto';
      const tierKey = activeSub === 'pro' && rawTierKey === 'carbon_auto'
        ? 'neon_auto'
        : (activeSub === 'pro' && rawTierKey === 'argon_auto' ? 'hydrogen_auto' : rawTierKey);
      const tierHint = SWARM_TIER_HINTS[tierKey] || SWARM_TIER_HINTS.hydrogen_auto;
      const isSwarmActive = Boolean(sw && sw.active && sw.totalSpawned > 0);

      if (isSwarmActive) {
        dotEl.className = 'swarm-dot active';
        const titlePart = sw.title ? ('«' + sw.title + '»') : 'Активный Рой';
        headEl.textContent = '🐝 ' + titlePart + ' · В строю: ' + sw.activeWorkers + ' из ' + sw.totalSpawned;
        badgeEl.className = 'swarm-pill';
        const neonPart = (sw.neonWorkers > 0) ? (' · Neon: ' + sw.neonWorkers) : '';
        badgeEl.textContent = 'Hydrogen: ' + (sw.hydrogenWorkers || 0) + neonPart + ' · Проверок: ' + (sw.verifiers || 0);

        const extras = [];
        extras.push('Авторов: ' + (sw.authors || 0));
        if (sw.verifiers > 0) extras.push('Ревизоров: ' + sw.verifiers);
        if (sw.supportWorkers > 0) extras.push('Монитор/Обзор: ' + sw.supportWorkers);
        if (sw.channelsCount > 0) extras.push('Каналов: #' + sw.channelsCount);
        if (sw.modelSwitches > 0) extras.push('Смен модели (квота): ' + sw.modelSwitches);
        if (sw.boardPosts > 0) extras.push('Сообщений на доске: ' + sw.boardPosts);
        detailsEl.textContent = extras.join(' · ');

        const aliveMembers = Array.isArray(sw.members) ? sw.members.filter((m) => m && m.alive) : [];
        if (aliveMembers.length > 0) {
          chipsBar.style.display = 'flex';
          chipsBar.innerHTML = aliveMembers.slice(0, 10).map((m) => {
            const cls = m.role === 'verifier' ? 'swarm-chip verifier' : (m.isHydrogen ? 'swarm-chip hydrogen' : (m.isNeon ? 'swarm-chip neon' : 'swarm-chip'));
            const wsBadge = m.workspace === 'share' ? ' [share]' : '';
            return '<span class="' + cls + '" title="Модель: ' + escapeHtml(m.model || 'inherit') + '">@' + escapeHtml(m.name) + wsBadge + '</span>';
          }).join('');
        } else {
          chipsBar.style.display = 'none';
          chipsBar.innerHTML = '';
        }
      } else {
        dotEl.className = 'swarm-dot';
        badgeEl.className = 'swarm-pill idle';
        badgeEl.textContent = SWARM_MODE_LABELS[modeKey] || 'Авто XL';
        chipsBar.style.display = 'none';
        chipsBar.innerHTML = '';

        if (modeKey === 'off') {
          headEl.textContent = 'Командный Рой отключён';
          detailsEl.textContent = 'Все задачи выполняются одиночной моделью или штатным Оркестратором без подъёма доски Роя';
        } else if (modeKey === 'manual_only') {
          headEl.textContent = 'Дежурный режим · Запуск только вручную (/swarm)';
          detailsEl.textContent = 'Защита фоновых воркеров от зависаний и страховка квот включатся сразу после команды /swarm';
        } else if (modeKey === 'always_ask') {
          headEl.textContent = 'Режим с подтверждением на задачах L и XL';
          detailsEl.textContent = 'Агент предложит подключить Рой перед стартом: ' + tierHint;
        } else if (modeKey === 'auto_all') {
          headEl.textContent = 'Максимальный Рой: подключается на многомодульных задачах';
          detailsEl.textContent = 'Координатор планирует, а ' + tierHint;
        } else if (modeKey === 'aggressive_l') {
          headEl.textContent = 'Готов к запуску на многофайловых задачах (L и XL)';
          detailsEl.textContent = 'Координатор планирует на вашей модели, а ' + tierHint;
        } else {
          headEl.textContent = 'Адаптивный режим: бережёт квоту на S/M/L, включает Рой на XL';
          detailsEl.textContent = tierKey === 'hydrogen_auto'
            ? 'На обычных задачах работает быстрый контур · На крупных XL (4+ модулей) поднимется экономный Hydrogen-Рой + Ревизор'
            : 'На крупных XL (4+ модулей) поднимется Рой: ' + tierHint;
        }
      }
    }

    let _lastTelemetrySnapshot = null;

    function syncRamSavedPillFromState(ramCache) {
      const ramSavedEl = document.getElementById('ramUnitSavedPill');
      if (!ramSavedEl) return;
      const telRamSaved = Number((_lastTelemetrySnapshot && _lastTelemetrySnapshot.ramSavedTokens) || 0);
      const liveRamSaved = Number((ramCache && ramCache.savedTokensEstimate) || 0);
      const savedRamTok = Math.max(telRamSaved, liveRamSaved);
      const rc = (_lastTelemetrySnapshot && _lastTelemetrySnapshot.ramCalls) || {};
      const slicesCnt = Math.max(Number(rc.slices || 0), Number((ramCache && ramCache.slices) || 0));
      const searchesCnt = Math.max(Number(rc.searches || 0), Number((ramCache && ramCache.searches) || 0));
      ramSavedEl.textContent = '~' + formatK(savedRamTok) + ' ток.';
      ramSavedEl.title =
        'Экономия памяти In-RAM: ~' + formatExactInt(savedRamTok) + ' ток. ' +
        '(срезов кода: ' + formatExactInt(slicesCnt) + ' · поисков в ОЗУ: ' + formatExactInt(searchesCnt) + ')';
    }

    function updateHeaderSessionPill(t) {
      if (!t) return;
      const chatsCount = Number(t.totalChats || 0);
      const convoEl = document.getElementById('convoShortId');
      if (convoEl) {
        convoEl.textContent = chatsCount > 0 ? ('Все чаты (' + chatsCount + ')') : 'Все чаты · Автопилот';
        convoEl.title = 'Сводная статистика собирается по всем открытым и завершённым диалогам без путаницы между параллельными чатами';
      }
    }

    function syncSwarmHeaderPills(t, s) {
      const st = s || currentState || {};
      if (t) {
        const bk = t.savingsBreakdown || {};
        const hitRate = Number(bk.cacheHitRate ?? t.cacheHitRate ?? 0);
        const cacheHitBadgeEl = document.getElementById('metricCacheHitBadge');
        if (cacheHitBadgeEl) {
          cacheHitBadgeEl.textContent = 'Кэш: ' + hitRate + '%';
          cacheHitBadgeEl.className = 'swarm-pill ' + (hitRate >= 50 ? 'active' : 'idle');
        }
      }
      const badgeEl = document.getElementById('swarmStatusBadge');
      if (badgeEl) {
        const sw = t ? t.swarm : null;
        const modeKey = st.swarmMode ? st.swarmMode : 'auto_xl';
        const isSwarmActive = Boolean(sw && sw.active && sw.totalSpawned > 0);
        if (isSwarmActive) {
          badgeEl.className = 'swarm-pill';
          const neonPart = (sw.neonWorkers > 0) ? (' · Neon: ' + sw.neonWorkers) : '';
          badgeEl.textContent = 'Hydrogen: ' + (sw.hydrogenWorkers || 0) + neonPart + ' · Проверок: ' + (sw.verifiers || 0);
        } else {
          badgeEl.className = 'swarm-pill idle';
          badgeEl.textContent = SWARM_MODE_LABELS[modeKey] || 'Авто XL';
        }
      }
    }

    function renderTelemetry(t) {
      if (!t) return;
      _lastTelemetrySnapshot = t;
      updateHeaderSessionPill(t);
      const ac = t.activeChat || null;
      const savedTotalEl = document.getElementById('metricTotalSaved');
      const bk = t.savingsBreakdown || {};
      const cacheSaved = Number(bk.cache ?? t.cacheSavedTokens ?? 0);
      const ramSaved = Number(bk.ram ?? t.ramSavedTokens ?? 0);
      const cpuSaved = Number(bk.cpu ?? t.cpuSavedTokens ?? 0);
      const gpuSaved = Number(bk.gpu ?? t.gpuSavedTokens ?? 0);
      const hitRate = Number(bk.cacheHitRate ?? t.cacheHitRate ?? 0);
      if (savedTotalEl) {
        savedTotalEl.textContent = '~' + formatK(t.totalSavedTokens || 0) + ' ток.';
        savedTotalEl.title =
          'Сэкономлено всего: ~' + formatExactInt(t.totalSavedTokens || 0) + ' ток. ' +
          '(кэш промптов ~' + formatExactInt(cacheSaved) +
          ' + RAM ~' + formatExactInt(ramSaved) +
          ' + CPU ~' + formatExactInt(cpuSaved) +
          ' + GPU ~' + formatExactInt(gpuSaved) + ' ток.)';
      }
      const cacheHitBadgeEl = document.getElementById('metricCacheHitBadge');
      if (cacheHitBadgeEl) {
        cacheHitBadgeEl.textContent = 'Кэш: ' + hitRate + '%';
        cacheHitBadgeEl.className = 'swarm-pill ' + (hitRate >= 50 ? 'active' : 'idle');
      }
      const setBkCell = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = formatK(val || 0);
      };
      setBkCell('metricSavedCacheVal', cacheSaved);
      setBkCell('metricSavedRamVal', ramSaved);
      setBkCell('metricSavedCpuVal', cpuSaved);
      setBkCell('metricSavedGpuVal', gpuSaved);

      const summaryEl = document.getElementById('allChatsSummaryLabel');
      if (summaryEl) {
        if (ac && ac.steps > 0) {
          const acSaved = Number(ac.cacheSavedTokens || 0) + Number(ac.ramSavedTokens || 0);
          summaryEl.textContent =
            'Текущий чат: ~' + formatExactInt(acSaved) +
            ' ток. сэкономлено (контекст ' + formatK(ac.lastContextTokens || 0) + ')';
        } else {
          summaryEl.textContent =
            'Текущий чат: ожидание первого хода · Авто-перенос контекста в новый чат включён';
        }
      }

      syncRamSavedPillFromState(_lastHwRenderCtx ? _lastHwRenderCtx.ramCache : null);
      renderSwarmTelemetry(t.swarm, currentState);
    }

    let _checkpointsViewMode = 'turns';
    let _latestCheckpointsList = [];
    let _latestTurnCheckpointsList = [];
    let _latestWorktreesList = [];
    let _activeTurnDiffPreview = null;

    let _latestVictoryRecipes = [];
    let _latestFederatedPeers = [];
    let _latestKnowledgeStats = null;

    function renderShadowWorktrees(worktrees) {
      if (Array.isArray(worktrees)) _latestWorktreesList = worktrees;
      const bar = document.getElementById('shadowWorktreeBar');
      const createBtn = bar ? bar.querySelector('[data-action="worktreeAction"][data-mode="create"]') : null;
      const box = document.getElementById('shadowWorktreeList');
      const wtEnabled = !currentState || currentState.shadowWorktreeEnabled !== false;
      if (bar) bar.style.opacity = wtEnabled ? '1' : '0.55';
      if (createBtn) {
        createBtn.disabled = !wtEnabled;
        createBtn.title = wtEnabled
          ? 'Создать изолированную копию репозитория git worktree'
          : 'Включите «Изолированная Git-песочница» в экспертных параметрах';
      }
      if (!box) return;
      if (!wtEnabled) {
        box.innerHTML = '<span>Git-песочница отключена в экспертных параметрах</span>';
        return;
      }
      if (!_latestWorktreesList || _latestWorktreesList.length === 0) {
        box.innerHTML = '<span>Изолированных песочниц не создано</span>';
        return;
      }
      let html = '';
      for (let i = 0; i < _latestWorktreesList.length; i++) {
        const wt = _latestWorktreesList[i];
        const wtId = wt.id || '';
        html +=
          '<div class="checkpoint-item" style="margin-top: 3px;">' +
            '<div class="checkpoint-info">' +
              '<div class="checkpoint-file" title="' + escapeHtml(wt.worktreePath || '') + '">' + escapeHtml(wt.label || wtId) + '</div>' +
              '<div class="checkpoint-meta">' + escapeHtml(wtId) + ' · ' + escapeHtml((wt.baseHead || '').slice(0, 7)) + '</div>' +
            '</div>' +
            '<div style="display: flex; gap: 3px; flex-shrink: 0;">' +
              '<button type="button" class="win-btn" style="padding: 1px 5px; font-size: 10px;" data-action="worktreeAction" data-mode="promote" data-id="' + escapeHtml(wtId) + '" title="Перенести проверенные правки в проект (с бэкапом)">✓ Применить</button>' +
              '<button type="button" class="win-btn" style="padding: 1px 5px; font-size: 10px;" data-action="worktreeAction" data-mode="discard" data-id="' + escapeHtml(wtId) + '" title="Удалить изолированную песочницу без изменений в проекте">✕</button>' +
            '</div>' +
          '</div>';
      }
      box.innerHTML = html;
    }

    function renderCheckpoints(checkpoints, turnCheckpoints, worktrees) {
      if (Array.isArray(checkpoints)) _latestCheckpointsList = checkpoints;
      if (Array.isArray(turnCheckpoints)) _latestTurnCheckpointsList = turnCheckpoints;
      if (Array.isArray(worktrees)) renderShadowWorktrees(worktrees);
      syncWorkspaceSwitcherBadge();

      document.querySelectorAll('#checkpointsViewGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === _checkpointsViewMode);
      });

      const container = document.getElementById('checkpointsContainer');
      if (!container) return;

      const showProjTag = _selectedWorkspaceMode === '__all__';

      if (_checkpointsViewMode === 'turns' && _latestTurnCheckpointsList.length > 0) {
        let html = '';
        for (let i = 0; i < _latestTurnCheckpointsList.length; i++) {
          const t = _latestTurnCheckpointsList[i];
          const tId = t.turnId || ('turn_' + i);
          const tWs = t.workspaceRoot || '';
          const tProj = t.projectName || getWorkspaceBasename(tWs);
          const title = t.turnLabel || (Array.isArray(t.files) && t.files[0]) || 'Правки хода';
          const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : 'недавно';
          const filesHint = (Array.isArray(t.files) ? t.files.slice(0, 3).join(', ') : '') + (t.filesCount > 3 ? (' +' + (t.filesCount - 3)) : '');
          const diffExtra = (_activeTurnDiffPreview && _activeTurnDiffPreview.turnId === tId)
            ? (' · +' + (_activeTurnDiffPreview.totalAdded || 0) + '/-' + (_activeTurnDiffPreview.totalRemoved || 0) + ' стр.')
            : '';
          const projBadge = (showProjTag && tProj)
            ? ('<button type="button" class="cp-project-badge" data-action="selectPanelWorkspaceChip" data-ws="' + escapeHtml(tWs) + '" title="Переключиться на проект ' + escapeHtml(tWs || tProj) + '">📁 ' + escapeHtml(tProj) + '</button>')
            : '';
          const btnHtml = t.allRestored
            ? '<span style="font-size: 10px; color: var(--accent-cyan); flex-shrink: 0;">✓ Восст. хода</span>'
            : '<div style="display: flex; gap: 3px; flex-shrink: 0;">' +
                '<button type="button" class="win-btn" style="padding: 1px 5px; font-size: 10px;" data-action="showTurnDiff" data-id="' + escapeHtml(tId) + '" data-ws="' + escapeHtml(tWs) + '" title="Показать статистику изменений за ход">Diff</button>' +
                '<button type="button" class="win-btn" style="padding: 1px 6px; font-size: 10px;" data-action="rollbackTurnById" data-id="' + escapeHtml(tId) + '" data-ws="' + escapeHtml(tWs) + '">↶ Ход</button>' +
              '</div>';
          html +=
            '<div class="checkpoint-item">' +
              '<div class="checkpoint-info">' +
                '<div class="checkpoint-file" title="' + escapeHtml(filesHint) + '">' + escapeHtml(title) + '</div>' +
                '<div class="checkpoint-meta">' + projBadge + escapeHtml(time) + ' · ' + escapeHtml(String(t.filesCount || 0)) + ' ф. (' + escapeHtml(filesHint || '—') + ')' + escapeHtml(diffExtra) + '</div>' +
              '</div>' +
              btnHtml +
            '</div>';
        }
        container.innerHTML = html;
        return;
      }

      const list = _latestCheckpointsList;
      if (!list || !list.length) {
        container.innerHTML = '<div style="color: var(--text-sub); font-size: 11px; padding: 4px;">Снимки файлов для выбранного проекта не найдены</div>';
        return;
      }
      let html = '';
      for (let i = 0; i < list.length; i++) {
        const cp = list[i];
        const cpId = cp.id || cp.checkpointId || ('cp_' + i);
        const cpWs = cp.workspaceRoot || '';
        const cpProj = cp.projectName || getWorkspaceBasename(cpWs);
        const file = cp.fileName || cp.file || cp.filePath || 'Файл';
        const fullPath = cp.filePath || file;
        const time = cp.time || (cp.timestamp ? new Date(cp.timestamp).toLocaleTimeString() : 'недавно');
        const isRestored = !!cp.restored;
        const status = isRestored ? 'откачен ✓' : (cp.status || 'сохранён');
        const projBadge = (showProjTag && cpProj)
          ? ('<button type="button" class="cp-project-badge" data-action="selectPanelWorkspaceChip" data-ws="' + escapeHtml(cpWs) + '" title="Переключиться на проект ' + escapeHtml(cpWs || cpProj) + '">📁 ' + escapeHtml(cpProj) + '</button>')
          : '';
        const btnHtml = isRestored
          ? '<span style="font-size: 10px; color: var(--accent-cyan); flex-shrink: 0;">✓ Восст.</span>'
          : '<button type="button" class="win-btn" style="padding: 1px 6px; font-size: 10px; flex-shrink: 0;" data-action="rollbackSpecific" data-id="' + escapeHtml(cpId) + '" data-ws="' + escapeHtml(cpWs) + '">Откат</button>';
        html +=
          '<div class="checkpoint-item">' +
            '<div class="checkpoint-info">' +
              '<div class="checkpoint-file" title="' + escapeHtml(fullPath) + '">' + escapeHtml(file) + '</div>' +
              '<div class="checkpoint-meta">' + projBadge + escapeHtml(time) + ' · ' + escapeHtml(status) + '</div>' +
            '</div>' +
            btnHtml +
          '</div>';
      }
      container.innerHTML = html;
    }

    let _lastSkillsDomSig = '';

    function applySkillsFilterDom() {
      const container = document.getElementById('skillsContainer');
      if (!container) return;
      const items = container.querySelectorAll('.skill-item');
      let visibleCount = 0;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const hay = item.getAttribute('data-search') || '';
        const matches = !currentSkillQuery || hay.indexOf(currentSkillQuery) !== -1;
        item.hidden = !matches;
        if (matches) visibleCount++;
      }
      const emptyEl = document.getElementById('skillsFilterEmptyMsg');
      if (emptyEl) {
        if (visibleCount === 0 && currentSkillQuery) {
          emptyEl.textContent = 'Ничего не найдено по запросу «' + currentSkillQuery + '»';
          emptyEl.hidden = false;
        } else {
          emptyEl.hidden = true;
        }
      }
    }

    function renderSkills(skills, skillModes) {
      discoveredSkills = skills || discoveredSkills || [];
      const modes = skillModes || currentState.skillModes || {};
      const container = document.getElementById('skillsContainer');
      if (!container) return;

      let offCount = 0;
      const sigParts = [];
      for (let i = 0; i < discoveredSkills.length; i++) {
        const sk = discoveredSkills[i];
        if (modes[sk.id] === 'off') offCount++;
        const humanTitle = sk.title || sk.id;
        sigParts.push(String(sk.id || '') + '\x1f' + String(humanTitle) + '\x1f' + String(sk.hint || ''));
      }

      const summaryLabel = document.getElementById('skillsSummaryLabel');
      if (summaryLabel) {
        summaryLabel.textContent = offCount > 0
          ? ('Авто: ' + (discoveredSkills.length - offCount) + ', Выкл: ' + offCount)
          : ('Все ' + discoveredSkills.length + ' в умном Авто-режиме');
      }

      if (!discoveredSkills.length) {
        _lastSkillsDomSig = '';
        container.innerHTML = '<div style="color: var(--text-sub); font-size: 11px; padding: 4px;">Все возможности управляются ИИ-автопилотом</div>';
        return;
      }

      const structSig = sigParts.join('\x1e');
      if (structSig === _lastSkillsDomSig && container.querySelector('.skill-item')) {
        const items = container.querySelectorAll('.skill-item');
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const skId = item.getAttribute('data-skill-id') || '';
          const mode = modes[skId] === 'off' ? 'off' : 'auto';
          const btns = item.querySelectorAll('.skill-btn');
          for (let b = 0; b < btns.length; b++) {
            const btnMode = btns[b].getAttribute('data-mode');
            btns[b].classList.toggle('active-auto', btnMode === 'auto' && mode === 'auto');
            btns[b].classList.toggle('active-off', btnMode === 'off' && mode === 'off');
          }
        }
        applySkillsFilterDom();
        return;
      }

      let rowsHtml = '';
      for (let i = 0; i < discoveredSkills.length; i++) {
        const sk = discoveredSkills[i];
        const mode = modes[sk.id] === 'off' ? 'off' : 'auto';
        const humanTitle = sk.title || sk.id;
        const searchHay = (String(humanTitle) + ' ' + String(sk.id || '') + ' ' + String(sk.hint || '')).toLowerCase();

        rowsHtml +=
          '<div class="skill-item" data-skill-id="' + escapeHtml(sk.id) + '" data-search="' + escapeHtml(searchHay) + '">' +
            '<div class="skill-info">' +
              '<div class="skill-title">' +
                '<span>' + escapeHtml(humanTitle) + '</span>' +
                '<span class="skill-id-tag">' + escapeHtml(sk.id) + '</span>' +
              '</div>' +
              '<div class="skill-hint">' + escapeHtml(sk.hint) + '</div>' +
            '</div>' +
            '<div class="skill-mode-group">' +
              '<button type="button" class="skill-btn' + (mode === 'auto' ? ' active-auto' : '') + '" data-action="setSkillMode" data-skill="' + escapeHtml(sk.id) + '" data-mode="auto" title="ИИ сам включает этот навык только тогда, когда вы просите подходящую задачу">Авто (ИИ сам)</button>' +
              '<button type="button" class="skill-btn' + (mode === 'off' ? ' active-off' : '') + '" data-action="setSkillMode" data-skill="' + escapeHtml(sk.id) + '" data-mode="off" title="Временно запретить использование этого навыка">Выкл</button>' +
            '</div>' +
          '</div>';
      }
      rowsHtml += '<div id="skillsFilterEmptyMsg" style="color: var(--text-sub); font-size: 11px; padding: 6px;" hidden></div>';
      container.innerHTML = rowsHtml;
      _lastSkillsDomSig = structSig;
      applySkillsFilterDom();
    }

    function renderCircuitBreaker(cb) {
      const dot = document.getElementById('circuitDot');
      const badge = document.getElementById('circuitBadgeText');
      const reasonEl = document.getElementById('circuitReason');
      if (!dot || !badge || !reasonEl) return;

      const st = (cb && cb.status) ? String(cb.status).toUpperCase() : 'CLOSED';
      const count = Number(cb && cb.repeatCount !== undefined ? cb.repeatCount : 0);
      const reason = (cb && cb.reason) ? String(cb.reason) : '';

      if (st === 'TRIPPED') {
        dot.className = 'circuit-dot tripped';
        badge.textContent = 'БЛОКИРОВКА ЦИКЛА (' + (count || 3) + '/3)';
        badge.style.color = 'var(--status-err)';
        reasonEl.textContent = reason || 'Автомат сработал: обнаружено 3-кратное зацикливание правок!';
      } else if (st === 'WARNING') {
        dot.className = 'circuit-dot warning';
        badge.textContent = 'ВНИМАНИЕ (' + count + '/3)';
        badge.style.color = 'var(--status-warn)';
        reasonEl.textContent = reason || 'Повторяющиеся ошибки в шагах: риск срабатывания стоп-крана.';
      } else {
        dot.className = 'circuit-dot closed';
        badge.textContent = 'НОРМА (' + count + '/3)';
        badge.style.color = 'var(--status-ok)';
        reasonEl.textContent = reason || 'Автомат замкнут. Защита от зацикливания правок активна.';
      }
    }

    function renderCompaction(comp) {
      const label = document.getElementById('compactionLabel');
      const bar = document.getElementById('compactionBar');
      if (!label || !bar) return;

      const epoch = Number(comp && comp.epoch !== undefined ? comp.epoch : 0);
      const fill = Math.max(0, Math.min(100, Math.round(comp && comp.fillPercent !== undefined ? comp.fillPercent : 0)));
      const fallbackThresh = (currentState && Number(currentState.compactionTokenThreshold)) || 120000;
      const threshK = formatK(comp && comp.thresholdTokens ? comp.thresholdTokens : fallbackThresh);
      const totalTok = Number(comp && comp.lastPromptTokens ? comp.lastPromptTokens : 0);
      const totalSuffix = epoch > 0 && totalTok > 0 ? ' (всего ' + formatK(totalTok) + ')' : '';

      label.textContent = 'Эпоха #' + epoch + ' · ' + fill + '% от ' + threshK + totalSuffix;
      bar.style.width = fill + '%';
    }

    function syncFooterPluginVersion(pluginVersion) {
      if (!pluginVersion) return;
      const cleanVer = String(pluginVersion).trim();
      if (!cleanVer) return;
      const el = document.getElementById('footerPluginVersion');
      if (el) el.textContent = 'The Tunnel v' + cleanVer;
    }

    function renderPitfalls(pitfalls) {
      const container = document.getElementById('pitfallsContainer');
      if (!container) return;

      if (!pitfalls || !Array.isArray(pitfalls) || pitfalls.length === 0) {
        container.innerHTML = '<div style="color: var(--text-sub); font-size: 10.5px; padding: 2px;">Пока нет зафиксированных сбоев/откатов</div>';
        return;
      }

      let html = '';
      for (let i = 0; i < pitfalls.length; i++) {
        const item = pitfalls[i];
        const text = typeof item === 'string' ? item : (item.rule || item.message || JSON.stringify(item));
        html +=
          '<div class="pitfall-item">' +
            '<span class="pitfall-bullet">⚠</span>' +
            '<span>' + escapeHtml(text) + '</span>' +
          '</div>';
      }
      container.innerHTML = html;
    }

    function renderKnowledgeHub(recipes, peers, stats) {
      if (Array.isArray(recipes)) _latestVictoryRecipes = recipes;
      if (Array.isArray(peers)) _latestFederatedPeers = peers;
      if (stats !== undefined) _latestKnowledgeStats = stats;

      const boxEl = document.getElementById('expertKnowledgeBox');
      const badge = document.getElementById('knowledgeStatsBadge');
      const extStatsEl = document.getElementById('knowledgeExtendedStats');
      const recBox = document.getElementById('victoryRecipesContainer');
      const peerBox = document.getElementById('federatedPeersContainer');
      const peerInp = document.getElementById('federatedPeerInput');
      const addBtn = boxEl ? boxEl.querySelector('[data-action="addFederatedPeer"]') : null;
      const clearBtn = boxEl ? boxEl.querySelector('[data-action="clearVictoryRecipes"]') : null;
      const epBtn = boxEl ? boxEl.querySelector('[data-action="loadSessionEpisodes"]') : null;

      const sqlEnabled = !currentState || currentState.sqliteKnowledgeEnabled !== false;
      if (peerInp) peerInp.disabled = !sqlEnabled;
      if (addBtn) addBtn.disabled = !sqlEnabled;
      if (clearBtn) clearBtn.disabled = !sqlEnabled;
      if (epBtn) epBtn.disabled = !sqlEnabled;

      const rList = _latestVictoryRecipes;
      const pList = _latestFederatedPeers;
      const curStats = _latestKnowledgeStats;
      if (badge) {
        if (!sqlEnabled) {
          badge.textContent = 'Откл.';
        } else {
          const astCnt = curStats && Number(curStats.astCachedFilesCount || 0);
          badge.textContent = rList.length + ' рец.' + (astCnt > 0 ? ' · AST:' + astCnt : '');
        }
      }
      if (extStatsEl) {
        if (!sqlEnabled) {
          extStatsEl.textContent = 'NVMe-память отключена';
        } else {
          const stObj = curStats && typeof curStats === 'object' ? curStats : {};
          const epCnt = Number(stObj.sessionEpisodesCount || 0);
          const ccrCnt = Number(stObj.ccrBlobsCount || 0);
          const repCnt = Number(stObj.repairBucketsCount || 0);
          const instCnt = Number(stObj.instinctsCount || 0);
          extStatsEl.textContent = 'Эпизоды: ' + epCnt + ' · CCR-блобы: ' + ccrCnt + ' · RepairKV: ' + repCnt + ' · Инстинкты: ' + instCnt;
        }
      }
      if (recBox) {
        if (!sqlEnabled) {
          recBox.innerHTML = '<div style="color: var(--text-sub); font-size: 10.5px; padding: 2px;">NVMe-память (SQLite) отключена в настройках</div>';
        } else if (rList.length === 0) {
          recBox.innerHTML = '<div style="color: var(--text-sub); font-size: 10.5px; padding: 2px;">Рецепты записываются автоматически при починке тестов</div>';
        } else {
          recBox.innerHTML = rList.slice(0, 8).map(function (r) {
            const label = (r.errorExcerpt ? r.errorExcerpt + ' → ' : '') + (r.fixSummary || '');
            return '<div class="pitfall-item"><span class="pitfall-bullet">🏆</span><span>' + escapeHtml(label) + '</span></div>';
          }).join('');
        }
      }
      if (peerBox) {
        if (!sqlEnabled) {
          peerBox.innerHTML = '<span>Кросс-репо поиск приостановлен</span>';
        } else if (pList.length === 0) {
          peerBox.innerHTML = '<span>Связанных репозиториев нет</span>';
        } else {
          peerBox.innerHTML = pList.map(function (p) {
            const pPath = typeof p === 'string' ? p : (p.path || '');
            const pLbl = typeof p === 'string' ? p : (p.label || pPath);
            return '<span class="composer-chip-btn" style="margin:2px 4px 2px 0; display:inline-flex; align-items:center; gap:4px;">' +
              '🔗 ' + escapeHtml(pLbl) +
              ' <button type="button" class="win-btn" style="padding:0 4px;font-size:10px;" data-action="removeFederatedPeer" data-arg="' + escapeHtml(pPath) + '">×</button>' +
              '</span>';
          }).join('');
        }
      }
    }

    const BLOCK_REQUIRED_SECTIONS = {
      skillsSectionCard: ['skills'],
      agentModeCard: ['circuit'],
      swarmTelemetryCard: ['swarm'],
      gpuRamCard: ['hw'],
      sentinelSectionCard: ['hw'],
      snapshotsBayesianSpoiler: ['checkpoints', 'bayesian'],
      checkpointsCard: ['checkpoints'],
      intelligenceBayesianCard: ['bayesian'],
      expertDetailsBox: ['circuit', 'compaction', 'pitfalls'],
      expertCircuitBox: ['circuit'],
      expertPitfallsBox: ['pitfalls'],
      expertKnowledgeBox: ['pitfalls'],
      expertGuardrailsCard: ['compaction'],
      expertRamGpuFieldset: ['hw'],
    };
    const _visibleBlockIds = new Set();
    let _blockIntersectionObserver = null;
    let _blockObserverReady = false;
    const _pendingBlockRenders = Object.create(null);
    const _loadedPanelSections = new Set();
    const _inFlightPanelSections = new Set();
    let _pendingHwRenderArgs = null;

    function isBlockRenderable(blockId) {
      const el = document.getElementById(blockId);
      if (!el) return false;
      if (el.classList.contains('is-collapsed')) return false;
      const collapsedAncestor = el.closest && el.closest('.lg-card.is-collapsed');
      if (collapsedAncestor) return false;
      if (el.tagName === 'DETAILS') {
        if (!el.open) return false;
      } else {
        const parentDetails = el.closest && el.closest('details');
        if (parentDetails && !parentDetails.open) return false;
      }
      if (_blockObserverReady && _visibleBlockIds.size > 0) {
        if (_visibleBlockIds.has(blockId)) return true;
        const parentDetails = el.closest && el.closest('details');
        if (parentDetails && parentDetails.id && _visibleBlockIds.has(parentDetails.id)) {
          return true;
        }
        return false;
      }
      return true;
    }

    function scheduleBlockRender(blockId, fn) {
      _pendingBlockRenders[blockId] = fn;
      if (isBlockRenderable(blockId)) {
        delete _pendingBlockRenders[blockId];
        fn();
      }
    }

    function scheduleHwBlockRender(gpu, ramCache, s, cpu) {
      if (typeof syncHwHeaderSummaryBadge === 'function') {
        syncHwHeaderSummaryBadge(s, gpu, ramCache);
      }
      const sentinelSnap = lastPayloadCache ? lastPayloadCache.sentinel : null;
      if (sentinelSnap !== undefined && sentinelSnap !== null) {
        scheduleBlockRender('sentinelSectionCard', function () {
          renderSentinelStatus(sentinelSnap, s);
        });
      }
      _pendingHwRenderArgs = { gpu: gpu, ramCache: ramCache, s: s, cpu: cpu };
      const runHwOnce = function () {
        if (!_pendingHwRenderArgs) return;
        const args = _pendingHwRenderArgs;
        _pendingHwRenderArgs = null;
        delete _pendingBlockRenders.gpuRamCard;
        delete _pendingBlockRenders.expertRamGpuFieldset;
        renderGpuAndRam(args.gpu, args.ramCache, args.s, args.cpu);
      };
      if (isBlockRenderable('gpuRamCard') || isBlockRenderable('expertRamGpuFieldset')) {
        runHwOnce();
        return;
      }
      _pendingBlockRenders.gpuRamCard = runHwOnce;
      _pendingBlockRenders.expertRamGpuFieldset = runHwOnce;
    }

    function flushVisibleBlockRenders() {
      const keys = Object.keys(_pendingBlockRenders);
      for (let i = 0; i < keys.length; i++) {
        const blockId = keys[i];
        const fn = _pendingBlockRenders[blockId];
        if (typeof fn === 'function' && isBlockRenderable(blockId)) {
          delete _pendingBlockRenders[blockId];
          fn();
        }
      }
    }

    function syncLoadedSectionsFromPayload(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (Array.isArray(payload.includedSections)) {
        for (let i = 0; i < payload.includedSections.length; i++) {
          _loadedPanelSections.add(payload.includedSections[i]);
        }
        return;
      }
      if (payload.telemetry !== undefined) {
        _loadedPanelSections.add('core');
        _loadedPanelSections.add('swarm');
      }
      if (payload.skills !== undefined) _loadedPanelSections.add('skills');
      if (payload.checkpoints !== undefined) _loadedPanelSections.add('checkpoints');
      if (payload.bayesian !== undefined) _loadedPanelSections.add('bayesian');
      if (payload.circuitBreaker !== undefined) _loadedPanelSections.add('circuit');
      if (payload.compaction !== undefined) _loadedPanelSections.add('compaction');
      if (payload.pitfalls !== undefined) _loadedPanelSections.add('pitfalls');
      if (payload.gpu !== undefined || payload.ramCache !== undefined || payload.cpu !== undefined) {
        _loadedPanelSections.add('hw');
      }
    }

    async function ensurePanelSectionsLoaded(sectionNames) {
      if (!Array.isArray(sectionNames) || sectionNames.length === 0) return null;
      const missing = [];
      for (let i = 0; i < sectionNames.length; i++) {
        const sec = sectionNames[i];
        if (!sec || _loadedPanelSections.has(sec) || _inFlightPanelSections.has(sec)) continue;
        if (missing.indexOf(sec) === -1) missing.push(sec);
      }
      if (missing.length === 0) return null;
      for (let i = 0; i < missing.length; i++) {
        _inFlightPanelSections.add(missing[i]);
      }
      try {
        const res = await panelFetch('/api/panel-sections?sections=' + encodeURIComponent(missing.join(',')), { method: 'GET' });
        if (!res || !res.ok) return null;
        const data = await res.json();
        if (!data || data.ok === false) return null;
        for (let i = 0; i < missing.length; i++) {
          _loadedPanelSections.add(missing[i]);
        }
        if (Array.isArray(data.includedSections)) {
          for (let i = 0; i < data.includedSections.length; i++) {
            _loadedPanelSections.add(data.includedSections[i]);
          }
        }
        if (!lastPayloadCache) {
          lastPayloadCache = { state: currentState };
        }
        if (data.skills !== undefined) lastPayloadCache.skills = data.skills;
        if (data.checkpoints !== undefined) lastPayloadCache.checkpoints = data.checkpoints;
        if (data.turnCheckpoints !== undefined) lastPayloadCache.turnCheckpoints = data.turnCheckpoints;
        if (data.shadowWorktrees !== undefined) lastPayloadCache.shadowWorktrees = data.shadowWorktrees;
        if (data.pitfalls !== undefined) lastPayloadCache.pitfalls = data.pitfalls;
        if (data.bayesian !== undefined) lastPayloadCache.bayesian = data.bayesian;
        if (data.circuitBreaker !== undefined) lastPayloadCache.circuitBreaker = data.circuitBreaker;
        if (data.compaction !== undefined) lastPayloadCache.compaction = data.compaction;
        if (data.ramCache !== undefined) lastPayloadCache.ramCache = data.ramCache;
        if (data.gpu !== undefined) lastPayloadCache.gpu = data.gpu;
        if (data.cpu !== undefined) lastPayloadCache.cpu = data.cpu;
        if (data.sentinel !== undefined) lastPayloadCache.sentinel = data.sentinel;
        if (data.hardwareProfile !== undefined) {
          lastPayloadCache.hardwareProfile = data.hardwareProfile;
          currentHardwareProfile = data.hardwareProfile;
        }
        if (data.hardwareCeilings) {
          lastPayloadCache.hardwareCeilings = data.hardwareCeilings;
          currentHardwareCeilings = data.hardwareCeilings;
        } else if (data.hardwareProfile && data.hardwareProfile.hardwareCeilings) {
          currentHardwareCeilings = data.hardwareProfile.hardwareCeilings;
        }

        if (data.skills !== undefined) {
          scheduleBlockRender('skillsSectionCard', function () {
            renderSkills(data.skills, currentState.skillModes);
          });
        }
        if (data.checkpoints !== undefined || data.turnCheckpoints !== undefined || data.shadowWorktrees !== undefined) {
          scheduleBlockRender('checkpointsCard', function () {
            renderCheckpoints(data.checkpoints, data.turnCheckpoints, data.shadowWorktrees);
          });
        }
        if (data.pitfalls !== undefined) {
          scheduleBlockRender('expertPitfallsBox', function () {
            renderPitfalls(data.pitfalls);
            renderKnowledgeHub(data.victoryRecipes, data.federatedPeers, data.knowledgeStats);
          });
        }
        if (data.bayesian !== undefined) {
          scheduleBlockRender('intelligenceBayesianCard', function () {
            renderBayesian(data.bayesian, currentState);
          });
        }
        if (data.circuitBreaker !== undefined) {
          scheduleBlockRender('expertCircuitBox', function () {
            renderCircuitBreaker(data.circuitBreaker);
          });
          updateAutopilotLiveText(currentState, data.circuitBreaker);
        }
        if (data.compaction !== undefined) {
          scheduleBlockRender('expertGuardrailsCard', function () {
            renderCompaction(data.compaction);
          });
        }
        if (data.gpu !== undefined || data.ramCache !== undefined || data.cpu !== undefined) {
          scheduleHwBlockRender(
            data.gpu !== undefined ? data.gpu : lastPayloadCache.gpu,
            data.ramCache !== undefined ? data.ramCache : lastPayloadCache.ramCache,
            currentState,
            data.cpu !== undefined ? data.cpu : lastPayloadCache.cpu
          );
        }
        if (data.sentinel !== undefined) {
          scheduleBlockRender('sentinelSectionCard', function () {
            renderSentinelStatus(data.sentinel, currentState);
          });
        }
        return data;
      } catch (e) {
        return null;
      } finally {
        for (let i = 0; i < missing.length; i++) {
          _inFlightPanelSections.delete(missing[i]);
        }
      }
    }

    function maybeLoadMissingSectionsForBlock(blockId) {
      const req = BLOCK_REQUIRED_SECTIONS[blockId];
      if (!req || req.length === 0) return;
      if (!isBlockRenderable(blockId)) return;
      void ensurePanelSectionsLoaded(req);
    }

    function computeActiveTelemetrySections() {
      const secs = ['core'];
      if (isBlockRenderable('swarmTelemetryCard')) {
        secs.push('swarm');
      }
      if (isBlockRenderable('expertCircuitBox') || isBlockRenderable('agentModeCard')) {
        secs.push('circuit');
      }
      if (isBlockRenderable('expertDetailsBox') || isBlockRenderable('expertGuardrailsCard')) {
        secs.push('compaction');
      }
      if (
        isBlockRenderable('gpuRamCard') ||
        isBlockRenderable('sentinelSectionCard') ||
        isBlockRenderable('expertRamGpuFieldset') ||
        _gpuPullActiveUi
      ) {
        secs.push('hw');
      }
      if (isBlockRenderable('intelligenceBayesianCard')) {
        secs.push('bayesian');
      }
      return secs;
    }

    function refreshBlockVisibilityObserver() {
      if (!_blockIntersectionObserver) return;
      _blockIntersectionObserver.disconnect();
      for (let i = 0; i < DEFAULT_PANEL_BLOCK_ORDER.length; i++) {
        const el = document.getElementById(DEFAULT_PANEL_BLOCK_ORDER[i]);
        if (el) _blockIntersectionObserver.observe(el);
      }
    }

    function initBlockVisibilityObserver() {
      if (typeof window.IntersectionObserver !== 'function') return;
      if (_blockIntersectionObserver) {
        refreshBlockVisibilityObserver();
        return;
      }
      _blockIntersectionObserver = new IntersectionObserver(function (entries) {
        const becameVisible = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const id = entry && entry.target ? entry.target.id : '';
          if (!id) continue;
          if (entry.isIntersecting) {
            _visibleBlockIds.add(id);
            entry.target.classList.remove('is-offscreen');
            becameVisible.push(id);
          } else {
            _visibleBlockIds.delete(id);
            entry.target.classList.add('is-offscreen');
          }
        }
        _blockObserverReady = true;
        if (becameVisible.length > 0) {
          flushVisibleBlockRenders();
          for (let i = 0; i < becameVisible.length; i++) {
            maybeLoadMissingSectionsForBlock(becameVisible[i]);
          }
        }
      }, { root: null, rootMargin: '140px 0px', threshold: 0.01 });
      refreshBlockVisibilityObserver();
    }

    function renderPayload(payload) {
      if (payload && payload.state && (payload.telemetry || payload.gpu || payload.skills || payload.includedSections)) {
        lastPayloadCache = payload;
      }
      syncLoadedSectionsFromPayload(payload);
      if (payload && payload.pluginVersion) {
        syncFooterPluginVersion(payload.pluginVersion);
      }
      if (payload && (payload.knownWorkspaces || payload.activeWorkspace || payload.autoWorkspace)) {
        renderWorkspaceSwitcher(payload);
      } else {
        syncWorkspaceSwitcherBadge();
      }
      const s = payload && payload.state ? payload.state : (payload || {});
      currentState = s;
      const wizModalOpenEarly = document.getElementById('onboardingWizardModal')?.classList.contains('visible');
      const activeLangEarly = (wizModalOpenEarly && wizLangPreviewDirty)
        ? normalizeUiLanguage(wizDraft.uiLanguage || s.uiLanguage)
        : normalizeUiLanguage(s.uiLanguage);
      if (typeof applyUiLanguageDom === 'function') {
        applyUiLanguageDom(activeLangEarly);
      }
      ensureBlockMoveControls();
      applyPanelBlockOrder(s.panelBlockOrder, Array.isArray(s.panelBlockOrder));
      applyAllCollapsedCardsState(s.panelCollapsedCards);
      applyAllSpoilersOpenState(s.panelOpenSpoilers);
      const isAdvisor = s.confirmBeforeRun !== false;
      const confirmThr = s.confirmThreshold || 'M';

      document.getElementById('mode-advisor').className = 'mode-card' + (isAdvisor ? ' active-card' : '');
      document.getElementById('mode-autopilot').className = 'mode-card' + (!isAdvisor ? ' active-card' : '');

      document.getElementById('advisorBox').className = 'sub-settings' + (isAdvisor ? ' visible' : '');
      document.getElementById('autopilotBox').className = 'sub-settings' + (!isAdvisor ? ' visible' : '');

      document.querySelectorAll('#confirmThresholdGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === confirmThr);
      });

      const wizModalOpen = document.getElementById('onboardingWizardModal')?.classList.contains('visible');
      const activeSubTier = (wizModalOpen && wizSubTierPreviewDirty)
        ? (wizDraft.subscriptionTier === 'ultra' ? 'ultra' : 'pro')
        : (s.subscriptionTier === 'ultra' ? 'ultra' : 'pro');
      applySubscriptionTierDom(activeSubTier);

      document.querySelectorAll('#strategyGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === s.strategy);
      });

      document.querySelectorAll('#thresholdGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === s.heavyThreshold);
      });

      const activeSwarmMode = s.swarmMode || 'auto_xl';
      document.querySelectorAll('#swarmModeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeSwarmMode);
      });

      const rawSwarmTier = s.swarmWorkerTier || 'hydrogen_auto';
      const activeSwarmTier = activeSubTier === 'pro' && rawSwarmTier === 'carbon_auto'
        ? 'neon_auto'
        : (activeSubTier === 'pro' && rawSwarmTier === 'argon_auto' ? 'hydrogen_auto' : rawSwarmTier);
      document.querySelectorAll('#swarmWorkerTierGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeSwarmTier);
      });

      const activeTheme = (wizModalOpen && wizThemePreviewDirty)
        ? normalizeUiTheme(wizDraft.panelTheme || s.panelTheme)
        : normalizeUiTheme(s.panelTheme);
      document.body.setAttribute('data-panel-theme', activeTheme);
      document.querySelectorAll('#panelThemeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.theme === activeTheme);
      });

      const activeLang = (wizModalOpen && wizLangPreviewDirty)
        ? normalizeUiLanguage(wizDraft.uiLanguage || s.uiLanguage)
        : normalizeUiLanguage(s.uiLanguage);
      if (typeof applyUiLanguageDom === 'function') {
        applyUiLanguageDom(activeLang);
      }

      const swVerifierEl = document.getElementById('chk-swarmAutoVerifier');
      if (swVerifierEl) swVerifierEl.checked = s.swarmAutoVerifier !== false;
      const swQuotaEl = document.getElementById('chk-swarmQuotaFailover');
      if (swQuotaEl) swQuotaEl.checked = s.swarmQuotaFailover !== false;

      const designGateOn = s.uiDesignPreviewGate !== false;
      document.querySelectorAll('#uiDesignGateGroup button').forEach((btn) => {
        btn.classList.toggle('active', (btn.dataset.val === 'on') === designGateOn);
      });

      const activeUiInspMode = (s.uiInspirationMode === 'showroom' || s.uiInspirationMode === 'web_refs')
        ? s.uiInspirationMode
        : 'ask';
      document.querySelectorAll('#uiInspirationModeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeUiInspMode);
      });
      const inspRowEl = document.getElementById('uiInspirationModeRow');
      if (inspRowEl) {
        inspRowEl.style.opacity = designGateOn ? '1' : '0.5';
      }
      const inspHintEl = document.getElementById('uiInspirationModeHint');
      if (inspHintEl) {
        if (!designGateOn) {
          inspHintEl.textContent = L(
            'Превью-гейт отключён: включите показ примеров выше, чтобы использовать витрину A/B/C или поиск веб-референсов.',
            'Preview gate is off: enable previews above to use the A/B/C showroom or web reference search.'
          );
        } else if (activeUiInspMode === 'showroom') {
          inspHintEl.textContent = L(
            'Режим «Витрина A/B/C»: ИИ сразу спросит желаемый стиль и соберёт 3 авторских интерактивных прототипа без веб-поиска.',
            '"A/B/C Showroom" mode: AI asks your style preference and builds 3 custom interactive prototypes without web search.'
          );
        } else if (activeUiInspMode === 'web_refs') {
          inspHintEl.textContent = L(
            'Режим «Веб-референсы»: ИИ спросит стиль и соберёт 3 открытых референса + CSS-токены через локальный Zero-LLM экстрактор и кэш (минимум токенов).',
            '"Web Refs" mode: AI gathers 3 live references + CSS tokens via the local Zero-LLM extractor & cache (minimal tokens).'
          );
        } else {
          inspHintEl.textContent = L(
            'Режим «Спрашивать»: ИИ предложит выбор между 3 локальными прототипами A/B/C, поиском живых примеров в сети (21st.dev, Godly, CodePen и др.) и гибридом.',
            '"Ask" mode: AI offers a choice between 3 local A/B/C prototypes, live web references (21st.dev, Godly, CodePen, etc.), or a hybrid.'
          );
        }
      }

      const activeGrillMode = (s.grillMode === 'off' || s.grillMode === 'always') ? s.grillMode : 'auto';
      document.querySelectorAll('#grillModeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeGrillMode);
      });
      const grillHintEl = document.getElementById('grillModeHint');
      if (grillHintEl) {
        if (activeGrillMode === 'off') {
          grillHintEl.textContent = L(
            'Режим «Выкл»: детальный опрос не предлагается (можно включить разово кнопкой «🔥 Опрос» в Композере).',
            '"Off" mode: deep interview is not offered automatically (you can trigger it once via "🔥 Grill-Me" in Composer).'
          );
        } else if (activeGrillMode === 'always') {
          grillHintEl.textContent = L(
            'Режим «Всегда»: перед кодом агент проверяет дерево решений и уточняет независимые развилки раундами.',
            '"Always" mode: before coding, the agent walks the decision tree and clarifies open design forks in rounds.'
          );
        } else {
          grillHintEl.textContent = L(
            'Режим «Авто M+»: предлагает детальный опрос по развилкам в стартовом окне на крупных или новых задачах.',
            '"Auto M+" mode: offers a decision-tree interview in the Pre-Task Gate for large or ambiguous tasks.'
          );
        }
      }

      // Оформление ответов, связка с Orchestrator и кристаллизация навыков
      const orchSynEl = document.getElementById('chk-orchestratorSmartSynergy');
      if (orchSynEl) orchSynEl.checked = s.orchestratorSmartSynergy !== false;
      const showBadgeEl = document.getElementById('chk-showBadge');
      if (showBadgeEl) showBadgeEl.checked = !!s.showBadge;
      const skillCrysEl = document.getElementById('chk-skillCrystallizer');
      if (skillCrysEl) skillCrysEl.checked = s.skillCrystallizer !== false;

      const activeHookProfile = (s.hookProfile === 'minimal' || s.hookProfile === 'strict') ? s.hookProfile : 'standard';
      document.querySelectorAll('#hookProfileGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeHookProfile);
      });
      const hookProfileHintEl = document.getElementById('hookProfileHint');
      if (hookProfileHintEl) {
        if (activeHookProfile === 'minimal') {
          hookProfileHintEl.textContent = L(
            'Профиль «Лёгкий»: отключены тяжёлые каскады и мутационные проверки — минимум задержек.',
            '"Minimal" profile: disables heavy cascade & mutation checks for lowest latency.'
          );
        } else if (activeHookProfile === 'strict') {
          hookProfileHintEl.textContent = L(
            'Профиль «Строгий»: принудительно активны все щиты, LSP и защита конфигов линтеров.',
            '"Strict" profile: forces all shields, LSP and linter config protection on.'
          );
        } else {
          hookProfileHintEl.textContent = L(
            'Профиль «Стандарт»: действуют ваши индивидуальные переключатели контуров.',
            '"Standard" profile: uses your individual contour toggles below.'
          );
        }
      }

      // 24 ключевые системы разведки, мышления и защиты ИИ-Пилота
      const guardrailModules = [
        'repoMap', 'pageRankGraph', 'zeroTurnSlices', 'sessionHandoff', 'pitfallLedger',
        'thinkingLimiter', 'bayesianRouter', 'toolPruning', 'readDedup', 'obsMasking', 'historyCompaction',
        'diffOnly', 'transactionalPatch', 'shadowCheckpoints', 'shadowWorktreeEnabled', 'blastRadius',
        'selfVerify', 'cascadeVerify', 'testImpactVerify', 'circuitBreaker', 'securityGuard', 'configProtection',
        'completionGates', 'runtimeWiretapEnabled', 'quotaPacerEnabled'
      ];
      for (let i = 0; i < guardrailModules.length; i++) {
        const k = guardrailModules[i];
        const el = document.getElementById('chk-' + k);
        if (el) el.checked = s[k] !== false;
      }
      const chkVoiceComp = document.getElementById('chk-composerVoiceEnabled');
      if (chkVoiceComp) chkVoiceComp.checked = Boolean(s.composerVoiceEnabled);
      const chkMutGuard = document.getElementById('chk-mutationGuardEnabled');
      if (chkMutGuard) chkMutGuard.checked = Boolean(s.mutationGuardEnabled);
      const voiceBtnEl = document.getElementById('btnVoiceComposer');
      if (voiceBtnEl) voiceBtnEl.style.display = s.composerVoiceEnabled ? 'inline-flex' : 'none';

      if (payload && (payload.wiretapFaults !== undefined || payload.quotaPacer !== undefined)) {
        renderWiretapAndQuota(payload.wiretapFaults, payload.quotaPacer);
      }

      if (payload && payload.skills !== undefined) {
        scheduleBlockRender('skillsSectionCard', function () {
          renderSkills(payload.skills, s.skillModes);
        });
      } else if (discoveredSkills.length > 0) {
        scheduleBlockRender('skillsSectionCard', function () {
          renderSkills(discoveredSkills, s.skillModes);
        });
      }

      if (payload && payload.telemetry) {
        updateHeaderSessionPill(payload.telemetry);
        syncSwarmHeaderPills(payload.telemetry, s);
        scheduleBlockRender('swarmTelemetryCard', function () {
          renderTelemetry(payload.telemetry);
        });
      } else {
        syncSwarmHeaderPills(null, s);
        scheduleBlockRender('swarmTelemetryCard', function () {
          renderSwarmTelemetry(null, s);
        });
      }

      if (payload && (payload.checkpoints !== undefined || payload.turnCheckpoints !== undefined || payload.shadowWorktrees !== undefined)) {
        scheduleBlockRender('checkpointsCard', function () {
          renderCheckpoints(payload.checkpoints, payload.turnCheckpoints, payload.shadowWorktrees);
        });
      } else {
        renderShadowWorktrees();
      }

      if (payload && payload.hardwareProfile) {
        currentHardwareProfile = payload.hardwareProfile;
      }
      if (payload && payload.hardwareCeilings) {
        currentHardwareCeilings = payload.hardwareCeilings;
      } else if (payload && payload.hardwareProfile && payload.hardwareProfile.hardwareCeilings) {
        currentHardwareCeilings = payload.hardwareProfile.hardwareCeilings;
      }
      if (payload && payload.circuitBreaker !== undefined) {
        scheduleBlockRender('expertCircuitBox', function () {
          renderCircuitBreaker(payload.circuitBreaker);
        });
      }
      if (payload && payload.compaction !== undefined) {
        scheduleBlockRender('expertGuardrailsCard', function () {
          renderCompaction(payload.compaction);
        });
      }
      if (payload && payload.pitfalls !== undefined) {
        scheduleBlockRender('expertPitfallsBox', function () {
          renderPitfalls(payload.pitfalls);
        });
        scheduleBlockRender('expertKnowledgeBox', function () {
          renderKnowledgeHub(payload.victoryRecipes, payload.federatedPeers, payload.knowledgeStats);
        });
      } else {
        renderKnowledgeHub();
      }
      if (payload && payload.bayesian !== undefined) {
        scheduleBlockRender('intelligenceBayesianCard', function () {
          renderBayesian(payload.bayesian, s);
        });
      }
      syncSentinelCheckboxes(s);
      const selCompThresh = document.getElementById('sel-compactionThreshold');
      if (selCompThresh && document.activeElement !== selCompThresh) {
        const curThresh = String(s.compactionTokenThreshold || 120000);
        if (selCompThresh.querySelector('option[value="' + curThresh + '"]')) {
          selCompThresh.value = curThresh;
        }
      }
      applyHookProfileOverridesToUi(activeHookProfile);
      if (typeof syncHwHeaderSummaryBadge === 'function') {
        syncHwHeaderSummaryBadge(
          s,
          payload ? (payload.gpu || null) : null,
          payload ? (payload.ramCache || null) : null
        );
      }
      if (
        (payload && (payload.gpu !== undefined || payload.ramCache !== undefined || payload.cpu !== undefined)) ||
        isBlockRenderable('expertRamGpuFieldset')
      ) {
        scheduleHwBlockRender(
          payload ? (payload.gpu || null) : null,
          payload ? (payload.ramCache || null) : null,
          s,
          payload ? (payload.cpu || null) : null
        );
      }
      if (payload && payload.sentinel !== undefined) {
        scheduleBlockRender('sentinelSectionCard', function () {
          renderSentinelStatus(payload.sentinel, s);
        });
      }
      renderTaskProgressAndHud(payload ? payload.taskProgress : null, payload ? payload.floatingHud : null, s);

      // Смарт-баннер разговорного ИИ-пилота, профиль воркспейса и авто-запуск Мастера
      if (payload && payload.projectDetection) {
        detectedProjectInfo = payload.projectDetection;
        const bannerTextEl = document.getElementById('smartBannerText');
        if (bannerTextEl && detectedProjectInfo.label) {
          bannerTextEl.innerHTML =
            '<strong>' + L('ИИ-Пилот активен', 'AI Pilot Active') + '</strong> · ' +
            L('Профиль воркспейса: ', 'Workspace profile: ') + '<strong>' +
            L('«', '"') + escHtml(detectedProjectInfo.label) + L('»', '"') +
            '</strong> · ' + L('Навыки в Авто-режиме', 'Skills in Auto mode');
        }
      }
      if (s.onboardingCompleted === false && !wizAutoOpenedOnce) {
        wizAutoOpenedOnce = true;
        openOnboardingWizard(1);
      }

      // Сводная карточка размышлений ИИ-пилота и авто-защиты
      const healthTitleEl = document.getElementById('autopilotHealthTitle');
      const liveTelemEl = document.getElementById('autopilotLiveTelemetry');
      if (healthTitleEl && liveTelemEl) {
        let activeCount = 0;
        for (let i = 0; i < guardrailModules.length; i++) {
          if (s[guardrailModules[i]] !== false) activeCount++;
        }
        if (activeCount === guardrailModules.length) {
          healthTitleEl.textContent = L(
            'Глубокое мышление без урезания + самостоятельная разведка файлов активны',
            'Unthrottled deep thinking + autonomous file scouting active'
          );
        } else {
          healthTitleEl.textContent = L(
            'Разведка ИИ-Пилота активна (' + activeCount + ' из ' + guardrailModules.length + ' систем защиты включено)',
            'AI Pilot scouting active (' + activeCount + ' of ' + guardrailModules.length + ' guardrails enabled)'
          );
        }

        updateAutopilotLiveText(s, payload ? payload.circuitBreaker : null);
      }
    }

    function updateAutopilotLiveText(s, circuitBreaker) {
      const liveTelemEl = document.getElementById('autopilotLiveTelemetry');
      if (!liveTelemEl) return;
      const st = (s && typeof s === 'object') ? s : currentState;
      const cbSt = (circuitBreaker && circuitBreaker.status)
        ? String(circuitBreaker.status).toUpperCase()
        : 'CLOSED';
      const cbText = cbSt === 'CLOSED' ? L('нет', 'none') : (cbSt === 'WARNING' ? L('риск', 'warning') : L('блокировка', 'tripped'));
      const handoffState = (st.historyCompaction !== false && st.sessionHandoff !== false)
        ? L('авто-перенос контекста включён', 'auto-handoff enabled')
        : L('базовый режим', 'basic mode');
      liveTelemEl.textContent =
        L('ИИ сам находит нужные файлы по вашим словам · Память между чатами: ', 'AI scouts relevant files automatically · Cross-chat memory: ') +
        handoffState + L(' · Зацикливаний: ', ' · Loops: ') + cbText;
    }

    const TELEMETRY_POLL_MS = 2800;
    let telemetryPollTimer = null;
    let telemetryPollInFlight = false;
    let telemetryLastSig = '';

    function buildTelemetrySignature(data) {
      if (!data || !data.telemetry) return '';
      const t = data.telemetry;
      const ac = t.activeChat || {};
      const sw = t.swarm || {};
      const cb = data.circuitBreaker || {};
      const comp = data.compaction || {};
      const prog = data.taskProgress || {};
      const hud = data.floatingHud || {};
      const gpu = data.gpu || {};
      const gpuTel = gpu.telemetry || {};
      const cpu = data.cpu || {};
      const cpuTel = cpu.telemetry || {};
      const ram = data.ramCache || {};
      const bay = data.bayesian || {};
      const sen = data.sentinel || {};
      const senSg = sen.shadowGuard || {};
      const senBb = sen.bugBot || {};
      const senSc = sen.symbolCards || {};
      const senSt = sen.shadowTests || {};
      return [
        t.steps || 0,
        t.inputTokens || 0,
        t.outputTokens || 0,
        t.totalSavedTokens || 0,
        t.gpuSavedTokens || 0,
        t.cacheHitRate || 0,
        t.totalChats || 0,
        ac.steps || 0,
        ac.cacheSavedTokens || 0,
        ac.lastContextTokens || 0,
        t.subagents ? t.subagents.total : 0,
        sw.active ? 1 : 0,
        sw.activeWorkers || 0,
        sw.boardPosts || 0,
        cb.status || 'CLOSED',
        cb.repeatCount || 0,
        comp.epoch || 0,
        comp.fillPercent || 0,
        comp.lastPromptTokens || 0,
        comp.thresholdTokens || 0,
        gpuTel.savedTokensEstimate || 0,
        gpuTel.semanticSearches || 0,
        gpuTel.distillCalls || 0,
        (gpu.ollama && gpu.ollama.loadedVramMb) || 0,
        (gpu.hardware && gpu.hardware.usedMb) || 0,
        (gpu.hardware && gpu.hardware.tempC) || 0,
        (gpu.hardware && gpu.hardware.utilPct) || 0,
        (gpu.thermalGuard && gpu.thermalGuard.throttled) ? 1 : 0,
        (gpu.liveActivity && gpu.liveActivity.inFlightCount) || 0,
        (gpu.liveActivity && gpu.liveActivity.opSeq) || 0,
        (gpu.liveActivity && gpu.liveActivity.isWorking) ? 1 : 0,
        (gpu.liveActivity && gpu.liveActivity.isAfterglow) ? 1 : 0,
        cpuTel.rerankCalls || 0,
        cpuTel.workerBatches || 0,
        cpuTel.lastRerankMs || 0,
        (cpuTel.sbflLocalizations || 0) + (cpuTel.bitapHealedPatches || 0) + (cpuTel.pprBridgeQueries || 0),
        ram.cacheUsedMb || 0,
        ram.hits || 0,
        ram.slices || 0,
        ram.searches || 0,
        (ram.liveActivity && ram.liveActivity.opSeq) || 0,
        (ram.liveActivity && ram.liveActivity.isWorking) ? 1 : 0,
        (data.hardwareCeilings && data.hardwareCeilings.maxVramMb) || 0,
        (data.hardwareCeilings && data.hardwareCeilings.maxRamBudgetMb) || 0,
        (data.hardwareCeilings && data.hardwareCeilings.maxCpuThreads) || 0,
        bay.totalRuns || 0,
        sen.enabled === false ? 0 : 1,
        sen.state || 'idle',
        sen.currentTaskRu || '',
        sen.preemptedCount || 0,
        sen.speculativeHits || 0,
        senSg.status || 'healthy',
        senSg.errorCount || 0,
        senSg.warnCount || 0,
        senSg.cloneCount || 0,
        Array.isArray(senSg.issues) ? senSg.issues.length : 0,
        Array.isArray(senSg.coChangeAlerts) ? senSg.coChangeAlerts.length : 0,
        senBb.findingsCount || (Array.isArray(senBb.findings) ? senBb.findings.length : 0),
        senSc.indexedFiles || 0,
        senSc.totalEligibleFiles || 0,
        senSc.coveragePct || 0,
        senSt.lastStatus || 'idle',
        prog.status || 'idle',
        prog.currentStep || 0,
        prog.totalSteps || 0,
        prog.percent || 0,
        prog.formattedText || '',
        Array.isArray(prog.activeChats)
          ? prog.activeChats.map(function (c) {
              return (c.conversationId || '') + ':' + (c.status || '') + ':' + (c.percent || 0) + ':' + (c.formattedText || '');
            }).join(';')
          : '',
        hud.running ? 1 : 0,
        Array.isArray(data.wiretapFaults) ? (data.wiretapFaults.length + ':' + ((data.wiretapFaults[0] && data.wiretapFaults[0].occurrences) || 0)) : '0',
        data.quotaPacer ? (data.quotaPacer.status + ':' + (data.quotaPacer.utilizationPct || 0)) : 'calm',
        Array.isArray(data.includedSections) ? data.includedSections.join(',') : 'all',
        data.activeWorkspace || '',
        data.autoWorkspace || '',
        data.projectDetection ? (data.projectDetection.label || '') : '',
        Array.isArray(data.knownWorkspaces) ? data.knownWorkspaces.map(function (w) { return (w.workspaceRoot || '') + ':' + (w.checkpointsCount || 0) + ':' + (w.status || ''); }).join(',') : '',
      ].join('|');
    }

    let _knownUiBuildVersion = null;
    let _autoWorkspaceRefreshInFlight = false;

    function checkUiHotReload(data) {
      if (!data || !data.uiBuildVersion || data.uiBuildVersion === '0') return false;
      if (_knownUiBuildVersion === null) {
        _knownUiBuildVersion = data.uiBuildVersion;
        return false;
      }
      if (_knownUiBuildVersion !== data.uiBuildVersion) {
        _knownUiBuildVersion = data.uiBuildVersion;
        window.location.reload();
        return true;
      }
      return false;
    }

    function applyLiveTelemetry(data) {
      if (!data || !data.telemetry) return;
      if (checkUiHotReload(data)) return;
      if (data.pluginVersion) {
        syncFooterPluginVersion(data.pluginVersion);
      }
      const prevActiveWsKey = normalizeWsClientKey(_activeWorkspaceResolved);
      if (data.knownWorkspaces || data.activeWorkspace || data.autoWorkspace) {
        renderWorkspaceSwitcher(data);
      }
      if (data.projectDetection) {
        detectedProjectInfo = data.projectDetection;
        const bannerTextEl = document.getElementById('smartBannerText');
        if (bannerTextEl && detectedProjectInfo.label) {
          bannerTextEl.innerHTML =
            '<strong>ИИ-Пилот активен</strong> · Профиль воркспейса: <strong>«' +
            escHtml(detectedProjectInfo.label) +
            '»</strong> · Навыки в Авто-режиме';
        }
      }
      const nextActiveWsKey = normalizeWsClientKey(data.activeWorkspace || '');
      if (
        _selectedWorkspaceMode === '__auto__' &&
        prevActiveWsKey &&
        nextActiveWsKey &&
        nextActiveWsKey !== prevActiveWsKey &&
        !_autoWorkspaceRefreshInFlight
      ) {
        _autoWorkspaceRefreshInFlight = true;
        _activeTurnDiffPreview = null;
        _loadedPanelSections.clear();
        telemetryLastSig = '';
        Promise.resolve(refreshAll()).finally(function () {
          _autoWorkspaceRefreshInFlight = false;
        });
        return;
      }
      const sig = buildTelemetrySignature(data);
      if (sig && sig === telemetryLastSig) return;
      telemetryLastSig = sig;
      syncLoadedSectionsFromPayload(data);
      if (lastPayloadCache) {
        lastPayloadCache.telemetry = data.telemetry;
        if (data.wiretapFaults !== undefined) lastPayloadCache.wiretapFaults = data.wiretapFaults;
        if (data.quotaPacer !== undefined) lastPayloadCache.quotaPacer = data.quotaPacer;
        if (data.circuitBreaker !== undefined) lastPayloadCache.circuitBreaker = data.circuitBreaker;
        if (data.compaction !== undefined) lastPayloadCache.compaction = data.compaction;
        if (data.ramCache !== undefined) lastPayloadCache.ramCache = data.ramCache;
        if (data.gpu !== undefined) lastPayloadCache.gpu = data.gpu;
        if (data.cpu !== undefined) lastPayloadCache.cpu = data.cpu;
        if (data.sentinel !== undefined) lastPayloadCache.sentinel = data.sentinel;
        if (data.hardwareCeilings) lastPayloadCache.hardwareCeilings = data.hardwareCeilings;
        if (data.bayesian !== undefined) lastPayloadCache.bayesian = data.bayesian;
        if (data.taskProgress) lastPayloadCache.taskProgress = data.taskProgress;
        if (data.floatingHud) lastPayloadCache.floatingHud = data.floatingHud;
      }
      if (data.wiretapFaults !== undefined || data.quotaPacer !== undefined) {
        renderWiretapAndQuota(data.wiretapFaults, data.quotaPacer);
      }
      if (data.hardwareCeilings) {
        currentHardwareCeilings = data.hardwareCeilings;
      }
      if (Array.isArray(data.includedSections) && data.includedSections.indexOf('hw') === -1) {
        _hwHasLiveActivity = Boolean(_gpuPullActiveUi);
      }
      updateHeaderSessionPill(data.telemetry);
      syncSwarmHeaderPills(data.telemetry, currentState);
      scheduleBlockRender('swarmTelemetryCard', function () {
        renderTelemetry(data.telemetry);
      });
      if (data.circuitBreaker !== undefined) {
        scheduleBlockRender('expertCircuitBox', function () {
          renderCircuitBreaker(data.circuitBreaker);
        });
        updateAutopilotLiveText(currentState, data.circuitBreaker);
      }
      if (data.compaction !== undefined) {
        scheduleBlockRender('expertGuardrailsCard', function () {
          renderCompaction(data.compaction);
        });
      }
      if (data.gpu || data.ramCache || data.cpu) {
        scheduleHwBlockRender(
          data.gpu || (lastPayloadCache ? lastPayloadCache.gpu : null),
          data.ramCache || (lastPayloadCache ? lastPayloadCache.ramCache : null),
          currentState,
          data.cpu || (lastPayloadCache ? lastPayloadCache.cpu : null)
        );
      }
      if (data.sentinel !== undefined) {
        scheduleBlockRender('sentinelSectionCard', function () {
          renderSentinelStatus(data.sentinel, currentState);
        });
      }
      if (data.bayesian !== undefined) {
        scheduleBlockRender('intelligenceBayesianCard', function () {
          renderBayesian(data.bayesian, currentState);
        });
      }
      if (data.taskProgress || data.floatingHud) {
        renderTaskProgressAndHud(data.taskProgress, data.floatingHud, currentState);
      }
    }

    let _agHasLiveTasks = false;
    let _hwHasLiveActivity = false;

    function scheduleTelemetryPoll() {
      if (telemetryPollTimer) {
        clearTimeout(telemetryPollTimer);
        telemetryPollTimer = null;
      }
      if (document.visibilityState === 'hidden') return;
      const pollDelay = (_agHasLiveTasks || _hwHasLiveActivity) ? 750 : TELEMETRY_POLL_MS;
      telemetryPollTimer = setTimeout(pollTelemetryTick, pollDelay);
    }

    async function pollTelemetryTick() {
      if (telemetryPollInFlight || document.visibilityState === 'hidden') return;
      telemetryPollInFlight = true;
      try {
        const activeSections = computeActiveTelemetrySections();
        const res = await panelFetch('/api/telemetry?sections=' + encodeURIComponent(activeSections.join(',')), { method: 'GET' });
        if (res && res.ok) {
          const data = await res.json();
          if (data && data.telemetry) {
            applyLiveTelemetry(data);
          }
        }
      } catch (e) {
        // Silent retry on next tick to keep panel responsive if sidecar restarts
      } finally {
        telemetryPollInFlight = false;
        scheduleTelemetryPoll();
      }
    }

    let flashStatusTimer = null;
    function flashStatus(text) {
      const pill = document.getElementById('statusPill');
      if (!pill) return;
      pill.textContent = text;
      if (flashStatusTimer) clearTimeout(flashStatusTimer);
      flashStatusTimer = setTimeout(() => {
        flashStatusTimer = null;
        pill.textContent = 'Готово · Синхронизировано';
      }, 2500);
    }

    let _updateStateSeq = 0;

    async function updateState(patch, opts) {
      const reqSeq = ++_updateStateSeq;
      const skipOptimistic = Boolean(opts && opts.skipOptimistic);
      const prevState = Object.assign({}, currentState, {
        skillModes: Object.assign({}, currentState.skillModes || {}),
        panelCollapsedCards: Object.assign({}, currentState.panelCollapsedCards || {}),
        panelOpenSpoilers: Object.assign({}, currentState.panelOpenSpoilers || {}),
      });
      const optimistic = Object.assign({}, currentState, patch);
      if (patch && patch.skillModes) {
        const mergedModes = Object.assign({}, currentState.skillModes || {});
        for (const k of Object.keys(patch.skillModes)) {
          if (patch.skillModes[k] === 'auto') delete mergedModes[k];
          else mergedModes[k] = patch.skillModes[k];
        }
        optimistic.skillModes = mergedModes;
      }
      if (!skipOptimistic) {
        renderPayload(Object.assign({}, lastPayloadCache || {}, { state: optimistic }));
      }
      try {
        const res = await panelFetch('/api/update', {
          method: 'POST',
          body: JSON.stringify(patch),
        });
        if (!res || !res.ok) {
          throw new Error('HTTP ' + (res ? res.status : 'err'));
        }
        const updated = await res.json();
        if (!updated || updated.ok === false || !updated.state) {
          throw new Error((updated && updated.error) ? updated.error : 'Ответ сервера без state');
        }
        if (reqSeq === _updateStateSeq) {
          renderPayload(updated);
          flashStatus('Сохранено в router-state.json ✓');
        }
        return true;
      } catch (err) {
        console.error(err);
        if (reqSeq === _updateStateSeq) {
          if (!skipOptimistic) {
            renderPayload(Object.assign({}, lastPayloadCache || {}, { state: prevState }));
          }
          flashStatus('Ошибка записи: ' + (err && err.message ? err.message : 'сбой'));
        }
        return false;
      }
    }

    function setAdvisorMode(confirmBeforeRun) {
      void updateState({ confirmBeforeRun: confirmBeforeRun });
    }

    function applySubscriptionTierDom(tier) {
      const cleanTier = tier === 'ultra' ? 'ultra' : 'pro';
      document.body.setAttribute('data-subscription-tier', cleanTier);
      document.querySelectorAll('#subscriptionTierGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === cleanTier);
      });
      const subHintEl = document.getElementById('subscriptionTierHint');
      if (subHintEl) {
        subHintEl.textContent = cleanTier === 'ultra'
          ? L(
              'Подписка Ultra: открыт полный набор моделей — включая Orchestrator (Carbon), Carbon и расширенный выбор воркеров Роя.',
              'Ultra Tier: unlocks the full model lineup — including Orchestrator (Carbon), Carbon, and extended Swarm worker tiers.'
            )
          : L(
              'Подписка Pro: бережёт квоту — Hydrogen на S/M и Orchestrator (Neon) на сложных задачах.',
              'Pro Tier: saves quota — Hydrogen on S/M and Orchestrator (Neon) on complex tasks.'
            );
      }
      const gateNoteEl = document.getElementById('subscriptionTierGateNote');
      if (gateNoteEl) {
        gateNoteEl.style.display = cleanTier === 'pro' ? '' : 'none';
        gateNoteEl.textContent = cleanTier === 'pro'
          ? L('Режим Pro: скрыты настройки моделей Ultra (Carbon).', 'Pro mode: Ultra (Carbon) model settings are hidden.')
          : '';
      }
      const proArchBtn = document.getElementById('btnStrategyProArchitect');
      if (proArchBtn) {
        proArchBtn.textContent = cleanTier === 'ultra' ? 'Neon / Carbon' : 'Neon';
        proArchBtn.title = cleanTier === 'ultra'
          ? L('Максимальная точность и архитектурный контроль через Neon / Carbon', 'Maximum precision and architectural control via Neon / Carbon')
          : L('Максимальная точность и архитектурный контроль через Orchestrator (Neon) / Neon', 'Maximum precision and architectural control via Orchestrator (Neon) / Neon');
      }
      const heavyLblEl = document.getElementById('heavyThresholdLabel');
      if (heavyLblEl) {
        heavyLblEl.textContent = cleanTier === 'ultra'
          ? L('Порог Neon/Carbon:', 'Neon/Carbon threshold:')
          : L('Порог Neon:', 'Neon threshold:');
      }
      const synLblEl = document.getElementById('orchestratorSmartSynergyLabel');
      if (synLblEl) {
        synLblEl.title = cleanTier === 'ultra'
          ? L(
              'Когда выбран Orchestrator (Neon / Carbon / Argon), штатный движок сам передаёт правки на Hydrogen (-24% квоты), поэтому на S/M лишние опросы не показываются',
              'When Orchestrator (Neon / Carbon / Argon) is selected, the native engine delegates edits to Hydrogen (-24% quota), skipping extra S/M prompts'
            )
          : L(
              'Когда выбран Orchestrator (Neon / Argon), штатный движок сам передаёт правки на Hydrogen (-24% квоты), поэтому на S/M лишние опросы не показываются',
              'When Orchestrator (Neon / Argon) is selected, the native engine delegates edits to Hydrogen (-24% quota), skipping extra S/M prompts'
            );
      }
      const swHydBtn = document.getElementById('btnSwarmTierHydrogen');
      if (swHydBtn) {
        swHydBtn.title = cleanTier === 'ultra'
          ? L(
              'Координатор планирует на вашей основной модели (Neon/Carbon), а рабочие авторы пишут код на быстром Gemini 4 Hydrogen в изолированных ветках share',
              'Coordinator plans on your main model (Neon/Carbon) while workers code on fast Gemini 4 Hydrogen in isolated share workspaces'
            )
          : L(
              'Координатор планирует на вашей основной модели (Neon), а рабочие авторы пишут код на быстром Gemini 4 Hydrogen в изолированных ветках share',
              'Coordinator plans on your main model (Neon) while workers code on fast Gemini 4 Hydrogen in isolated share workspaces'
            );
      }
    }

    function setSubscriptionTier(tier) {
      const cleanTier = tier === 'ultra' ? 'ultra' : 'pro';
      wizDraft.subscriptionTier = cleanTier;
      wizSubTierPreviewDirty = false;
      const patch = { subscriptionTier: cleanTier };
      if (cleanTier === 'pro') {
        if (currentState.swarmWorkerTier === 'carbon_auto') {
          patch.swarmWorkerTier = 'neon_auto';
        } else if (currentState.swarmWorkerTier === 'argon_auto') {
          patch.swarmWorkerTier = 'hydrogen_auto';
        }
      }
      void updateState(patch);
    }

    function setConfirmThreshold(confirmThreshold) {
      void updateState({ confirmThreshold: confirmThreshold });
    }

    function selectStrategy(strategy) {
      void updateState({ strategy: strategy });
    }

    function setThreshold(heavyThreshold) {
      void updateState({ heavyThreshold: heavyThreshold });
    }

    function setSwarmMode(swarmMode) {
      void updateState({ swarmMode: swarmMode });
    }

    function setSwarmWorkerTier(swarmWorkerTier) {
      void updateState({ swarmWorkerTier: swarmWorkerTier });
    }

    function setPanelTheme(panelTheme) {
      const valid = normalizeUiTheme(panelTheme);
      wizDraft.panelTheme = valid;
      wizThemePreviewDirty = false;
      document.body.setAttribute('data-panel-theme', valid);
      void updateState({ panelTheme: valid });
    }

    function toggleOption(key, val) {
      const patch = {};
      patch[key] = val;
      void updateState(patch);
    }

    function setSkillMode(skillId, mode) {
      const nextModes = Object.assign({}, currentState.skillModes || {});
      if (mode === 'auto') {
        delete nextModes[skillId];
      } else {
        nextModes[skillId] = mode;
      }
      currentState.skillModes = nextModes;
      const patch = { skillModes: {} };
      patch.skillModes[skillId] = mode;
      void updateState(patch);
    }

    async function refreshAll(opts) {
      const silent = Boolean(opts && opts.silent);
      try {
        _loadedPanelSections.clear();
        const res = await panelFetch('/api/state?adaptive=1', { method: 'GET' });
        const data = await res.json();
        if (!res || !res.ok || !data || typeof data !== 'object' || data.error || data.ok === false) {
          throw new Error((data && data.error) ? data.error : 'Ошибка ответа сервера');
        }
        renderPayload(data);
        telemetryLastSig = buildTelemetrySignature(data);
        if (!silent) {
          flashStatus('Телеметрия, ROI и скиллы обновлены ✓');
        }
      } catch (e) {
        console.error('Ошибка обновления:', e);
      } finally {
        scheduleTelemetryPoll();
      }
    }

    async function rollbackLastCheckpoint() {
      try {
        flashStatus('Откат последней правки...');
        const res = await panelFetch('/api/rollback', {
          method: 'POST',
          body: JSON.stringify({ checkpointId: 'latest' }),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus('Откат выполнен успешно ✓');
          await refreshAll({ silent: true });
        } else {
          flashStatus('Откат: ' + (result ? (result.message || result.error) : 'нет снимков'));
        }
      } catch (err) {
        flashStatus('Ошибка при вызове отката!');
      }
    }

    async function rollbackSpecific(cpId, wsRoot) {
      try {
        flashStatus('Откат чекпоинта...');
        const payload = { checkpointId: cpId };
        if (wsRoot) payload.rootDir = wsRoot;
        const res = await panelFetch('/api/rollback', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus('Снимок ' + cpId + ' восстановлен ✓');
          await refreshAll({ silent: true });
        } else {
          flashStatus('Ошибка отката: ' + (result ? (result.message || result.error) : 'сбой'));
        }
      } catch (err) {
        flashStatus('Ошибка вызова rollback!');
      }
    }

    function setCheckpointsViewMode(mode) {
      _checkpointsViewMode = mode === 'files' ? 'files' : 'turns';
      renderCheckpoints();
    }

    async function rollbackTurnById(turnId, wsRoot) {
      try {
        flashStatus('Откат всех правок хода...');
        const payload = { turnId: turnId || 'latest' };
        if (wsRoot) payload.rootDir = wsRoot;
        const res = await panelFetch('/api/checkpoints/rollback-turn', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false) {
          flashStatus('Откат хода выполнен (' + (result.count || 0) + ' ф.) ✓');
          _activeTurnDiffPreview = null;
          await refreshAll({ silent: true });
        } else {
          flashStatus('Откат хода: ' + (result ? (result.error || 'нет снимков') : 'сбой'));
        }
      } catch {
        flashStatus('Ошибка вызова rollback-turn!');
      }
    }

    async function showTurnDiff(turnId, wsRoot) {
      try {
        const payload = { turnId: turnId || 'latest' };
        if (wsRoot) payload.rootDir = wsRoot;
        const res = await panelFetch('/api/checkpoints/turn-diff', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          _activeTurnDiffPreview = data;
          renderCheckpoints();
          flashStatus('Ход: +' + (data.totalAdded || 0) + '/-' + (data.totalRemoved || 0) + ' строк (' + ((data.files && data.files.length) || 0) + ' ф.)');
        }
      } catch {}
    }

    async function worktreeAction(mode, id) {
      try {
        flashStatus(mode === 'create' ? 'Создание Git-песочницы...' : mode === 'promote' ? 'Перенос правок из песочницы...' : 'Обновление Git-песочницы...');
        const res = await panelFetch('/api/worktree/action', {
          method: 'POST',
          body: JSON.stringify({ action: mode || 'list', id: id || '' }),
        });
        const data = await res.json();
        if (Array.isArray(data && data.worktrees)) {
          renderShadowWorktrees(data.worktrees);
        }
        if (res && res.ok && data && data.ok !== false) {
          flashStatus(mode === 'promote' ? 'Правки перенесены с чекпоинтом ✓' : mode === 'create' ? 'Git-песочница создана ✓' : 'Песочница обновлена ✓');
          if (mode === 'promote') await refreshAll({ silent: true });
        } else {
          flashStatus('Worktree: ' + ((data && data.error) || 'операция не выполнена'));
        }
      } catch {
        flashStatus('Ошибка обращения к Git-песочнице!');
      }
    }

    async function resetCircuitBreaker() {
      try {
        flashStatus('Сброс автомата Circuit Breaker...');
        const res = await panelFetch('/api/circuit-reset', { method: 'POST' });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ? data.error : 'Сбой сброса');
        }
        if (data.circuitBreaker) {
          renderCircuitBreaker(data.circuitBreaker);
        }
        flashStatus('Circuit Breaker сброшен в НОРМУ ✓');
        await refreshAll({ silent: true });
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка сброса Circuit Breaker!');
      }
    }

    function escHtml(str) {
      return escapeHtml(str === null || str === undefined ? '' : String(str));
    }

    function renderBayesian(bayesian, s) {
      const metaEl = document.getElementById('bayesianSummaryMeta');
      const domEl = document.getElementById('bayesianDomainsLine');
      const fragileEl = document.getElementById('bayesianFragileList');
      if (!metaEl || !domEl || !fragileEl) return;

      const enabled = !s || s.bayesianRouter !== false;
      if (!enabled) {
        metaEl.textContent = 'Отключён';
        domEl.textContent = 'Bayesian v2 приостановлен пользователем.';
        fragileEl.innerHTML = '';
        return;
      }
      if (!bayesian) {
        metaEl.textContent = 'Нет данных';
        return;
      }

      const conf = Number(bayesian.overallConfidencePercent ?? 0);
      const runs = Number(bayesian.totalRuns ?? 0);
      const fpPct = bayesian.overallFirstPassPercent !== undefined ? Number(bayesian.overallFirstPassPercent) : null;
      const expTurns = bayesian.overallExpectedTurns !== undefined ? Number(bayesian.overallExpectedTurns) : null;
      const codynTag = fpPct !== null && expTurns !== null
        ? (' · 1-й проход: ' + fpPct + '% (~' + expTurns.toFixed(1) + ' итер.)')
        : '';
      const ctxTag = Number(bayesian.contextualUpdates || 0) > 0
        ? (' · конт. модель: ' + Number(bayesian.contextualUpdates))
        : '';
      metaEl.textContent = 'Доверие: ' + conf + '% · Запусков: ' + runs + codynTag + ctxTag;

      const domainsRaw = Array.isArray(bayesian.domains)
        ? bayesian.domains
        : Object.entries(bayesian.domains || {}).map(([name, info]) => ({ name, ...(info || {}) }));
      const topDomains = [...domainsRaw]
        .filter((d) => Number(d?.runs || 0) > 0 || Number(d?.confidencePercent || 0) > 0)
        .sort((a, b) => Number(b?.runs || 0) - Number(a?.runs || 0))
        .slice(0, 6);
      domEl.textContent = topDomains.length > 0
        ? 'Домены: ' + topDomains.map((d) => {
            const label = d.label || d.name || d.domain || d.key || 'Общий';
            const fpPart = (Number(d.runs || 0) > 0 && d.firstPassPercent !== undefined) ? (', 1п:' + Number(d.firstPassPercent) + '%') : '';
            return label + ' (' + (d.confidencePercent ?? 0) + '%' + fpPart + ')';
          }).join(' · ')
        : 'Домены: базовый априорный профиль (' + conf + '%)';

      const fragile = Array.isArray(bayesian.fragileFiles) ? bayesian.fragileFiles : [];
      if (fragile.length === 0) {
        fragileEl.innerHTML = '<span style="color: var(--status-ok); font-weight:600;">✓ Хрупких файлов с повторными сбоями не зафиксировано</span>';
      } else {
        fragileEl.innerHTML =
          '<div style="color: var(--status-warn); font-weight:700; margin-bottom:2px;">⚠️ Матрица хрупкости (Топ-' + fragile.length + '):</div>' +
          fragile
            .map((f) => {
              const relColor = f.reliabilityPercent < 60 ? 'var(--status-err)' : 'var(--status-warn)';
              const deps = f.dependentsCount > 0 ? ' · связей: ' + Number(f.dependentsCount) : '';
              return (
                '<div style="display:flex; justify-content:space-between; gap:8px;">' +
                  '<code style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escHtml(f.file) + '</code>' +
                  '<span style="color:' + relColor + '; white-space:nowrap;">' + Number(f.reliabilityPercent) + '% (' + Number(f.failures || 0) + '/' + Number(f.runs || 0) + deps + ')</span>' +
                '</div>'
              );
            })
            .join('');
      }
    }

    async function resetWorkspaceFragility() {
      try {
        flashStatus('Сброс хрупкости файлов выбранного проекта...');
        const res = await panelFetch('/api/bayesian-reset', {
          method: 'POST',
          body: JSON.stringify({ onlyFragility: true }),
        });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ? data.error : 'Сбой сброса');
        }
        if (data.summary) {
          renderBayesian(data.summary, currentState);
        }
        flashStatus('Хрупкость файлов проекта сброшена ✓');
        await refreshAll({ silent: true });
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка сброса хрупкости проекта!');
      }
    }

    async function resetBayesianPriors() {
      try {
        flashStatus('Сброс весов Байесовского доверия...');
        const res = await panelFetch('/api/bayesian-reset', { method: 'POST' });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ? data.error : 'Сбой сброса');
        }
        if (data.summary) {
          renderBayesian(data.summary, currentState);
        }
        flashStatus('Веса доверия сброшены к базовым ✓');
        await refreshAll({ silent: true });
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка сброса весов доверия!');
      }
    }

    async function compactDigest() {
      try {
        flashStatus('Сборка дайджеста контекста...');
        const res = await panelFetch('/api/compact-digest', {
          method: 'POST',
          body: JSON.stringify({ manual: true }),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus('Дайджест контекста собран ✓');
          await refreshAll({ silent: true });
        } else {
          flashStatus('Дайджест: ' + (result ? (result.message || result.error) : 'ошибка'));
        }
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка сборки дайджеста!');
      }
    }

    async function refreshRepoMap() {
      try {
        flashStatus('Обновление AST-карты проекта...');
        const res = await panelFetch('/api/repomap', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus('Карта проекта обновлена ✓');
        } else {
          flashStatus('Карта проекта: ' + (result ? (result.message || result.error) : 'ошибка'));
        }
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка обновления карты проекта!');
      }
    }

    async function clearPitfalls() {
      try {
        flashStatus('Очистка реестра граблей...');
        const res = await panelFetch('/api/pitfalls-clear', { method: 'POST' });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus('Реестр граблей очищен ✓');
          renderPitfalls([]);
          await refreshAll({ silent: true });
        } else {
          flashStatus('Ошибка очистки граблей!');
        }
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка очистки реестра!');
      }
    }

    async function clearVictoryRecipes() {
      try {
        const res = await panelFetch('/api/knowledge/recipes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clear' }),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok) {
          renderKnowledgeHub(result.recipes || [], undefined, result.stats);
          flashStatus('Рецепты побед очищены ✓');
        }
      } catch {}
    }

    async function addFederatedPeer() {
      const inp = document.getElementById('federatedPeerInput');
      const val = inp ? String(inp.value || '').trim() : '';
      if (!val) {
        flashStatus('Укажите путь к папке связанного репозитория');
        return;
      }
      try {
        const res = await panelFetch('/api/knowledge/federation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addPeer: val }),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok) {
          if (inp) inp.value = '';
          renderKnowledgeHub(undefined, result.peers || [], result.stats);
          flashStatus('Репозиторий связан ✓');
        } else {
          flashStatus('Федерация: ' + ((result && result.error) || 'папка не найдена'));
        }
      } catch {
        flashStatus('Ошибка привязки репозитория');
      }
    }

    async function removeFederatedPeer(peerPath) {
      if (!peerPath) return;
      try {
        const res = await panelFetch('/api/knowledge/federation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ removePeer: peerPath }),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok) {
          renderKnowledgeHub(undefined, result.peers || [], result.stats);
          flashStatus('Связь удалена ✓');
        } else {
          flashStatus('Федерация: ' + ((result && result.error) || 'не удалось удалить связь'));
        }
      } catch {
        flashStatus('Ошибка удаления связи репозитория');
      }
    }

    const HOOK_PROFILE_UI_OVERRIDES = {
      minimal: {
        cascadeVerify: false,
        testImpactVerify: false,
        gpuPostEditCritic: false,
        mutationGuardEnabled: false,
        sentinelLocalBugBot: false,
        blastRadius: false,
        skillCrystallizer: false,
        configProtection: false,
        completionGates: false,
      },
      strict: {
        securityGuard: true,
        configProtection: true,
        selfVerify: true,
        cascadeVerify: true,
        testImpactVerify: true,
        transactionalPatch: true,
        circuitBreaker: true,
        blastRadius: true,
        lspBridgeEnabled: true,
        completionGates: true,
      },
      standard: {},
    };
    const HOOK_PROFILE_OVERRIDE_KEYS = [
      'cascadeVerify', 'testImpactVerify', 'gpuPostEditCritic', 'mutationGuardEnabled',
      'sentinelLocalBugBot', 'blastRadius', 'skillCrystallizer', 'configProtection',
      'completionGates', 'securityGuard', 'selfVerify', 'transactionalPatch',
      'circuitBreaker', 'lspBridgeEnabled',
    ];

    function applyHookProfileOverridesToUi(profile) {
      const clean = (profile === 'minimal' || profile === 'strict') ? profile : 'standard';
      const overrides = HOOK_PROFILE_UI_OVERRIDES[clean] || {};
      const profLabel = clean === 'minimal' ? 'Лёгкий' : 'Строгий';
      for (let i = 0; i < HOOK_PROFILE_OVERRIDE_KEYS.length; i++) {
        const key = HOOK_PROFILE_OVERRIDE_KEYS[i];
        const el = document.getElementById('chk-' + key);
        if (!el) continue;
        const row = el.closest ? el.closest('label') : null;
        if (row && !row.hasAttribute('data-orig-title')) {
          row.setAttribute('data-orig-title', row.getAttribute('title') || '');
        }
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          el.checked = Boolean(overrides[key]);
          el.disabled = true;
          if (row) {
            row.setAttribute('title', 'Управляется активным профилем хуков («' + profLabel + '»)');
          }
        } else {
          el.disabled = false;
          if (row) {
            const origTitle = row.getAttribute('data-orig-title') || '';
            if (origTitle) row.setAttribute('title', origTitle);
            else row.removeAttribute('title');
          }
        }
      }
    }

    function setHookProfile(profile) {
      const clean = (profile === 'minimal' || profile === 'strict') ? profile : 'standard';
      applyHookProfileOverridesToUi(clean);
      void updateState({ hookProfile: clean });
    }

    function setCompactionThreshold(rawVal) {
      const n = Math.round(Number(rawVal) || 120000);
      const clean = Math.max(16000, Math.min(500000, n));
      void updateState({ compactionTokenThreshold: clean });
      flashStatus('Порог сжатия эпохи: ' + Math.round(clean / 1000) + 'k ✓');
    }

    async function runAgentShield() {
      const badge = document.getElementById('agentShieldBadge');
      const sumEl = document.getElementById('agentShieldSummary');
      if (badge) {
        badge.textContent = 'Проверка...';
        badge.className = 'swarm-pill active';
      }
      try {
        const res = await panelFetch('/api/shield', { method: 'GET' });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || 'Ошибка аудита AgentShield');
        }
        if (badge) {
          badge.textContent = String(data.score ?? 100) + '/100 (' + (data.grade || 'A') + ')';
          badge.className = 'swarm-pill ' + ((data.counts && data.counts.critical > 0) ? 'warn' : (data.score >= 90 ? 'idle' : 'active'));
        }
        if (sumEl) {
          const findings = Array.isArray(data.findings) ? data.findings : [];
          if (findings.length === 0) {
            sumEl.textContent = data.summaryRu || 'Угроз не обнаружено';
          } else {
            sumEl.innerHTML = '<div>' + escapeHtml(data.summaryRu || '') + '</div>' +
              findings.slice(0, 6).map(function (f) {
                return '<div class="pitfall-item"><span class="pitfall-bullet">⚠️</span><span><strong>[' +
                  escapeHtml(String(f.severity || '').toUpperCase()) + ']</strong> ' + escapeHtml(f.message || '') +
                  '</span></div>';
              }).join('');
          }
        }
        flashStatus('Аудит AgentShield завершён ✓');
      } catch (err) {
        if (badge) {
          badge.textContent = 'Ошибка';
          badge.className = 'swarm-pill warn';
        }
        if (sumEl) sumEl.textContent = (err && err.message) ? err.message : 'Сбой запуска AgentShield';
      }
    }

    function renderProjectInstinctsList(items) {
      const box = document.getElementById('projectInstinctsList');
      if (!box) return;
      const list = Array.isArray(items) ? items : [];
      if (list.length === 0) {
        box.innerHTML = '<div>Пока нет накопленных инстинктов для текущего проекта.</div>';
        return;
      }
      box.innerHTML = list.slice(0, 12).map(function (it) {
        const pct = Math.round(Number(it.effectiveConfidence || it.confidence || 0) * 100);
        const promoBtn = (!it.promotedSkill && it.readyForPromotion)
          ? '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;" data-action="promoteInstinct" data-arg="' + escapeHtml(it.id) + '">В навык</button>'
          : (it.promotedSkill ? '<span style="color:var(--status-ok);">✓ ' + escapeHtml(it.promotedSkill) + '</span>' : '');
        const delBtn = '<button type="button" class="win-btn" style="padding:1px 5px;font-size:10px;" data-action="deleteInstinct" data-arg="' + escapeHtml(it.id) + '" title="Удалить инстинкт">✕</button>';
        return '<div class="pitfall-item" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">' +
          '<span style="min-width:0;flex:1 1 160px;word-break:break-word;"><strong>' + pct + '%</strong> (x' + Number(it.evidenceCount || 1) + ') ' + escapeHtml(it.pattern || '') + '</span>' +
          '<span style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">' + promoBtn + delBtn + '</span>' +
          '</div>';
      }).join('');
    }

    async function loadProjectInstincts(opts) {
      const silent = Boolean(opts && opts.silent);
      try {
        const res = await panelFetch('/api/instincts', { method: 'GET' });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          renderProjectInstinctsList(data.items || []);
          if (data.stats) renderKnowledgeHub(undefined, undefined, data.stats);
          if (!silent) flashStatus('Список инстинктов обновлён ✓');
        }
      } catch {
        if (!silent) flashStatus('Ошибка загрузки инстинктов проекта');
      }
    }

    async function promoteInstinct(instinctId) {
      if (!instinctId) return;
      try {
        const res = await panelFetch('/api/instincts/promote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: instinctId }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          renderProjectInstinctsList(data.items || []);
          if (data.stats) renderKnowledgeHub(undefined, undefined, data.stats);
          flashStatus('Инстинкт повышен в навык ' + (data.skillSlug || '') + ' ✓');
          await refreshAll({ silent: true });
        } else {
          flashStatus('Не удалось повысить инстинкт: ' + ((data && data.error) || 'ошибка'));
        }
      } catch {
        flashStatus('Ошибка повышения инстинкта в навык');
      }
    }

    async function deleteInstinct(instinctId) {
      if (!instinctId) return;
      try {
        const res = await panelFetch('/api/instincts/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: instinctId }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          renderProjectInstinctsList(data.items || []);
          if (data.stats) renderKnowledgeHub(undefined, undefined, data.stats);
          flashStatus('Инстинкт удалён ✓');
        } else {
          flashStatus('Удаление инстинкта: ' + ((data && data.error) || 'не найден'));
        }
      } catch {
        flashStatus('Ошибка удаления инстинкта');
      }
    }

    function renderSetupDoctorReport(rec) {
      const box = document.getElementById('setupDoctorBox');
      if (!box) return;
      if (!rec || rec.ok === false) {
        box.innerHTML = '<div style="color: var(--status-warn);">Не удалось проанализировать стек проекта: ' +
          escapeHtml((rec && rec.error) || 'ошибка') + '</div>';
        return;
      }
      const st = rec.stack || {};
      const langs = Array.isArray(st.languages) && st.languages.length ? st.languages.join(', ') : 'авто';
      const fws = Array.isArray(st.frameworks) && st.frameworks.length ? (' · ' + st.frameworks.join(', ')) : '';
      const hyg = Array.isArray(rec.projectHygieneSuggestions) ? rec.projectHygieneSuggestions : [];
      const skills = Array.isArray(rec.recommendedLocalSkills) ? rec.recommendedLocalSkills : [];
      const ext = Array.isArray(rec.externalIntegrations) ? rec.externalIntegrations : [];
      const recProf = rec.recommendedHookProfile || 'standard';
      const profLabel = recProf === 'strict' ? 'Строгий' : (recProf === 'minimal' ? 'Лёгкий' : 'Стандарт');
      const applyableKinds = new Set(['hook_profile', 'agentignore', 'design_md', 'gates_md']);

      let html =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">' +
          '<strong style="color:var(--accent-cyan);">🩺 Setup Doctor · ' + escapeHtml(langs + fws) + ' (' + Number(st.totalFiles || 0) + ' ф.)</strong>' +
          '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;" data-action="loadSetupDoctor">↻ Пересканировать</button>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;color:var(--text-sub);">' +
          '<span style="min-width:0;flex:1 1 170px;">Рекомендованный профиль: <strong>' + escapeHtml(profLabel) + '</strong>' +
          (rec.hookProfileReasonRu ? (' — ' + escapeHtml(rec.hookProfileReasonRu)) : '') + '</span>' +
          '<button type="button" class="win-btn" style="padding:1px 7px;font-size:10px;" data-action="applySetupDoctorItem" data-arg="hook_profile">Применить профиль</button>' +
        '</div>';

      if (hyg.length > 0) {
        html += hyg.slice(0, 4).map(function (h) {
          const canApply = applyableKinds.has(h.kind);
          const btnHtml = canApply
            ? '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;flex-shrink:0;" data-action="applySetupDoctorItem" data-arg="' + escapeHtml(h.kind) + '">Применить</button>'
            : '';
          return '<div class="pitfall-item" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">' +
            '<span style="min-width:0;flex:1 1 160px;">⚙️ ' + escapeHtml(h.titleRu || h.kind || '') + '</span>' +
            btnHtml +
            '</div>';
        }).join('');
      } else {
        html += '<div style="color:var(--status-ok);font-size:10.5px;">✓ Базовая гигиена проекта (`.agentignore` / конфиги) в порядке</div>';
      }

      if (skills.length > 0) {
        html += '<div style="margin-top:4px;font-size:10.5px;color:var(--text-sub);">Навыки под стек: ' +
          skills.slice(0, 4).map(function (s) { return '<code>' + escapeHtml(s.slug) + '</code>'; }).join(', ') +
          '</div>';
      }
      if (ext.length > 0) {
        html += '<div style="margin-top:2px;font-size:10.5px;color:var(--text-sub);">Интеграции: ' +
          ext.slice(0, 4).map(function (e) { return escapeHtml(e.name || e.id); }).join(', ') +
          '</div>';
      }
      box.innerHTML = html;
    }

    async function loadSetupDoctor() {
      const box = document.getElementById('setupDoctorBox');
      if (!box) return;
      box.style.display = 'block';
      box.innerHTML = '<div style="color:var(--text-sub);">Анализ стека и гигиены проекта...</div>';
      try {
        const res = await panelFetch('/api/setup-recommendations', { method: 'GET' });
        const data = await res.json();
        renderSetupDoctorReport(data);
      } catch {
        box.innerHTML = '<div style="color:var(--status-warn);">Ошибка запроса Setup Doctor</div>';
      }
    }

    function toggleSetupDoctor() {
      const box = document.getElementById('setupDoctorBox');
      if (!box) return;
      if (box.style.display !== 'none' && box.innerHTML.trim()) {
        box.style.display = 'none';
        return;
      }
      void loadSetupDoctor();
    }

    async function applySetupDoctorItem(kind) {
      if (!kind) return;
      try {
        flashStatus('Применение рекомендации Setup Doctor...');
        const res = await panelFetch('/api/setup-recommendations/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: kind }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          if (data.recommendation) renderSetupDoctorReport(data.recommendation);
          flashStatus((data.detail || 'Рекомендация применена') + ' ✓');
          await refreshAll({ silent: true });
          if (kind === 'gates_md') void refreshGatesStatus({ silent: true });
        } else {
          flashStatus('Setup Doctor: ' + ((data && (data.detail || data.error)) || 'не удалось применить'));
        }
      } catch {
        flashStatus('Ошибка применения рекомендации Setup Doctor');
      }
    }

    function toggleSkillRegistryDrawer() {
      const drawer = document.getElementById('skillRegistryDrawer');
      if (!drawer) return;
      const open = drawer.style.display === 'none';
      drawer.style.display = open ? 'block' : 'none';
      if (open) {
        const inp = document.getElementById('extSkillSourceInput');
        if (inp && typeof inp.focus === 'function') inp.focus();
      }
    }

    async function searchExternalSkills() {
      const srcInp = document.getElementById('extSkillSourceInput');
      const resBox = document.getElementById('skillRegistryResults');
      const query = srcInp ? String(srcInp.value || '').trim() : '';
      if (resBox) {
        resBox.innerHTML = '<div>Поиск по локальному и внешнему каталогу...</div>';
      }
      try {
        const res = await panelFetch('/api/skills/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: query, includeRemote: true, limit: 8 }),
        });
        const data = await res.json();
        if (!resBox) return;
        const locals = Array.isArray(data && data.localMatches) ? data.localMatches : [];
        const remotes = Array.isArray(data && data.remoteMatches) ? data.remoteMatches : [];
        if (locals.length === 0 && remotes.length === 0) {
          resBox.innerHTML = '<div>Совпадений не найдено.' +
            (data && data.offlineFallback ? ' (Внешний каталог офлайн — можно ввести owner/repo вручную и нажать «Проверить и импортировать».)' : '') +
            '</div>';
          return;
        }
        let html = '';
        if (locals.length > 0) {
          html += '<div style="margin-bottom:4px;font-weight:600;color:var(--status-ok);">Локально установлено: ' +
            locals.slice(0, 6).map(function (m) { return '<code>' + escapeHtml(m.slug || m.id || m.name) + '</code>'; }).join(', ') +
            '</div>';
        }
        if (remotes.length > 0) {
          html += remotes.slice(0, 6).map(function (m) {
            const btn = m.sourceRepo
              ? '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;flex-shrink:0;" data-action="importExternalSkill" data-source="' +
                escapeHtml(m.sourceRepo) + '" data-slug="' + escapeHtml(m.slug || '') + '">' +
                (m.alreadyInstalled ? 'Обновить' : 'Импорт') + '</button>'
              : '';
            return '<div class="pitfall-item" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">' +
              '<span style="min-width:0;flex:1 1 150px;"><strong>' + escapeHtml(m.slug || m.name) + '</strong>' +
              (m.sourceRepo ? ' · <code>' + escapeHtml(m.sourceRepo) + '</code>' : '') +
              (m.description ? (' — ' + escapeHtml(m.description.slice(0, 90))) : '') +
              '</span>' + btn + '</div>';
          }).join('');
        }
        if (data && data.offlineFallback) {
          html += '<div style="color:var(--text-sub);font-size:10px;margin-top:2px;">Внешний реестр недоступен (offline fallback).</div>';
        }
        resBox.innerHTML = html;
        flashStatus('Поиск навыков завершён ✓');
      } catch {
        if (resBox) resBox.innerHTML = '<div style="color:var(--status-warn);">Ошибка поиска по каталогу навыков</div>';
      }
    }

    async function importExternalSkill(sourceArg, slugArg) {
      const srcInp = document.getElementById('extSkillSourceInput');
      const slugInp = document.getElementById('extSkillSlugInput');
      const resBox = document.getElementById('skillRegistryResults');
      const source = String(sourceArg || (srcInp && srcInp.value) || '').trim();
      let slug = String(slugArg || (slugInp && slugInp.value) || '').trim();
      if (!slug && source) {
        const parts = source.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
        slug = (parts[parts.length - 1] || '').toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
      }
      if (!source || !slug) {
        flashStatus('Укажите источник (owner/repo или локальную папку) и slug навыка');
        return;
      }
      if (resBox) resBox.innerHTML = '<div>Карантинная проверка AgentShield для <code>' + escapeHtml(slug) + '</code>...</div>';
      try {
        const res = await panelFetch('/api/skills/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: source, slug: slug }),
        });
        const data = await res.json();
        if (data && data.installed) {
          if (Array.isArray(data.skills)) {
            renderSkills(data.skills, (currentState && currentState.skillModes) || {});
          }
          if (resBox) {
            resBox.innerHTML = '<div style="color:var(--status-ok);">✓ Навык <code>' + escapeHtml(data.slug || slug) + '</code> прошёл карантин AgentShield и установлен.</div>';
          }
          flashStatus('Навык ' + (data.slug || slug) + ' импортирован ✓');
          await refreshAll({ silent: true });
        } else {
          const reasons = Array.isArray(data && data.reasons) ? data.reasons : [];
          const msg = (data && data.securityBlocked ? 'Заблокировано AgentShield: ' : 'Импорт отклонён: ') +
            (reasons.length ? reasons.slice(0, 3).join('; ') : ((data && data.error) || 'не прошёл проверку'));
          if (resBox) resBox.innerHTML = '<div style="color:var(--status-warn);">' + escapeHtml(msg) + '</div>';
          flashStatus('Импорт навыка отклонён');
        }
      } catch {
        if (resBox) resBox.innerHTML = '<div style="color:var(--status-warn);">Ошибка карантинного импорта навыка</div>';
      }
    }

    async function loadSessionEpisodes() {
      const box = document.getElementById('sessionEpisodesContainer');
      if (!box) return;
      box.style.display = 'block';
      box.innerHTML = '<div style="color:var(--text-sub);padding:2px;">Загрузка эпизодов памяти...</div>';
      try {
        const res = await panelFetch('/api/knowledge/episodes?limit=12', { method: 'GET' });
        const data = await res.json();
        const items = Array.isArray(data && data.items) ? data.items : [];
        if (data && data.stats) renderKnowledgeHub(undefined, undefined, data.stats);
        if (items.length === 0) {
          box.innerHTML = '<div style="color:var(--text-sub);padding:2px;">Пока нет записанных эпизодов прошлых сессий.</div>';
          return;
        }
        box.innerHTML = items.map(function (ep) {
          const filesStr = Array.isArray(ep.files) && ep.files.length ? (' · ' + ep.files.slice(0, 2).join(', ')) : '';
          return '<div class="pitfall-item"><span class="pitfall-bullet">🗂</span><span style="min-width:0;word-break:break-word;"><strong>[' +
            escapeHtml((ep.date || '') + ' · ' + (ep.kind || 'session')) + ']</strong> ' +
            escapeHtml((ep.title || ep.shortId || '') + filesStr) + '</span></div>';
        }).join('');
        flashStatus('Загружено эпизодов памяти: ' + items.length + ' ✓');
      } catch {
        box.innerHTML = '<div style="color:var(--status-warn);padding:2px;">Ошибка загрузки эпизодов памяти</div>';
      }
    }

    async function resetComboCooldowns() {
      try {
        const res = await panelFetch('/api/quota/reset-cooldowns', { method: 'POST', body: '{}' });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          if (data.quotaPacer) renderWiretapAndQuota(undefined, data.quotaPacer);
          flashStatus('Временные паузы Combo сброшены ✓');
        } else {
          flashStatus('Combo: ' + ((data && data.error) || 'ошибка сброса'));
        }
      } catch {
        flashStatus('Ошибка сброса пауз Combo');
      }
    }

    async function refreshGatesStatus(opts) {
      const silent = Boolean(opts && opts.silent);
      const badge = document.getElementById('gatesStatusBadge');
      if (!badge) return;
      try {
        const res = await panelFetch('/api/gates', { method: 'GET' });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          if (!data.exists) {
            badge.textContent = 'GATES.md: файл не создан';
            badge.style.color = 'var(--text-sub)';
          } else {
            badge.textContent = 'GATES.md: ' + Number(data.metCount || 0) + '/' + Number(data.total || 0) + ' выполнено';
            badge.style.color = Number(data.unmetCount || 0) > 0 ? 'var(--status-warn)' : 'var(--status-ok)';
          }
          if (!silent) flashStatus('Статус GATES.md обновлён ✓');
        }
      } catch {
        if (!silent) flashStatus('Ошибка проверки GATES.md');
      }
    }

    async function initGatesMd() {
      const badge = document.getElementById('gatesStatusBadge');
      try {
        const res = await panelFetch('/api/gates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          if (badge) {
            badge.textContent = 'GATES.md: ' + Number(data.metCount || 0) + '/' + Number(data.total || 0) + ' выполнено';
            badge.style.color = 'var(--status-ok)';
          }
          flashStatus('Журнал GATES.md готов ✓');
        } else {
          flashStatus('GATES.md: ' + ((data && data.error) || 'ошибка создания'));
        }
      } catch {
        flashStatus('Ошибка создания GATES.md');
      }
    }

    const EXPERT_GPU_INPUT_IDS = [
      'inp-gpuEndpoint',
      'inp-gpuChatModel',
      'inp-gpuEmbedModel',
      'inp-gpuKeepAlive',
      'inp-gpuEmbedKeepAlive',
      'inp-gpuContextTokens',
      'inp-gpuModelsDir',
    ];

    function clearExpertGpuInputsDirty() {
      for (let i = 0; i < EXPERT_GPU_INPUT_IDS.length; i++) {
        const el = document.getElementById(EXPERT_GPU_INPUT_IDS[i]);
        if (el) el.removeAttribute('data-dirty');
      }
    }

    function syncExpertInput(id, val) {
      const el = document.getElementById(id);
      if (!el || document.activeElement === el || el.getAttribute('data-dirty') === '1') return;
      el.value = val === undefined || val === null ? '' : String(val);
    }

