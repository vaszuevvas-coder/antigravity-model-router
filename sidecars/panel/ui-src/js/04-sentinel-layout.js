    let _sentinelActionBusy = false;
    let _lastNormalizedSentinelFindings = [];
    let _lastSentinelAlertCounts = { errs: 0, warns: 0, bugbot: 0 };

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
        const targetLineNum = Number(rawItem.targetLine || 0);
        const lineHintStr = String(rawItem.lineHint || '').trim();
        if (category === 'clone' && fileStr && partnerStr) {
          const leftSym = rawItem.symbol ? ('#' + rawItem.symbol) : '';
          const rightSym = rawItem.targetSymbol ? ('#' + rawItem.targetSymbol) : '';
          const leftLine = lineNum > 0 ? (':L' + lineNum) : '';
          const rightLine = targetLineNum > 0 ? (':L' + targetLineNum) : '';
          loc = fileStr + leftSym + leftLine + ' ↔ ' + partnerStr + rightSym + rightLine;
        } else if (fileStr && partnerStr) {
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
      const tagLabel = category === 'bugbot'
        ? 'BugBot'
        : (category === 'cochange' ? 'Co-Change' : (category === 'clone' ? L('Клон', 'Clone') : L('Контракт', 'Contract')));
      const tagClass = category === 'bugbot'
        ? 'tag-bugbot'
        : (category === 'cochange' || category === 'clone' ? 'tag-cochange' : 'tag-contract');
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

    let _sentinelFixCooldownUntil = 0;
    let _sentinelFixCooldownTimer = null;
    let _sentinelFixNoticeTimer = null;

    function syncSentinelNormalizedFindings(sentinelData) {
      const sen = (sentinelData && typeof sentinelData === 'object') ? sentinelData : {};
      const sg = (sen.shadowGuard && typeof sen.shadowGuard === 'object') ? sen.shadowGuard : {};
      const bb = (sen.bugBot && typeof sen.bugBot === 'object') ? sen.bugBot : {};
      const rawIssues = Array.isArray(sg.issues) ? sg.issues : [];
      const rawCoChange = Array.isArray(sg.coChangeAlerts) ? sg.coChangeAlerts : [];
      const rawClones = Array.isArray(sg.clonePairs) ? sg.clonePairs : [];
      const rawBugBot = Array.isArray(bb.findings) ? bb.findings : [];

      const errCount = Math.max(0, Number(sg.errorCount || 0));
      const warnCount = Math.max(0, Number(sg.warnCount || 0)) + (Number(sg.warnCount || 0) === 0 ? Math.max(0, Number(sg.cloneCount || 0)) : 0);
      const hasContractAlerts = !(errCount === 0 && warnCount === 0 && rawIssues.length === 0 && rawCoChange.length === 0);
      const shownWarns = hasContractAlerts ? Math.max(warnCount, rawCoChange.length) : 0;
      const shownErrs = hasContractAlerts
        ? Math.max(errCount, rawIssues.length > 0 && shownWarns === 0 ? rawIssues.length : errCount)
        : 0;
      const bbCount = Math.max(0, Number(bb.findingsCount || 0), rawBugBot.length);

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
      for (let i = 0; i < rawClones.length && normalizedFindings.length < 18; i++) {
        const item = normalizeSentinelFindingEntry(rawClones[i], 'clone');
        if (item) normalizedFindings.push(item);
      }

      const rawCloneCount = Math.max(0, Number(sg.cloneCount || 0));
      const onlyClones = rawCloneCount > 0 && errCount === 0 && Number(sg.warnCount || 0) === 0 && bbCount === 0 && rawIssues.length === 0 && rawCoChange.length === 0;
      const hasAnyAlert = normalizedFindings.length > 0 || errCount > 0 || warnCount > 0 || bbCount > 0;
      if (hasAnyAlert && normalizedFindings.length === 0) {
        const fallbackDesc = onlyClones
          ? L('Обнаружены дубликаты кода (SimHash): ' + rawCloneCount + '. Нажмите ↻ для показа пар.', 'SimHash code duplicates detected: ' + rawCloneCount + '. Click ↻ to load pairs.')
          : L('Есть предупреждения или ошибки Дозора (' + (shownErrs + shownWarns + bbCount) + '). Нажмите ↻ для деталей.', 'Sentinel warnings or errors detected (' + (shownErrs + shownWarns + bbCount) + '). Click ↻ for details.');
        normalizedFindings.push({
          category: onlyClones ? 'clone' : 'contract',
          tagClass: onlyClones ? 'is-clone' : 'is-contract',
          tagLabel: onlyClones ? L('Клон', 'Clone') : L('Дозор', 'Sentinel'),
          loc: '',
          desc: fallbackDesc,
          prompt: L('Проверь и исправь находки Фонового Дозора (Shadow Guard / SimHash-клоны) в текущем проекте.', 'Check and fix Background Sentinel findings (Shadow Guard / SimHash clones) in the current project.'),
        });
      }
      _lastNormalizedSentinelFindings = normalizedFindings;
      _lastSentinelAlertCounts = { errs: shownErrs, warns: shownWarns, bugbot: bbCount };
      return {
        rawIssues: rawIssues,
        rawCoChange: rawCoChange,
        rawClones: rawClones,
        rawBugBot: rawBugBot,
        errCount: errCount,
        warnCount: warnCount,
        hasContractAlerts: hasContractAlerts,
        shownWarns: shownWarns,
        shownErrs: shownErrs,
        bbCount: bbCount,
        rawCloneCount: rawCloneCount,
        normalizedFindings: normalizedFindings,
        hasAnyAlert: hasAnyAlert,
      };
    }

    function resetSentinelTransientState() {
      _lastNormalizedSentinelFindings = [];
      _lastSentinelAlertCounts = { errs: 0, warns: 0, bugbot: 0 };
      if (typeof _latestWiretapFault !== 'undefined') {
        _latestWiretapFault = null;
      }
    }

    function renderSentinelStatus(sentinelData, state) {
      const s = state || currentState || {};
      syncSentinelCheckboxes(s);
      const parsedSen = syncSentinelNormalizedFindings(sentinelData);
      const boxEl = document.getElementById('sentinelStatusBox');
      const liteRowEl = document.getElementById('liteSentinelRow');
      if (!boxEl && !liteRowEl) return;

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

      const rawCoChange = parsedSen.rawCoChange;
      const errCount = parsedSen.errCount;
      const hasContractAlerts = parsedSen.hasContractAlerts;
      const shownWarns = parsedSen.shownWarns;
      const shownErrs = parsedSen.shownErrs;

      const healthEl = document.getElementById('sentinelHealthVal');
      if (healthEl) {
        if (!hasContractAlerts) {
          healthEl.textContent = L('Чисто', 'Clean');
          healthEl.className = 'sentinel-metric-val is-ok';
          healthEl.title = L('Нарушений контрактов, импортов и пар Git Co-Change не обнаружено', 'No contract, import, or Git co-change violations detected');
        } else {
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

      const bbCount = parsedSen.bbCount;
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

      const normalizedFindings = parsedSen.normalizedFindings;
      const rawCloneCount = parsedSen.rawCloneCount;
      const hasAnyAlert = parsedSen.hasAnyAlert;

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

      const liteBadgeEl = document.getElementById('liteSentinelBadge');
      if (liteBadgeEl) {
        const curTaskLite = String(pickText(sen, 'currentTaskRu', 'currentTaskEn', '') || '').trim();
        if (!isEnabled) {
          liteBadgeEl.className = 'sentinel-live-badge is-off lite-sentinel-badge';
          liteBadgeEl.textContent = L('Выключен', 'Off');
          liteBadgeEl.title = L('Фоновый Дозор отключён в настройках', 'Background Sentinel is disabled in settings');
        } else if (rawState === 'preempted' || rawState === 'yielded' || sen.p0Active) {
          liteBadgeEl.className = 'sentinel-live-badge is-preempted lite-sentinel-badge';
          liteBadgeEl.textContent = L('P0 Уступил чату', 'P0 Yielded');
          liteBadgeEl.title = curTaskLite || L('Фоновая задача мгновенно уступила ресурсы активному запросу', 'Background task immediately yielded resources to active request');
        } else if (rawState === 'working' || rawState === 'running' || rawState === 'scanning' || _sentinelActionBusy) {
          liteBadgeEl.className = 'sentinel-live-badge is-working lite-sentinel-badge';
          liteBadgeEl.textContent = L('Проверка…', 'Checking…');
          liteBadgeEl.title = curTaskLite || L('Фоновый Дозор выполняет проверку', 'Background Sentinel is running checks');
        } else if (shownErrs > 0) {
          liteBadgeEl.className = 'sentinel-live-badge is-err lite-sentinel-badge';
          liteBadgeEl.textContent = L('Ошибок: ', 'Errors: ') + (shownErrs + bbCount);
          liteBadgeEl.title = L('Обнаружены ошибки контрактов или BugBot', 'Contract or BugBot errors detected');
        } else if (shownWarns > 0 || bbCount > 0 || normalizedFindings.length > 0) {
          liteBadgeEl.className = 'sentinel-live-badge is-preempted lite-sentinel-badge';
          liteBadgeEl.textContent = L('Находок: ', 'Findings: ') + Math.max(normalizedFindings.length, shownWarns + bbCount);
          liteBadgeEl.title = L('Есть предупреждения или находки Фонового Дозора', 'Background Sentinel warnings or findings detected');
        } else {
          liteBadgeEl.className = 'sentinel-live-badge is-ok lite-sentinel-badge';
          liteBadgeEl.textContent = L('Чисто', 'Clean');
          liteBadgeEl.title = L('Дежурит в паузах · ошибок не обнаружено', 'Standing by during pauses · no errors detected');
        }
      }

      const liteSummaryEl = document.getElementById('liteSentinelSummary');
      if (liteSummaryEl) {
        if (!isEnabled) {
          liteSummaryEl.className = 'lite-sentinel-summary';
          liteSummaryEl.textContent = L('Дозор отключён в настройках', 'Sentinel disabled in settings');
        } else if (!hasAnyAlert) {
          liteSummaryEl.className = 'lite-sentinel-summary is-ok';
          liteSummaryEl.textContent = L('Контракты: чисто · BugBot: чисто', 'Contracts: clean · BugBot: clean');
        } else {
          const sumParts = [];
          if (shownErrs > 0) sumParts.push(L('Ошибок: ', 'Errors: ') + shownErrs);
          if (shownWarns > 0) {
            if (rawCloneCount > 0 && Number(sg.warnCount || 0) === 0 && rawCoChange.length === 0) {
              sumParts.push(L('Дубликатов кода: ', 'Code clones: ') + shownWarns);
            } else {
              sumParts.push(L('Предупреждений: ', 'Warnings: ') + shownWarns);
            }
          }
          if (bbCount > 0) sumParts.push('BugBot: ' + bbCount);
          if (sumParts.length === 0) sumParts.push(L('Находок: ', 'Findings: ') + normalizedFindings.length);
          liteSummaryEl.className = 'lite-sentinel-summary ' + (shownErrs > 0 ? 'is-err' : 'is-warn');
          liteSummaryEl.textContent = sumParts.join(' · ');
        }
      }

      const liteCheckBtn = document.getElementById('btnLiteSentinelCheck');
      if (liteCheckBtn) {
        liteCheckBtn.disabled = _sentinelActionBusy;
      }

      const liteFixBtn = document.getElementById('btnLiteSentinelFix');
      if (liteFixBtn) {
        const inFixCooldown = Date.now() < _sentinelFixCooldownUntil;
        liteFixBtn.style.display = hasAnyAlert ? 'inline-flex' : 'none';
        liteFixBtn.disabled = !hasAnyAlert || _sentinelActionBusy || inFixCooldown;
        liteFixBtn.textContent = inFixCooldown
          ? L('✓ В новом чате', '✓ In new chat')
          : (normalizedFindings.length > 1
            ? (L('Исправить (', 'Fix (') + normalizedFindings.length + ')')
            : L('Исправить', 'Fix'));
      }

      const liteFindingsEl = document.getElementById('liteSentinelFindings');
      if (liteFindingsEl) {
        liteFindingsEl.textContent = '';
        if (normalizedFindings.length === 0) {
          liteFindingsEl.style.display = 'none';
        } else {
          liteFindingsEl.style.display = 'flex';
          const previewLimit = Math.min(3, normalizedFindings.length);
          for (let i = 0; i < previewLimit; i++) {
            const lf = normalizedFindings[i];
            const itemRow = document.createElement('div');
            itemRow.className = 'lite-sentinel-finding-item';

            const textWrap = document.createElement('div');
            textWrap.className = 'lite-sentinel-finding-text';

            const tagEl = document.createElement('span');
            tagEl.className = 'sentinel-finding-tag ' + lf.tagClass;
            tagEl.textContent = lf.tagLabel;
            textWrap.appendChild(tagEl);

            if (lf.loc) {
              const locEl = document.createElement('span');
              locEl.className = 'sentinel-finding-loc';
              locEl.textContent = lf.loc;
              locEl.title = lf.loc;
              textWrap.appendChild(locEl);
            }

            if (lf.desc) {
              const descEl = document.createElement('span');
              descEl.className = 'lite-sentinel-finding-desc';
              descEl.textContent = lf.desc;
              descEl.title = (lf.loc ? (lf.loc + ' — ') : '') + lf.desc;
              textWrap.appendChild(descEl);
            }

            const itemFixBtn = document.createElement('button');
            itemFixBtn.type = 'button';
            itemFixBtn.className = 'win-btn lite-sentinel-item-fix-btn';
            itemFixBtn.setAttribute('data-action', 'fixSentinelFindingNow');
            itemFixBtn.setAttribute('data-prompt', lf.prompt);
            itemFixBtn.textContent = 'Fix';
            itemFixBtn.title = L('Отправить эту ошибку на исправление в отдельный чат проекта', 'Send this issue to a separate project chat to fix');

            itemRow.appendChild(textWrap);
            itemRow.appendChild(itemFixBtn);
            liteFindingsEl.appendChild(itemRow);
          }
          if (normalizedFindings.length > previewLimit) {
            const moreEl = document.createElement('div');
            moreEl.className = 'lite-sentinel-more';
            moreEl.textContent = L('+ ещё находок: ', '+ more findings: ') + (normalizedFindings.length - previewLimit);
            liteFindingsEl.appendChild(moreEl);
          }
        }
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
              locSpan.title = f.loc;
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
      if (typeof syncGuardDockFromSentinel === 'function') {
        syncGuardDockFromSentinel(normalizedFindings, _lastSentinelAlertCounts);
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

    function showSentinelFixNotice(noticeText) {
      const el = document.getElementById('liteSentinelFixNotice');
      if (!el) return;
      el.textContent = String(noticeText || '');
      el.style.display = noticeText ? 'flex' : 'none';
      if (_sentinelFixNoticeTimer) {
        clearTimeout(_sentinelFixNoticeTimer);
        _sentinelFixNoticeTimer = null;
      }
      if (noticeText) {
        _sentinelFixNoticeTimer = setTimeout(function () {
          _sentinelFixNoticeTimer = null;
          const node = document.getElementById('liteSentinelFixNotice');
          if (node) {
            node.style.display = 'none';
            node.textContent = '';
          }
        }, 7000);
      }
    }

    function armSentinelFixCooldown() {
      _sentinelFixCooldownUntil = Date.now() + 3000;
      const liteFixBtn = document.getElementById('btnLiteSentinelFix');
      if (liteFixBtn) {
        liteFixBtn.disabled = true;
        liteFixBtn.textContent = L('✓ В новом чате', '✓ In new chat');
      }
      document.querySelectorAll('#liteSentinelFindings .lite-sentinel-item-fix-btn').forEach(function (btn) {
        btn.disabled = true;
      });
      if (_sentinelFixCooldownTimer) clearTimeout(_sentinelFixCooldownTimer);
      _sentinelFixCooldownTimer = setTimeout(function () {
        _sentinelFixCooldownTimer = null;
        _sentinelFixCooldownUntil = 0;
        renderSentinelStatus(lastPayloadCache ? lastPayloadCache.sentinel : null, currentState);
      }, 3050);
    }

    function fixSentinelFindingNow(promptText) {
      const clean = String(promptText || '').trim();
      if (!clean) return;
      if (Date.now() < _sentinelFixCooldownUntil) return;
      if (typeof enqueueSmartComposerMessage === 'function') {
        armSentinelFixCooldown();
        enqueueSmartComposerMessage(clean, {
          forceNewConversation: true,
          focusNewConversation: false,
          title: L('Дозор: исправление', 'Sentinel: fix'),
        });
        const msg = L(
          '✓ Исправление открыто в новом стороннем чате проекта — текущий диалог не затронут.',
          '✓ Fix opened in a new separate project chat — current dialog untouched.'
        );
        showSentinelFixNotice(msg);
        flashStatus(msg);
      } else {
        sendSentinelToComposer(clean);
      }
    }

    function fixLiteSentinelFindings() {
      const findings = Array.isArray(_lastNormalizedSentinelFindings) ? _lastNormalizedSentinelFindings : [];
      if (findings.length === 1) {
        fixSentinelFindingNow(findings[0].prompt);
        return;
      }
      if (findings.length > 1) {
        const lines = findings.slice(0, 6).map(function (item, idx) {
          const locPart = item.loc ? (' [' + item.loc + ']') : '';
          return (idx + 1) + '. (' + item.tagLabel + ')' + locPart + ' ' + item.desc;
        });
        const extra = findings.length > 6
          ? ('\n' + L('И ещё находок: ', 'And additional findings: ') + (findings.length - 6))
          : '';
        const batchPrompt = isRu()
          ? ('Проверь и исправь находки Фонового Дозора:\n' + lines.join('\n') + extra)
          : ('Inspect and fix these Background Sentinel findings:\n' + lines.join('\n') + extra);
        fixSentinelFindingNow(batchPrompt);
        return;
      }
      const c = _lastSentinelAlertCounts || { errs: 0, warns: 0, bugbot: 0 };
      if (c.errs > 0 || c.warns > 0 || c.bugbot > 0) {
        const fallbackPrompt = isRu()
          ? ('Проверь и исправь предупреждения Фонового Дозора (ошибок: ' + c.errs + ', предупреждений: ' + c.warns + ', BugBot: ' + c.bugbot + ').')
          : ('Inspect and fix Background Sentinel alerts (errors: ' + c.errs + ', warnings: ' + c.warns + ', BugBot: ' + c.bugbot + ').');
        fixSentinelFindingNow(fallbackPrompt);
      }
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
            txt.textContent = '[' + loc + ']' + rep + ' ' + (_latestWiretapFault.summary || L('Сбой процесса', 'Runtime fault'));
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
      if (Array.isArray(wiretapFaults) && typeof renderGuardDock === 'function') {
        renderGuardDock(null);
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
        case 'wizSetLanguage': wizSetLanguage(arg); break;
        case 'wizSetViewMode': wizSetViewMode(arg); break;
        case 'setUiLanguage': void setUiLanguage(arg); break;
        case 'setPanelViewMode': setPanelViewMode(arg); break;
        case 'cyclePanelUiScale': cyclePanelUiScale(); break;
        case 'setPanelUiScale': setPanelUiScale(arg); break;
        case 'toggleLiteRamGpuMaster': toggleLiteRamGpuMaster(); break;
        case 'toggleLiteRamOnly': toggleLiteRamOnly(); break;
        case 'toggleLiteGpuOnly': toggleLiteGpuOnly(); break;
        case 'toggleLiteCpuOnly': toggleLiteCpuOnly(); break;
        case 'wizRescanHw': wizRescanHw(); break;
        case 'wizToggleFlag': wizToggleFlag(arg); break;
        case 'wizSetGpuPullMode': wizSetGpuPullMode(arg); break;
        case 'wizPickGpuInstallDir': void wizPickGpuInstallDir(); break;
        case 'autoCalibrateHardware': autoCalibrateHardware(); break;
        case 'sendHardwareTunePrompt': sendHardwareTunePrompt(); break;
        case 'prepareModelSearchPrompt': prepareModelSearchPrompt(); break;
        case 'sendVramFitModelPrompt': sendVramFitModelPrompt(); break;
        case 'startGpuCascadePull': startGpuCascadePull(arg || 'cascade'); break;
        case 'startGpuCascadePullHf': void startGpuCascadePullHf(); break;
        case 'dismissGpuPullError': void dismissGpuPullError(); break;
        case 'cancelGpuCascadePull': cancelGpuCascadePull(); break;
        case 'installOllamaFromPanel': void installOllamaFromPanel(); break;
        case 'dismissOllamaInstallStatus': void dismissOllamaInstallStatus(); break;
        case 'pickGpuFolder': void pickGpuFolder(arg || 'ollama'); break;
        case 'applySuggestedVramModel': if (arg) selectGpuModel('gpuChatModel', arg); break;
        case 'refreshAll': refreshAll(); break;
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
        case 'setAutoSpecMode': setAutoSpecMode(arg); break;
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
        case 'toggleBgTasksList': toggleBgTasksList(arg, actionEl); break;
        case 'toggleBgTasksShowAll': toggleBgTasksShowAll(arg, actionEl); break;
        case 'resetStaleProgressChats': resetStaleProgressChats(arg); break;
        case 'focusWaitingProgressChat': focusWaitingProgressChat(actionEl.getAttribute('data-cid') || arg); break;
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
        case 'fixLiteSentinelFindings': fixLiteSentinelFindings(); break;
        case 'fixSentinelFindingNow': fixSentinelFindingNow(actionEl.getAttribute('data-prompt') || arg); break;
        case 'sendWiretapFaultToComposer': sendWiretapFaultToComposer(); break;
        case 'clearWiretapFaults': clearWiretapFaults(); break;
        case 'selectComposerAtItem': selectComposerAtItem(actionEl.getAttribute('data-token') || arg); break;
        case 'analyzeComposerScreenshot': analyzeComposerScreenshot(); break;
        case 'clearComposerScreenshot': clearComposerScreenshot(); break;
        case 'prepareLocalCommit': prepareLocalCommit(); break;
        case 'toggleComposerVoice': toggleComposerVoice(); break;
        case 'setHookProfile': setHookProfile(arg); break;
        case 'applyTogglePreset': applyTogglePreset(arg); break;
        case 'runAgentShield': runAgentShield(); break;
        case 'loadProjectInstincts': loadProjectInstincts(); break;
        case 'promoteInstinct': promoteInstinct(arg); break;
        case 'deleteInstinct': deleteInstinct(arg); break;
        case 'toggleGuardTab': if (typeof toggleGuardTab === 'function') toggleGuardTab(arg); break;
        case 'closeGuardDrawer': if (typeof closeGuardDrawer === 'function') closeGuardDrawer(arg); break;
        case 'toggleGuardMenu': if (typeof toggleGuardMenu === 'function') toggleGuardMenu(arg); break;
        case 'runGuardAudit': if (typeof runGuardAudit === 'function') void runGuardAudit(arg || 'all'); break;
        case 'sendDeepStressAuditToChat': if (typeof sendDeepStressAuditToChat === 'function') sendDeepStressAuditToChat(); break;
        case 'evolveAllInstinctsFromDock': if (typeof evolveAllInstinctsFromDock === 'function') void evolveAllInstinctsFromDock(); break;
        case 'promoteInstinctFromDock': if (typeof promoteInstinctFromDock === 'function') void promoteInstinctFromDock(arg); break;
        case 'deleteInstinctFromDock': if (typeof deleteInstinctFromDock === 'function') void deleteInstinctFromDock(arg); break;
        case 'fixGuardItemInChat': if (typeof fixGuardItemInChat === 'function') fixGuardItemInChat(actionEl.getAttribute('data-prompt') || arg); break;
        case 'fixGuardAllShieldInChat': if (typeof fixGuardAllShieldInChat === 'function') fixGuardAllShieldInChat(); break;
        case 'runHealthDoctorFixFromDock': if (typeof runHealthDoctorFixFromDock === 'function') void runHealthDoctorFixFromDock(arg || 'fix_all'); break;
        case 'clearPitfallsFromDock': if (typeof clearPitfallsFromDock === 'function') void clearPitfallsFromDock(); break;
        case 'resetFragilityFromDock': if (typeof resetFragilityFromDock === 'function') void resetFragilityFromDock(); break;
        case 'resetCircuitFromDock': if (typeof resetCircuitFromDock === 'function') void resetCircuitFromDock(); break;
        case 'initGatesFromDock': if (typeof initGatesFromDock === 'function') void initGatesFromDock(); break;
        case 'jumpGuardFullSection': if (typeof jumpGuardFullSection === 'function') jumpGuardFullSection(arg); break;
        case 'openFragileInGraph': if (typeof openFragileInGraph === 'function') openFragileInGraph(arg); break;
        case 'toggleSetupDoctor': toggleSetupDoctor(); break;
        case 'closeSetupDoctor': closeSetupDoctor(); break;
        case 'loadSetupDoctor': loadSetupDoctor(); break;
        case 'applySetupDoctorItem': applySetupDoctorItem(arg); break;
        case 'runHealthDoctorFix': runHealthDoctorFix(arg); break;
        case 'setRoiTimelineScale': setRoiTimelineScale(arg); break;
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
        case 'pgClearLayerFilter': pgToggleLayerFilter(null); break;
        case 'pgResetLayeredPositions': pgResetLayeredPositions(); break;
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
        case 'pgBrowseWorkspaceFolder': void pgBrowseWorkspaceFolder(); break;
        case 'pgToggleAskAiMenu': pgToggleAskAiMenu(); break;
        case 'pgCtxAction': pgRunNodeContextAction(arg); break;
        case 'pgRunAiPreset': void pgRunAiPreset(arg); break;
        case 'pgSubmitCustomAiQuestion': void pgSubmitCustomAiQuestion(); break;
        case 'pgClearAiChat': pgClearAiChat(); break;
        case 'pgCloseAiChat': pgCloseAiChat(); break;
        case 'pgStopAiRequest': pgStopAiRequest(); break;
        case 'pgFocusAiMention': pgFocusAiMention(arg); break;
        case 'pgDismissAiMapCallout': pgDismissAiMapCallout(); break;
        case 'pgExpandAiFromCallout': pgExpandAiFromCallout(); break;
        case 'pgSendAiToComposer': pgSendAiToComposer(); break;
        case 'checkPluginUpdateManual': void checkPluginUpdate({ force: true, silent: false }); break;
        case 'applyPluginUpdateFromPanel': void applyPluginUpdateFromPanel(); break;
        case 'dismissPluginUpdateBanner': void dismissPluginUpdateBanner(); break;
        case 'closePluginUpdateOverlay': closePluginUpdateOverlay(); break;
        case 'hidePluginUpdateToast': hidePluginUpdateToast(); break;
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
      'expertDetailsBox',
      'hwEnginesSpoiler',
      'sentinelEnginesSpoiler',
      'intelBudgetSpoiler',
      'safetyContoursSpoiler'
    ]);
    const NESTED_TUNE_SPOILER_IDS = new Set([
      'hwEnginesSpoiler',
      'sentinelEnginesSpoiler',
      'intelBudgetSpoiler',
      'safetyContoursSpoiler'
    ]);
    let _lastAppliedSpoilersMap = Object.create(null);
    let _spoilerListenersInitialized = false;
    let _spoilerHydratedFromServer = false;
    const _locallyToggledSpoilers = Object.create(null);

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
      const localMap = loadBooleanMapFromStorage(OPEN_SPOILERS_STORAGE_KEY, PANEL_SPOILER_IDS);
      const map = hasServerMap
        ? sanitizeBooleanIdMap(serverMap, PANEL_SPOILER_IDS)
        : Object.assign({}, localMap);
      if (hasServerMap) {
        NESTED_TUNE_SPOILER_IDS.forEach(function (id) {
          const localToggle = _locallyToggledSpoilers[id];
          if (localToggle) {
            if (Boolean(map[id]) === Boolean(localToggle.open)) {
              delete _locallyToggledSpoilers[id];
            } else {
              // Stale in-memory sidecar server or unrelated patch response dropped nested spoiler state; preserve local toggle.
              if (localToggle.open) map[id] = true;
              else delete map[id];
            }
          } else if (!map[id] && localMap[id] === true) {
            // Preserve locally opened nested tune spoiler even if a stale server strips it from panelOpenSpoilers.
            map[id] = true;
          }
        });
        _spoilerHydratedFromServer = true;
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
            _locallyToggledSpoilers[id] = { open: Boolean(el.open), at: Date.now() };
            _lastAppliedSpoilersMap = domMap;
            saveBooleanMapToStorage(OPEN_SPOILERS_STORAGE_KEY, domMap, PANEL_SPOILER_IDS);
            updateState({ panelOpenSpoilers: domMap });
          }
          if (el.open) {
            refreshBlockVisibilityObserver();
            flushVisibleBlockRenders();
            maybeLoadMissingSectionsForBlock(id);
            if (!NESTED_TUNE_SPOILER_IDS.has(id)) {
              pollTelemetryTick();
            }
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
      'liteQuickCard',
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
          if (defId === 'liteQuickCard') {
            const anchorIdx = out.indexOf('smartComposerCard');
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

    function syncPinnedWindowBodyCompanions() {
      const windowBody = document.querySelector('.window-body');
      const banner = document.getElementById('smartProjectBanner');
      if (!windowBody || !banner || banner.parentElement !== windowBody) return;
      const doctorBox = document.getElementById('setupDoctorBox');
      if (doctorBox && doctorBox.parentElement === windowBody && banner.nextSibling !== doctorBox) {
        windowBody.insertBefore(doctorBox, banner.nextSibling);
      }
      const anchor = (doctorBox && doctorBox.parentElement === windowBody) ? doctorBox : banner;
      const fullGuardRail = document.getElementById('fullGuardRailWrap');
      if (fullGuardRail && fullGuardRail.parentElement === windowBody && anchor.nextSibling !== fullGuardRail) {
        windowBody.insertBefore(fullGuardRail, anchor.nextSibling);
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
      syncPinnedWindowBodyCompanions();
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
          if (defId === 'liteQuickCard') {
            const anchorIdx = out.indexOf('smartComposerCard');
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

    const DISMISSED_UPDATE_VERSION_KEY = 'tunnel_dismissed_update_ver_v1';
    let _latestPluginUpdateCheck = null;
    let _latestPluginUpdateStatus = null;
    let _pluginUpdateCheckInFlight = false;
    let _pluginUpdatePollTimer = null;
    let _pluginUpdateToastState = null;
    let _pluginUpdateToastTimer = null;
    let _pluginUpdateOverlayDismissed = false;

    function getDismissedUpdateVersion() {
      try {
        return String(localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY) || '').trim();
      } catch {
        return '';
      }
    }

    function setDismissedUpdateVersion(ver) {
      try {
        const clean = String(ver || '').trim();
        if (clean) localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, clean);
        else localStorage.removeItem(DISMISSED_UPDATE_VERSION_KEY);
      } catch {}
    }

    function clearPluginUpdatePollTimer() {
      if (_pluginUpdatePollTimer) {
        clearTimeout(_pluginUpdatePollTimer);
        _pluginUpdatePollTimer = null;
      }
    }

    function clearPluginUpdateToastTimer() {
      if (_pluginUpdateToastTimer) {
        clearTimeout(_pluginUpdateToastTimer);
        _pluginUpdateToastTimer = null;
      }
    }

    function renderPluginUpdateToast() {
      const toastEl = document.getElementById('pluginUpdateToast');
      const textEl = document.getElementById('pluginUpdateToastText');
      const closeBtn = document.getElementById('pluginUpdateToastCloseBtn');
      if (!toastEl) return;

      if (!_pluginUpdateToastState) {
        toastEl.style.display = 'none';
        toastEl.classList.remove('is-ok', 'is-info', 'is-error');
        return;
      }

      const kind = _pluginUpdateToastState.kind;
      toastEl.style.display = 'flex';
      toastEl.classList.toggle('is-info', kind === 'checking');
      toastEl.classList.toggle('is-ok', kind === 'up_to_date');
      toastEl.classList.toggle('is-error', kind === 'error');

      if (textEl) {
        if (kind === 'checking') {
          textEl.textContent = L('Проверка обновлений на GitHub…', 'Checking GitHub for updates…');
        } else if (kind === 'up_to_date') {
          textEl.textContent =
            L('Доступных обновлений нет', 'No updates available') +
            (_pluginUpdateToastState.version ? (' (v' + _pluginUpdateToastState.version + ')') : '');
        } else {
          textEl.textContent =
            L('Не удалось проверить обновления: ', 'Failed to check for updates: ') +
            (_pluginUpdateToastState.error || L('сеть недоступна', 'network error'));
        }
      }

      if (closeBtn) {
        closeBtn.style.display = kind === 'checking' ? 'none' : 'inline-flex';
        const closeLabel = L('Закрыть уведомление', 'Close notification');
        closeBtn.title = closeLabel;
        closeBtn.setAttribute('aria-label', closeLabel);
      }
    }

    function showPluginUpdateToast(state, autoHideMs) {
      clearPluginUpdateToastTimer();
      _pluginUpdateToastState = state || null;
      renderPluginUpdateToast();
      const ttl = Number(autoHideMs) || 0;
      if (_pluginUpdateToastState && ttl > 0) {
        _pluginUpdateToastTimer = setTimeout(() => {
          _pluginUpdateToastTimer = null;
          _pluginUpdateToastState = null;
          renderPluginUpdateToast();
        }, ttl);
      }
    }

    function hidePluginUpdateToast() {
      clearPluginUpdateToastTimer();
      _pluginUpdateToastState = null;
      renderPluginUpdateToast();
    }

    function schedulePluginUpdatePoll() {
      clearPluginUpdatePollTimer();
      if (document.visibilityState === 'hidden') return;
      _pluginUpdatePollTimer = setTimeout(() => {
        void pollPluginUpdateStatus();
      }, 350);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', () => {
        clearPluginUpdatePollTimer();
        clearPluginUpdateToastTimer();
      });
    }

    function closePluginUpdateOverlay() {
      _pluginUpdateOverlayDismissed = true;
      const overlay = document.getElementById('pluginUpdateOverlay');
      if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.remove('is-busy', 'is-done', 'is-error');
      }
      if (document.body) {
        document.body.classList.remove('is-plugin-updating');
      }
    }

    function renderPluginUpdateOverlay(st, info) {
      const overlay = document.getElementById('pluginUpdateOverlay');
      if (!overlay) return;

      const iconEl = document.getElementById('pluginUpdateOverlayIcon');
      const titleEl = document.getElementById('pluginUpdateOverlayTitle');
      const descEl = document.getElementById('pluginUpdateOverlayDesc');
      const progressWrap = document.getElementById('pluginUpdateProgressWrap');
      const progressFill = document.getElementById('pluginUpdateProgressFill');
      const stageEl = document.getElementById('pluginUpdateProgressStage');
      const pctEl = document.getElementById('pluginUpdateProgressPct');
      const errorEl = document.getElementById('pluginUpdateOverlayError');
      const actionsEl = document.getElementById('pluginUpdateOverlayActions');
      const retryBtn = document.getElementById('pluginUpdateOverlayRetryBtn');
      const closeBtn = document.getElementById('pluginUpdateOverlayCloseBtn');

      const isBusy = Boolean(st && st.active);
      const isDone = Boolean(!isBusy && st && st.phase === 'done' && st.needsRestart && !st.dismissed);
      const isErr = Boolean(!isBusy && st && st.phase === 'error' && st.error && !st.dismissed);

      if (isBusy) {
        _pluginUpdateOverlayDismissed = false;
      }

      if ((!isBusy && !isDone && !isErr) || (!isBusy && _pluginUpdateOverlayDismissed)) {
        overlay.style.display = 'none';
        overlay.classList.remove('is-busy', 'is-done', 'is-error');
        if (document.body) document.body.classList.remove('is-plugin-updating');
        return;
      }

      overlay.style.display = 'flex';
      overlay.classList.toggle('is-busy', isBusy);
      overlay.classList.toggle('is-done', isDone);
      overlay.classList.toggle('is-error', isErr);
      if (document.body) document.body.classList.add('is-plugin-updating');

      const verStr = String((st && st.targetVersion) || (info && info.latestVersion) || '').trim();
      const verSuffix = verStr ? (' v' + verStr) : '';
      const localizedStatusText = st
        ? (isRu() ? (st.statusTextRu || st.statusText) : (st.statusTextEn || st.statusText))
        : '';

      if (isBusy) {
        const rawPct = Number(st.percent || 0);
        const pct = Math.max(5, Math.min(100, Number.isFinite(rawPct) ? Math.round(rawPct) : 5));
        let stageLabel = L('Подготовка…', 'Preparing…');
        if (st.phase === 'downloading') {
          stageLabel = L('Скачивание с GitHub', 'Downloading from GitHub');
        } else if (st.phase === 'extracting') {
          stageLabel = L('Проверка и распаковка', 'Verifying & extracting');
        } else if (st.phase === 'installing') {
          stageLabel = L('Установка с сохранением настроек', 'Installing (preserving settings)');
        }
        if (iconEl) iconEl.textContent = '⬇';
        if (titleEl) titleEl.textContent = L('Идёт обновление', 'Updating') + verSuffix;
        if (descEl) descEl.textContent = localizedStatusText || L('Пожалуйста, не закрывайте окно…', 'Please keep this window open…');
        if (progressWrap) progressWrap.style.display = 'flex';
        if (progressFill) {
          progressFill.style.width = pct + '%';
          progressFill.style.setProperty('--fill-scale', (Math.max(0, Math.min(100, Number(pct) || 0)) / 100).toFixed(4));
        }
        if (stageEl) stageEl.textContent = stageLabel;
        if (pctEl) pctEl.textContent = pct + '%';
        if (errorEl) {
          errorEl.style.display = 'none';
          errorEl.textContent = '';
        }
        if (actionsEl) actionsEl.style.display = 'none';
        if (retryBtn) retryBtn.style.display = 'none';
      } else if (isDone) {
        if (iconEl) iconEl.textContent = '✓';
        if (titleEl) titleEl.textContent = L('Обновление' + verSuffix + ' установлено', 'Updated to' + verSuffix);
        if (descEl) {
          descEl.textContent = L(
            'Настройки сохранены. Перезагрузите Google Antigravity, чтобы применить изменения.',
            'Settings preserved. Restart Google Antigravity to apply changes.'
          );
        }
        if (progressWrap) progressWrap.style.display = 'flex';
        if (progressFill) {
          progressFill.style.width = '100%';
          progressFill.style.setProperty('--fill-scale', '1');
        }
        if (stageEl) stageEl.textContent = L('Готово · Требуется перезагрузка', 'Done · Restart required');
        if (pctEl) pctEl.textContent = '100%';
        if (errorEl) {
          errorEl.style.display = 'none';
          errorEl.textContent = '';
        }
        if (actionsEl) actionsEl.style.display = 'flex';
        if (retryBtn) retryBtn.style.display = 'none';
        if (closeBtn) closeBtn.textContent = L('Понятно', 'Got it');
      } else if (isErr) {
        if (iconEl) iconEl.textContent = '✕';
        if (titleEl) titleEl.textContent = L('Ошибка при установке обновления', 'Update installation failed');
        if (descEl) descEl.textContent = L('Настройки не затронуты.', 'Your settings were not affected.');
        if (progressWrap) progressWrap.style.display = 'none';
        if (errorEl) {
          errorEl.style.display = 'block';
          errorEl.textContent = localizedStatusText || String(st.error || L('Неизвестная ошибка', 'Unknown error'));
        }
        if (actionsEl) actionsEl.style.display = 'flex';
        if (retryBtn) {
          retryBtn.style.display = 'inline-flex';
          retryBtn.textContent = L('↻ Повторить', '↻ Retry');
        }
        if (closeBtn) closeBtn.textContent = L('Закрыть', 'Close');
      }
    }

    function renderPluginUpdateBanner(checkInfo, statusInfo) {
      if (checkInfo !== undefined) _latestPluginUpdateCheck = checkInfo;
      if (statusInfo !== undefined) _latestPluginUpdateStatus = statusInfo;

      const info = _latestPluginUpdateCheck;
      const st = _latestPluginUpdateStatus;
      const banner = document.getElementById('pluginUpdateBanner');
      const badgeEl = document.getElementById('pluginUpdateBadge');
      const textEl = document.getElementById('pluginUpdateBannerText');
      const linkEl = document.getElementById('pluginUpdateReleaseLink');
      const applyBtn = document.getElementById('pluginUpdateApplyBtn');
      const dismissBtn = document.getElementById('pluginUpdateDismissBtn');
      const hdrBtn = document.getElementById('checkPluginUpdateBtn');
      const hdrDot = document.getElementById('headerUpdateDot');

      const isBusy = Boolean(st && st.active);
      const isDone = Boolean(!isBusy && st && st.phase === 'done' && st.needsRestart && !st.dismissed);
      const isErr = Boolean(!isBusy && st && st.phase === 'error' && st.error && !st.dismissed);
      const hasUpdate = Boolean(info && info.ok && info.updateAvailable && info.latestVersion);
      const dismissedVer = getDismissedUpdateVersion();
      const isSuppressed = Boolean(hasUpdate && !isBusy && !isDone && !isErr && dismissedVer && dismissedVer === String(info.latestVersion));

      if (hdrDot) {
        hdrDot.style.display = (hasUpdate || isBusy) && !isDone ? 'inline-block' : 'none';
      }
      if (hdrBtn) {
        hdrBtn.classList.toggle('has-update', Boolean(hasUpdate && !isDone));
      }

      if (!banner) {
        renderPluginUpdateOverlay(st, info);
        renderPluginUpdateToast();
        return;
      }
      if (!isBusy && !isDone && !isErr && (!hasUpdate || isSuppressed)) {
        banner.style.display = 'none';
        banner.classList.remove('is-busy', 'is-done', 'is-error');
        renderPluginUpdateOverlay(st, info);
        renderPluginUpdateToast();
        return;
      }

      banner.style.display = 'flex';
      banner.classList.toggle('is-busy', isBusy);
      banner.classList.toggle('is-done', isDone);
      banner.classList.toggle('is-error', isErr);

      const localizedStatusText = st
        ? (isRu() ? (st.statusTextRu || st.statusText) : (st.statusTextEn || st.statusText))
        : '';

      if (isBusy) {
        if (badgeEl) badgeEl.textContent = L('Обновление', 'Updating');
        if (textEl) {
          const pct = Number(st.percent || 0);
          textEl.textContent = (localizedStatusText || L('Установка обновления...', 'Installing update...')) + (pct > 0 ? (' (' + pct + '%)') : '');
        }
        if (applyBtn) {
          applyBtn.style.display = 'inline-flex';
          applyBtn.disabled = true;
          applyBtn.textContent = L('Установка...', 'Installing...');
        }
        if (dismissBtn) dismissBtn.style.display = 'none';
      } else if (isDone) {
        if (badgeEl) badgeEl.textContent = L('Готово', 'Updated');
        if (textEl) {
          textEl.textContent = localizedStatusText || L('Обновлено ✓ Перезапустите Google Antigravity.', 'Updated ✓ Restart Google Antigravity.');
        }
        if (applyBtn) {
          applyBtn.style.display = 'none';
          applyBtn.disabled = false;
        }
        if (dismissBtn) dismissBtn.style.display = 'inline-flex';
      } else if (isErr) {
        if (badgeEl) badgeEl.textContent = L('Ошибка', 'Error');
        if (textEl) {
          textEl.textContent = localizedStatusText || String(st.error || L('Не удалось обновить расширение', 'Plugin update failed'));
        }
        if (applyBtn) {
          applyBtn.style.display = 'inline-flex';
          applyBtn.disabled = false;
          applyBtn.textContent = L('↻ Повторить', '↻ Retry');
        }
        if (dismissBtn) dismissBtn.style.display = 'inline-flex';
      } else {
        if (badgeEl) badgeEl.textContent = 'v' + String(info.latestVersion);
        if (textEl) {
          textEl.textContent =
            L('Доступна версия v', 'New version v') +
            String(info.latestVersion) +
            L(' (сейчас v', ' available (current v') +
            String(info.currentVersion || '?') +
            ')';
        }
        if (applyBtn) {
          applyBtn.style.display = 'inline-flex';
          applyBtn.disabled = false;
          applyBtn.textContent = L('Да, обновить', 'Yes, update');
          applyBtn.title = L('Скачать и установить обновление с GitHub с сохранением настроек', 'Download and install update from GitHub while preserving settings');
        }
        if (dismissBtn) {
          dismissBtn.style.display = 'inline-flex';
          dismissBtn.title = L('Позже', 'Later');
        }
      }

      if (linkEl) {
        const relUrl = info && typeof info.releaseUrl === 'string' ? info.releaseUrl.trim() : '';
        if (relUrl) {
          linkEl.href = relUrl;
          linkEl.style.display = 'inline-flex';
          linkEl.textContent = L('Что нового ↗', 'What\'s new ↗');
          if (info.releaseNotes) linkEl.title = String(info.releaseNotes);
        } else {
          linkEl.style.display = 'none';
        }
      }
      renderPluginUpdateOverlay(st, info);
      renderPluginUpdateToast();
    }

    async function pollPluginUpdateStatus() {
      try {
        const res = await panelFetch('/api/plugin/update-status', { method: 'GET' });
        if (!res || !res.ok) {
          clearPluginUpdatePollTimer();
          return;
        }
        const data = await res.json();
        const st = (data && data.status) || null;
        renderPluginUpdateBanner(undefined, st);
        if (st && st.active) {
          schedulePluginUpdatePoll();
        } else {
          clearPluginUpdatePollTimer();
          if (st && st.phase === 'done' && st.needsRestart) {
            flashStatus(L('Плагин обновлён · Перезапустите Google Antigravity ✓', 'Plugin updated · Restart Google Antigravity ✓'));
            void refreshAll({ silent: true });
          } else if (st && st.phase === 'error' && st.error) {
            flashStatus(L('Ошибка обновления: ', 'Update error: ') + st.error);
          }
        }
      } catch {
        clearPluginUpdatePollTimer();
      }
    }

    async function checkPluginUpdate(opts) {
      const o = (opts && typeof opts === 'object') ? opts : {};
      const force = Boolean(o.force);
      const silent = o.silent !== false;
      if (_pluginUpdateCheckInFlight) return null;
      _pluginUpdateCheckInFlight = true;
      const hdrBtn = document.getElementById('checkPluginUpdateBtn');
      if (!silent) {
        if (hdrBtn) hdrBtn.disabled = true;
        flashStatus(L('Проверка обновлений на GitHub...', 'Checking GitHub for updates...'));
        showPluginUpdateToast({ kind: 'checking' }, 0);
      }
      if (force) {
        setDismissedUpdateVersion('');
      }
      try {
        const url = force ? '/api/plugin/update-check?force=1' : '/api/plugin/update-check';
        const res = await panelFetch(url, { method: 'GET' });
        if (!res || !res.ok) {
          if (!silent) {
            flashStatus(L('Не удалось проверить обновления', 'Failed to check for updates'));
            showPluginUpdateToast({ kind: 'error', error: L('ошибка ответа сервера', 'server error') }, 6000);
          }
          return null;
        }
        const data = await res.json();
        if (!data || typeof data !== 'object') {
          if (!silent) {
            showPluginUpdateToast({ kind: 'error', error: L('некорректный ответ сервера', 'invalid server response') }, 6000);
          }
          return null;
        }
        renderPluginUpdateBanner(data, data.status || null);
        if (data.status && data.status.active) {
          schedulePluginUpdatePoll();
        }
        if (!silent) {
          if (data.ok === false) {
            flashStatus(L('Ошибка проверки обновлений: ', 'Update check failed: ') + (data.error || L('сеть недоступна', 'network error')));
            showPluginUpdateToast({ kind: 'error', error: data.error || L('сеть недоступна', 'network error') }, 6000);
          } else if (data.updateAvailable) {
            hidePluginUpdateToast();
            flashStatus(L('Доступно обновление v', 'Update available: v') + data.latestVersion + ' ✓');
          } else {
            showPluginUpdateToast({ kind: 'up_to_date', version: data.currentVersion || '' }, 4500);
            flashStatus(L('Доступных обновлений нет', 'No updates available') + (data.currentVersion ? (' (v' + data.currentVersion + ')') : '') + ' ✓');
          }
        }
        return data;
      } catch {
        if (!silent) {
          flashStatus(L('Ошибка связи при проверке обновлений', 'Connection error checking updates'));
          showPluginUpdateToast({ kind: 'error', error: L('ошибка связи', 'connection error') }, 6000);
        }
        return null;
      } finally {
        _pluginUpdateCheckInFlight = false;
        if (hdrBtn) hdrBtn.disabled = false;
      }
    }

    async function applyPluginUpdateFromPanel() {
      const info = _latestPluginUpdateCheck || {};
      setDismissedUpdateVersion('');
      _pluginUpdateOverlayDismissed = false;
      renderPluginUpdateBanner(undefined, {
        ok: true,
        active: true,
        phase: 'downloading',
        percent: 5,
        targetVersion: info.latestVersion || '',
        statusTextRu: 'Запуск загрузки обновления с GitHub…',
        statusTextEn: 'Starting plugin update from GitHub…',
        error: '',
        dismissed: false,
      });
      try {
        flashStatus(L('Запуск загрузки обновления с GitHub...', 'Starting plugin update from GitHub...'));
        const res = await panelFetch('/api/plugin/update-apply', {
          method: 'POST',
          body: JSON.stringify({
            downloadUrl: info.downloadUrl || '',
            targetVersion: info.latestVersion || '',
          }),
        });
        const data = await res.json();
        if (data && data.status) {
          renderPluginUpdateBanner(undefined, data.status);
          if (data.status.active) {
            schedulePluginUpdatePoll();
          } else {
            clearPluginUpdatePollTimer();
            if (data.status.phase === 'done' && data.status.needsRestart) {
              flashStatus(L('Плагин обновлён · Перезапустите Google Antigravity ✓', 'Plugin updated · Restart Google Antigravity ✓'));
              void refreshAll({ silent: true });
            } else if (data.error || data.status.error) {
              flashStatus(L('Ошибка обновления: ', 'Update error: ') + (data.error || data.status.error));
            }
          }
        } else if (!data || !data.ok) {
          const errMsg = (data && data.error) || L('сбой запуска обновления', 'failed to start update');
          renderPluginUpdateBanner(undefined, {
            ok: false,
            active: false,
            phase: 'error',
            targetVersion: info.latestVersion || '',
            error: errMsg,
            statusTextRu: errMsg,
            statusTextEn: errMsg,
            dismissed: false,
          });
          flashStatus(L('Ошибка обновления: ', 'Update error: ') + errMsg);
        }
      } catch {
        const netMsg = L('Ошибка связи при установке обновления', 'Connection error installing update');
        renderPluginUpdateBanner(undefined, {
          ok: false,
          active: false,
          phase: 'error',
          targetVersion: info.latestVersion || '',
          error: netMsg,
          statusTextRu: netMsg,
          statusTextEn: netMsg,
          dismissed: false,
        });
        flashStatus(netMsg);
      }
    }

    async function dismissPluginUpdateBanner() {
      clearPluginUpdatePollTimer();
      _pluginUpdateOverlayDismissed = true;
      if (_latestPluginUpdateCheck && _latestPluginUpdateCheck.latestVersion) {
        setDismissedUpdateVersion(_latestPluginUpdateCheck.latestVersion);
      }
      try {
        const res = await panelFetch('/api/plugin/update-dismiss', { method: 'POST', body: '{}' });
        const data = await res.json();
        _latestPluginUpdateStatus = (data && data.status) || { active: false, phase: 'idle', dismissed: true };
      } catch {
        _latestPluginUpdateStatus = { active: false, phase: 'idle', dismissed: true };
      }
      renderPluginUpdateBanner(undefined, _latestPluginUpdateStatus);
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

    // =========================================================================
    // Global Styled Tooltip Portal (replaces native browser [title] popups)
    // =========================================================================
    const _tooltipSavedTitles = typeof WeakMap === 'function' ? new WeakMap() : null;
    let _stashedTooltipEls = [];
    let _customTooltipInitialized = false;
    let _activeTooltipOwner = null;
    let _activeTooltipText = '';
    let _tooltipShowTimer = 0;
    let _tooltipLastHideAt = 0;
    let _tooltipPointerX = null;
    let _tooltipFocusShown = false;
    let _tooltipClickSuppressedOwner = null;
    let _tooltipEscapeDismissedOwner = null;
    let _tooltipMenuSuppressedTrigger = null;
    let _tooltipMutationObserver = null;

    function isCustomSelectMenuOpen() {
      if (typeof _openCustomSelectId !== 'undefined' && Boolean(_openCustomSelectId)) {
        return true;
      }
      const menu = typeof document !== 'undefined' ? document.getElementById('lgCustomSelectMenu') : null;
      return Boolean(menu && !menu.hidden && menu.classList && menu.classList.contains('is-open'));
    }

    function isProtectedBySuppressedMenu(el) {
      if (!_tooltipMenuSuppressedTrigger || !el || !isCustomSelectMenuOpen()) return false;
      if (el === _tooltipMenuSuppressedTrigger) return true;
      return typeof el.contains === 'function' && el.contains(_tooltipMenuSuppressedTrigger);
    }

    function isTooltipHostNode(node) {
      if (!node || typeof node.tagName !== 'string') return false;
      if (node.nodeType !== undefined && node.nodeType !== 1) return false;
      const tag = String(node.tagName).toUpperCase();
      return tag !== 'HTML' && tag !== 'BODY' && tag !== 'HEAD' && tag !== 'TITLE' && tag !== 'SCRIPT' && tag !== 'STYLE';
    }

    function isTooltipElementHovered(el) {
      if (!el || typeof el.matches !== 'function') return false;
      try {
        return Boolean(el.matches(':hover'));
      } catch {
        return false;
      }
    }

    function findTooltipOwner(startNode) {
      let cur = startNode;
      while (cur && typeof cur.tagName === 'string') {
        if (!isTooltipHostNode(cur)) break;
        if (_tooltipSavedTitles && _tooltipSavedTitles.has(cur)) return cur;
        if (typeof cur.getAttribute === 'function') {
          const t = cur.getAttribute('title');
          if (typeof t === 'string' && t.trim() !== '') return cur;
        }
        cur = cur.parentElement || null;
      }
      return null;
    }

    function stashTooltipTitle(el) {
      if (!el || typeof el.getAttribute !== 'function') return '';
      const live = el.getAttribute('title');
      if (_tooltipSavedTitles && _tooltipSavedTitles.has(el)) {
        if (typeof live === 'string' && live.trim() !== '') {
          _tooltipSavedTitles.set(el, live);
          if (typeof el.removeAttribute === 'function') el.removeAttribute('title');
          if (_stashedTooltipEls.indexOf(el) === -1) _stashedTooltipEls.push(el);
          return live;
        }
        return _tooltipSavedTitles.get(el) || '';
      }
      if (typeof live !== 'string' || !live.trim()) return '';
      if (_tooltipSavedTitles) {
        _tooltipSavedTitles.set(el, live);
        if (typeof el.removeAttribute === 'function') el.removeAttribute('title');
        if (_stashedTooltipEls.indexOf(el) === -1) _stashedTooltipEls.push(el);
      }
      return live;
    }

    function stashAncestorTooltipTitles(ownerEl) {
      let cur = ownerEl ? (ownerEl.parentElement || null) : null;
      while (cur && isTooltipHostNode(cur)) {
        stashTooltipTitle(cur);
        cur = cur.parentElement || null;
      }
    }

    function restoreTooltipTitle(el) {
      if (!el || !_tooltipSavedTitles || !_tooltipSavedTitles.has(el)) return;
      const orig = _tooltipSavedTitles.get(el);
      _tooltipSavedTitles.delete(el);
      if (typeof el.getAttribute === 'function' && typeof el.setAttribute === 'function') {
        const cur = el.getAttribute('title');
        if ((cur === null || cur === '') && orig) {
          el.setAttribute('title', orig);
        }
      }
    }

    function setTooltipTitle(el, text) {
      if (!el) return;
      const nextText = typeof text === 'string' ? text : String(text == null ? '' : text);
      if ((_tooltipSavedTitles && _tooltipSavedTitles.has(el)) || isProtectedBySuppressedMenu(el)) {
        if (nextText.trim()) {
          if (_tooltipSavedTitles) _tooltipSavedTitles.set(el, nextText);
          if (_stashedTooltipEls.indexOf(el) === -1) _stashedTooltipEls.push(el);
          if (typeof el.removeAttribute === 'function' && el.getAttribute('title') !== null) {
            el.removeAttribute('title');
          }
          if (el === _activeTooltipOwner && !isCustomSelectMenuOpen()) {
            _activeTooltipText = nextText;
            const tipEl = document.getElementById('agCustomTooltip');
            if (tipEl && !tipEl.hidden) {
              tipEl.textContent = nextText;
              positionCustomTooltip(tipEl, el, _tooltipPointerX);
            }
          }
        } else {
          if (_tooltipSavedTitles) _tooltipSavedTitles.delete(el);
          const idx = _stashedTooltipEls.indexOf(el);
          if (idx !== -1) _stashedTooltipEls.splice(idx, 1);
          if (typeof el.removeAttribute === 'function') el.removeAttribute('title');
          if (el === _activeTooltipOwner) hideCustomTooltip();
        }
        return;
      }
      if (typeof el.getAttribute === 'function' && typeof el.setAttribute === 'function') {
        if (nextText.trim()) {
          if (el.getAttribute('title') !== nextText) {
            el.setAttribute('title', nextText);
          }
        } else if (el.getAttribute('title') !== null) {
          el.removeAttribute('title');
        }
      }
    }

    function positionCustomTooltip(tipEl, ownerEl, anchorX) {
      if (!tipEl || !ownerEl || typeof ownerEl.getBoundingClientRect !== 'function') return false;
      const rect = ownerEl.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return false;

      const vw = Math.max(200, Number(window.innerWidth) || 800);
      const vh = Math.max(160, Number(window.innerHeight) || 600);
      tipEl.style.left = '0px';
      tipEl.style.top = '0px';
      tipEl.hidden = false;

      const tipW = Math.min(vw - 16, Math.max(48, Number(tipEl.offsetWidth) || 180));
      const tipH = Math.max(22, Number(tipEl.offsetHeight) || 28);
      const centerX = (rect.width > 260 && typeof anchorX === 'number' && anchorX >= rect.left && anchorX <= rect.right)
        ? anchorX
        : (rect.left + rect.width * 0.5);
      const left = Math.max(8, Math.min(centerX - tipW * 0.5, vw - tipW - 8));

      const gap = 7;
      const spaceBelow = vh - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const placeTop = spaceBelow < tipH + gap && spaceAbove > spaceBelow;
      let top;
      if (placeTop) {
        top = Math.max(8, rect.top - tipH - gap);
        tipEl.setAttribute('data-placement', 'top');
      } else {
        top = Math.min(vh - tipH - 8, rect.bottom + gap);
        tipEl.setAttribute('data-placement', 'bottom');
      }

      tipEl.style.left = Math.round(left) + 'px';
      tipEl.style.top = Math.round(top) + 'px';
      return true;
    }

    function showCustomTooltipNow(ownerEl, text) {
      const tipEl = document.getElementById('agCustomTooltip');
      if (!tipEl || !ownerEl || ownerEl.isConnected === false) return;
      tipEl.textContent = text;
      tipEl.classList.remove('is-visible');
      tipEl.setAttribute('aria-hidden', 'false');
      if (!positionCustomTooltip(tipEl, ownerEl, _tooltipPointerX)) {
        hideCustomTooltip();
        return;
      }
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(function () {
          if (_activeTooltipOwner === ownerEl && !tipEl.hidden) {
            tipEl.classList.add('is-visible');
          }
        });
      } else {
        tipEl.classList.add('is-visible');
      }
    }

    function dismissCustomTooltipVisual() {
      if (_tooltipShowTimer) {
        clearTimeout(_tooltipShowTimer);
        _tooltipShowTimer = 0;
      }
      _tooltipFocusShown = false;
      const tipEl = document.getElementById('agCustomTooltip');
      if (tipEl && !tipEl.hidden) {
        _tooltipLastHideAt = Date.now();
        tipEl.classList.remove('is-visible');
        tipEl.setAttribute('aria-hidden', 'true');
        tipEl.hidden = true;
      }
    }

    function hideCustomTooltip() {
      dismissCustomTooltipVisual();
      if (_tooltipMenuSuppressedTrigger && isCustomSelectMenuOpen()) {
        const remaining = [];
        while (_stashedTooltipEls.length > 0) {
          const el = _stashedTooltipEls.pop();
          if (isProtectedBySuppressedMenu(el)) {
            remaining.push(el);
          } else {
            restoreTooltipTitle(el);
          }
        }
        _stashedTooltipEls = remaining;
      } else {
        while (_stashedTooltipEls.length > 0) {
          restoreTooltipTitle(_stashedTooltipEls.pop());
        }
      }
      if (_activeTooltipOwner) {
        if (!isProtectedBySuppressedMenu(_activeTooltipOwner)) {
          restoreTooltipTitle(_activeTooltipOwner);
        }
        _activeTooltipOwner = null;
      }
      _activeTooltipText = '';
      _tooltipClickSuppressedOwner = null;
    }

    function suppressTooltipForOpenMenu(triggerEl) {
      hideCustomTooltip();
      _tooltipMenuSuppressedTrigger = triggerEl || null;
      if (!triggerEl) return;
      stashTooltipTitle(triggerEl);
      stashAncestorTooltipTitles(triggerEl);
    }

    function releaseTooltipForClosedMenu() {
      _tooltipMenuSuppressedTrigger = null;
      hideCustomTooltip();
    }

    function activateTooltipHover(owner) {
      if (!owner) return;
      if (isCustomSelectMenuOpen()) {
        hideCustomTooltip();
        return;
      }
      if (_activeTooltipOwner && _activeTooltipOwner.isConnected === false) {
        hideCustomTooltip();
      }
      if (owner === _activeTooltipOwner) {
        const refreshed = stashTooltipTitle(owner);
        if (refreshed && refreshed !== _activeTooltipText) {
          _activeTooltipText = refreshed;
          const tipEl = document.getElementById('agCustomTooltip');
          if (tipEl && !tipEl.hidden) {
            tipEl.textContent = refreshed;
            positionCustomTooltip(tipEl, owner, _tooltipPointerX);
          }
        }
        return;
      }
      _tooltipEscapeDismissedOwner = null;
      hideCustomTooltip();
      const text = stashTooltipTitle(owner);
      if (!text) return;
      stashAncestorTooltipTitles(owner);
      _activeTooltipOwner = owner;
      _activeTooltipText = text;
      const delay = (Date.now() - _tooltipLastHideAt < 220) ? 300 : 700;
      _tooltipShowTimer = setTimeout(function () {
        _tooltipShowTimer = 0;
        if (!isCustomSelectMenuOpen() && _activeTooltipOwner === owner && _tooltipClickSuppressedOwner !== owner) {
          showCustomTooltipNow(owner, _activeTooltipText || text);
        }
      }, delay);
    }

    function syncMutatedTooltipTitle(target) {
      if (!target || typeof target.getAttribute !== 'function') return;
      const live = target.getAttribute('title');
      if (typeof live !== 'string' || !live.trim()) return;
      const protectedByMenu = isProtectedBySuppressedMenu(target);
      const isTracked = target === _activeTooltipOwner || _stashedTooltipEls.indexOf(target) !== -1 || protectedByMenu;
      if (!isTracked) {
        if (!isCustomSelectMenuOpen() && !_activeTooltipOwner && target !== _tooltipEscapeDismissedOwner && isTooltipElementHovered(target)) {
          activateTooltipHover(target);
        }
        return;
      }
      if (_tooltipSavedTitles) {
        _tooltipSavedTitles.set(target, live);
        if (typeof target.removeAttribute === 'function') target.removeAttribute('title');
        if (_stashedTooltipEls.indexOf(target) === -1) _stashedTooltipEls.push(target);
      }
      if (!isCustomSelectMenuOpen() && target === _activeTooltipOwner) {
        _activeTooltipText = live;
        const tipEl = document.getElementById('agCustomTooltip');
        if (tipEl && !tipEl.hidden) {
          tipEl.textContent = live;
          positionCustomTooltip(tipEl, target, _tooltipPointerX);
        }
      }
    }

    function initCustomTooltipController() {
      if (_customTooltipInitialized) return;
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
      _customTooltipInitialized = true;

      if (typeof MutationObserver === 'function' && !_tooltipMutationObserver) {
        const obsRoot = document.body || document.documentElement;
        if (obsRoot) {
          try {
            _tooltipMutationObserver = new MutationObserver(function (mutations) {
              for (let i = 0; i < mutations.length; i++) {
                const m = mutations[i];
                if (m && m.type === 'attributes' && m.attributeName === 'title') {
                  syncMutatedTooltipTitle(m.target);
                }
              }
            });
            _tooltipMutationObserver.observe(obsRoot, { attributes: true, attributeFilter: ['title'], subtree: true });
          } catch {
            _tooltipMutationObserver = null;
          }
        }
      }

      document.addEventListener('mouseover', function (ev) {
        _tooltipPointerX = (ev && typeof ev.clientX === 'number') ? ev.clientX : null;
        if (isCustomSelectMenuOpen()) {
          hideCustomTooltip();
          return;
        }
        const owner = findTooltipOwner(ev ? ev.target : null);
        if (!owner) {
          if (_activeTooltipOwner) hideCustomTooltip();
          return;
        }
        if (owner === _tooltipEscapeDismissedOwner) _tooltipEscapeDismissedOwner = null;
        activateTooltipHover(owner);
      });

      document.addEventListener('mousemove', function (ev) {
        _tooltipPointerX = (ev && typeof ev.clientX === 'number') ? ev.clientX : null;
        if (isCustomSelectMenuOpen()) {
          if (_activeTooltipOwner) hideCustomTooltip();
          else dismissCustomTooltipVisual();
          return;
        }
        if (_activeTooltipOwner) {
          if (_activeTooltipOwner.isConnected === false) {
            hideCustomTooltip();
            return;
          }
          if (typeof _activeTooltipOwner.getAttribute === 'function' && _activeTooltipOwner.getAttribute('title')) {
            syncMutatedTooltipTitle(_activeTooltipOwner);
          }
          return;
        }
        const owner = findTooltipOwner(ev ? ev.target : null);
        if (owner && owner !== _tooltipEscapeDismissedOwner) {
          activateTooltipHover(owner);
        }
      });

      document.addEventListener('mouseout', function (ev) {
        const nextOwner = findTooltipOwner(ev ? ev.relatedTarget : null);
        if (_tooltipEscapeDismissedOwner && nextOwner !== _tooltipEscapeDismissedOwner) {
          _tooltipEscapeDismissedOwner = null;
        }
        if (isCustomSelectMenuOpen()) {
          hideCustomTooltip();
          return;
        }
        if (!_activeTooltipOwner) return;
        if (nextOwner === _activeTooltipOwner) return;
        hideCustomTooltip();
      });

      document.addEventListener('focusin', function (ev) {
        if (isCustomSelectMenuOpen()) {
          hideCustomTooltip();
          return;
        }
        const target = ev ? ev.target : null;
        let isFocusVisible = false;
        try {
          isFocusVisible = Boolean(target && typeof target.matches === 'function' && target.matches(':focus-visible'));
        } catch {}
        if (!isFocusVisible) return;
        const owner = findTooltipOwner(target);
        if (!owner || owner === _activeTooltipOwner) return;
        _tooltipEscapeDismissedOwner = null;
        hideCustomTooltip();
        const text = stashTooltipTitle(owner);
        if (!text) return;
        stashAncestorTooltipTitles(owner);
        _activeTooltipOwner = owner;
        _activeTooltipText = text;
        _tooltipFocusShown = true;
        _tooltipPointerX = null;
        showCustomTooltipNow(owner, text);
      });

      document.addEventListener('focusout', function () {
        if (_tooltipFocusShown) hideCustomTooltip();
      });

      // Keep title stashed until mouseout so clicking never exposes native tooltip under stationary cursor
      document.addEventListener('pointerdown', function () {
        if (_activeTooltipOwner) {
          _tooltipClickSuppressedOwner = _activeTooltipOwner;
        }
        dismissCustomTooltipVisual();
      }, true);

      document.addEventListener('keydown', function (ev) {
        if (!ev) return;
        if (ev.key === 'Escape') {
          _tooltipEscapeDismissedOwner = _activeTooltipOwner;
          hideCustomTooltip();
        } else if (ev.key === 'Enter' || ev.key === ' ') {
          hideCustomTooltip();
        }
      }, true);

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', hideCustomTooltip, true);
        window.addEventListener('resize', hideCustomTooltip);
        window.addEventListener('blur', hideCustomTooltip);
      }
    }

    initCustomTooltipController();

