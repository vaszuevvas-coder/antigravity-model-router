    let _sentinelActionBusy = false;

    function syncSentinelCheckboxes(s) {
      const st = s || {};
      const chkEn = document.getElementById('chk-sentinelEnabled');
      if (chkEn) chkEn.checked = st.sentinelEnabled !== false;
      const chkSg = document.getElementById('chk-sentinelShadowGuard');
      if (chkSg) chkSg.checked = st.sentinelShadowGuard !== false;
      const chkBb = document.getElementById('chk-sentinelLocalBugBot');
      if (chkBb) chkBb.checked = st.sentinelLocalBugBot !== false;
      const chkSc = document.getElementById('chk-sentinelSymbolCards');
      if (chkSc) chkSc.checked = st.sentinelSymbolCards !== false;
      const chkSw = document.getElementById('chk-sentinelSpeculativeWarm');
      if (chkSw) chkSw.checked = st.sentinelSpeculativeWarm !== false;
      const chkSt = document.getElementById('chk-sentinelShadowTests');
      if (chkSt) chkSt.checked = Boolean(st.sentinelShadowTests);
      const chkLsp = document.getElementById('chk-lspBridgeEnabled');
      if (chkLsp) chkLsp.checked = st.lspBridgeEnabled !== false;
      const chkSql = document.getElementById('chk-sqliteKnowledgeEnabled');
      if (chkSql) chkSql.checked = st.sentinelEnabled !== undefined ? st.sqliteKnowledgeEnabled !== false : st.sqliteKnowledgeEnabled !== false;
      if (typeof applyHookProfileOverridesToUi === 'function') {
        applyHookProfileOverridesToUi(st.hookProfile || 'standard');
      }
      const badgeEl = document.getElementById('sentinelLiveBadge');
      if (badgeEl) {
        if (st.sentinelEnabled === false) {
          badgeEl.className = 'sentinel-live-badge is-off';
          badgeEl.textContent = L('Выключен', 'Off');
          badgeEl.title = L('Фоновый Дозор отключён в настройках', 'Background Sentinel is disabled in settings');
        } else if (badgeEl.classList.contains('is-off')) {
          badgeEl.className = 'sentinel-live-badge is-idle';
          badgeEl.textContent = L('Ожидание простоя', 'Waiting for idle');
          badgeEl.title = L('Фоновый Дозор дежурит и ждёт паузы в работе', 'Background Sentinel is standing by for idle pauses');
        }
      }
    }

    function normalizeSentinelFindingEntry(rawItem, category) {
      if (!rawItem) return null;
      let loc = '';
      let desc = '';
      let prompt = '';
      if (typeof rawItem === 'string') {
        desc = rawItem.trim();
      } else if (typeof rawItem === 'object') {
        const fileStr = String(rawItem.file || rawItem.filePath || rawItem.sourceFile || '').trim();
        const partnerStr = String(rawItem.partnerFile || rawItem.partner || rawItem.coupledFile || rawItem.targetFile || '').trim();
        const lineNum = Number(rawItem.line || rawItem.startLine || 0);
        const lineHintStr = String(rawItem.lineHint || '').trim();
        if (fileStr && partnerStr) {
          loc = fileStr + ' ↔ ' + partnerStr;
        } else if (fileStr) {
          if (lineNum > 0) {
            loc = fileStr + ':L' + lineNum;
          } else if (lineHintStr) {
            loc = fileStr + ' (' + lineHintStr + ')';
          } else {
            loc = fileStr;
          }
        } else if (lineHintStr) {
          loc = lineHintStr;
        }
        const rawDescRu = rawItem.issueRu || rawItem.detailRu || rawItem.detail || rawItem.message || rawItem.summary || rawItem.title || rawItem.reason || rawItem.suggestion || '';
        const rawDescEn = rawItem.issueEn || rawItem.detailEn || rawItem.detail || rawItem.messageEn || rawItem.message || rawItem.summaryEn || rawItem.summary || rawItem.title || rawItem.reason || rawItem.suggestion || '';
        desc = String(
          (isRu() ? (rawDescRu || rawDescEn) : (rawDescEn || rawDescRu)) ||
          (rawItem.symbol ? (L('Символ ', 'Symbol ') + rawItem.symbol + (rawItem.type ? (' (' + rawItem.type + ')') : '')) : '')
        ).trim();
        if (!desc && loc) {
          desc = category === 'cochange'
            ? L('Связанный файл не обновлён в текущем наборе правок', 'Co-changed file was not updated in the current edit set')
            : L('Обнаружено нарушение контракта', 'Contract violation detected');
        }
        const rawPromptRu = rawItem.fixPromptRu || rawItem.prompt || '';
        const rawPromptEn = rawItem.fixPromptEn || rawItem.prompt || '';
        const customPrompt = String(isRu() ? (rawPromptRu || rawPromptEn) : (rawPromptEn || rawPromptRu)).trim();
        if (customPrompt) {
          prompt = customPrompt;
        }
      }
      if (!desc && !loc) return null;
      const tagLabel = category === 'bugbot' ? 'BugBot' : (category === 'cochange' ? 'Co-Change' : L('Контракт', 'Contract'));
      const tagClass = category === 'bugbot' ? 'tag-bugbot' : (category === 'cochange' ? 'tag-cochange' : 'tag-contract');
      if (!prompt) {
        prompt = isRu()
          ? ('Проверь находку Фонового Дозора (' + tagLabel + ')' + (loc ? (' в ' + loc) : '') + ': ' + desc + '. Предложи или внеси точечное исправление.')
          : ('Inspect Background Sentinel finding (' + tagLabel + ')' + (loc ? (' in ' + loc) : '') + ': ' + desc + '. Suggest or apply a targeted fix.');
      }
      return {
        tagLabel: tagLabel,
        tagClass: tagClass,
        loc: loc,
        desc: desc,
        prompt: prompt,
      };
    }

    function renderSentinelStatus(sentinelData, state) {
      const s = state || currentState || {};
      syncSentinelCheckboxes(s);
      const boxEl = document.getElementById('sentinelStatusBox');
      if (!boxEl) return;

      const sen = (sentinelData && typeof sentinelData === 'object') ? sentinelData : {};
      const sg = (sen.shadowGuard && typeof sen.shadowGuard === 'object') ? sen.shadowGuard : {};
      const bb = (sen.bugBot && typeof sen.bugBot === 'object') ? sen.bugBot : {};
      const sc = (sen.symbolCards && typeof sen.symbolCards === 'object') ? sen.symbolCards : {};
      const st = (sen.shadowTests && typeof sen.shadowTests === 'object') ? sen.shadowTests : {};

      const isEnabled = s.sentinelEnabled !== false && sen.enabled !== false && sen.state !== 'disabled';
      const rawState = String(sen.state || 'idle').toLowerCase();

      const badgeEl = document.getElementById('sentinelLiveBadge');
      if (badgeEl) {
        const curTask = String(pickText(sen, 'currentTaskRu', 'currentTaskEn', '') || '').trim();
        if (!isEnabled) {
          badgeEl.className = 'sentinel-live-badge is-off';
          badgeEl.textContent = L('Выключен', 'Off');
          badgeEl.title = L('Фоновый Дозор отключён в настройках', 'Background Sentinel is disabled in settings');
        } else if (rawState === 'preempted' || rawState === 'yielded' || sen.p0Active) {
          badgeEl.className = 'sentinel-live-badge is-preempted';
          badgeEl.textContent = L('P0 Уступил чату', 'P0 Yielded to chat');
          badgeEl.title = curTask || L('Фоновая задача мгновенно уступила ресурсы активному запросу', 'Background task immediately yielded resources to active request');
        } else if (rawState === 'working' || rawState === 'running' || rawState === 'scanning' || _sentinelActionBusy) {
          badgeEl.className = 'sentinel-live-badge is-working';
          badgeEl.textContent = (curTask && curTask !== 'Ожидание простоя' && curTask !== 'Waiting for idle')
            ? (L('В работе · ', 'Working · ') + curTask)
            : L('В работе', 'Working');
          badgeEl.title = curTask || L('Фоновый Дозор выполняет проверку', 'Background Sentinel is running checks');
        } else {
          badgeEl.className = 'sentinel-live-badge is-idle';
          badgeEl.textContent = (curTask && curTask !== 'Выключен' && curTask !== 'Off') ? curTask : L('Ожидание простоя', 'Waiting for idle');
          const sumTxt = pickText(st, 'lastSummaryRu', 'lastSummaryEn', '');
          badgeEl.title = sumTxt ? (L('Микро-тесты: ', 'Micro-tests: ') + sumTxt) : L('Дежурит в паузах с P0-приоритетом чата', 'Standing by during pauses with P0 chat priority');
        }
      }

      const rawIssues = Array.isArray(sg.issues) ? sg.issues : [];
      const rawCoChange = Array.isArray(sg.coChangeAlerts) ? sg.coChangeAlerts : [];
      const rawBugBot = Array.isArray(bb.findings) ? bb.findings : [];

      const errCount = Math.max(0, Number(sg.errorCount || 0));
      const warnCount = Math.max(0, Number(sg.warnCount || 0)) + (Number(sg.warnCount || 0) === 0 ? Math.max(0, Number(sg.cloneCount || 0)) : 0);

      const healthEl = document.getElementById('sentinelHealthVal');
      if (healthEl) {
        if (errCount === 0 && warnCount === 0 && rawIssues.length === 0 && rawCoChange.length === 0) {
          healthEl.textContent = L('Чисто', 'Clean');
          healthEl.className = 'sentinel-metric-val is-ok';
          healthEl.title = L('Нарушений контрактов, импортов и пар Git Co-Change не обнаружено', 'No contract, import, or Git co-change violations detected');
        } else {
          const shownWarns = Math.max(warnCount, rawCoChange.length);
          const shownErrs = Math.max(errCount, rawIssues.length > 0 && shownWarns === 0 ? rawIssues.length : errCount);
          healthEl.textContent = L('Ошибок: ', 'Errors: ') + shownErrs + L(' · Пред.: ', ' · Warn: ') + shownWarns;
          healthEl.className = 'sentinel-metric-val ' + (shownErrs > 0 ? 'is-err' : 'is-warn');
          healthEl.title = L('Клонов SimHash: ', 'SimHash clones: ') + Number(sg.cloneCount || 0);
        }
      }

      const cardsEl = document.getElementById('sentinelCardsVal');
      if (cardsEl) {
        const idxFiles = Math.max(0, Number(sc.indexedFiles || 0));
        const totFiles = Math.max(0, Number(sc.totalEligibleFiles || 0));
        const covPct = sc.coveragePct !== undefined
          ? Math.max(0, Math.min(100, Math.round(Number(sc.coveragePct) || 0)))
          : (totFiles > 0 ? Math.min(100, Math.round((idxFiles / totFiles) * 100)) : 0);
        cardsEl.textContent = idxFiles + ' / ' + totFiles + ' (' + covPct + '%)';
        cardsEl.className = 'sentinel-metric-val' + (covPct >= 80 && totFiles > 0 ? ' is-ok' : '');
        cardsEl.title = sc.lastFile ? (L('Последний индексированный модуль: ', 'Last indexed module: ') + sc.lastFile) : L('Покрытие семантических паспортов модулей по SHA-256', 'SHA-256 semantic module passport coverage');
      }

      const bbCount = Math.max(0, Number(bb.findingsCount || 0), rawBugBot.length);
      const bugBotEl = document.getElementById('sentinelBugBotVal');
      if (bugBotEl) {
        if (bbCount > 0) {
          bugBotEl.textContent = L('Находок: ', 'Findings: ') + bbCount;
          bugBotEl.className = 'sentinel-metric-val is-warn';
        } else {
          bugBotEl.textContent = L('Чисто', 'Clean');
          bugBotEl.className = 'sentinel-metric-val is-ok';
        }
        bugBotEl.title = L('Локальное ревью git diff в глубоком простое', 'Local git diff review during deep idle');
      }

      const specEl = document.getElementById('sentinelSpecVal');
      if (specEl) {
        const specHits = Math.max(0, Number(sen.speculativeHits || 0));
        const preempts = Math.max(0, Number(sen.preemptedCount || 0));
        specEl.textContent = L('Префетч: ', 'Prefetch: ') + specHits + L(' · Уступок: ', ' · Yields: ') + preempts;
        specEl.title = L('Упреждающих сборок контекста: ', 'Speculative context packs: ') + specHits + L(' · Мгновенных P0-уступок чату: ', ' · Instant P0 yields: ') + preempts;
      }

      const normalizedFindings = [];
      for (let i = 0; i < rawIssues.length && normalizedFindings.length < 18; i++) {
        const item = normalizeSentinelFindingEntry(rawIssues[i], 'contract');
        if (item) normalizedFindings.push(item);
      }
      for (let i = 0; i < rawCoChange.length && normalizedFindings.length < 18; i++) {
        const item = normalizeSentinelFindingEntry(rawCoChange[i], 'cochange');
        if (item) normalizedFindings.push(item);
      }
      for (let i = 0; i < rawBugBot.length && normalizedFindings.length < 18; i++) {
        const item = normalizeSentinelFindingEntry(rawBugBot[i], 'bugbot');
        if (item) normalizedFindings.push(item);
      }

      const hasAnyAlert = normalizedFindings.length > 0 || errCount > 0 || warnCount > 0 || bbCount > 0;
      const clearBtn = document.getElementById('btnClearSentinelFindings');
      if (clearBtn) {
        clearBtn.style.display = hasAnyAlert ? 'inline-flex' : 'none';
        clearBtn.disabled = !hasAnyAlert || _sentinelActionBusy;
      }

      const runBtn = document.getElementById('btnRunSentinelNow');
      if (runBtn) {
        runBtn.disabled = _sentinelActionBusy;
        runBtn.textContent = _sentinelActionBusy ? L('Проверка…', 'Checking…') : L('Проверить сейчас', 'Check now');
      }

      const listEl = document.getElementById('sentinelFindingsList');
      if (listEl) {
        listEl.textContent = '';
        if (normalizedFindings.length === 0) {
          listEl.style.display = 'none';
        } else {
          listEl.style.display = 'flex';
          for (let i = 0; i < normalizedFindings.length; i++) {
            const f = normalizedFindings[i];
            const row = document.createElement('div');
            row.className = 'sentinel-finding-item';

            const body = document.createElement('div');
            body.className = 'sentinel-finding-body';

            const head = document.createElement('div');
            head.className = 'sentinel-finding-head';

            const tag = document.createElement('span');
            tag.className = 'sentinel-finding-tag ' + f.tagClass;
            tag.textContent = f.tagLabel;
            head.appendChild(tag);

            if (f.loc) {
              const locSpan = document.createElement('span');
              locSpan.className = 'sentinel-finding-loc';
              locSpan.textContent = f.loc;
              head.appendChild(locSpan);
            }
            body.appendChild(head);

            if (f.desc) {
              const descDiv = document.createElement('div');
              descDiv.className = 'sentinel-finding-desc';
              descDiv.textContent = f.desc;
              body.appendChild(descDiv);
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'win-btn sentinel-composer-btn';
            btn.setAttribute('data-action', 'sendSentinelToComposer');
            btn.setAttribute('data-prompt', f.prompt);
            btn.textContent = L('В композер', 'To Composer');
            btn.title = L('Перенести задачу на исправление в Умный Композер', 'Send fix prompt to Smart Composer');

            row.appendChild(body);
            row.appendChild(btn);
            listEl.appendChild(row);
          }
        }
      }
    }

    async function runSentinelNow() {
      if (_sentinelActionBusy) return;
      _sentinelActionBusy = true;
      renderSentinelStatus(lastPayloadCache ? lastPayloadCache.sentinel : null, currentState);
      try {
        flashStatus(L('Запуск проверки Фонового Дозора...', 'Running Background Sentinel check...'));
        const res = await panelFetch('/api/sentinel', {
          method: 'POST',
          body: JSON.stringify({ action: 'run_now', force: true }),
        });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ? data.error : L('Сбой запуска Дозора', 'Sentinel launch error'));
        }
        const snap = (data.sentinel && typeof data.sentinel === 'object') ? data.sentinel : data;
        if (lastPayloadCache) lastPayloadCache.sentinel = snap;
        _sentinelActionBusy = false;
        renderSentinelStatus(snap, currentState);
        flashStatus(L('Проверка Фонового Дозора завершена ✓', 'Background Sentinel check complete ✓'));
      } catch (err) {
        console.error(err);
        _sentinelActionBusy = false;
        renderSentinelStatus(lastPayloadCache ? lastPayloadCache.sentinel : null, currentState);
        flashStatus(L('Ошибка запуска Фонового Дозора!', 'Background Sentinel error!'));
      }
    }

    async function clearSentinelFindings() {
      if (_sentinelActionBusy) return;
      _sentinelActionBusy = true;
      try {
        const res = await panelFetch('/api/sentinel', {
          method: 'POST',
          body: JSON.stringify({ action: 'clear_findings' }),
        });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ? data.error : L('Сбой сброса находок', 'Failed to clear findings'));
        }
        const snap = (data.sentinel && typeof data.sentinel === 'object') ? data.sentinel : data;
        if (lastPayloadCache) lastPayloadCache.sentinel = snap;
        _sentinelActionBusy = false;
        renderSentinelStatus(snap, currentState);
        flashStatus(L('Находки Фонового Дозора сброшены ✓', 'Sentinel findings cleared ✓'));
      } catch (err) {
        console.error(err);
        _sentinelActionBusy = false;
        renderSentinelStatus(lastPayloadCache ? lastPayloadCache.sentinel : null, currentState);
        flashStatus(L('Ошибка сброса находок Дозора!', 'Error clearing Sentinel findings!'));
      }
    }

    function sendSentinelToComposer(promptText) {
      const clean = String(promptText || '').trim();
      if (!clean) return;
      const compCard = document.getElementById('smartComposerCard');
      if (compCard && compCard.classList.contains('is-collapsed')) {
        togglePanelCardCollapse('smartComposerCard');
      }
      applyComposerChip(clean);
      if (compCard && typeof compCard.scrollIntoView === 'function') {
        compCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      flashStatus(L('Задача из Дозора перенесена в Композер ✓', 'Sentinel task sent to Composer ✓'));
    }

    let _latestWiretapFault = null;

    function renderWiretapAndQuota(wiretapFaults, quotaPacer) {
      if (Array.isArray(wiretapFaults)) {
        const bar = document.getElementById('wiretapAlertBar');
        const txt = document.getElementById('wiretapAlertText');
        _latestWiretapFault = wiretapFaults.length > 0 ? wiretapFaults[0] : null;
        if (bar && txt) {
          if (_latestWiretapFault) {
            const loc = _latestWiretapFault.file
              ? (_latestWiretapFault.file + (_latestWiretapFault.line ? ':' + _latestWiretapFault.line : ''))
              : (_latestWiretapFault.source || 'runtime');
            const rep = (_latestWiretapFault.occurrences || 1) > 1 ? (' (x' + _latestWiretapFault.occurrences + ')') : '';
            txt.textContent = '🐞 [' + loc + ']' + rep + ' ' + (_latestWiretapFault.summary || L('Сбой процесса', 'Runtime fault'));
            txt.title = _latestWiretapFault.excerpt || txt.textContent;
            bar.style.display = 'block';
          } else {
            bar.style.display = 'none';
          }
        }
      }
      if (quotaPacer && typeof quotaPacer === 'object') {
        const badge = document.getElementById('quotaPacerBadge');
        if (badge) {
          const st = quotaPacer.status || 'calm';
          const pct = Number(quotaPacer.utilizationPct || 0);
          const lbl = st === 'critical'
            ? L('Квота: высокий расход', 'Quota: high burn')
            : (st === 'elevated' ? L('Квота: повышенный', 'Quota: elevated') : L('Квота: спокойно', 'Quota: calm'));
          badge.textContent = lbl + (pct > 0 ? (' · ' + pct + '%') : '');
          badge.className = 'swarm-pill ' + (st === 'critical' ? 'warn' : st === 'elevated' ? 'active' : 'idle');
          const recTxt = pickText(quotaPacer, 'recommendationRu', 'recommendationEn', '');
          badge.title = recTxt + ' (30m: ' + (quotaPacer.turnsLast30m || 0) + L(' ходов)', ' turns)');
        }
        const comboTextEl = document.getElementById('comboFailoverText');
        const comboResetBtn = document.getElementById('btnResetComboCooldowns');
        const combo = quotaPacer.combo && typeof quotaPacer.combo === 'object' ? quotaPacer.combo : null;
        if (comboTextEl && combo) {
          const skippedCnt = Array.isArray(combo.skippedOnCooldown) ? combo.skippedOnCooldown.length : 0;
          const activeCnt = Array.isArray(combo.activeCooldowns) ? combo.activeCooldowns.length : 0;
          const pausedCnt = Math.max(skippedCnt, activeCnt);
          comboTextEl.textContent = L('Маршрут страховки (Combo): ', 'Failover route (Combo): ') + (combo.selected || 'ready') +
            (pausedCnt > 0 ? (L(' · на паузе: ', ' · on cooldown: ') + pausedCnt) : '');
          comboTextEl.style.color = combo.allExhausted ? 'var(--status-warn)' : 'var(--text-sub)';
          if (comboResetBtn) {
            comboResetBtn.style.display = pausedCnt > 0 ? 'inline-flex' : 'none';
          }
        }
      }
    }

    function sendWiretapFaultToComposer() {
      if (!_latestWiretapFault) return;
      const loc = _latestWiretapFault.file
        ? (_latestWiretapFault.file + (_latestWiretapFault.line ? ':' + _latestWiretapFault.line : ''))
        : L('проекте', 'project');
      const prompt = isRu()
        ? ('Исправь ошибку выполнения в ' + loc + ': ' + (_latestWiretapFault.summary || '') +
            (_latestWiretapFault.codeFrame ? ('\n\nФрагмент кода:\n' + _latestWiretapFault.codeFrame) : ''))
        : ('Fix runtime error in ' + loc + ': ' + (_latestWiretapFault.summary || '') +
            (_latestWiretapFault.codeFrame ? ('\n\nCode frame:\n' + _latestWiretapFault.codeFrame) : ''));
      applyComposerChip(prompt);
      flashStatus(L('Ошибка из Wiretap вставлена в Композер ✓', 'Wiretap fault sent to Composer ✓'));
    }

    async function clearWiretapFaults() {
      try {
        await panelFetch('/api/wiretap/clear', { method: 'POST', body: '{}' });
        _latestWiretapFault = null;
        renderWiretapAndQuota([], null);
        flashStatus(L('Журнал сбоев Wiretap очищен ✓', 'Wiretap fault log cleared ✓'));
      } catch {}
    }

    function dispatchPanelAction(actionEl, ev) {
      if (!actionEl) return;
      const action = actionEl.getAttribute('data-action');
      const arg = actionEl.getAttribute('data-arg');
      if ((actionEl.id === 'mode-advisor' && ev.target.closest('#advisorBox'))
          || (actionEl.id === 'mode-autopilot' && ev.target.closest('#autopilotBox'))) {
        return;
      }
      switch (action) {
        case 'openOnboardingWizard': openOnboardingWizard(Number(arg || 1)); break;
        case 'closeOnboardingWizard': closeOnboardingWizard(); break;
        case 'wizGoStep': wizGoStep(Number(arg || 1)); break;
        case 'wizPrevStep': wizPrevStep(); break;
        case 'wizNextStep': wizNextStep(); break;
        case 'wizSelectMode': wizSelectMode(arg); break;
        case 'wizSetDesignGate': wizSetDesignGate(arg === 'true'); break;
        case 'wizSetInspirationMode': wizSetInspirationMode(arg); break;
        case 'wizSetSubTier': wizSetSubTier(arg); break;
        case 'wizSetThemePreview': wizSetThemePreview(arg); break;
        case 'wizSetLanguage': wizSetLanguage(arg); break;
        case 'setUiLanguage': void setUiLanguage(arg); break;
        case 'wizRescanHw': wizRescanHw(); break;
        case 'wizToggleFlag': wizToggleFlag(arg); break;
        case 'wizSetGpuPullMode': wizSetGpuPullMode(arg); break;
        case 'autoCalibrateHardware': autoCalibrateHardware(); break;
        case 'sendHardwareTunePrompt': sendHardwareTunePrompt(); break;
        case 'prepareModelSearchPrompt': prepareModelSearchPrompt(); break;
        case 'sendVramFitModelPrompt': sendVramFitModelPrompt(); break;
        case 'startGpuCascadePull': startGpuCascadePull(arg || 'cascade'); break;
        case 'cancelGpuCascadePull': cancelGpuCascadePull(); break;
        case 'applySuggestedVramModel': if (arg) selectGpuModel('gpuChatModel', arg); break;
        case 'refreshAll': refreshAll(); break;
        case 'setPanelTheme': setPanelTheme(arg); break;
        case 'setSwarmMode': setSwarmMode(arg); break;
        case 'setSwarmWorkerTier': setSwarmWorkerTier(arg); break;
        case 'setGpuVramCap': setGpuVramCap(Number(arg)); break;
        case 'runGpuPanelAction': runGpuPanelAction(arg); break;
        case 'setCpuMaxThreads': setCpuMaxThreads(Number(arg)); break;
        case 'setAdvisorMode': setAdvisorMode(arg === 'true'); break;
        case 'setSubscriptionTier': setSubscriptionTier(arg); break;
        case 'setConfirmThreshold': setConfirmThreshold(arg); break;
        case 'selectStrategy': selectStrategy(arg); break;
        case 'setThreshold': setThreshold(arg); break;
        case 'setUiDesignGate': setUiDesignGate(arg === 'true'); break;
        case 'setUiInspirationMode': setUiInspirationMode(arg); break;
        case 'setGrillMode': setGrillMode(arg); break;
        case 'setLeanMode': setLeanMode(arg); break;
        case 'setTerseMode': setTerseMode(arg); break;
        case 'toggleComposerGrillMe': toggleComposerGrillMe(); break;
        case 'selectCuratedSkillPreset': selectCuratedSkillPreset(actionEl.getAttribute('data-repo') || '', actionEl.getAttribute('data-slug') || ''); break;
        case 'rollbackLastCheckpoint': rollbackLastCheckpoint(); break;
        case 'rollbackSpecific': rollbackSpecific(actionEl.getAttribute('data-id'), actionEl.getAttribute('data-ws') || ''); break;
        case 'setCheckpointsViewMode': setCheckpointsViewMode(arg); break;
        case 'rollbackLatestTurn': rollbackTurnById('latest'); break;
        case 'rollbackTurnById': rollbackTurnById(actionEl.getAttribute('data-id'), actionEl.getAttribute('data-ws') || ''); break;
        case 'showTurnDiff': showTurnDiff(actionEl.getAttribute('data-id'), actionEl.getAttribute('data-ws') || ''); break;
        case 'worktreeAction': worktreeAction(actionEl.getAttribute('data-mode') || arg, actionEl.getAttribute('data-id') || ''); break;
        case 'selectPanelWorkspaceChip': selectPanelWorkspace(actionEl.getAttribute('data-ws') || arg || '__auto__'); break;
        case 'resetWorkspaceToAuto': selectPanelWorkspace('__auto__'); break;
        case 'resetWorkspaceFragility': resetWorkspaceFragility(); break;
        case 'resetBayesianPriors': resetBayesianPriors(); break;
        case 'resetAllSkillsToAuto': resetAllSkillsToAuto(); break;
        case 'setSkillMode': setSkillMode(actionEl.getAttribute('data-skill'), actionEl.getAttribute('data-mode')); break;
        case 'resetCircuitBreaker': resetCircuitBreaker(); break;
        case 'compactDigest': compactDigest(); break;
        case 'refreshRepoMap': refreshRepoMap(); break;
        case 'clearPitfalls': clearPitfalls(); break;
        case 'clearVictoryRecipes': clearVictoryRecipes(); break;
        case 'addFederatedPeer': addFederatedPeer(); break;
        case 'removeFederatedPeer': removeFederatedPeer(arg); break;
        case 'backupProfile': backupProfile(); break;
        case 'restoreProfile': restoreProfile(); break;
        case 'setRamBudget': setRamBudget(Number(arg)); break;
        case 'saveExpertGpuConfig': saveExpertGpuConfig(); break;
        case 'toggleSubagentsList': toggleSubagentsList(arg, actionEl); break;
        case 'resetStaleProgressChats': resetStaleProgressChats(arg); break;
        case 'toggleStepChip': toggleStepChip(actionEl.getAttribute('data-cid'), actionEl.getAttribute('data-step'), actionEl); break;
        case 'resetPanelBlockOrder': resetPanelBlockOrder(); break;
        case 'togglePanelCardCollapse': togglePanelCardCollapse(arg); break;
        case 'scrollToGpuRamCard': scrollToGpuRamCard(); break;
        case 'toggleCustomSelect': toggleCustomSelect(arg); break;
        case 'sendSmartComposer': sendSmartComposer(); break;
        case 'askLocalRagChat': askLocalRagChat(); break;
        case 'clearLocalRagChat': clearLocalRagChat(); break;
        case 'insertRagSourceRef': insertRagSourceRef(actionEl.getAttribute('data-source') || arg); break;
        case 'clearSmartComposer': clearSmartComposer(); break;
        case 'acceptSmartComposerGhost': acceptSmartComposerGhost(false); break;
        case 'applyComposerChip': applyComposerChip(actionEl.getAttribute('data-prompt') || arg); break;
        case 'runSentinelNow': runSentinelNow(); break;
        case 'clearSentinelFindings': clearSentinelFindings(); break;
        case 'sendSentinelToComposer': sendSentinelToComposer(actionEl.getAttribute('data-prompt') || arg); break;
        case 'sendWiretapFaultToComposer': sendWiretapFaultToComposer(); break;
        case 'clearWiretapFaults': clearWiretapFaults(); break;
        case 'selectComposerAtItem': selectComposerAtItem(actionEl.getAttribute('data-token') || arg); break;
        case 'analyzeComposerScreenshot': analyzeComposerScreenshot(); break;
        case 'clearComposerScreenshot': clearComposerScreenshot(); break;
        case 'prepareLocalCommit': prepareLocalCommit(); break;
        case 'toggleComposerVoice': toggleComposerVoice(); break;
        case 'setHookProfile': setHookProfile(arg); break;
        case 'runAgentShield': runAgentShield(); break;
        case 'loadProjectInstincts': loadProjectInstincts(); break;
        case 'promoteInstinct': promoteInstinct(arg); break;
        case 'deleteInstinct': deleteInstinct(arg); break;
        case 'toggleSetupDoctor': toggleSetupDoctor(); break;
        case 'loadSetupDoctor': loadSetupDoctor(); break;
        case 'applySetupDoctorItem': applySetupDoctorItem(arg); break;
        case 'toggleSkillRegistryDrawer': toggleSkillRegistryDrawer(); break;
        case 'searchExternalSkills': searchExternalSkills(); break;
        case 'importExternalSkill': importExternalSkill(actionEl.getAttribute('data-source') || arg, actionEl.getAttribute('data-slug') || ''); break;
        case 'loadSessionEpisodes': loadSessionEpisodes(); break;
        case 'refreshGatesStatus': refreshGatesStatus(); break;
        case 'initGatesMd': initGatesMd(); break;
        case 'loadGraphifyOverview': loadGraphifyOverview(); break;
        case 'loadShortcutDebt': loadShortcutDebt(); break;
        case 'resetComboCooldowns': resetComboCooldowns(); break;
        case 'openProjectGraphModal': openProjectGraphModal(); break;
        case 'closeProjectGraphModal': closeProjectGraphModal(); break;
        case 'pgSetGraphMode': pgSetGraphMode(arg); break;
        case 'pgSetViewLevel': pgSetViewLevel(arg); break;
        case 'pgSetLayoutMode': pgSetLayoutMode(arg); break;
        case 'pgDrillIntoFolder': pgDrillIntoFolder(arg); break;
        case 'pgExitFolderDrill': pgExitFolderDrill(); break;
        case 'pgExitToMainView': pgExitToMainView(); break;
        case 'pgOpenFileFromFolder': pgOpenFileFromFolder(arg); break;
        case 'pgRefreshGraph': pgRefreshGraph(); break;
        case 'pgClearSearch': pgClearSearch(); break;
        case 'pgToggleFilter': pgToggleFilter(arg); break;
        case 'pgZoomStep': pgZoomStep(arg); break;
        case 'pgFilterCluster': pgFilterCluster(arg); break;
        case 'pgSetInspectorTab': pgSetInspectorTab(arg); break;
        case 'pgSelectNodeById': pgSelectNodeById(arg); break;
        case 'pgFocusSelectedNode': pgFocusSelectedNode(); break;
        case 'pgCopySelectedPath': void pgCopySelectedPath(); break;
        case 'pgSendToComposer': pgSendToComposer(); break;
        case 'pgSetLens': pgSetLens(arg); break;
        case 'pgToggleGitDiffWave': pgToggleGitDiffWave(); break;
        case 'pgSelectCycleIdx': pgSelectCycleIdx(arg); break;
        case 'pgStartPathFromSelected': pgStartPathFromSelected(); break;
        case 'pgSwapPathEndpoints': pgSwapPathEndpoints(); break;
        case 'pgClearPath': pgClearPath(); break;
        case 'pgToggleNodeInCart': pgToggleNodeInCart(arg); break;
        case 'pgAddBlastWaveToCart': pgAddBlastWaveToCart(); break;
        case 'pgAddPathToCart': pgAddPathToCart(); break;
        case 'pgClearContextCart': pgClearContextCart(); break;
        case 'pgSendCartToComposer': pgSendCartToComposer(); break;
        case 'pgToggleSemanticSearch': pgToggleSemanticSearch(); break;
        case 'pgExportMermaid': void pgExportMermaid(); break;
        case 'pgExportPng': pgExportPng(); break;
        case 'pgOpenSymbolsForSelected': pgOpenSymbolsForSelected(); break;
        case 'pgExitSymbolsLevel': pgExitSymbolsLevel(arg); break;
        case 'pgChangeChurnDays': pgChangeChurnDays(arg); break;
        case 'pgAddTopHotspotsToCart': pgAddTopHotspotsToCart(); break;
        default: break;
      }
    }

    const COLLAPSED_CARDS_STORAGE_KEY = 'ag_tunnel_collapsed_cards_v1';
    const OPEN_SPOILERS_STORAGE_KEY = 'ag_tunnel_open_spoilers_v1';
    const COLLAPSIBLE_CARD_IDS = new Set([
      'smartComposerCard',
      'skillsSectionCard',
      'agentModeCard',
      'skillProfilesFieldset',
      'swarmTelemetryCard',
      'gpuRamCard',
      'sentinelSectionCard',
      'checkpointsCard',
      'intelligenceBayesianCard',
      'expertGuardrailsCard',
      'expertProfileCard',
      'expertRamGpuFieldset'
    ]);
    const DEFAULT_COLLAPSED_CARDS_MAP = {
      swarmTelemetryCard: true,
      gpuRamCard: true,
      sentinelSectionCard: true
    };
    const PANEL_SPOILER_IDS = new Set([
      'snapshotsBayesianSpoiler',
      'expertDetailsBox'
    ]);
    let _lastAppliedSpoilersMap = Object.create(null);
    let _spoilerListenersInitialized = false;

    function sanitizeBooleanIdMap(rawMap, allowedSet) {
      const out = {};
      if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return out;
      allowedSet.forEach(function (id) {
        if (rawMap[id] === true) out[id] = true;
      });
      return out;
    }

    function areBooleanMapsEqual(a, b, allowedSet) {
      const left = sanitizeBooleanIdMap(a, allowedSet);
      const right = sanitizeBooleanIdMap(b, allowedSet);
      let equal = true;
      allowedSet.forEach(function (id) {
        if (!!left[id] !== !!right[id]) equal = false;
      });
      return equal;
    }

    function loadBooleanMapFromStorage(storageKey, allowedSet) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return {};
        return sanitizeBooleanIdMap(JSON.parse(raw), allowedSet);
      } catch {
        return {};
      }
    }

    function saveBooleanMapToStorage(storageKey, map, allowedSet) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(sanitizeBooleanIdMap(map, allowedSet)));
      } catch {}
    }

    function applyCardCollapseState(cardId, collapsed) {
      if (!COLLAPSIBLE_CARD_IDS.has(cardId)) return;
      const el = document.getElementById(cardId);
      if (!el) return;
      const isCollapsed = !!collapsed;
      el.classList.toggle('is-collapsed', isCollapsed);
      const btn = el.querySelector('.lg-card-collapse-btn[data-arg="' + cardId + '"]');
      if (btn) {
        const labelText = isCollapsed ? L('Показать содержимое блока', 'Expand card content') : L('Скрыть содержимое блока', 'Collapse card content');
        btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        btn.setAttribute('aria-label', labelText);
        btn.setAttribute('title', labelText);
      }
    }

    function loadCollapsedCardsFromStorageWithFallback() {
      try {
        const raw = localStorage.getItem(COLLAPSED_CARDS_STORAGE_KEY);
        if (!raw) return Object.assign({}, DEFAULT_COLLAPSED_CARDS_MAP);
        return sanitizeBooleanIdMap(JSON.parse(raw), COLLAPSIBLE_CARD_IDS);
      } catch {
        return Object.assign({}, DEFAULT_COLLAPSED_CARDS_MAP);
      }
    }

    function applyAllCollapsedCardsState(serverMap) {
      const hasServerMap = serverMap && typeof serverMap === 'object' && !Array.isArray(serverMap);
      const map = hasServerMap
        ? sanitizeBooleanIdMap(serverMap, COLLAPSIBLE_CARD_IDS)
        : loadCollapsedCardsFromStorageWithFallback();
      if (hasServerMap) {
        saveBooleanMapToStorage(COLLAPSED_CARDS_STORAGE_KEY, map, COLLAPSIBLE_CARD_IDS);
      }
      COLLAPSIBLE_CARD_IDS.forEach(function (id) {
        applyCardCollapseState(id, !!map[id]);
      });
    }

    function togglePanelCardCollapse(cardId) {
      if (!COLLAPSIBLE_CARD_IDS.has(cardId)) return;
      const map = {};
      COLLAPSIBLE_CARD_IDS.forEach(function (id) {
        const el = document.getElementById(id);
        if (el && el.classList.contains('is-collapsed')) {
          map[id] = true;
        }
      });
      const nextCollapsed = !map[cardId];
      if (nextCollapsed) {
        map[cardId] = true;
      } else {
        delete map[cardId];
      }
      saveBooleanMapToStorage(COLLAPSED_CARDS_STORAGE_KEY, map, COLLAPSIBLE_CARD_IDS);
      applyCardCollapseState(cardId, nextCollapsed);
      if (!nextCollapsed) {
        flushVisibleBlockRenders();
        maybeLoadMissingSectionsForBlock(cardId);
        if (
          cardId === 'swarmTelemetryCard' ||
          cardId === 'gpuRamCard' ||
          cardId === 'sentinelSectionCard' ||
          cardId === 'intelligenceBayesianCard' ||
          cardId === 'expertGuardrailsCard'
        ) {
          pollTelemetryTick();
        }
      }
      updateState({ panelCollapsedCards: map });
    }

    function readDomOpenSpoilersMap() {
      const out = {};
      PANEL_SPOILER_IDS.forEach(function (id) {
        const el = document.getElementById(id);
        if (el && el.open) out[id] = true;
      });
      return out;
    }

    function applyAllSpoilersOpenState(serverMap) {
      const hasServerMap = serverMap && typeof serverMap === 'object' && !Array.isArray(serverMap);
      const map = hasServerMap
        ? sanitizeBooleanIdMap(serverMap, PANEL_SPOILER_IDS)
        : loadBooleanMapFromStorage(OPEN_SPOILERS_STORAGE_KEY, PANEL_SPOILER_IDS);
      if (hasServerMap) {
        saveBooleanMapToStorage(OPEN_SPOILERS_STORAGE_KEY, map, PANEL_SPOILER_IDS);
      }
      _lastAppliedSpoilersMap = map;
      PANEL_SPOILER_IDS.forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        const shouldOpen = !!map[id];
        if (el.open !== shouldOpen) {
          el.open = shouldOpen;
        }
      });
    }

    function setupSpoilerPersistence() {
      if (_spoilerListenersInitialized) return;
      _spoilerListenersInitialized = true;
      PANEL_SPOILER_IDS.forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('toggle', function () {
          const domMap = readDomOpenSpoilersMap();
          const changed = !areBooleanMapsEqual(domMap, _lastAppliedSpoilersMap, PANEL_SPOILER_IDS);
          if (changed) {
            _lastAppliedSpoilersMap = domMap;
            saveBooleanMapToStorage(OPEN_SPOILERS_STORAGE_KEY, domMap, PANEL_SPOILER_IDS);
            updateState({ panelOpenSpoilers: domMap });
          }
          if (el.open) {
            refreshBlockVisibilityObserver();
            flushVisibleBlockRenders();
            maybeLoadMissingSectionsForBlock(id);
            pollTelemetryTick();
            if (id === 'expertDetailsBox') {
              if (typeof loadProjectInstincts === 'function') loadProjectInstincts({ silent: true });
              if (typeof refreshGatesStatus === 'function') refreshGatesStatus({ silent: true });
            }
          }
        });
      });
    }

    const DEFAULT_PANEL_BLOCK_ORDER = [
      'smartProjectBanner',
      'agLiveProgressWrap',
      'smartComposerCard',
      'skillsSectionCard',
      'agentModeCard',
      'skillProfilesFieldset',
      'swarmTelemetryCard',
      'gpuRamCard',
      'sentinelSectionCard',
      'snapshotsBayesianSpoiler',
      'expertDetailsBox',
      'checkpointsCard',
      'intelligenceBayesianCard',
      'expertCircuitBox',
      'expertPitfallsBox',
      'expertKnowledgeBox',
      'expertGuardrailsCard',
      'expertProfileCard',
      'expertRamGpuFieldset'
    ];
    const BLOCK_ORDER_STORAGE_KEY = 'ag_tunnel_panel_block_order_v1';
    let _suppressSummaryClickUntil = 0;
    let _blockControlsInitialized = false;

    function normalizeBlockOrderList(rawOrder) {
      let candidate = Array.isArray(rawOrder) ? rawOrder : null;
      if (!candidate || candidate.length === 0) {
        try {
          const savedLocal = localStorage.getItem(BLOCK_ORDER_STORAGE_KEY);
          if (savedLocal) {
            const parsed = JSON.parse(savedLocal);
            if (Array.isArray(parsed)) candidate = parsed;
          }
        } catch {}
      }
      const validSet = new Set(DEFAULT_PANEL_BLOCK_ORDER);
      const seen = new Set();
      const out = [];
      const pushUnique = function (id) {
        if (validSet.has(id) && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      };
      if (Array.isArray(candidate)) {
        const trimmed = candidate.map(function (v) { return String(v || '').trim(); });
        const hasExplicitSentinel = trimmed.indexOf('sentinelSectionCard') !== -1;
        for (let i = 0; i < trimmed.length; i++) {
          const id = trimmed[i];
          if (id === 'telemetrySwarmSpoiler') {
            pushUnique('swarmTelemetryCard');
            continue;
          }
          if (id === 'hardwareResourcesSpoiler') {
            pushUnique('gpuRamCard');
            if (!hasExplicitSentinel) pushUnique('sentinelSectionCard');
            continue;
          }
          pushUnique(id);
          if (id === 'gpuRamCard' && !hasExplicitSentinel) {
            pushUnique('sentinelSectionCard');
          }
        }
      }
      for (let i = 0; i < DEFAULT_PANEL_BLOCK_ORDER.length; i++) {
        const defId = DEFAULT_PANEL_BLOCK_ORDER[i];
        if (!seen.has(defId)) {
          seen.add(defId);
          if (defId === 'smartComposerCard') {
            const anchorIdx = out.indexOf('agLiveProgressWrap');
            if (anchorIdx >= 0) {
              out.splice(anchorIdx + 1, 0, defId);
              continue;
            }
          }
          if (defId === 'sentinelSectionCard') {
            const anchorIdx = out.indexOf('gpuRamCard');
            if (anchorIdx >= 0) {
              out.splice(anchorIdx + 1, 0, defId);
              continue;
            }
          }
          if (defId === 'expertKnowledgeBox') {
            const anchorIdx = out.indexOf('expertPitfallsBox');
            if (anchorIdx >= 0) {
              out.splice(anchorIdx + 1, 0, defId);
              continue;
            }
          }
          out.push(defId);
        }
      }
      return out;
    }

    function createBlockMoveControlsElement(blockId) {
      const wrap = document.createElement('div');
      wrap.className = 'block-move-controls';
      wrap.setAttribute('data-block-controls', blockId);
      wrap.innerHTML =
        '<span class="block-drag-handle" data-role="drag-handle" data-block-id="' + escapeHtml(blockId) + '" title="' + L('Перетащите, чтобы изменить порядок блока', 'Drag to reorder card') + '">' +
        '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">' +
        '<circle cx="3.75" cy="3.75" r="1.25"/><circle cx="8.25" cy="3.75" r="1.25"/>' +
        '<circle cx="3.75" cy="8.25" r="1.25"/><circle cx="8.25" cy="8.25" r="1.25"/>' +
        '</svg></span>';
      return wrap;
    }

    function ensureBlockMoveControls() {
      if (_blockControlsInitialized) return;
      _blockControlsInitialized = true;
      for (let i = 0; i < DEFAULT_PANEL_BLOCK_ORDER.length; i++) {
        const id = DEFAULT_PANEL_BLOCK_ORDER[i];
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.add('reorderable-block');
        el.setAttribute('data-block-id', id);
        if (el.querySelector('[data-block-controls="' + id + '"]')) continue;

        const controls = createBlockMoveControlsElement(id);
        if (el.tagName === 'DETAILS') {
          const sum = el.querySelector(':scope > summary');
          if (sum) {
            if (!sum.querySelector('.summary-title-text')) {
              const span = document.createElement('span');
              span.className = 'summary-title-text';
              while (sum.firstChild) {
                span.appendChild(sum.firstChild);
              }
              sum.appendChild(span);
            }
            sum.appendChild(controls);
          }
        } else if (id === 'smartProjectBanner') {
          const actionsDiv = el.children[1] || el;
          actionsDiv.style.alignItems = 'center';
          actionsDiv.appendChild(controls);
        } else if (id === 'agLiveProgressWrap') {
          const topRow = el.querySelector('.ag-progress-top-row');
          if (topRow) topRow.appendChild(controls);
        } else if (id === 'expertCircuitBox') {
          const headRow = document.getElementById('expertCircuitHeadRow');
          if (headRow) headRow.appendChild(controls);
        } else if (id === 'expertPitfallsBox') {
          const headRow = document.getElementById('expertPitfallsHeadRow');
          if (headRow) headRow.appendChild(controls);
        } else if (id === 'expertKnowledgeBox') {
          const headRow = document.getElementById('expertKnowledgeHeadRow');
          if (headRow) headRow.appendChild(controls);
        } else {
          const head = el.querySelector(':scope > .lg-card-head');
          if (head) {
            if (COLLAPSIBLE_CARD_IDS.has(id)) {
              el.setAttribute('data-collapsible-card', '1');
              const titleEl = head.querySelector(':scope > .lg-card-title');
              if (titleEl && !titleEl.getAttribute('data-action')) {
                titleEl.setAttribute('data-action', 'togglePanelCardCollapse');
                titleEl.setAttribute('data-arg', id);
              }
            }
            let actionsHost = head.querySelector(':scope > .lg-card-head-actions');
            if (!actionsHost && COLLAPSIBLE_CARD_IDS.has(id)) {
              actionsHost = document.createElement('div');
              actionsHost.className = 'lg-card-head-actions';
              const trailing = Array.from(head.children).slice(1);
              for (let t = 0; t < trailing.length; t++) {
                actionsHost.appendChild(trailing[t]);
              }
              head.appendChild(actionsHost);
            }
            const targetHost = actionsHost || head;
            if (COLLAPSIBLE_CARD_IDS.has(id) && !el.querySelector('.lg-card-collapse-btn[data-arg="' + id + '"]')) {
              const collapseBtn = document.createElement('button');
              collapseBtn.type = 'button';
              collapseBtn.className = 'lg-card-collapse-btn';
              collapseBtn.setAttribute('data-action', 'togglePanelCardCollapse');
              collapseBtn.setAttribute('data-arg', id);
              collapseBtn.setAttribute('aria-expanded', 'true');
              collapseBtn.setAttribute('aria-label', L('Скрыть содержимое блока', 'Collapse card content'));
              collapseBtn.setAttribute('title', L('Скрыть содержимое блока', 'Collapse card content'));
              targetHost.appendChild(collapseBtn);
            }
            targetHost.appendChild(controls);
          }
        }
      }
    }

    function getReorderContainers() {
      return [
        document.querySelector('.window-body'),
        document.getElementById('snapshotsInnerStack'),
        document.getElementById('expertInnerStack')
      ].filter(Boolean);
    }

    function updateBlockControlsStatus() {
      const currentOrder = readCurrentDomBlockOrder();
      const isDefault = currentOrder.length === DEFAULT_PANEL_BLOCK_ORDER.length &&
        currentOrder.every(function (id, idx) { return id === DEFAULT_PANEL_BLOCK_ORDER[idx]; });
      const resetBtn = document.getElementById('resetBlockOrderBtn');
      if (resetBtn) {
        resetBtn.style.display = !isDefault ? 'inline-flex' : 'none';
      }
    }

    function applyPanelBlockOrder(rawOrder, syncLocal) {
      ensureBlockMoveControls();
      const order = normalizeBlockOrderList(rawOrder);
      if (syncLocal) {
        try {
          localStorage.setItem(BLOCK_ORDER_STORAGE_KEY, JSON.stringify(order));
        } catch {}
      }
      const rankMap = Object.create(null);
      for (let i = 0; i < order.length; i++) {
        rankMap[order[i]] = i;
      }

      const containers = getReorderContainers();
      for (let c = 0; c < containers.length; c++) {
        const parent = containers[c];
        const blocks = Array.from(parent.children).filter(function (node) {
          return node.classList && node.classList.contains('reorderable-block');
        });
        if (blocks.length < 2) continue;
        const sorted = blocks.slice().sort(function (a, b) {
          const ra = rankMap[a.id] !== undefined ? rankMap[a.id] : 999;
          const rb = rankMap[b.id] !== undefined ? rankMap[b.id] : 999;
          return ra - rb;
        });
        let changed = false;
        for (let i = 0; i < blocks.length; i++) {
          if (blocks[i] !== sorted[i]) {
            changed = true;
            break;
          }
        }
        if (changed) {
          for (let i = 0; i < sorted.length; i++) {
            parent.appendChild(sorted[i]);
          }
        }
      }
      updateBlockControlsStatus();
      refreshBlockVisibilityObserver();
    }

    function readCurrentDomBlockOrder() {
      const out = [];
      const seen = new Set();
      const containers = getReorderContainers();
      for (let c = 0; c < containers.length; c++) {
        const parent = containers[c];
        const blocks = Array.from(parent.children).filter(function (node) {
          return node.classList && node.classList.contains('reorderable-block');
        });
        for (let i = 0; i < blocks.length; i++) {
          const id = blocks[i].id;
          if (id && !seen.has(id)) {
            seen.add(id);
            out.push(id);
          }
        }
      }
      for (let i = 0; i < DEFAULT_PANEL_BLOCK_ORDER.length; i++) {
        const defId = DEFAULT_PANEL_BLOCK_ORDER[i];
        if (!seen.has(defId)) {
          seen.add(defId);
          if (defId === 'smartComposerCard') {
            const anchorIdx = out.indexOf('agLiveProgressWrap');
            if (anchorIdx >= 0) {
              out.splice(anchorIdx + 1, 0, defId);
              continue;
            }
          }
          if (defId === 'sentinelSectionCard') {
            const anchorIdx = out.indexOf('gpuRamCard');
            if (anchorIdx >= 0) {
              out.splice(anchorIdx + 1, 0, defId);
              continue;
            }
          }
          if (defId === 'expertKnowledgeBox') {
            const anchorIdx = out.indexOf('expertPitfallsBox');
            if (anchorIdx >= 0) {
              out.splice(anchorIdx + 1, 0, defId);
              continue;
            }
          }
          out.push(defId);
        }
      }
      return out;
    }

    function recordFlipRects(nodes) {
      const map = new Map();
      for (let i = 0; i < nodes.length; i++) {
        map.set(nodes[i], nodes[i].getBoundingClientRect());
      }
      return map;
    }

    function playFlipAnimation(nodes, prevRects, excludeNode) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node === excludeNode) continue;
        const first = prevRects.get(node);
        if (!first) continue;
        const last = node.getBoundingClientRect();
        const dy = first.top - last.top;
        if (Math.abs(dy) < 1) continue;
        node.style.transition = 'none';
        node.style.transform = 'translate3d(0, ' + dy + 'px, 0)';
        window.requestAnimationFrame(function () {
          node.style.transition = 'transform 0.26s cubic-bezier(0.22, 1, 0.36, 1)';
          node.style.transform = '';
          setTimeout(function () {
            node.style.transition = '';
          }, 270);
        });
      }
    }

    function persistCurrentBlockOrder(statusMsg) {
      const nextOrder = readCurrentDomBlockOrder();
      try {
        localStorage.setItem(BLOCK_ORDER_STORAGE_KEY, JSON.stringify(nextOrder));
      } catch {}
      updateBlockControlsStatus();
      updateState({ panelBlockOrder: nextOrder });
      if (statusMsg) flashStatus(statusMsg);
    }

    function resetPanelBlockOrder() {
      ensureBlockMoveControls();
      try {
        localStorage.removeItem(BLOCK_ORDER_STORAGE_KEY);
      } catch {}
      const containers = getReorderContainers();
      for (let c = 0; c < containers.length; c++) {
        const siblings = Array.from(containers[c].children).filter(function (n) {
          return n.classList && n.classList.contains('reorderable-block');
        });
        const rects = recordFlipRects(siblings);
        applyPanelBlockOrder(DEFAULT_PANEL_BLOCK_ORDER);
        playFlipAnimation(siblings, rects, null);
      }
      updateState({ panelBlockOrder: DEFAULT_PANEL_BLOCK_ORDER.slice() });
      flashStatus(L('Восстановлен исходный порядок блоков ✓', 'Default card order restored ✓'));
    }

