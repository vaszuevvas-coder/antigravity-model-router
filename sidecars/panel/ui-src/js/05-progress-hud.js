    const _agDisplayedPctByChat = Object.create(null);
    const _agPctAnimFrameByChat = Object.create(null);
    const _agExpandedSubagentsByChat = Object.create(null);
    const _agExpandedBgTasksByChat = Object.create(null);
    const _agShowAllBgTasksByChat = Object.create(null);
    const _agExpandedStepsByChat = Object.create(null);
    const AG_BG_TASKS_PREVIEW_LIMIT = 4;
    const AG_RECENT_COMPLETED_MAX = 12;
    const _agLastTrackedChatsByCid = Object.create(null);
    let _agRecentCompletedTasks = [];
    let _agPinnedCompletedTask = null;
    let _agRecentCompletedOpen = false;
    let _agLastProgressPayload = null;

    function agCanSmoothHudMotion(el) {
      if (!el || typeof el.animate !== 'function') return false;
      if (typeof uiPrefersReducedMotion === 'function' && uiPrefersReducedMotion()) return false;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return Boolean(r && r.height > 0);
    }

    function agSmoothCollapseAndRemoveNode(node, onDone) {
      if (!node || !node.parentNode) return;
      if (!agCanSmoothHudMotion(node)) {
        node.remove();
        if (typeof onDone === 'function') onDone();
        return;
      }
      const h = (typeof uiMeasureLayoutHeight === 'function' ? uiMeasureLayoutHeight(node) : 0)
        || node.offsetHeight
        || (node.getBoundingClientRect ? node.getBoundingClientRect().height : 0)
        || 0;
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      const pt = cs ? cs.paddingTop : '0px';
      const pb = cs ? cs.paddingBottom : '0px';
      const mb = cs ? cs.marginBottom : '0px';
      const btw = cs ? cs.borderTopWidth : '0px';
      const bbw = cs ? cs.borderBottomWidth : '0px';
      node.classList.add('closing');
      node.style.overflow = 'hidden';
      try {
        node.animate(
          [
            { height: h + 'px', opacity: 1, paddingTop: pt, paddingBottom: pb, marginTop: '0px', marginBottom: mb, borderTopWidth: btw, borderBottomWidth: bbw, transform: 'translate3d(0,0,0) scale(1)' },
            { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', transform: 'translate3d(0,-4px,0) scale(0.975)' }
          ],
          { duration: 245, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }
        );
      } catch {}
      setTimeout(function () {
        if (node.parentNode) node.remove();
        if (typeof syncFullLeftRailStickyOffset === 'function') syncFullLeftRailStickyOffset();
        if (typeof onDone === 'function') onDone();
      }, 260);
    }

    function agSmoothHideInlineStrip(stripEl, onHidden) {
      if (!stripEl) return;
      if (stripEl._agStripAnim) {
        try { stripEl._agStripAnim.cancel(); } catch {}
        stripEl._agStripAnim = null;
      }
      const seq = (stripEl._agStripSeq || 0) + 1;
      stripEl._agStripSeq = seq;
      if (stripEl.style.display === 'none' || !agCanSmoothHudMotion(stripEl)) {
        stripEl.style.display = 'none';
        if (typeof onHidden === 'function') onHidden();
        return;
      }
      const h = (typeof uiMeasureLayoutHeight === 'function' ? uiMeasureLayoutHeight(stripEl) : 0)
        || stripEl.offsetHeight
        || (stripEl.getBoundingClientRect ? stripEl.getBoundingClientRect().height : 0)
        || 0;
      stripEl.style.overflow = 'hidden';
      try {
        const anim = stripEl.animate(
          [
            { height: h + 'px', opacity: 1, marginTop: getComputedStyle(stripEl).marginTop || '0px' },
            { height: '0px', opacity: 0, marginTop: '0px' }
          ],
          { duration: 210, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
        );
        stripEl._agStripAnim = anim;
        anim.onfinish = function () {
          if (stripEl._agStripSeq !== seq) return;
          stripEl._agStripAnim = null;
          stripEl.style.display = 'none';
          stripEl.style.overflow = '';
          if (typeof onHidden === 'function') onHidden();
          if (typeof syncFullLeftRailStickyOffset === 'function') syncFullLeftRailStickyOffset();
        };
      } catch {
        stripEl.style.display = 'none';
        stripEl.style.overflow = '';
        if (typeof onHidden === 'function') onHidden();
      }
    }

    function agShowInlineStrip(stripEl, displayVal) {
      if (!stripEl) return;
      stripEl._agStripSeq = (stripEl._agStripSeq || 0) + 1;
      if (stripEl._agStripAnim) {
        try { stripEl._agStripAnim.cancel(); } catch {}
        stripEl._agStripAnim = null;
      }
      stripEl.style.overflow = '';
      stripEl.style.display = displayVal || 'flex';
    }

    function toggleStepChip(cid, stepKey, chipEl) {
      const cleanCid = String(cid || '').trim();
      const cleanStep = String(stepKey || '').trim();
      if (!cleanCid || !cleanStep) return;
      let expandedSet = _agExpandedStepsByChat[cleanCid];
      if (!expandedSet) {
        expandedSet = new Set();
        _agExpandedStepsByChat[cleanCid] = expandedSet;
      }
      const nextExpanded = !expandedSet.has(cleanStep);
      if (nextExpanded) {
        expandedSet.add(cleanStep);
      } else {
        expandedSet.delete(cleanStep);
        if (expandedSet.size === 0) delete _agExpandedStepsByChat[cleanCid];
      }
      if (chipEl) {
        chipEl.classList.toggle('is-expanded', nextExpanded);
        chipEl.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      }
    }

    function focusWaitingProgressChat(cid) {
      const cleanCid = String(cid || '').trim();
      if (!cleanCid || cleanCid === '__primary_slot__' || cleanCid === 'default') return false;
      let focused = false;
      try {
        if (window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleConversation === 'function') {
          window.sidecar.ui.toggleConversation(cleanCid);
          focused = true;
        }
      } catch {}
      if (focused) {
        flashStatus(L('Переход к чату с вопросом ↗', 'Switching to chat with question ↗'));
        return true;
      }
      if (typeof copyTextToClipboardSafe === 'function') {
        void copyTextToClipboardSafe(cleanCid);
      }
      flashStatus(L('Откройте чат в Antigravity (ID скопирован: ' + cleanCid.slice(0, 8) + ')', 'Open chat in Antigravity (ID copied: ' + cleanCid.slice(0, 8) + ')'));
      return false;
    }

    function toggleSubagentsList(cid, btnEl) {
      const cleanCid = String(cid || '').trim();
      if (!cleanCid) return;
      const nextExpanded = !_agExpandedSubagentsByChat[cleanCid];
      _agExpandedSubagentsByChat[cleanCid] = nextExpanded;
      const itemEl = btnEl && btnEl.closest
        ? btnEl.closest('.ag-chat-task-item')
        : document.querySelector('.ag-chat-task-item[data-cid="' + CSS.escape(cleanCid) + '"]');
      if (!itemEl) return;
      const toggleBtn = itemEl.querySelector('.ag-subagent-toggle-btn');
      const drawerEl = itemEl.querySelector('.ag-subagents-drawer');
      if (toggleBtn) {
        toggleBtn.classList.toggle('is-expanded', nextExpanded);
        toggleBtn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      }
      if (drawerEl) {
        drawerEl.classList.toggle('is-open', nextExpanded);
        drawerEl.setAttribute('aria-hidden', nextExpanded ? 'false' : 'true');
      }
    }

    function toggleBgTasksList(cid, btnEl) {
      const cleanCid = String(cid || '').trim();
      if (!cleanCid) return;
      const nextExpanded = !_agExpandedBgTasksByChat[cleanCid];
      _agExpandedBgTasksByChat[cleanCid] = nextExpanded;
      const itemEl = btnEl && btnEl.closest
        ? btnEl.closest('.ag-chat-task-item')
        : document.querySelector('.ag-chat-task-item[data-cid="' + CSS.escape(cleanCid) + '"]');
      if (!itemEl) return;
      const toggleBtn = itemEl.querySelector('.ag-bgtask-toggle-btn');
      const drawerEl = itemEl.querySelector('.ag-bgtasks-drawer');
      if (toggleBtn) {
        toggleBtn.classList.toggle('is-expanded', nextExpanded);
        toggleBtn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      }
      if (drawerEl) {
        drawerEl.classList.toggle('is-open', nextExpanded);
        drawerEl.setAttribute('aria-hidden', nextExpanded ? 'false' : 'true');
      }
    }

    function toggleBgTasksShowAll(cid, btnEl) {
      const cleanCid = String(cid || '').trim();
      if (!cleanCid) return;
      const nextShowAll = !_agShowAllBgTasksByChat[cleanCid];
      _agShowAllBgTasksByChat[cleanCid] = nextShowAll;
      const itemEl = btnEl && btnEl.closest
        ? btnEl.closest('.ag-chat-task-item')
        : document.querySelector('.ag-chat-task-item[data-cid="' + CSS.escape(cleanCid) + '"]');
      if (!itemEl) return;
      const listEl = itemEl.querySelector('.ag-bgtasks-list');
      if (!listEl) return;
      const rows = Array.from(listEl.querySelectorAll('.ag-bgtask-item'));
      rows.forEach(function (rowEl, idx) {
        const isOverflowHidden = !nextShowAll && idx >= AG_BG_TASKS_PREVIEW_LIMIT;
        rowEl.classList.toggle('is-overflow-hidden', isOverflowHidden);
        rowEl.setAttribute('aria-hidden', isOverflowHidden ? 'true' : 'false');
      });
      const seeAllBtn = listEl.querySelector('.ag-bgtasks-see-all-btn');
      if (seeAllBtn) {
        const totalHint = Number(seeAllBtn.getAttribute('data-total') || rows.length);
        seeAllBtn.textContent = nextShowAll
          ? L('Свернуть', 'Collapse')
          : (L('Показать все (', 'See all (') + totalHint + ')');
        seeAllBtn.setAttribute('aria-expanded', nextShowAll ? 'true' : 'false');
      }
      listEl.dataset.sig = '';
    }

    function animateChatPctNode(cid, numEl, targetPct) {
      if (!numEl) return;
      if (_agPctAnimFrameByChat[cid]) cancelAnimationFrame(_agPctAnimFrameByChat[cid]);
      const startPct = Number.isFinite(_agDisplayedPctByChat[cid]) ? _agDisplayedPctByChat[cid] : targetPct;
      const diff = targetPct - startPct;
      if (Math.abs(diff) <= 1) {
        _agDisplayedPctByChat[cid] = targetPct;
        numEl.textContent = String(targetPct);
        return;
      }
      const duration = 460;
      const startTime = performance.now();
      function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const cur = Math.round(startPct + diff * eased);
        _agDisplayedPctByChat[cid] = cur;
        numEl.textContent = String(cur);
        if (t < 1) {
          _agPctAnimFrameByChat[cid] = requestAnimationFrame(step);
        } else {
          _agDisplayedPctByChat[cid] = targetPct;
          numEl.textContent = String(targetPct);
        }
      }
      _agPctAnimFrameByChat[cid] = requestAnimationFrame(step);
    }

    function normalizeSidecarUriToWsKey(rawUri) {
      let s = String(rawUri || '').trim();
      if (!s) return '';
      if (/^file:\/\//i.test(s)) {
        try {
          s = decodeURIComponent(s.replace(/^file:\/\/\/?/i, ''));
          if (!/^[A-Za-z]:/.test(s) && !s.startsWith('/')) s = '/' + s;
        } catch {}
      }
      return typeof normalizeWsClientKey === 'function' ? normalizeWsClientKey(s) : s.toLowerCase();
    }

    async function resetStaleProgressChats(conversationId) {
      try {
        if (!conversationId) {
          _agPinnedCompletedTask = null;
          Object.keys(_agLastTrackedChatsByCid).forEach(function (k) {
            delete _agLastTrackedChatsByCid[k];
          });
        } else if (_agPinnedCompletedTask && _agPinnedCompletedTask.conversationId === conversationId) {
          _agPinnedCompletedTask = null;
        }
        const wsMode = typeof _selectedWorkspaceMode !== 'undefined' ? _selectedWorkspaceMode : '__auto__';
        const autoWs = typeof _autoWorkspaceResolved !== 'undefined' ? _autoWorkspaceResolved : '';
        const activeWs = typeof _activeWorkspaceResolved !== 'undefined' ? _activeWorkspaceResolved : '';
        const scopedWs = (wsMode !== '__all__')
          ? ((wsMode !== '__auto__' ? wsMode : '') || autoWs || activeWs || '')
          : '';
        const body = conversationId
          ? { action: 'dismiss_chat', conversationId: conversationId, workspaceRoot: scopedWs }
          : { action: 'reset_stale', workspaceRoot: scopedWs };
        const res = await panelFetch('/api/hud', { method: 'POST', body: JSON.stringify(body) });
        const data = (res && typeof res.json === 'function') ? await res.json().catch(function () { return null; }) : res;
        if (data && data.ok && data.taskProgress) {
          renderTaskProgressAndHud(data.taskProgress, data.floatingHud);
        }
        if (typeof flashStatus === 'function') {
          flashStatus(L('Карточки прогресса сброшены ✓', 'Progress cards cleared ✓'));
        }
      } catch {}
    }

    function agDoesTaskMatchWorkspaceFilter(task, pinnedWsKey, autoOpenWsKeys) {
      if (!task) return false;
      if (task.isUnscopedChat || !task.workspaceRoot) return true;
      const taskWsKey = normalizeWsClientKey(task.workspaceRoot);
      if (pinnedWsKey) {
        return taskWsKey === pinnedWsKey;
      }
      if (autoOpenWsKeys && autoOpenWsKeys.size > 0) {
        return autoOpenWsKeys.has(taskWsKey);
      }
      return true;
    }

    function agFormatRecentAgo(ts) {
      const diffSec = Math.max(0, Math.round((Date.now() - Number(ts || Date.now())) / 1000));
      if (diffSec < 60) return L(diffSec + 'с назад', diffSec + 's ago');
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return L(diffMin + 'м назад', diffMin + 'm ago');
      const diffHr = Math.floor(diffMin / 60);
      return L(diffHr + 'ч назад', diffHr + 'h ago');
    }

    function agArchiveCompletedChat(chatObj) {
      if (!chatObj || typeof chatObj !== 'object') return null;
      const cid = String(chatObj.conversationId || '').trim();
      if (!cid || cid === '__primary_slot__') return null;
      const nowTs = Date.now();
      const finishedAt = Number(chatObj.completedAt || chatObj.updatedAt || nowTs) || nowTs;
      const rawTitleRu = String(chatObj.topicLabel || chatObj.stepTitle || chatObj.formattedText || '').trim();
      const rawTitleEn = String(chatObj.topicLabel || chatObj.stepTitleEn || chatObj.formattedTextEn || rawTitleRu).trim();
      const cleanTitleRu = rawTitleRu && rawTitleRu !== 'Ожидание задачи' ? rawTitleRu : L('Задача завершена', 'Task completed');
      const cleanTitleEn = rawTitleEn && rawTitleEn !== 'Waiting for task' ? rawTitleEn : 'Task completed';
      const totalSteps = Math.max(0, Number(chatObj.totalSteps || 0));
      const curStep = Math.max(0, Number(chatObj.currentStep || totalSteps || 0));
      const stepsText = totalSteps > 0 ? (Math.min(curStep || totalSteps, totalSteps) + '/' + totalSteps) : '';
      const summary = {
        key: cid + ':' + finishedAt,
        conversationId: cid,
        chatNumber: Math.max(1, Number(chatObj.chatNumber || 1)),
        chatLabel: String(chatObj.chatLabel || ('Чат #' + (chatObj.chatNumber || 1))),
        chatLabelEn: String(chatObj.chatLabelEn || ('Chat #' + (chatObj.chatNumber || 1))),
        topicLabel: String(chatObj.topicLabel || '').trim(),
        projectName: String(chatObj.projectName || '').trim(),
        workspaceRoot: String(chatObj.workspaceRoot || '').trim(),
        isUnscopedChat: Boolean(chatObj.isUnscopedChat || !chatObj.workspaceRoot),
        title: cleanTitleRu,
        titleEn: cleanTitleEn,
        stepsText: stepsText,
        finishedAt: finishedAt,
        status: chatObj.status === 'error' ? 'error' : 'completed',
      };
      const existingIdx = _agRecentCompletedTasks.findIndex(function (item) {
        return item && item.conversationId === cid && Math.abs((item.finishedAt || 0) - finishedAt) <= 15000;
      });
      if (existingIdx !== -1) {
        _agRecentCompletedTasks[existingIdx] = summary;
      } else {
        _agRecentCompletedTasks.unshift(summary);
        if (_agRecentCompletedTasks.length > AG_RECENT_COMPLETED_MAX) {
          _agRecentCompletedTasks = _agRecentCompletedTasks.slice(0, AG_RECENT_COMPLETED_MAX);
        }
      }
      _agPinnedCompletedTask = summary;
      return summary;
    }

    function renderRecentCompletedUi(pinnedWsKey, autoOpenWsKeys) {
      const btnEl = document.getElementById('btnRecentCompletedTasks');
      const popEl = document.getElementById('agRecentCompletedPopover');
      const listEl = document.getElementById('agRecentCompletedList');
      const visibleItems = _agRecentCompletedTasks.filter(function (item) {
        return agDoesTaskMatchWorkspaceFilter(item, pinnedWsKey, autoOpenWsKeys);
      });
      if (btnEl) {
        if (visibleItems.length > 0) {
          btnEl.style.display = 'inline-flex';
          const lblEl = btnEl.querySelector('.ag-recent-completed-label');
          const cntEl = btnEl.querySelector('.ag-recent-completed-count');
          if (lblEl) lblEl.textContent = L('✓ Недавние', '✓ Recent');
          if (cntEl) cntEl.textContent = String(visibleItems.length);
          btnEl.setAttribute('aria-expanded', _agRecentCompletedOpen ? 'true' : 'false');
          btnEl.title = L('Недавние выполненные задачи (', 'Recent completed tasks (') + visibleItems.length + ')';
        } else {
          btnEl.style.display = 'none';
          btnEl.setAttribute('aria-expanded', 'false');
          _agRecentCompletedOpen = false;
        }
      }
      if (popEl) {
        const showPop = Boolean(_agRecentCompletedOpen && visibleItems.length > 0);
        popEl.style.display = showPop ? 'flex' : 'none';
        popEl.setAttribute('aria-hidden', showPop ? 'false' : 'true');
      }
      if (listEl) {
        if (visibleItems.length === 0) {
          listEl.innerHTML = '';
        } else {
          listEl.innerHTML = visibleItems.map(function (item) {
            const titleTxt = isRu() ? (item.title || item.titleEn) : (item.titleEn || item.title);
            const chatBadgeTxt = isRu() ? item.chatLabel : item.chatLabelEn;
            const metaParts = [chatBadgeTxt];
            if (item.projectName) metaParts.push(item.projectName);
            if (item.stepsText) metaParts.push(item.stepsText);
            metaParts.push(agFormatRecentAgo(item.finishedAt));
            const iconTxt = item.status === 'error' ? '✕' : '✓';
            return '<div class="ag-recent-completed-row" data-recent-cid="' + escapeHtml(item.conversationId) + '">' +
              '<span class="ag-recent-completed-row-icon">' + iconTxt + '</span>' +
              '<div class="ag-recent-completed-row-body">' +
                '<div class="ag-recent-completed-row-title" title="' + escapeHtml(titleTxt) + '">' + escapeHtml(titleTxt) + '</div>' +
                '<div class="ag-recent-completed-row-meta">' + escapeHtml(metaParts.join(' · ')) + '</div>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      }
    }

    function closeRecentCompletedPopover() {
      _agRecentCompletedOpen = false;
      const btnEl = document.getElementById('btnRecentCompletedTasks');
      const popEl = document.getElementById('agRecentCompletedPopover');
      if (btnEl) btnEl.setAttribute('aria-expanded', 'false');
      if (popEl) {
        popEl.style.display = 'none';
        popEl.setAttribute('aria-hidden', 'true');
      }
    }

    function toggleRecentCompletedPopover(btnEl) {
      const nextOpen = !_agRecentCompletedOpen;
      _agRecentCompletedOpen = nextOpen;
      const targetBtn = btnEl || document.getElementById('btnRecentCompletedTasks');
      const popEl = document.getElementById('agRecentCompletedPopover');
      if (targetBtn) targetBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      if (popEl) {
        popEl.style.display = nextOpen ? 'flex' : 'none';
        popEl.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
      }
    }

    function dismissLastCompletedTask() {
      _agPinnedCompletedTask = null;
      if (_agLastProgressPayload) {
        renderTaskProgressAndHud(_agLastProgressPayload);
      } else {
        renderTaskProgressAndHud({ status: 'idle', activeChats: [] });
      }
    }

    function clearRecentCompletedTasks() {
      _agRecentCompletedTasks = [];
      _agPinnedCompletedTask = null;
      closeRecentCompletedPopover();
      if (_agLastProgressPayload) {
        renderTaskProgressAndHud(_agLastProgressPayload);
      } else {
        renderTaskProgressAndHud({ status: 'idle', activeChats: [] });
      }
    }

    let _agChatsStackFadeRaf = 0;
    let _categoryScrollFadeRaf = 0;
    let _categoryScrollFadeObserver = null;

    function syncVerticalScrollFade(el) {
      if (!el || !el.classList) return;
      const overflowPx = el.scrollHeight - el.clientHeight;
      const hasOverflow = overflowPx > 2;
      const showTop = hasOverflow && el.scrollTop > 2;
      const showBottom = hasOverflow && (el.scrollTop + el.clientHeight < el.scrollHeight - 2);
      el.classList.toggle('has-fade-top', showTop);
      el.classList.toggle('has-fade-bottom', showBottom);
    }

    function syncActiveChatsStackFade(targetEl) {
      const el = targetEl || document.getElementById('agActiveChatsStack');
      syncVerticalScrollFade(el);
    }

    function syncCategoryScrollFades() {
      const bodyEl = document.querySelector('.full-workspace-shell > .window-body');
      const railEl = document.getElementById('fullTabsBar');
      syncVerticalScrollFade(bodyEl);
      syncVerticalScrollFade(railEl);
    }

    function scheduleCategoryScrollFadeSync() {
      if (typeof requestAnimationFrame !== 'function') {
        syncCategoryScrollFades();
        return;
      }
      if (_categoryScrollFadeRaf) return;
      _categoryScrollFadeRaf = requestAnimationFrame(function () {
        _categoryScrollFadeRaf = 0;
        syncCategoryScrollFades();
      });
    }

    function ensureCategoryScrollFadeListeners() {
      const bodyEl = document.querySelector('.full-workspace-shell > .window-body');
      const railEl = document.getElementById('fullTabsBar');
      [bodyEl, railEl].forEach(function (el) {
        if (!el || el._categoryScrollFadeBound) return;
        el._categoryScrollFadeBound = true;
        el.addEventListener('scroll', function () {
          syncVerticalScrollFade(el);
        }, { passive: true });
        el.addEventListener('transitionend', function () {
          scheduleCategoryScrollFadeSync();
        });
      });
      if (!_categoryScrollFadeObserver && typeof ResizeObserver === 'function') {
        try {
          _categoryScrollFadeObserver = new ResizeObserver(function () {
            scheduleCategoryScrollFadeSync();
          });
          if (bodyEl) _categoryScrollFadeObserver.observe(bodyEl);
          if (railEl) _categoryScrollFadeObserver.observe(railEl);
          document.querySelectorAll('.full-workspace-shell > .window-body > [data-tab-panel], #fullTabsBar > .full-rail-nav').forEach(function (child) {
            _categoryScrollFadeObserver.observe(child);
          });
        } catch {}
      }
      scheduleCategoryScrollFadeSync();
    }

    function scheduleActiveChatsStackFadeSync(targetEl) {
      const el = targetEl || document.getElementById('agActiveChatsStack');
      if (!el) return;
      if (typeof requestAnimationFrame !== 'function') {
        syncActiveChatsStackFade(el);
        return;
      }
      if (_agChatsStackFadeRaf) return;
      _agChatsStackFadeRaf = requestAnimationFrame(function () {
        _agChatsStackFadeRaf = 0;
        syncActiveChatsStackFade(el);
      });
    }

    function ensureActiveChatsStackFadeListeners(el) {
      if (!el || el._agChatsStackFadeBound) return;
      el._agChatsStackFadeBound = true;
      el.addEventListener('scroll', function () {
        syncActiveChatsStackFade(el);
      }, { passive: true });
      el.addEventListener('transitionend', function () {
        scheduleActiveChatsStackFadeSync(el);
      });
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(function () {
          scheduleActiveChatsStackFadeSync(el);
        });
        ro.observe(el);
      }
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('resize', function () {
          scheduleActiveChatsStackFadeSync(el);
        }, { passive: true });
      }
    }

    function renderTaskProgressAndHud(progress, hud) {
      const p = progress || (hud && hud.progress) || null;
      if (!p) return;
      _agLastProgressPayload = p;
      const headingEl = document.getElementById('agProgressHeadingText');
      const projBadgeEl = document.getElementById('agProgressProjectBadge');
      const recentBarEl = document.getElementById('agRecentProjectsBar');
      const stackEl = document.getElementById('agActiveChatsStack');
      if (!stackEl) return;
      ensureActiveChatsStackFadeListeners(stackEl);

      function formatChatsWord(n) {
        return Lplural(n, 'чат', 'чата', 'чатов', 'chat', 'chats');
      }
      function formatProjectsWordRu(n) {
        return Lplural(n, 'проект', 'проекта', 'проектов', 'project', 'projects');
      }

      const projName = p.projectName || 'antigravity-model-router';
      const rawChats = Array.isArray(p.activeChats) && p.activeChats.length > 0
        ? p.activeChats
        : (p.status && p.status !== 'idle' && p.totalSteps > 0
            ? [{
                conversationId: p.activeConversationId || 'default',
                chatNumber: 1,
                chatLabel: 'Чат #1',
                chatLabelEn: 'Chat #1',
                topicLabel: '',
                projectName: projName,
                workspaceRoot: p.workspaceRoot || '',
                status: p.status,
                currentStep: p.currentStep,
                totalSteps: p.totalSteps,
                percent: p.percent,
                stepTitle: p.stepTitle,
                stepTitleEn: p.stepTitleEn,
                formattedText: p.formattedText,
                formattedTextEn: p.formattedTextEn,
                steps: p.steps || [],
              }]
            : []);

      const pinnedWsKey = (_selectedWorkspaceMode !== '__auto__' && _selectedWorkspaceMode !== '__all__')
        ? normalizeWsClientKey(_selectedWorkspaceMode)
        : '';
      const autoOpenWsKeys = new Set();
      if (_selectedWorkspaceMode === '__auto__') {
        if (typeof _cachedSidecarOpenWorkspaces !== 'undefined' && Array.isArray(_cachedSidecarOpenWorkspaces)) {
          for (let oi = 0; oi < _cachedSidecarOpenWorkspaces.length; oi++) {
            const ok = normalizeSidecarUriToWsKey(_cachedSidecarOpenWorkspaces[oi]);
            if (ok) autoOpenWsKeys.add(ok);
          }
        }
        const autoResKey = normalizeWsClientKey(
          (typeof _autoWorkspaceResolved !== 'undefined' && _autoWorkspaceResolved) ||
          (typeof _activeWorkspaceResolved !== 'undefined' && _activeWorkspaceResolved) ||
          ''
        );
        if (autoResKey) autoOpenWsKeys.add(autoResKey);
      }
      const chats = pinnedWsKey
        ? rawChats.filter(function (c) {
            if (!c) return false;
            if (c.isUnscopedChat || !c.workspaceRoot) return true;
            return normalizeWsClientKey(c.workspaceRoot) === pinnedWsKey;
          })
        : (autoOpenWsKeys.size > 0
            ? rawChats.filter(function (c) {
                if (!c) return false;
                if (c.isUnscopedChat || !c.workspaceRoot) return true;
                return autoOpenWsKeys.has(normalizeWsClientKey(c.workspaceRoot));
              })
            : rawChats);

      _agHasLiveTasks = chats.length > 0;

      const rawChatByCid = Object.create(null);
      rawChats.forEach(function (c) {
        if (!c || !c.conversationId) return;
        rawChatByCid[c.conversationId] = c;
        _agLastTrackedChatsByCid[c.conversationId] = c;
        if (c.status === 'completed' || Number(c.percent || 0) >= 100) {
          agArchiveCompletedChat(c);
        }
      });
      Object.keys(_agLastTrackedChatsByCid).forEach(function (prevCid) {
        if (!rawChatByCid[prevCid]) {
          const prevChat = _agLastTrackedChatsByCid[prevCid];
          delete _agLastTrackedChatsByCid[prevCid];
          if (prevChat && prevChat.status !== 'idle') {
            agArchiveCompletedChat({ ...prevChat, status: prevChat.status === 'error' ? 'error' : 'completed', percent: 100 });
          }
        }
      });

      const projectGroups = [];
      const projectGroupMap = Object.create(null);
      chats.forEach(function (c) {
        const isUnscoped = Boolean(c && (c.isUnscopedChat || !c.workspaceRoot));
        const cProj = isUnscoped
          ? L('Без проекта', 'No project')
          : (String((c && c.projectName) || projName).trim() || projName);
        let grp = projectGroupMap[cProj];
        if (!grp) {
          grp = {
            projectName: cProj,
            workspaceRoot: isUnscoped ? '' : ((c && c.workspaceRoot) || ''),
            isUnscopedChat: isUnscoped,
            chats: [],
          };
          projectGroupMap[cProj] = grp;
          projectGroups.push(grp);
        } else if (!isUnscoped && !grp.workspaceRoot && c && c.workspaceRoot) {
          grp.workspaceRoot = c.workspaceRoot;
        }
        grp.chats.push(c);
      });
      const currentHeaderWsKey = normalizeWsClientKey(
        pinnedWsKey
          ? _selectedWorkspaceMode
          : ((typeof _activeWorkspaceResolved !== 'undefined' && _activeWorkspaceResolved) || (typeof _autoWorkspaceResolved !== 'undefined' && _autoWorkspaceResolved) || '')
      );
      const singleForeignGroup = projectGroups.length === 1 &&
        !projectGroups[0].isUnscopedChat &&
        projectGroups[0].workspaceRoot &&
        currentHeaderWsKey &&
        normalizeWsClientKey(projectGroups[0].workspaceRoot) !== currentHeaderWsKey;
      const isMultiProject = projectGroups.length > 1 || Boolean(singleForeignGroup);

      const activePool = Array.isArray(p.activeProjects)
        ? p.activeProjects
        : (Array.isArray(p.recentProjects) ? p.recentProjects : []);
      const runningProjects = activePool.filter(function (rp) {
        return rp && rp.projectName && (rp.status === 'running' || rp.status === 'waiting_user');
      });
      const activeProjMetaMap = Object.create(null);
      runningProjects.forEach(function (rp) {
        activeProjMetaMap[rp.projectName] = rp;
      });

      if (headingEl) {
        headingEl.textContent = chats.length > 1
          ? (L('Параллельные задачи (', 'Parallel Tasks (') + chats.length + ')')
          : L('Прогресс задачи', 'Task Progress');
      }

      const pinnedCompletedVisible = (_agPinnedCompletedTask && agDoesTaskMatchWorkspaceFilter(_agPinnedCompletedTask, pinnedWsKey, autoOpenWsKeys))
        ? _agPinnedCompletedTask
        : null;
      renderRecentCompletedUi(pinnedWsKey, autoOpenWsKeys);

      const resetStaleBtn = document.getElementById('btnResetStaleProgress');
      if (resetStaleBtn) {
        resetStaleBtn.style.display = (chats.length > 0 || pinnedCompletedVisible) ? 'inline-flex' : 'none';
      }

      if (projBadgeEl) {
        syncWorkspaceSwitcherBadge();
      }

      if (recentBarEl) {
        const otherProjects = runningProjects.filter(function (rp) {
          if (!rp || !rp.workspaceRoot || rp.isUnscopedChat) return false;
          const rpWsKey = normalizeWsClientKey(rp.workspaceRoot);
          if (pinnedWsKey) {
            if (rpWsKey) return rpWsKey !== pinnedWsKey;
            return rp.projectName !== getSelectedWorkspaceDisplayName();
          }
          if (autoOpenWsKeys.size > 0 && rpWsKey) {
            return !autoOpenWsKeys.has(rpWsKey);
          }
          if (chats.length > 0) {
            return !Object.prototype.hasOwnProperty.call(projectGroupMap, rp.projectName);
          }
          return rp.projectName !== projName;
        });
        if (otherProjects.length > 0) {
          recentBarEl.style.display = 'flex';
          recentBarEl.innerHTML = otherProjects.slice(0, 3).map(function (rp) {
            const rpPct = Math.max(0, Math.min(100, Math.round(Number(rp.percent || 0))));
            const isWaitProj = rp.status === 'waiting_user';
            const countSuffix = Number(rp.activeChatsCount) > 1 ? (' (' + rp.activeChatsCount + ')') : '';
            const rpWs = rp.workspaceRoot || '';
            const rpStage = pickText(rp, 'stageLabel', 'stageLabelEn', '');
            const rpStep = pickText(rp, 'stepTitle', 'stepTitleEn', '');
            const waitLabel = isWaitProj ? L(' · Вопрос', ' · Question') : '';
            const tip = L('Переключить панель на активный проект ', 'Switch panel to active project ') + rp.projectName +
              (isWaitProj ? L(' (ожидает ответа на вопрос)', ' (waiting for user answer)') : '') +
              (rpStage ? (' · ' + rpStage) : '') +
              (rpStep ? (' · ' + rpStep) : '');
            return '<button type="button" class="ag-step-chip active' + (isWaitProj ? ' is-waiting-user' : '') + '" data-action="selectPanelWorkspaceChip" data-ws="' + escapeHtml(rpWs) + '" title="' + escapeHtml(tip) + '">' +
              (isWaitProj ? '? ' : '') + escapeHtml(rp.projectName) + countSuffix + waitLabel + ' · ' + rpPct + '%</button>';
          }).join('');
        } else {
          recentBarEl.style.display = 'none';
          recentBarEl.innerHTML = '';
        }
      }

      function createProjectGroupElement(projKey) {
        const el = document.createElement('div');
        el.className = 'ag-project-group';
        el.setAttribute('data-project', projKey);
        el.innerHTML =
          '<div class="ag-project-group-head">' +
            '<div class="ag-project-group-title">' +
              '<span class="ag-project-group-name"></span>' +
              '<span class="ag-project-group-count"></span>' +
            '</div>' +
          '</div>' +
          '<div class="ag-project-group-chats"></div>';
        return el;
      }

      function createStatusBarRowElement(slotKey) {
        const el = document.createElement('div');
        el.className = 'ag-chat-task-item';
        el.setAttribute('data-cid', slotKey);
        el.innerHTML =
          '<div class="ag-progress-capsule">' +
            '<span class="ag-bloom-dot idle"></span>' +
            '<span class="ag-chat-num-badge" style="display: none;"></span>' +
            '<span class="ag-progress-title">' + L('Ожидание задачи', 'Waiting for task') + '</span>' +
            '<div class="ag-hud-meta-row ag-hud-seg-group" style="display: none;">' +
              '<button type="button" class="ag-subagent-toggle-btn" data-action="toggleSubagentsList" data-arg="' + escapeHtml(slotKey) + '" aria-expanded="false" style="display: none;" title="' + L('Раскрыть список субагентов', 'Expand subagents list') + '">' +
                '<svg class="ag-subagent-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
                  '<path d="M6 3.75L10.25 8L6 12.25" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>' +
                '<svg class="ag-subagent-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
                  '<circle cx="5.5" cy="5.5" r="2.2" stroke="currentColor" stroke-width="1.5"/>' +
                  '<circle cx="11" cy="6.5" r="1.8" stroke="currentColor" stroke-width="1.4"/>' +
                  '<path d="M2.2 12.8c.5-1.9 1.8-2.8 3.3-2.8s2.8.9 3.3 2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
                  '<path d="M9.6 12.5c.3-1.2 1.1-1.9 2.2-1.9 1 0 1.7.6 2 1.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
                '</svg>' +
                '<span class="ag-hud-pill-lbl">' + L('Агенты', 'Agents') + '</span>' +
                '<span class="ag-subagent-count">0</span>' +
              '</button>' +
              '<button type="button" class="ag-bgtask-toggle-btn" data-action="toggleBgTasksList" data-arg="' + escapeHtml(slotKey) + '" aria-expanded="false" style="display: none;" title="' + L('Раскрыть список фоновых задач', 'Expand background tasks list') + '">' +
                '<svg class="ag-bgtask-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
                  '<path d="M6 3.75L10.25 8L6 12.25" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>' +
                '<svg class="ag-bgtask-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
                  '<rect x="2" y="2.8" width="12" height="10.4" rx="2" stroke="currentColor" stroke-width="1.4"/>' +
                  '<path d="M5 6.3L7.3 8 5 9.7M8.5 9.7H11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>' +
                '<span class="ag-hud-pill-lbl">' + L('Фон', 'Bg') + '</span>' +
                '<span class="ag-bgtask-count">0</span>' +
              '</button>' +
            '</div>' +
            '<div class="ag-bloom-track">' +
              '<div class="ag-bloom-fill idle" style="width: 0%; --fill-scale: 0;"><div class="ag-bloom-shimmer"></div></div>' +
            '</div>' +
            '<span class="ag-progress-pct"><span class="ag-pct-num">0</span>%</span>' +
            '<button type="button" class="ag-completed-dismiss-btn" data-action="dismissLastCompletedTask" style="display: none;" title="' + L('Скрыть выполненную задачу', 'Dismiss completed task') + '" aria-label="' + L('Скрыть выполненную задачу', 'Dismiss completed task') + '">×</button>' +
          '</div>' +
          '<div class="ag-steps-mini-list" style="display: none;"></div>' +
          '<div class="ag-subagents-drawer" aria-hidden="true">' +
            '<div class="ag-subagents-drawer-inner">' +
              '<div class="ag-subagents-list"></div>' +
            '</div>' +
          '</div>' +
          '<div class="ag-bgtasks-drawer" aria-hidden="true">' +
            '<div class="ag-bgtasks-drawer-inner">' +
              '<div class="ag-bgtasks-list"></div>' +
            '</div>' +
          '</div>' +
          '<div class="ag-context-pills-row" style="display: none;"></div>';
        return el;
      }

      function createSubagentRowElement(subCid) {
        const el = document.createElement('div');
        el.className = 'ag-subagent-item';
        el.setAttribute('data-sub-cid', subCid);
        el.innerHTML =
          '<div class="ag-subagent-capsule">' +
            '<span class="ag-bloom-dot is-mini"></span>' +
            '<span class="ag-subagent-badge">' + L('Агент #1', 'Agent #1') + '</span>' +
            '<span class="ag-subagent-title">' + L('Работа субагента', 'Subagent running') + '</span>' +
            '<div class="ag-bloom-track is-mini">' +
              '<div class="ag-bloom-fill" style="width: 0%; --fill-scale: 0;"><div class="ag-bloom-shimmer"></div></div>' +
            '</div>' +
            '<span class="ag-progress-pct is-mini"><span class="ag-pct-num">0</span>%</span>' +
          '</div>';
        return el;
      }

      function syncHudMetaRowVisibility(itemEl) {
        if (!itemEl) return;
        const metaRow = itemEl.querySelector('.ag-hud-meta-row');
        if (!metaRow) return;
        const subBtn = metaRow.querySelector('.ag-subagent-toggle-btn');
        const bgBtn = metaRow.querySelector('.ag-bgtask-toggle-btn');
        const hasSub = Boolean(subBtn && subBtn.style.display !== 'none');
        const hasBg = Boolean(bgBtn && bgBtn.style.display !== 'none');
        const hasVisible = hasSub || hasBg;
        const subActive = Boolean(hasSub && subBtn.classList.contains('is-active-glow'));
        const bgActive = Boolean(hasBg && bgBtn.classList.contains('is-active-glow'));
        metaRow.style.display = hasVisible ? 'inline-flex' : 'none';
        metaRow.classList.toggle('is-only-sub', hasSub && !hasBg);
        metaRow.classList.toggle('is-only-bg', !hasSub && hasBg);
        metaRow.classList.toggle('is-both', hasSub && hasBg);
        metaRow.classList.toggle('is-sub-active', subActive);
        metaRow.classList.toggle('is-bg-active', bgActive);
        metaRow.classList.toggle('is-calm', hasVisible && !subActive && !bgActive);
        const capEl = itemEl.querySelector('.ag-progress-capsule');
        if (capEl) capEl.classList.toggle('has-seg-group', hasVisible);
      }

      function syncSubagentsDrawerForChat(itemEl, cid, subagents) {
        const toggleBtn = itemEl.querySelector('.ag-subagent-toggle-btn');
        const countEl = toggleBtn ? toggleBtn.querySelector('.ag-subagent-count') : null;
        const lblEl = toggleBtn ? toggleBtn.querySelector('.ag-hud-pill-lbl') : null;
        const drawerEl = itemEl.querySelector('.ag-subagents-drawer');
        const listEl = itemEl.querySelector('.ag-subagents-list');
        const subs = Array.isArray(subagents) ? subagents : [];

        if (subs.length === 0) {
          delete _agExpandedSubagentsByChat[cid];
          if (toggleBtn) {
            toggleBtn.style.display = 'none';
            toggleBtn.classList.remove('is-expanded', 'is-active-glow');
            toggleBtn.setAttribute('aria-expanded', 'false');
          }
          syncHudMetaRowVisibility(itemEl);
          if (drawerEl) {
            drawerEl.classList.remove('is-open');
            drawerEl.setAttribute('aria-hidden', 'true');
          }
          if (listEl && listEl.children.length > 0) {
            Array.from(listEl.querySelectorAll('.ag-subagent-item')).forEach(function (subNode) {
              const sCid = subNode.getAttribute('data-sub-cid');
              if (sCid) delete _agDisplayedPctByChat['sub:' + sCid];
              subNode.remove();
            });
          }
          return;
        }

        const runningCount = subs.filter(function (s) {
          return s && (s.status === 'running' || s.status === 'waiting_user');
        }).length;
        const isExpanded = Boolean(_agExpandedSubagentsByChat[cid]);

        if (toggleBtn) {
          toggleBtn.style.display = 'inline-flex';
          toggleBtn.setAttribute('data-arg', cid);
          toggleBtn.classList.toggle('is-expanded', isExpanded);
          toggleBtn.classList.toggle('is-active-glow', runningCount > 0);
          toggleBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
          toggleBtn.title = isExpanded
            ? (L('Свернуть список субагентов (', 'Collapse subagents (') + subs.length + ')')
            : (L('Внутри задачи работают субагенты (', 'Active subagents in task (') + subs.length + L(') — нажмите, чтобы раскрыть', ') — click to expand'));
        }
        if (countEl) {
          countEl.textContent = String(subs.length);
        }
        if (lblEl) {
          lblEl.textContent = L('Агенты', 'Agents');
        }
        syncHudMetaRowVisibility(itemEl);
        if (drawerEl) {
          drawerEl.classList.toggle('is-open', isExpanded);
          drawerEl.setAttribute('aria-hidden', isExpanded ? 'false' : 'true');
        }
        if (!listEl) return;

        const activeSubIds = new Set();
        subs.forEach(function (s, sIdx) {
          const subCid = String(s.conversationId || (cid + '-sub-' + sIdx));
          activeSubIds.add(subCid);

          let subEl = listEl.querySelector('.ag-subagent-item[data-sub-cid="' + CSS.escape(subCid) + '"]:not(.closing)');
          if (!subEl) {
            subEl = createSubagentRowElement(subCid);
            listEl.appendChild(subEl);
          }

          const sDot = subEl.querySelector('.ag-bloom-dot');
          const sBadge = subEl.querySelector('.ag-subagent-badge');
          const sTitle = subEl.querySelector('.ag-subagent-title');
          const sFill = subEl.querySelector('.ag-bloom-fill');
          const sNum = subEl.querySelector('.ag-pct-num');

          const subPct = Math.max(0, Math.min(100, Math.round(Number(s.percent || 0))));
          animateChatPctNode('sub:' + subCid, sNum, subPct);

          const fallbackPrefix = (s && s.agentKind === 'swarm_worker') ? L('Рой #', 'Swarm #') : L('Агент #', 'Agent #');
          const badgeLabel = pickText(s, 'subagentBadge', 'subagentBadgeEn', '') || (fallbackPrefix + (s.subagentNumber || (sIdx + 1)));
          const roleText = String(pickText(s, 'roleLabel', 'roleLabelEn', '') || '').trim();
          const opText = pickText(s, 'stepTitle', 'stepTitleEn', '') || pickText(s, 'formattedText', 'formattedTextEn', '') || L('Работа субагента', 'Subagent running');
          const displayOp = roleText && opText.indexOf(roleText) === -1
            ? (roleText + ' · ' + opText)
            : opText;

          if (sBadge) {
            sBadge.textContent = badgeLabel;
            sBadge.title = roleText ? (badgeLabel + ' · ' + roleText) : badgeLabel;
          }
          if (sTitle) {
            sTitle.textContent = displayOp;
            sTitle.title = badgeLabel + ': ' + (pickText(s, 'formattedText', 'formattedTextEn', '') || displayOp);
          }
          if (sFill) {
            sFill.style.width = subPct + '%';
            sFill.style.setProperty('--fill-scale', (Math.max(0, Math.min(100, Number(subPct) || 0)) / 100).toFixed(4));
            if (s.status === 'completed' || subPct >= 100) {
              sFill.className = 'ag-bloom-fill completed idle';
            } else if (s.status === 'waiting_user') {
              sFill.className = 'ag-bloom-fill idle';
            } else {
              sFill.className = 'ag-bloom-fill';
            }
          }
          if (sDot) {
            if (s.status === 'completed' || subPct >= 100) {
              sDot.className = 'ag-bloom-dot is-mini completed';
            } else if (s.status === 'error') {
              sDot.className = 'ag-bloom-dot is-mini error';
            } else if (s.status === 'waiting_user') {
              sDot.className = 'ag-bloom-dot is-mini waiting';
            } else {
              sDot.className = 'ag-bloom-dot is-mini';
            }
          }
        });

        Array.from(listEl.querySelectorAll('.ag-subagent-item:not(.closing)')).forEach(function (subNode) {
          const sCid = subNode.getAttribute('data-sub-cid');
          if (!activeSubIds.has(sCid)) {
            delete _agDisplayedPctByChat['sub:' + sCid];
            subNode.classList.add('closing');
            setTimeout(function () { if (subNode.parentNode) subNode.remove(); }, 220);
          }
        });
      }

      function formatBgEtaText(etaSec) {
        const sec = Math.round(Number(etaSec || 0));
        if (!Number.isFinite(sec) || sec <= 0) return '';
        if (sec >= 3600) {
          const h = Math.floor(sec / 3600);
          const m = Math.floor((sec % 3600) / 60);
          return '~' + h + L('ч', 'h') + (m > 0 ? (' ' + m + L('м', 'm')) : '');
        }
        if (sec >= 60) {
          const m = Math.floor(sec / 60);
          const s = sec % 60;
          return '~' + m + L('м', 'm') + (s > 0 ? (' ' + s + L('с', 's')) : '');
        }
        return '~' + sec + L('с', 's');
      }

      function formatBgTaskMeta(task) {
        const st = String((task && task.status) || 'done');
        const started = Number((task && task.startedAt) || 0);
        const updated = Number((task && task.updatedAt) || 0);
        let durText = '';
        if (started > 0) {
          const endMs = st === 'running' ? Math.max(Date.now(), started) : (updated > started ? updated : 0);
          if (endMs >= started) {
            const sec = Math.max(0, Math.round((endMs - started) / 1000));
            if (sec >= 3600) durText = Math.floor(sec / 3600) + L('ч', 'h');
            else if (sec >= 60) durText = Math.floor(sec / 60) + L('м', 'm');
            else if (sec > 0 || st === 'running') durText = sec + L('с', 's');
          }
        }
        if (st === 'running') {
          if (task && task.isDaemon) return durText ? ('daemon · ' + durText) : 'daemon';
          const pMode = String((task && task.progressMode) || 'indeterminate');
          const rawPct = task && task.progressPct;
          const hasPct = typeof rawPct === 'number' && Number.isFinite(rawPct);
          if (hasPct && (pMode === 'determinate' || pMode === 'estimated')) {
            const pctVal = Math.max(0, Math.min(99, Math.round(rawPct)));
            const pctStr = (pMode === 'estimated' ? '~' : '') + pctVal + '%';
            const etaStr = formatBgEtaText(task && task.etaSec);
            const tailStr = etaStr || durText;
            return tailStr ? (pctStr + ' · ' + tailStr) : pctStr;
          }
          return durText || L('в работе', 'running');
        }
        if (st === 'error') return durText ? (L('ошиб · ', 'err · ') + durText) : L('ошибка', 'error');
        if (st === 'cancelled') return durText ? (L('отм · ', 'stop · ') + durText) : L('отменена', 'cancelled');
        return durText || L('готово', 'done');
      }

      function syncBgTasksDrawerForChat(itemEl, cid, bgTasks, totalCount, runningCountHint) {
        const toggleBtn = itemEl.querySelector('.ag-bgtask-toggle-btn');
        const countEl = toggleBtn ? toggleBtn.querySelector('.ag-bgtask-count') : null;
        const lblEl = toggleBtn ? toggleBtn.querySelector('.ag-hud-pill-lbl') : null;
        const drawerEl = itemEl.querySelector('.ag-bgtasks-drawer');
        const listEl = itemEl.querySelector('.ag-bgtasks-list');
        const tasks = Array.isArray(bgTasks) ? bgTasks : [];
        const total = Math.max(tasks.length, Math.round(Number(totalCount || 0)));

        if (total === 0 && tasks.length === 0) {
          delete _agExpandedBgTasksByChat[cid];
          delete _agShowAllBgTasksByChat[cid];
          if (toggleBtn) {
            toggleBtn.style.display = 'none';
            toggleBtn.classList.remove('is-expanded', 'is-active-glow');
            toggleBtn.setAttribute('aria-expanded', 'false');
          }
          syncHudMetaRowVisibility(itemEl);
          if (drawerEl) {
            drawerEl.classList.remove('is-open');
            drawerEl.setAttribute('aria-hidden', 'true');
          }
          if (listEl) {
            listEl.dataset.sig = '';
            if (listEl.children.length > 0) listEl.textContent = '';
          }
          return;
        }

        const runningInList = tasks.filter(function (t) { return t && t.status === 'running'; }).length;
        const runningCount = Math.max(runningInList, Math.round(Number(runningCountHint || 0)));
        const isExpanded = Boolean(_agExpandedBgTasksByChat[cid]);
        const isShowAll = Boolean(_agShowAllBgTasksByChat[cid]);
        const badgeText = runningCount > 0 ? (runningCount + '/' + total) : String(total);

        if (toggleBtn) {
          toggleBtn.style.display = 'inline-flex';
          toggleBtn.setAttribute('data-arg', cid);
          toggleBtn.classList.toggle('is-expanded', isExpanded);
          toggleBtn.classList.toggle('is-active-glow', runningCount > 0);
          toggleBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
          toggleBtn.title = isExpanded
            ? (L('Свернуть список фоновых задач (', 'Collapse background tasks (') + total + ')')
            : (runningCount > 0
                ? (L('Фоновые задачи: ', 'Background tasks: ') + runningCount + L(' в работе из ', ' running of ') + total)
                : (L('Фоновые задачи (', 'Background tasks (') + total + L(') — нажмите, чтобы раскрыть', ') — click to expand')));
        }
        if (countEl && countEl.textContent !== badgeText) {
          countEl.textContent = badgeText;
        }
        if (lblEl) {
          const nextLbl = L('Фон', 'Bg');
          if (lblEl.textContent !== nextLbl) lblEl.textContent = nextLbl;
        }
        syncHudMetaRowVisibility(itemEl);
        if (drawerEl) {
          drawerEl.classList.toggle('is-open', isExpanded);
          drawerEl.setAttribute('aria-hidden', isExpanded ? 'false' : 'true');
        }
        if (!listEl) return;

        // Reconcile items in-place by data-task-id so agBarSlideIn never replays on step/label updates
        let headerEl = listEl.querySelector('.ag-bgtasks-header');
        if (!headerEl) {
          headerEl = document.createElement('div');
          headerEl.className = 'ag-bgtasks-header';
          const headerTitle = document.createElement('span');
          headerTitle.className = 'ag-bgtasks-header-title';
          const headerBadge = document.createElement('span');
          headerBadge.className = 'ag-bgtasks-header-badge';
          headerEl.appendChild(headerTitle);
          headerEl.appendChild(headerBadge);
          listEl.insertBefore(headerEl, listEl.firstChild);
        }
        const headerTitle = headerEl.querySelector('.ag-bgtasks-header-title');
        const headerBadge = headerEl.querySelector('.ag-bgtasks-header-badge');
        const nextHeaderTitle = L('Фоновые задачи', 'Background Tasks');
        const nextHeaderBadge = String(total);
        if (headerTitle && headerTitle.textContent !== nextHeaderTitle) headerTitle.textContent = nextHeaderTitle;
        if (headerBadge && headerBadge.textContent !== nextHeaderBadge) headerBadge.textContent = nextHeaderBadge;

        const existingByTaskId = Object.create(null);
        Array.from(listEl.querySelectorAll('.ag-bgtask-item')).forEach(function (node) {
          const tid = node.getAttribute('data-task-id');
          if (tid) existingByTaskId[tid] = node;
        });

        const activeTaskIds = new Set();
        let prevNode = headerEl;

        tasks.forEach(function (t, tIdx) {
          const taskId = String((t && (t.taskId || t.id)) || ('bg-' + tIdx));
          activeTaskIds.add(taskId);
          const st = String((t && t.status) || 'done');
          const statusCls = st === 'running'
            ? 'is-running'
            : (st === 'error' ? 'is-error' : (st === 'cancelled' ? 'is-cancelled' : 'is-done'));
          const isOverflowHidden = !isShowAll && tIdx >= AG_BG_TASKS_PREVIEW_LIMIT;
          const nextCls = 'ag-bgtask-item ' + statusCls + (isOverflowHidden ? ' is-overflow-hidden' : '');
          const nextAriaHidden = isOverflowHidden ? 'true' : 'false';

          let rowItem = existingByTaskId[taskId];
          let icoEl;
          let titleEl;
          let metaEl;
          let trackEl;
          let fillEl;
          let subEl;
          if (!rowItem) {
            rowItem = document.createElement('div');
            rowItem.setAttribute('data-task-id', taskId);
            const rowInner = document.createElement('div');
            rowInner.className = 'ag-bgtask-row';
            const rowTop = document.createElement('div');
            rowTop.className = 'ag-bgtask-top';
            icoEl = document.createElement('span');
            titleEl = document.createElement('span');
            titleEl.className = 'ag-bgtask-title';
            metaEl = document.createElement('span');
            rowTop.appendChild(icoEl);
            rowTop.appendChild(titleEl);
            rowTop.appendChild(metaEl);

            const progLine = document.createElement('div');
            progLine.className = 'ag-bgtask-progress-line';
            trackEl = document.createElement('div');
            trackEl.className = 'ag-bgtask-track';
            trackEl.setAttribute('role', 'progressbar');
            trackEl.setAttribute('aria-valuemin', '0');
            trackEl.setAttribute('aria-valuemax', '100');
            fillEl = document.createElement('div');
            fillEl.className = 'ag-bgtask-fill';
            trackEl.appendChild(fillEl);
            progLine.appendChild(trackEl);

            subEl = document.createElement('div');
            subEl.className = 'ag-bgtask-substatus';
            subEl.style.display = 'none';

            rowInner.appendChild(rowTop);
            rowInner.appendChild(progLine);
            rowInner.appendChild(subEl);
            rowItem.appendChild(rowInner);
          } else {
            icoEl = rowItem.querySelector('.ag-bgtask-ico');
            titleEl = rowItem.querySelector('.ag-bgtask-title');
            metaEl = rowItem.querySelector('.ag-bgtask-meta');
            trackEl = rowItem.querySelector('.ag-bgtask-track');
            fillEl = rowItem.querySelector('.ag-bgtask-fill');
            subEl = rowItem.querySelector('.ag-bgtask-substatus');
          }

          if (rowItem.className !== nextCls) rowItem.className = nextCls;
          if (rowItem.getAttribute('aria-hidden') !== nextAriaHidden) {
            rowItem.setAttribute('aria-hidden', nextAriaHidden);
          }

          const nextIcoCls = 'ag-bgtask-ico ' + statusCls;
          const nextIcoTxt = (st === 'error' || st === 'cancelled') ? '×' : '>_';
          if (icoEl) {
            if (icoEl.className !== nextIcoCls) icoEl.className = nextIcoCls;
            if (icoEl.getAttribute('aria-hidden') !== 'true') icoEl.setAttribute('aria-hidden', 'true');
            if (icoEl.textContent !== nextIcoTxt) icoEl.textContent = nextIcoTxt;
          }

          const titleText = pickText(t, 'label', 'labelEn', '') || (t && t.commandPreview) || L('Фоновая задача', 'Background task');
          const previewText = String((t && t.commandPreview) || '').trim();
          const fullTip = previewText && previewText !== titleText
            ? (titleText + '\n' + previewText)
            : titleText;
          if (titleEl) {
            if (titleEl.textContent !== titleText) titleEl.textContent = titleText;
            if (titleEl.title !== fullTip) titleEl.title = fullTip;
          }

          const nextMetaCls = 'ag-bgtask-meta ' + statusCls;
          const nextMetaTxt = formatBgTaskMeta(t);
          if (metaEl) {
            if (metaEl.className !== nextMetaCls) metaEl.className = nextMetaCls;
            if (metaEl.textContent !== nextMetaTxt) metaEl.textContent = nextMetaTxt;
          }

          const rawMode = String((t && t.progressMode) || '').trim();
          const pMode = rawMode || (st === 'running' ? 'indeterminate' : st);
          const rawPct = t && t.progressPct;
          const hasPct = typeof rawPct === 'number' && Number.isFinite(rawPct);
          let nextFillCls = 'ag-bgtask-fill';
          let nextWidth = '';
          let nextAriaNow = null;

          if (st === 'done' || pMode === 'done') {
            nextFillCls += ' is-done';
            nextWidth = '100%';
            nextAriaNow = '100';
          } else if (st === 'error' || pMode === 'error') {
            const errPct = hasPct ? Math.max(0, Math.min(100, Math.round(rawPct))) : 100;
            nextFillCls += ' is-error';
            nextWidth = errPct + '%';
            nextAriaNow = String(errPct);
          } else if (st === 'cancelled' || pMode === 'cancelled') {
            const stopPct = hasPct ? Math.max(0, Math.min(100, Math.round(rawPct))) : 0;
            nextFillCls += ' is-cancelled';
            nextWidth = stopPct + '%';
            nextAriaNow = String(stopPct);
          } else if (!(t && t.isDaemon) && pMode === 'determinate' && hasPct) {
            const detPct = Math.max(0, Math.min(99, Math.round(rawPct)));
            nextFillCls += ' is-determinate';
            nextWidth = detPct + '%';
            nextAriaNow = String(detPct);
          } else if (!(t && t.isDaemon) && pMode === 'estimated' && hasPct) {
            const estPct = Math.max(0, Math.min(97, Math.round(rawPct)));
            nextFillCls += ' is-estimated';
            nextWidth = estPct + '%';
            nextAriaNow = String(estPct);
          } else {
            const updAt = Number((t && t.updatedAt) || 0);
            const isQuiet = updAt > 0 && (Date.now() - updAt) > 25000;
            nextFillCls += ' is-indeterminate' + (isQuiet ? ' is-quiet' : '');
            nextWidth = '';
            nextAriaNow = null;
          }

          if (trackEl) {
            if (nextAriaNow !== null) {
              if (trackEl.getAttribute('aria-valuenow') !== nextAriaNow) {
                trackEl.setAttribute('aria-valuenow', nextAriaNow);
              }
            } else if (trackEl.hasAttribute('aria-valuenow')) {
              trackEl.removeAttribute('aria-valuenow');
            }
          }
          if (fillEl) {
            if (fillEl.className !== nextFillCls) fillEl.className = nextFillCls;
            if (fillEl.style.width !== nextWidth) fillEl.style.width = nextWidth;
          }

          const rawSub = st === 'running' ? String((t && t.progressText) || '').trim() : '';
          const showSub = Boolean(rawSub && rawSub !== titleText);
          if (subEl) {
            if (showSub) {
              if (subEl.textContent !== rawSub) subEl.textContent = rawSub;
              if (subEl.title !== rawSub) subEl.title = rawSub;
              if (subEl.style.display !== '') subEl.style.display = '';
            } else {
              if (subEl.style.display !== 'none') subEl.style.display = 'none';
              if (subEl.textContent !== '') subEl.textContent = '';
            }
          }

          const expectedRef = prevNode.nextSibling;
          if (rowItem.parentNode !== listEl || rowItem !== expectedRef) {
            listEl.insertBefore(rowItem, expectedRef);
          }
          prevNode = rowItem;
        });

        Array.from(listEl.querySelectorAll('.ag-bgtask-item')).forEach(function (node) {
          const tid = node.getAttribute('data-task-id');
          if (!activeTaskIds.has(tid) && !node.classList.contains('closing')) {
            if (agCanSmoothHudMotion(node)) {
              agSmoothCollapseAndRemoveNode(node);
            } else {
              node.remove();
            }
          }
        });

        let seeAllBtn = listEl.querySelector('.ag-bgtasks-see-all-btn');
        if (tasks.length > AG_BG_TASKS_PREVIEW_LIMIT) {
          if (!seeAllBtn) {
            seeAllBtn = document.createElement('button');
            seeAllBtn.type = 'button';
            seeAllBtn.className = 'ag-bgtasks-see-all-btn';
            seeAllBtn.setAttribute('data-action', 'toggleBgTasksShowAll');
            listEl.appendChild(seeAllBtn);
          } else if (seeAllBtn.parentNode !== listEl || seeAllBtn !== listEl.lastElementChild) {
            listEl.appendChild(seeAllBtn);
          }
          const nextSeeTxt = isShowAll
            ? L('Свернуть', 'Collapse')
            : (L('Показать все (', 'See all (') + total + ')');
          const nextSeeExpanded = isShowAll ? 'true' : 'false';
          if (seeAllBtn.getAttribute('data-arg') !== cid) seeAllBtn.setAttribute('data-arg', cid);
          if (seeAllBtn.getAttribute('data-total') !== String(total)) seeAllBtn.setAttribute('data-total', String(total));
          if (seeAllBtn.getAttribute('aria-expanded') !== nextSeeExpanded) seeAllBtn.setAttribute('aria-expanded', nextSeeExpanded);
          if (seeAllBtn.textContent !== nextSeeTxt) seeAllBtn.textContent = nextSeeTxt;
        } else if (seeAllBtn) {
          seeAllBtn.remove();
        }
      }

      // Always keep at least 1 stable status-bar capsule on screen; morph it into "Ожидание задачи" when 0 tasks are active
      if (chats.length === 0) {
        const existingItems = Array.from(stackEl.querySelectorAll('.ag-chat-task-item:not(.closing)'));
        let primaryEl = existingItems[0] || null;
        existingItems.slice(1).forEach(function (extraNode) {
          const oldCid = extraNode.getAttribute('data-cid');
          delete _agDisplayedPctByChat[oldCid];
          delete _agExpandedSubagentsByChat[oldCid];
          delete _agExpandedBgTasksByChat[oldCid];
          delete _agShowAllBgTasksByChat[oldCid];
          delete _agExpandedStepsByChat[oldCid];
          agSmoothCollapseAndRemoveNode(extraNode);
        });
        let morphedFromActive = false;
        if (!primaryEl) {
          primaryEl = createStatusBarRowElement('__primary_slot__');
          stackEl.appendChild(primaryEl);
        } else {
          const prevCid = primaryEl.getAttribute('data-cid');
          if (prevCid && prevCid !== '__primary_slot__') {
            morphedFromActive = true;
            _agDisplayedPctByChat['__primary_slot__'] = _agDisplayedPctByChat[prevCid] || 0;
            delete _agDisplayedPctByChat[prevCid];
            delete _agExpandedSubagentsByChat[prevCid];
            delete _agExpandedBgTasksByChat[prevCid];
            delete _agShowAllBgTasksByChat[prevCid];
            delete _agExpandedStepsByChat[prevCid];
          }
          primaryEl.setAttribute('data-cid', '__primary_slot__');
          if (primaryEl.parentNode !== stackEl) {
            stackEl.appendChild(primaryEl);
          }
        }
        Array.from(stackEl.querySelectorAll('.ag-project-group')).forEach(function (grpNode) {
          grpNode.remove();
        });
        const mainCap = primaryEl.querySelector('.ag-progress-capsule') || primaryEl;
        const dotEl = mainCap.querySelector('.ag-bloom-dot');
        const badgeEl = mainCap.querySelector('.ag-chat-num-badge');
        const titleEl = mainCap.querySelector('.ag-progress-title');
        const fillEl = mainCap.querySelector('.ag-bloom-fill');
        const pctWrapEl = mainCap.querySelector('.ag-progress-pct');
        const numEl = mainCap.querySelector('.ag-pct-num');
        const dismissBtn = mainCap.querySelector('.ag-completed-dismiss-btn');
        const stepsEl = primaryEl.querySelector('.ag-steps-mini-list');

        syncSubagentsDrawerForChat(primaryEl, '__primary_slot__', []);
        syncBgTasksDrawerForChat(primaryEl, '__primary_slot__', [], 0, 0);

        mainCap.classList.remove('is-waiting-user');
        if (mainCap.getAttribute('data-action') === 'focusWaitingProgressChat') {
          mainCap.removeAttribute('data-action');
          mainCap.removeAttribute('data-cid');
          mainCap.removeAttribute('role');
          mainCap.removeAttribute('tabindex');
          mainCap.title = '';
        }
        const idleJumpBtn = mainCap.querySelector('.ag-waiting-jump-btn');
        if (idleJumpBtn) idleJumpBtn.style.display = 'none';
        if (pinnedCompletedVisible) {
          const isErrDone = pinnedCompletedVisible.status === 'error';
          const doneTitle = (isErrDone ? '✕ ' : '✓ ') + (isRu()
            ? (pinnedCompletedVisible.title || pinnedCompletedVisible.titleEn)
            : (pinnedCompletedVisible.titleEn || pinnedCompletedVisible.title));
          if (dotEl) dotEl.className = isErrDone ? 'ag-bloom-dot error' : 'ag-bloom-dot completed';
          if (badgeEl) {
            badgeEl.style.display = 'inline-flex';
            badgeEl.textContent = isRu() ? pinnedCompletedVisible.chatLabel : pinnedCompletedVisible.chatLabelEn;
            badgeEl.title = (pinnedCompletedVisible.projectName ? pinnedCompletedVisible.projectName + ' · ' : '') + doneTitle;
          }
          if (titleEl) {
            titleEl.textContent = doneTitle;
            titleEl.classList.remove('is-idle');
            titleEl.title = doneTitle + ' · ' + agFormatRecentAgo(pinnedCompletedVisible.finishedAt);
          }
          if (fillEl) {
            fillEl.style.width = '100%';
            fillEl.style.setProperty('--fill-scale', '1');
            fillEl.className = 'ag-bloom-fill completed idle';
          }
          if (pctWrapEl) pctWrapEl.classList.remove('is-idle');
          if (dismissBtn) {
            dismissBtn.style.display = 'inline-flex';
            dismissBtn.title = L('Скрыть выполненную задачу', 'Dismiss completed task');
          }
          animateChatPctNode('__primary_slot__', numEl, 100);
        } else {
          if (dotEl) dotEl.className = 'ag-bloom-dot idle';
          if (badgeEl) badgeEl.style.display = 'none';
          if (titleEl) {
            titleEl.textContent = L('Ожидание задачи', 'Waiting for task');
            titleEl.classList.add('is-idle');
            titleEl.title = L('Все задачи завершены · ожидание нового запроса', 'All tasks finished · awaiting new prompt');
          }
          if (fillEl) {
            fillEl.style.width = '0%';
            fillEl.style.setProperty('--fill-scale', '0');
            fillEl.className = 'ag-bloom-fill idle';
          }
          if (pctWrapEl) pctWrapEl.classList.add('is-idle');
          if (dismissBtn) dismissBtn.style.display = 'none';
          animateChatPctNode('__primary_slot__', numEl, 0);
        }
        if (stepsEl) {
          agSmoothHideInlineStrip(stepsEl, function () {
            stepsEl.innerHTML = '';
          });
        }
        const idleCtxEl = primaryEl.querySelector('.ag-context-pills-row');
        if (idleCtxEl) {
          agSmoothHideInlineStrip(idleCtxEl, function () {
            idleCtxEl.textContent = '';
            idleCtxEl.dataset.sig = '';
          });
        }
        if (morphedFromActive && agCanSmoothHudMotion(mainCap)) {
          try {
            mainCap.animate(
              [{ opacity: 0.72, transform: 'scale(0.99)' }, { opacity: 1, transform: 'scale(1)' }],
              { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
            );
          } catch {}
        }
        if (typeof syncFullLeftRailStickyOffset === 'function') syncFullLeftRailStickyOffset();
        syncActiveChatsStackFade(stackEl);
        scheduleActiveChatsStackFadeSync(stackEl);
        return;
      }

      const activeIds = new Set();

      function renderSingleChatRow(containerEl, prevRowEl, c, globalIdx) {
        const cid = String(c.conversationId || ('chat-' + globalIdx));
        activeIds.add(cid);

        let itemEl = stackEl.querySelector('.ag-chat-task-item[data-cid="' + CSS.escape(cid) + '"]:not(.closing)');
        if (!itemEl && globalIdx === 0) {
          // Reuse the permanent idle bar seamlessly for the 1st active chat
          const idleSlot = stackEl.querySelector('.ag-chat-task-item[data-cid="__primary_slot__"]:not(.closing)');
          if (idleSlot) {
            itemEl = idleSlot;
            itemEl.setAttribute('data-cid', cid);
            _agDisplayedPctByChat[cid] = 0;
          }
        }
        if (!itemEl) {
          itemEl = createStatusBarRowElement(cid);
          containerEl.appendChild(itemEl);
        }

        const expectedRef = prevRowEl ? prevRowEl.nextSibling : containerEl.firstChild;
        if (itemEl.parentNode !== containerEl || itemEl !== expectedRef) {
          containerEl.insertBefore(itemEl, expectedRef);
        }

        const mainCap = itemEl.querySelector('.ag-progress-capsule') || itemEl;
        const dotEl = mainCap.querySelector('.ag-bloom-dot');
        const badgeEl = mainCap.querySelector('.ag-chat-num-badge');
        const titleEl = mainCap.querySelector('.ag-progress-title');
        const fillEl = mainCap.querySelector('.ag-bloom-fill');
        const pctWrapEl = mainCap.querySelector('.ag-progress-pct');
        const numEl = mainCap.querySelector('.ag-pct-num');
        const stepsEl = itemEl.querySelector('.ag-steps-mini-list');

        syncSubagentsDrawerForChat(itemEl, cid, c.subagents);
        syncBgTasksDrawerForChat(itemEl, cid, c.backgroundTasks, c.backgroundTasksTotalCount, c.backgroundTasksCount);

        const pct = Math.max(0, Math.min(100, Math.round(Number(c.percent || 0))));
        animateChatPctNode(cid, numEl, pct);
        if (pctWrapEl) pctWrapEl.classList.remove('is-idle');
        const rowDismissBtn = mainCap.querySelector('.ag-completed-dismiss-btn');
        if (rowDismissBtn) {
          rowDismissBtn.style.display = (c.status === 'completed') ? 'inline-flex' : 'none';
        }

        const chatNumLabel = pickText(c, 'chatLabel', 'chatLabelEn', '') || (L('Чат #', 'Chat #') + (c.chatNumber || (globalIdx + 1)));
        const topic = String(c.topicLabel || '').trim();
        const isUnscopedRow = Boolean(c.isUnscopedChat || !c.workspaceRoot);
        const cProj = isUnscopedRow
          ? L('Без проекта', 'No project')
          : (String(c.projectName || projName).trim() || projName);
        if (badgeEl) {
          badgeEl.style.display = 'inline-flex';
          badgeEl.textContent = chatNumLabel;
          badgeEl.title = cProj + ' · ' + chatNumLabel + (topic ? (': ' + topic) : '');
        }

        const isWaitingRow = c.status === 'waiting_user';
        let jumpBtn = mainCap.querySelector('.ag-waiting-jump-btn');
        if (isWaitingRow) {
          mainCap.classList.add('is-waiting-user');
          mainCap.setAttribute('data-action', 'focusWaitingProgressChat');
          mainCap.setAttribute('data-cid', cid);
          mainCap.setAttribute('role', 'button');
          mainCap.tabIndex = 0;
          mainCap.title = L('Нажмите, чтобы перейти в чат и ответить на вопрос', 'Click to open this chat and answer the question');
          if (!jumpBtn) {
            jumpBtn = document.createElement('button');
            jumpBtn.type = 'button';
            jumpBtn.className = 'ag-waiting-jump-btn';
            jumpBtn.setAttribute('data-action', 'focusWaitingProgressChat');
            if (pctWrapEl && pctWrapEl.parentNode === mainCap) {
              mainCap.insertBefore(jumpBtn, pctWrapEl);
            } else {
              mainCap.appendChild(jumpBtn);
            }
          }
          jumpBtn.setAttribute('data-cid', cid);
          jumpBtn.textContent = L('Открыть чат ↗', 'Open chat ↗');
          jumpBtn.title = L('Перейти в чат с вопросом', 'Jump to chat with pending question');
          jumpBtn.style.display = 'inline-flex';
        } else {
          mainCap.classList.remove('is-waiting-user');
          if (mainCap.getAttribute('data-action') === 'focusWaitingProgressChat') {
            mainCap.removeAttribute('data-action');
            mainCap.removeAttribute('data-cid');
            mainCap.removeAttribute('role');
            mainCap.removeAttribute('tabindex');
            mainCap.title = '';
          }
          if (jumpBtn) jumpBtn.style.display = 'none';
        }

        const totalSteps = Math.max(1, Number(c.totalSteps || 3));
        const curStep = Math.max(1, Math.min(totalSteps, Number(c.currentStep || 1)));
        const stageText = pickText(c, 'formattedText', 'formattedTextEn', '') || pickText(c, 'stepTitle', 'stepTitleEn', '') || L('Выполнение операции', 'Running operation');
        if (titleEl) {
          titleEl.classList.remove('is-idle');
          titleEl.textContent = topic && chats.length > 1 ? (topic + ' — ' + stageText) : stageText;
          titleEl.title = stageText + (topic ? (' (' + topic + ')') : '');
        }

        if (fillEl) {
          fillEl.style.width = pct + '%';
          fillEl.style.setProperty('--fill-scale', (Math.max(0, Math.min(100, Number(pct) || 0)) / 100).toFixed(4));
          if (c.status === 'completed' || pct >= 100) {
            fillEl.className = 'ag-bloom-fill completed idle';
          } else if (c.status === 'waiting_user') {
            fillEl.className = 'ag-bloom-fill idle';
          } else {
            fillEl.className = 'ag-bloom-fill';
          }
        }

        if (dotEl) {
          if (c.status === 'completed' || pct >= 100) {
            dotEl.className = 'ag-bloom-dot completed';
          } else if (c.status === 'error') {
            dotEl.className = 'ag-bloom-dot error';
          } else if (c.status === 'waiting_user') {
            dotEl.className = 'ag-bloom-dot waiting';
          } else {
            dotEl.className = 'ag-bloom-dot';
          }
        }

        if (stepsEl && Array.isArray(c.steps) && c.steps.length > 0) {
          agShowInlineStrip(stepsEl, 'flex');
          const visibleSteps = c.steps.slice(0, 30);
          while (stepsEl.children.length > visibleSteps.length) {
            stepsEl.removeChild(stepsEl.lastElementChild);
          }
          visibleSteps.forEach(function (st, sIdx) {
            const stepNum = sIdx + 1;
            const stepKey = String(stepNum);
            const expandedSet = _agExpandedStepsByChat[cid];
            const isStepExpanded = Boolean(expandedSet && expandedSet.has(stepKey));
            const isQuestion = st.kind === 'question';
            const isWaitingQ = isQuestion && (st.status === 'waiting_user' || (c.status === 'waiting_user' && stepNum === curStep));
            const isDone = !isWaitingQ && (c.status === 'completed' || pct >= 100 || stepNum < curStep || st.status === 'completed');
            const isErr = !isDone && !isWaitingQ && stepNum === curStep && (c.status === 'error' || st.status === 'error');
            const isActive = !isDone && !isErr && (isWaitingQ || stepNum === curStep);
            const clsList = ['ag-step-chip'];
            if (isDone) clsList.push('done');
            else if (isErr) clsList.push('error');
            else if (isActive) clsList.push('active');
            if (isQuestion) clsList.push('question');
            if (isWaitingQ) clsList.push('waiting');
            if (isStepExpanded) clsList.push('is-expanded');
            const cls = clsList.join(' ');
            const prefix = isDone ? '✓ ' : (isErr ? '✕ ' : (isQuestion ? '? ' : ''));
            const rawTitle = pickText(st, 'title', 'titleEn', '') || (L('Этап ', 'Step ') + stepNum);
            const rawFull = isRu() ? (st.fullTitle || st.fullTitleEn || '') : (st.fullTitleEn || st.fullTitle || '');
            const tip = rawFull || pickText(st, 'activeDetail', 'activeDetailEn', '') || rawTitle;
            const fullTip = (prefix || (stepNum + '. ')) + tip + (isWaitingQ
              ? L(' (клик — перейти в чат)', ' (click to open chat)')
              : L(' (клик — раскрыть/свернуть)', ' (click to expand/collapse)'));
            const numText = stepKey;
            const labelText = prefix + rawTitle;

            let chipEl = stepsEl.children[sIdx];
            if (!chipEl) {
              chipEl = document.createElement('span');
              chipEl.tabIndex = 0;
              chipEl.setAttribute('role', 'button');
              chipEl.setAttribute('data-action', isWaitingQ ? 'focusWaitingProgressChat' : 'toggleStepChip');
              const numEl = document.createElement('span');
              numEl.className = 'ag-step-num';
              const lblEl = document.createElement('span');
              lblEl.className = 'ag-step-label';
              chipEl.appendChild(numEl);
              chipEl.appendChild(lblEl);
              stepsEl.appendChild(chipEl);
            }
            if (chipEl.className !== cls) chipEl.className = cls;
            const expectedAction = isWaitingQ ? 'focusWaitingProgressChat' : 'toggleStepChip';
            if (chipEl.getAttribute('data-action') !== expectedAction) {
              chipEl.setAttribute('data-action', expectedAction);
            }
            if (chipEl.getAttribute('data-cid') !== cid) chipEl.setAttribute('data-cid', cid);
            if (chipEl.getAttribute('data-step') !== stepKey) chipEl.setAttribute('data-step', stepKey);
            const nextAriaExpanded = isStepExpanded ? 'true' : 'false';
            if (chipEl.getAttribute('aria-expanded') !== nextAriaExpanded) {
              chipEl.setAttribute('aria-expanded', nextAriaExpanded);
            }
            if (chipEl.title !== fullTip) chipEl.title = fullTip;
            const numEl = chipEl.firstElementChild;
            const lblEl = chipEl.lastElementChild;
            if (numEl && numEl.textContent !== numText) numEl.textContent = numText;
            if (lblEl && lblEl.textContent !== labelText) lblEl.textContent = labelText;
          });
        } else if (stepsEl) {
          agSmoothHideInlineStrip(stepsEl, function () {
            if (stepsEl.children.length > 0) stepsEl.textContent = '';
          });
        }

        const ctxRowEl = itemEl.querySelector('.ag-context-pills-row');
        if (ctxRowEl) {
          const skills = Array.isArray(c.activeSkills) ? c.activeSkills.slice(0, 4) : [];
          const sig = skills.join(',') + '|' + getUiLanguage();
          if (skills.length === 0) {
            agSmoothHideInlineStrip(ctxRowEl, function () {
              if (ctxRowEl.children.length > 0) ctxRowEl.textContent = '';
              ctxRowEl.dataset.sig = '';
            });
          } else {
            agShowInlineStrip(ctxRowEl, 'flex');
            if (ctxRowEl.dataset.sig !== sig) {
              ctxRowEl.dataset.sig = sig;
              ctxRowEl.textContent = '';
              skills.forEach(function (slug) {
                const pill = document.createElement('span');
                pill.className = 'ag-ctx-pill';
                pill.textContent = slug;
                pill.title = L('Активный скилл: ', 'Active skill: ') + slug;
                ctxRowEl.appendChild(pill);
              });
            }
          }
        }

        return itemEl;
      }

      if (isMultiProject) {
        const activeGroupNames = new Set();
        let globalIdx = 0;
        let prevGrpEl = null;

        projectGroups.forEach(function (grp) {
          activeGroupNames.add(grp.projectName);
          let grpEl = stackEl.querySelector('.ag-project-group[data-project="' + CSS.escape(grp.projectName) + '"]');
          if (!grpEl) {
            grpEl = createProjectGroupElement(grp.projectName);
            stackEl.appendChild(grpEl);
          }

          const expectedGrpRef = prevGrpEl ? prevGrpEl.nextSibling : stackEl.firstChild;
          if (grpEl.parentNode !== stackEl || grpEl !== expectedGrpRef) {
            stackEl.insertBefore(grpEl, expectedGrpRef);
          }
          prevGrpEl = grpEl;

          const headEl = grpEl.querySelector('.ag-project-group-head');
          const nameEl = grpEl.querySelector('.ag-project-group-name');
          const countEl = grpEl.querySelector('.ag-project-group-count');
          const chatsWrapEl = grpEl.querySelector('.ag-project-group-chats') || grpEl;

          const meta = activeProjMetaMap[grp.projectName];
          const grpWs = grp.workspaceRoot || (meta && meta.workspaceRoot) || '';

          if (headEl) {
            headEl.title = grp.isUnscopedChat
              ? L('Обычные чаты без открытого проекта', 'Regular chats without an open project')
              : (L('Проект: ', 'Project: ') + (grpWs || grp.projectName));
          }
          if (nameEl) {
            nameEl.textContent = grp.projectName;
          }
          if (countEl) {
            countEl.textContent = formatChatsWord(grp.chats.length);
          }

          let prevRowEl = null;
          grp.chats.forEach(function (c) {
            prevRowEl = renderSingleChatRow(chatsWrapEl, prevRowEl, c, globalIdx);
            globalIdx += 1;
          });
        });

        Array.from(stackEl.querySelectorAll('.ag-chat-task-item:not(.closing)')).forEach(function (node) {
          const cid = node.getAttribute('data-cid');
          if (!activeIds.has(cid)) {
            delete _agDisplayedPctByChat[cid];
            delete _agExpandedSubagentsByChat[cid];
            delete _agExpandedBgTasksByChat[cid];
            delete _agShowAllBgTasksByChat[cid];
            delete _agExpandedStepsByChat[cid];
            agSmoothCollapseAndRemoveNode(node);
          }
        });

        Array.from(stackEl.querySelectorAll('.ag-project-group')).forEach(function (grpNode) {
          const pName = grpNode.getAttribute('data-project');
          if (!activeGroupNames.has(pName)) {
            agSmoothCollapseAndRemoveNode(grpNode);
          }
        });
      } else {
        let prevRowEl = null;
        chats.forEach(function (c, idx) {
          prevRowEl = renderSingleChatRow(stackEl, prevRowEl, c, idx);
        });

        Array.from(stackEl.querySelectorAll('.ag-project-group')).forEach(function (grpNode) {
          grpNode.remove();
        });

        Array.from(stackEl.querySelectorAll('.ag-chat-task-item:not(.closing)')).forEach(function (node) {
          const cid = node.getAttribute('data-cid');
          if (!activeIds.has(cid)) {
            delete _agDisplayedPctByChat[cid];
            delete _agExpandedSubagentsByChat[cid];
            delete _agExpandedBgTasksByChat[cid];
            delete _agShowAllBgTasksByChat[cid];
            delete _agExpandedStepsByChat[cid];
            agSmoothCollapseAndRemoveNode(node);
          }
        });
      }
      syncActiveChatsStackFade(stackEl);
      scheduleActiveChatsStackFadeSync(stackEl);
    }

    document.addEventListener('pointerdown', function (ev) {
      if (_agRecentCompletedOpen) {
        const inPop = ev.target && ev.target.closest ? ev.target.closest('#agRecentCompletedPopover') : null;
        const inPopBtn = ev.target && ev.target.closest ? ev.target.closest('#btnRecentCompletedTasks') : null;
        if (!inPop && !inPopBtn) {
          closeRecentCompletedPopover();
        }
      }
      if (!_openCustomSelectId) return;
      const inMenu = ev.target && ev.target.closest ? ev.target.closest('#lgCustomSelectMenu') : null;
      const inTrigger = ev.target && ev.target.closest ? ev.target.closest('.lg-select-trigger') : null;
      if (!inMenu && !inTrigger) {
        closeCustomSelectMenu(false);
      }
    });

    let _suppressBlockClickUntil = 0;

    document.addEventListener('click', function (ev) {
      const optBtn = ev.target && ev.target.closest ? ev.target.closest('#lgCustomSelectMenu .lg-select-option') : null;
      if (optBtn && _openCustomSelectId) {
        ev.preventDefault();
        ev.stopPropagation();
        commitCustomSelectOption(_openCustomSelectId, optBtn.getAttribute('data-select-value'));
        return;
      }
      const inMoveControls = ev.target && ev.target.closest ? ev.target.closest('.block-move-controls') : null;
      if (inMoveControls && ev.target.closest('summary')) {
        ev.preventDefault();
        ev.stopPropagation();
      } else if (Date.now() < _suppressSummaryClickUntil && ev.target && ev.target.closest && ev.target.closest('summary')) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      } else if (Date.now() < _suppressBlockClickUntil && ev.target && ev.target.closest) {
        const inDragHeader = ev.target.closest('.lg-card-head, summary, .ag-progress-top-row, .gd-full-rail, .unified-preset-top, #expertCircuitHeadRow, #expertPitfallsHeadRow, #expertKnowledgeHeadRow');
        if (inDragHeader) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
      }
      const clickedControl = ev.target && ev.target.closest ? ev.target.closest('button, summary') : null;
      if (ev && ev.detail > 0 && clickedControl && typeof clickedControl.blur === 'function') {
        clickedControl.blur();
      }
      const target = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (!target) return;
      if (target.tagName === 'INPUT' && target.type === 'checkbox') return;
      dispatchPanelAction(target, ev);
    });

    (function setupBlockPointerDragAndDrop() {
      // Drag-and-drop block reordering removed in favor of categorized left navigation.
    })();

    document.addEventListener('keydown', function (ev) {
      if (_openCustomSelectId) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          closeCustomSelectMenu(true);
          return;
        }
        if (ev.key === 'Tab') {
          closeCustomSelectMenu(false);
          return;
        }
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          highlightCustomSelectOption(_openCustomSelectFocusIdx + 1);
          return;
        }
        if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          highlightCustomSelectOption(_openCustomSelectFocusIdx - 1);
          return;
        }
        if (ev.key === 'Home') {
          ev.preventDefault();
          highlightCustomSelectOption(0);
          return;
        }
        if (ev.key === 'End') {
          ev.preventDefault();
          highlightCustomSelectOption(9999);
          return;
        }
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          const menu = document.getElementById('lgCustomSelectMenu');
          const items = menu ? Array.from(menu.querySelectorAll('.lg-select-option')) : [];
          const picked = items[_openCustomSelectFocusIdx] || items[0];
          if (picked) {
            commitCustomSelectOption(_openCustomSelectId, picked.getAttribute('data-select-value'));
          } else {
            closeCustomSelectMenu(true);
          }
          return;
        }
      }

      if (ev.key === 'Escape') {
        const wizModal = document.getElementById('onboardingWizardModal');
        if (wizModal && wizModal.classList.contains('visible')) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          closeOnboardingWizard();
          return;
        }
      }

      const selectTrigger = ev.target && ev.target.closest ? ev.target.closest('.lg-select-trigger') : null;
      if (selectTrigger && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
        ev.preventDefault();
        openCustomSelectMenu(selectTrigger.getAttribute('data-arg'));
        return;
      }

      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const target = ev.target && ev.target.closest ? ev.target.closest('[data-action="toggleStepChip"]') : null;
      if (!target) return;
      ev.preventDefault();
      dispatchPanelAction(target, ev);
    });

    let _uiScaleResizeTimer = 0;
    let _lastStickyHudH = -1;
    let _lastFullRailMaxH = -1;
    let _stickyHudResizeObserver = null;

    function syncFullLeftRailStickyOffset() {
      const hudEl = document.getElementById('lgStickyHud');
      const rootStyle = document.documentElement && document.documentElement.style;
      if (!hudEl || !rootStyle || typeof rootStyle.setProperty !== 'function') return;

      const hudH = Math.ceil(Number(hudEl.offsetHeight || 0));
      if (hudH > 0 && hudH !== _lastStickyHudH) {
        _lastStickyHudH = hudH;
        rootStyle.setProperty('--sticky-hud-h', hudH + 'px');
      }

      const scaleRaw = typeof rootStyle.getPropertyValue === 'function'
        ? parseFloat(rootStyle.getPropertyValue('--panel-ui-scale'))
        : 1;
      const scale = (Number.isFinite(scaleRaw) && scaleRaw > 0.25) ? scaleRaw : 1;
      const vpH = Number(window.innerHeight || 0);
      if (vpH > 0 && hudH > 0) {
        const maxRailH = Math.max(160, Math.floor((vpH / scale) - hudH - 22));
        if (maxRailH !== _lastFullRailMaxH) {
          _lastFullRailMaxH = maxRailH;
          rootStyle.setProperty('--full-rail-max-h', maxRailH + 'px');
        }
      }
      scheduleCategoryScrollFadeSync();
    }

    function initFullLeftRailStickySync() {
      ensureCategoryScrollFadeListeners();
      syncFullLeftRailStickyOffset();
      const hudEl = document.getElementById('lgStickyHud');
      if (!hudEl || _stickyHudResizeObserver || typeof ResizeObserver !== 'function') return;
      try {
        _stickyHudResizeObserver = new ResizeObserver(function () {
          syncFullLeftRailStickyOffset();
        });
        _stickyHudResizeObserver.observe(hudEl);
      } catch {}
    }

    window.addEventListener('resize', function () {
      if (_openCustomSelectId) closeCustomSelectMenu(false);
      syncFullLeftRailStickyOffset();
      if (typeof scheduleSyncAllSlidingPills === 'function') scheduleSyncAllSlidingPills();
      if (_uiScaleResizeTimer) clearTimeout(_uiScaleResizeTimer);
      _uiScaleResizeTimer = setTimeout(function () {
        _uiScaleResizeTimer = 0;
        const activeMode = typeof normalizePanelUiScale === 'function'
          ? normalizePanelUiScale((typeof currentState !== 'undefined' && currentState && currentState.panelUiScale) || (typeof _activePanelUiScaleMode !== 'undefined' ? _activePanelUiScaleMode : 'auto'))
          : 'auto';
        if (activeMode === 'auto' && typeof applyPanelUiScaleDom === 'function') {
          applyPanelUiScaleDom('auto', false);
        }
        syncFullLeftRailStickyOffset();
        if (typeof scheduleSyncAllSlidingPills === 'function') scheduleSyncAllSlidingPills();
      }, 180);
    });

    window.addEventListener('scroll', function (ev) {
      if (!_openCustomSelectId) return;
      const menu = document.getElementById('lgCustomSelectMenu');
      if (menu && ev.target && (ev.target === menu || (menu.contains && menu.contains(ev.target)))) {
        return;
      }
      closeCustomSelectMenu(false);
    }, true);

    document.addEventListener('change', function (ev) {
      const target = ev.target;
      if (!target || !target.getAttribute) return;
      if (target.getAttribute('data-action') === 'toggleOption') {
        toggleOption(target.getAttribute('data-key'), !!target.checked);
      } else if (target.getAttribute('data-change-action') === 'selectGpuModel') {
        selectGpuModel(target.getAttribute('data-key'), target.value);
      } else if (target.getAttribute('data-change-action') === 'selectPanelWorkspace') {
        selectPanelWorkspace(target.value);
      } else if (target.getAttribute('data-change-action') === 'setGpuVramCap') {
        setGpuVramCap(Number(target.value));
      } else if (target.getAttribute('data-change-action') === 'setRamBudget') {
        setRamBudget(Number(target.value));
      } else if (target.getAttribute('data-change-action') === 'setCpuMaxThreads') {
        setCpuMaxThreads(Number(target.value));
      } else if (target.getAttribute('data-change-action') === 'pgChangeDepth') {
        pgChangeDepth(target.value);
      } else if (target.getAttribute('data-change-action') === 'pgChangeNodeLimit') {
        pgChangeNodeLimit(target.value);
      } else if (target.getAttribute('data-change-action') === 'pgSelectWorkspace') {
        void pgSelectWorkspace(target.value);
      }
    });

