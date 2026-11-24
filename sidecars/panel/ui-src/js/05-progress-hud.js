    const _agDisplayedPctByChat = Object.create(null);
    const _agPctAnimFrameByChat = Object.create(null);
    const _agExpandedSubagentsByChat = Object.create(null);
    const _agExpandedStepsByChat = Object.create(null);

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

    async function resetStaleProgressChats(conversationId) {
      try {
        const body = conversationId ? { action: 'dismiss_chat', conversationId: conversationId } : { action: 'reset_stale' };
        const res = await panelFetch('/api/hud', { method: 'POST', body: JSON.stringify(body) });
        if (res && res.ok && res.taskProgress) {
          renderTaskProgressAndHud(res.taskProgress, res.floatingHud);
        }
        if (typeof flashStatus === 'function') {
          flashStatus(L('Карточки прогресса сброшены ✓', 'Progress cards cleared ✓'));
        }
      } catch {}
    }

    function renderTaskProgressAndHud(progress, hud) {
      const p = progress || (hud && hud.progress) || null;
      if (!p) return;
      const headingEl = document.getElementById('agProgressHeadingText');
      const projBadgeEl = document.getElementById('agProgressProjectBadge');
      const recentBarEl = document.getElementById('agRecentProjectsBar');
      const stackEl = document.getElementById('agActiveChatsStack');
      if (!stackEl) return;

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
      const chats = pinnedWsKey
        ? rawChats.filter(function (c) {
            return c && c.workspaceRoot && normalizeWsClientKey(c.workspaceRoot) === pinnedWsKey;
          })
        : rawChats;

      _agHasLiveTasks = chats.length > 0;

      const projectGroups = [];
      const projectGroupMap = Object.create(null);
      chats.forEach(function (c) {
        const cProj = String((c && c.projectName) || projName).trim() || projName;
        let grp = projectGroupMap[cProj];
        if (!grp) {
          grp = {
            projectName: cProj,
            workspaceRoot: (c && c.workspaceRoot) || '',
            chats: [],
          };
          projectGroupMap[cProj] = grp;
          projectGroups.push(grp);
        } else if (!grp.workspaceRoot && c && c.workspaceRoot) {
          grp.workspaceRoot = c.workspaceRoot;
        }
        grp.chats.push(c);
      });
      const isMultiProject = projectGroups.length > 1;

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

      const resetStaleBtn = document.getElementById('btnResetStaleProgress');
      if (resetStaleBtn) {
        resetStaleBtn.style.display = chats.length > 0 ? 'inline-flex' : 'none';
      }

      if (projBadgeEl) {
        syncWorkspaceSwitcherBadge();
      }

      if (recentBarEl) {
        const otherProjects = runningProjects.filter(function (rp) {
          if (pinnedWsKey) {
            if (rp.workspaceRoot) return normalizeWsClientKey(rp.workspaceRoot) !== pinnedWsKey;
            return rp.projectName !== getSelectedWorkspaceDisplayName();
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
            const countSuffix = Number(rp.activeChatsCount) > 1 ? (' (' + rp.activeChatsCount + ')') : '';
            const rpWs = rp.workspaceRoot || '';
            const rpStage = pickText(rp, 'stageLabel', 'stageLabelEn', '');
            const rpStep = pickText(rp, 'stepTitle', 'stepTitleEn', '');
            const tip = L('Переключить панель на активный проект ', 'Switch panel to active project ') + rp.projectName +
              (rpStage ? (' · ' + rpStage) : '') +
              (rpStep ? (' · ' + rpStep) : '');
            return '<button type="button" class="ag-step-chip active" data-action="selectPanelWorkspaceChip" data-ws="' + escapeHtml(rpWs) + '" title="' + escapeHtml(tip) + '">📁 ' +
              escapeHtml(rp.projectName) + countSuffix + ' · ' + rpPct + '%</button>';
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
            '<span class="ag-project-group-pct">0%</span>' +
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
            '<button type="button" class="ag-subagent-toggle-btn" data-action="toggleSubagentsList" data-arg="' + escapeHtml(slotKey) + '" aria-expanded="false" style="display: none;" title="' + L('Раскрыть список субагентов', 'Expand subagents list') + '">' +
              '<svg class="ag-subagent-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
                '<path d="M6 3.75L10.25 8L6 12.25" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
              '</svg>' +
              '<span class="ag-subagent-count">0</span>' +
            '</button>' +
            '<span class="ag-bloom-dot idle"></span>' +
            '<span class="ag-chat-num-badge" style="display: none;"></span>' +
            '<span class="ag-progress-title">' + L('Ожидание задачи', 'Waiting for task') + '</span>' +
            '<div class="ag-bloom-track">' +
              '<div class="ag-bloom-fill idle" style="width: 0%;"><div class="ag-bloom-shimmer"></div></div>' +
            '</div>' +
            '<span class="ag-progress-pct"><span class="ag-pct-num">0</span>%</span>' +
          '</div>' +
          '<div class="ag-steps-mini-list" style="display: none;"></div>' +
          '<div class="ag-context-pills-row" style="display: none;"></div>' +
          '<div class="ag-subagents-drawer" aria-hidden="true">' +
            '<div class="ag-subagents-drawer-inner">' +
              '<div class="ag-subagents-list"></div>' +
            '</div>' +
          '</div>';
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
              '<div class="ag-bloom-fill" style="width: 0%;"><div class="ag-bloom-shimmer"></div></div>' +
            '</div>' +
            '<span class="ag-progress-pct is-mini"><span class="ag-pct-num">0</span>%</span>' +
          '</div>';
        return el;
      }

      function syncSubagentsDrawerForChat(itemEl, cid, subagents) {
        const mainCap = itemEl.querySelector('.ag-progress-capsule') || itemEl;
        const toggleBtn = mainCap.querySelector('.ag-subagent-toggle-btn');
        const countEl = toggleBtn ? toggleBtn.querySelector('.ag-subagent-count') : null;
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

          const badgeLabel = pickText(s, 'subagentBadge', 'subagentBadgeEn', '') || (L('Агент #', 'Agent #') + (s.subagentNumber || (sIdx + 1)));
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

      // Always keep at least 1 stable status-bar capsule on screen; morph it into "Ожидание задачи" when 0 tasks are active
      if (chats.length === 0) {
        const existingItems = Array.from(stackEl.querySelectorAll('.ag-chat-task-item:not(.closing)'));
        let primaryEl = existingItems[0] || null;
        existingItems.slice(1).forEach(function (extraNode) {
          const oldCid = extraNode.getAttribute('data-cid');
          delete _agDisplayedPctByChat[oldCid];
          delete _agExpandedSubagentsByChat[oldCid];
          delete _agExpandedStepsByChat[oldCid];
          extraNode.classList.add('closing');
          setTimeout(function () { if (extraNode.parentNode) extraNode.remove(); }, 260);
        });
        if (!primaryEl) {
          primaryEl = createStatusBarRowElement('__primary_slot__');
          stackEl.appendChild(primaryEl);
        } else {
          const prevCid = primaryEl.getAttribute('data-cid');
          if (prevCid && prevCid !== '__primary_slot__') {
            _agDisplayedPctByChat['__primary_slot__'] = _agDisplayedPctByChat[prevCid] || 0;
            delete _agDisplayedPctByChat[prevCid];
            delete _agExpandedSubagentsByChat[prevCid];
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
        const stepsEl = primaryEl.querySelector('.ag-steps-mini-list');

        syncSubagentsDrawerForChat(primaryEl, '__primary_slot__', []);

        if (dotEl) dotEl.className = 'ag-bloom-dot idle';
        if (badgeEl) badgeEl.style.display = 'none';
        if (titleEl) {
          titleEl.textContent = L('Ожидание задачи', 'Waiting for task');
          titleEl.classList.add('is-idle');
          titleEl.title = L('Все задачи завершены · ожидание нового запроса', 'All tasks finished · awaiting new prompt');
        }
        if (fillEl) {
          fillEl.style.width = '0%';
          fillEl.className = 'ag-bloom-fill idle';
        }
        if (pctWrapEl) pctWrapEl.classList.add('is-idle');
        animateChatPctNode('__primary_slot__', numEl, 0);
        if (stepsEl) {
          stepsEl.style.display = 'none';
          stepsEl.innerHTML = '';
        }
        const idleCtxEl = primaryEl.querySelector('.ag-context-pills-row');
        if (idleCtxEl) {
          idleCtxEl.style.display = 'none';
          idleCtxEl.textContent = '';
          idleCtxEl.dataset.sig = '';
        }
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

        const pct = Math.max(0, Math.min(100, Math.round(Number(c.percent || 0))));
        animateChatPctNode(cid, numEl, pct);
        if (pctWrapEl) pctWrapEl.classList.remove('is-idle');

        const chatNumLabel = pickText(c, 'chatLabel', 'chatLabelEn', '') || (L('Чат #', 'Chat #') + (c.chatNumber || (globalIdx + 1)));
        const topic = String(c.topicLabel || '').trim();
        const cProj = String(c.projectName || projName).trim() || projName;
        if (badgeEl) {
          badgeEl.style.display = 'inline-flex';
          badgeEl.textContent = chatNumLabel;
          badgeEl.title = '📁 ' + cProj + ' · ' + chatNumLabel + (topic ? (': ' + topic) : '');
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
          stepsEl.style.display = 'flex';
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
            const fullTip = (prefix || (stepNum + '. ')) + tip + L(' (клик — раскрыть/свернуть)', ' (click to expand/collapse)');
            const numText = stepKey;
            const labelText = prefix + rawTitle;

            let chipEl = stepsEl.children[sIdx];
            if (!chipEl) {
              chipEl = document.createElement('span');
              chipEl.tabIndex = 0;
              chipEl.setAttribute('role', 'button');
              chipEl.setAttribute('data-action', 'toggleStepChip');
              const numEl = document.createElement('span');
              numEl.className = 'ag-step-num';
              const lblEl = document.createElement('span');
              lblEl.className = 'ag-step-label';
              chipEl.appendChild(numEl);
              chipEl.appendChild(lblEl);
              stepsEl.appendChild(chipEl);
            }
            if (chipEl.className !== cls) chipEl.className = cls;
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
          stepsEl.style.display = 'none';
          if (stepsEl.children.length > 0) stepsEl.textContent = '';
        }

        const ctxRowEl = itemEl.querySelector('.ag-context-pills-row');
        if (ctxRowEl) {
          const skills = Array.isArray(c.activeSkills) ? c.activeSkills.slice(0, 4) : [];
          const savedTok = Math.max(0, Math.round(Number(c.ramSavedTokens || 0)));
          const sig = skills.join(',') + '|' + savedTok + '|' + getUiLanguage();
          if (skills.length === 0 && savedTok <= 0) {
            ctxRowEl.style.display = 'none';
            if (ctxRowEl.children.length > 0) ctxRowEl.textContent = '';
            ctxRowEl.dataset.sig = '';
          } else {
            ctxRowEl.style.display = 'flex';
            if (ctxRowEl.dataset.sig !== sig) {
              ctxRowEl.dataset.sig = sig;
              ctxRowEl.textContent = '';
              skills.forEach(function (slug) {
                const pill = document.createElement('span');
                pill.className = 'ag-ctx-pill';
                pill.textContent = '⚡ ' + slug;
                pill.title = L('Активный скилл: ', 'Active skill: ') + slug;
                ctxRowEl.appendChild(pill);
              });
              if (savedTok > 0) {
                const ramPill = document.createElement('span');
                ramPill.className = 'ag-ctx-pill is-ram';
                const compactTok = savedTok >= 1000
                  ? (savedTok / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
                  : String(savedTok);
                ramPill.textContent = '💾 −' + compactTok + L(' тк', ' tok');
                ramPill.title = L('Сэкономлено токенов через In-RAM и GPU: ~', 'Tokens saved via In-RAM & GPU: ~') + savedTok;
                ctxRowEl.appendChild(ramPill);
              }
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
          const grpPctEl = grpEl.querySelector('.ag-project-group-pct');
          const chatsWrapEl = grpEl.querySelector('.ag-project-group-chats') || grpEl;

          const meta = activeProjMetaMap[grp.projectName];
          const grpWs = grp.workspaceRoot || (meta && meta.workspaceRoot) || '';
          const grpPct = Math.round(grp.chats.reduce(function (acc, item) {
            return acc + Math.max(0, Math.min(100, Math.round(Number(item.percent || 0))));
          }, 0) / Math.max(1, grp.chats.length));
          const allDone = grp.chats.every(function (item) {
            return item.status === 'completed' || Number(item.percent || 0) >= 100;
          });
          const hasWaiting = !allDone &&
            grp.chats.some(function (item) { return item.status === 'waiting_user'; }) &&
            !grp.chats.some(function (item) { return item.status === 'running'; });

          if (headEl) {
            headEl.title = L('Проект: ', 'Project: ') + (grpWs || grp.projectName);
          }
          if (nameEl) {
            nameEl.textContent = '📁 ' + grp.projectName;
          }
          if (countEl) {
            countEl.textContent = formatChatsWord(grp.chats.length);
          }
          if (grpPctEl) {
            grpPctEl.textContent = grpPct + '%';
            grpPctEl.className = 'ag-project-group-pct' + (allDone ? ' is-done' : (hasWaiting ? ' is-waiting' : ''));
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
            delete _agExpandedStepsByChat[cid];
            node.classList.add('closing');
            setTimeout(function () { if (node.parentNode) node.remove(); }, 260);
          }
        });

        Array.from(stackEl.querySelectorAll('.ag-project-group')).forEach(function (grpNode) {
          const pName = grpNode.getAttribute('data-project');
          if (!activeGroupNames.has(pName)) {
            grpNode.remove();
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
            delete _agExpandedStepsByChat[cid];
            node.classList.add('closing');
            setTimeout(function () { if (node.parentNode) node.remove(); }, 260);
          }
        });
      }
    }

    document.addEventListener('pointerdown', function (ev) {
      if (!_openCustomSelectId) return;
      const inMenu = ev.target && ev.target.closest ? ev.target.closest('#lgCustomSelectMenu') : null;
      const inTrigger = ev.target && ev.target.closest ? ev.target.closest('.lg-select-trigger') : null;
      if (!inMenu && !inTrigger) {
        closeCustomSelectMenu(false);
      }
    });

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
      }
      const target = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (!target) return;
      if (target.tagName === 'INPUT' && target.type === 'checkbox') return;
      dispatchPanelAction(target, ev);
    });

    (function setupBlockPointerDragAndDrop() {
      let dragState = null;

      document.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        const handle = ev.target && ev.target.closest ? ev.target.closest('[data-role="drag-handle"]') : null;
        if (!handle) return;
        const blockEl = handle.closest('.reorderable-block');
        if (!blockEl || !blockEl.parentElement) return;

        ev.preventDefault();
        ev.stopPropagation();
        _suppressSummaryClickUntil = Date.now() + 450;

        const parentEl = blockEl.parentElement;
        blockEl.classList.add('is-dragging-lift');
        try {
          if (handle.setPointerCapture) handle.setPointerCapture(ev.pointerId);
        } catch {}

        dragState = {
          pointerId: ev.pointerId,
          handle: handle,
          blockEl: blockEl,
          parentEl: parentEl,
          moved: false
        };
      });

      window.addEventListener('pointermove', function (ev) {
        if (!dragState || ev.pointerId !== dragState.pointerId) return;
        _suppressSummaryClickUntil = Date.now() + 450;
        const blockEl = dragState.blockEl;
        const parentEl = dragState.parentEl;
        const siblings = Array.from(parentEl.children).filter(function (node) {
          return node.classList && node.classList.contains('reorderable-block');
        });
        const idx = siblings.indexOf(blockEl);
        if (idx === -1) return;

        const clientY = ev.clientY;
        if (idx > 0) {
          const prevEl = siblings[idx - 1];
          const prevRect = prevEl.getBoundingClientRect();
          const prevMid = prevRect.top + prevRect.height * 0.5;
          if (clientY < prevMid) {
            const rects = recordFlipRects(siblings);
            parentEl.insertBefore(blockEl, prevEl);
            playFlipAnimation(siblings, rects, blockEl);
            dragState.moved = true;
            updateBlockControlsStatus();
            return;
          }
        }
        if (idx < siblings.length - 1) {
          const nextEl = siblings[idx + 1];
          const nextRect = nextEl.getBoundingClientRect();
          const nextMid = nextRect.top + nextRect.height * 0.5;
          if (clientY > nextMid) {
            const rects = recordFlipRects(siblings);
            parentEl.insertBefore(nextEl, blockEl);
            playFlipAnimation(siblings, rects, blockEl);
            dragState.moved = true;
            updateBlockControlsStatus();
          }
        }
      });

      function finishPointerDrag(ev) {
        if (!dragState || (ev && ev.pointerId !== undefined && ev.pointerId !== dragState.pointerId)) return;
        const st = dragState;
        dragState = null;
        _suppressSummaryClickUntil = Date.now() + 320;
        try {
          if (st.handle && st.handle.releasePointerCapture) {
            st.handle.releasePointerCapture(st.pointerId);
          }
        } catch {}
        st.blockEl.classList.remove('is-dragging-lift');
        if (st.moved) {
          st.blockEl.classList.add('is-just-moved');
          setTimeout(function () { st.blockEl.classList.remove('is-just-moved'); }, 360);
          persistCurrentBlockOrder(L('Порядок блоков сохранён ✓', 'Card order saved ✓'));
        }
      }

      window.addEventListener('pointerup', finishPointerDrag);
      window.addEventListener('pointercancel', finishPointerDrag);
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

    window.addEventListener('resize', function () {
      if (_openCustomSelectId) closeCustomSelectMenu(false);
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
      } else if (target.getAttribute('data-change-action') === 'setCompactionThreshold') {
        setCompactionThreshold(target.value);
      } else if (target.getAttribute('data-change-action') === 'pgChangeDepth') {
        pgChangeDepth(target.value);
      } else if (target.getAttribute('data-change-action') === 'pgChangeNodeLimit') {
        pgChangeNodeLimit(target.value);
      }
    });

