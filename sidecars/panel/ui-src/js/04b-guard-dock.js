    // =========================================================================
    // Hybrid Guard Dock (Variant B tiles in Lite + Variant C 36px rail in Full)
    // =========================================================================
    const GUARD_TABS = ['bugs', 'shield', 'instincts', 'risks', 'env'];
    let _lastGuardPulse = null;
    let _gdActiveTab = { lite: null, full: null };
    let _gdAutoOpenedBugsLite = false;
    let _gdDismissedBugsSig = '';
    let _gdAuditBusy = false;
    let _gdOpenMenu = null;

    function gdEsc(str) {
      return typeof escapeHtml === 'function'
        ? escapeHtml(str)
        : String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function gdSeverityRank(sev) {
      if (sev === 'err') return 3;
      if (sev === 'warn') return 2;
      if (sev === 'info') return 1;
      return 0;
    }

    function gdComputeBugsSig() {
      const list = Array.isArray(_lastNormalizedSentinelFindings) ? _lastNormalizedSentinelFindings : [];
      const wtCount = (_latestWiretapFault ? 1 : 0);
      if (list.length === 0 && wtCount === 0) return '';
      return list.length + ':' + wtCount + ':' + list.slice(0, 3).map(function (f) {
        return (f.category || '') + '@' + (f.loc || '') + '@' + (f.desc || '').slice(0, 32);
      }).join('|');
    }

    function gdGetComputedBuckets() {
      const pulse = (_lastGuardPulse && typeof _lastGuardPulse === 'object') ? _lastGuardPulse : {};
      const liveSenList = Array.isArray(_lastNormalizedSentinelFindings) ? _lastNormalizedSentinelFindings : [];
      const liveCounts = (_lastSentinelAlertCounts && typeof _lastSentinelAlertCounts === 'object')
        ? _lastSentinelAlertCounts
        : { errs: 0, warns: 0, bugbot: 0 };
      const wiretapList = (lastPayloadCache && Array.isArray(lastPayloadCache.wiretapFaults))
        ? lastPayloadCache.wiretapFaults
        : (_latestWiretapFault ? [_latestWiretapFault] : []);

      const pulseBugs = pulse.bugs && typeof pulse.bugs === 'object' ? pulse.bugs : {};
      const senTotal = Math.max(
        liveSenList.length,
        Number(liveCounts.errs || 0) + Number(liveCounts.warns || 0) + Number(liveCounts.bugbot || 0),
        Number(pulseBugs.sentinelErrors || 0) + Number(pulseBugs.sentinelWarnings || 0) + Number(pulseBugs.bugBotCount || 0)
      );
      const wtCount = Math.max(wiretapList.length, Number(pulseBugs.wiretapCount || 0));
      const bugsCount = senTotal + wtCount;
      const bugsSev = (Number(liveCounts.errs || 0) > 0 || Number(liveCounts.bugbot || 0) > 0 || Number(pulseBugs.sentinelErrors || 0) > 0 || Number(pulseBugs.bugBotCount || 0) > 0 || wtCount > 0)
        ? 'err'
        : (bugsCount > 0 ? 'warn' : 'ok');

      const sh = pulse.shield && typeof pulse.shield === 'object'
        ? pulse.shield
        : { checked: false, score: 100, grade: 'A', count: 0, criticalHighCount: 0, severity: 'ok', findings: [] };

      const inst = pulse.instincts && typeof pulse.instincts === 'object'
        ? pulse.instincts
        : { total: 0, readyCount: 0, count: 0, severity: 'ok', items: [] };

      const rsk = pulse.risks && typeof pulse.risks === 'object'
        ? pulse.risks
        : { cbStatus: 'CLOSED', cbRepeats: 0, cbReason: '', pitfallsCount: 0, fragileCount: 0, count: 0, severity: 'ok', pitfalls: [], fragileFiles: [] };

      const env = pulse.env && typeof pulse.env === 'object'
        ? pulse.env
        : { count: 0, severity: 'ok', doctorCount: 0, doctorScore: 100, doctorIssues: [], gatesExists: false, gatesTotal: 0, gatesUnmetCount: 0, gatesItems: [], debtTotal: 0, debtNoTriggerCount: 0, debtItems: [] };

      return {
        bugs: {
          count: bugsCount,
          severity: bugsSev,
          sentinelList: liveSenList,
          wiretapList: wiretapList,
        },
        shield: sh,
        instincts: inst,
        risks: rsk,
        env: env,
      };
    }

    function gdFormatCount(n) {
      const v = Math.max(0, Number(n || 0));
      return v > 99 ? '99+' : String(v);
    }

    function gdApplyBadge(el, count, sev) {
      if (!el) return;
      const n = Math.max(0, Number(count || 0));
      if (n > 0) {
        const toneClass = sev === 'err' ? 'is-err' : (sev === 'info' ? 'is-info' : 'is-warn');
        el.className = el.className.replace(/\bis-(?:ok|err|warn|info)\b/g, '').trim() + ' ' + toneClass;
        el.textContent = gdFormatCount(n);
      } else {
        el.className = el.className.replace(/\bis-(?:ok|err|warn|info)\b/g, '').trim() + ' is-ok';
        el.textContent = '';
      }
    }

    function gdBuildTabTooltip(tab, buckets) {
      if (tab === 'bugs') {
        const b = buckets.bugs;
        return b.count > 0
          ? L('Баги и Дозор: находок — ' + b.count + '. Нажмите для списка и починки в 1 клик.', 'Bugs & Sentinel: ' + b.count + ' findings. Click to inspect and fix in 1 click.')
          : L('Баги и Дозор: чисто · контракты, BugBot и Wiretap без ошибок.', 'Bugs & Sentinel: clean · contracts, BugBot, and Wiretap clear.');
      }
      if (tab === 'shield') {
        const s = buckets.shield;
        return s.count > 0
          ? L('Щит (AgentShield): оценка ' + s.grade + ' (' + s.score + '/100) · замечаний: ' + s.count + '.', 'Shield (AgentShield): grade ' + s.grade + ' (' + s.score + '/100) · findings: ' + s.count + '.')
          : L('Щит (AgentShield): оценка ' + s.grade + ' (' + s.score + '/100) · секреты, MCP и хуки чисты.', 'Shield (AgentShield): grade ' + s.grade + ' (' + s.score + '/100) · secrets, MCP, and hooks clean.');
      }
      if (tab === 'instincts') {
        const i = buckets.instincts;
        if (i.readyCount > 0) {
          return L('Инстинкты проекта: готовы к созданию навыка — ' + i.readyCount + ' (всего ' + i.total + ').', 'Project Instincts: ready to promote — ' + i.readyCount + ' (total ' + i.total + ').');
        }
        return i.total > 0
          ? L('Инстинкты проекта: накоплено ' + i.total + ', пока набирают уверенность.', 'Project Instincts: ' + i.total + ' tracked, building confidence.')
          : L('Инстинкты проекта: повторяющиеся паттерны появятся здесь для превращения в навыки SKILL.md.', 'Project Instincts: recurring patterns will appear here for SKILL.md promotion.');
      }
      if (tab === 'risks') {
        const r = buckets.risks;
        return r.count > 0
          ? L('Риски: грабли — ' + r.pitfallsCount + ', хрупких файлов — ' + r.fragileCount + ', Circuit Breaker: ' + r.cbStatus + '.', 'Risks: pitfalls — ' + r.pitfallsCount + ', fragile files — ' + r.fragileCount + ', Circuit Breaker: ' + r.cbStatus + '.')
          : L('Риски: граблей и хрупких файлов нет · Circuit Breaker в норме (0/3).', 'Risks: no pitfalls or fragile files · Circuit Breaker normal (0/3).');
      }
      const e = buckets.env;
      return e.count > 0
        ? L('Среда: Доктор — ' + e.doctorCount + ', GATES.md — ' + e.gatesUnmetCount + ', техдолг — ' + e.debtNoTriggerCount + '.', 'Environment: Doctor — ' + e.doctorCount + ', GATES.md — ' + e.gatesUnmetCount + ', tech debt — ' + e.debtNoTriggerCount + '.')
        : L('Среда: Health-Doctor, GATES.md и техдолг shortcut: в норме.', 'Environment: Health-Doctor, GATES.md, and shortcut: debt clean.');
    }

    function syncFullGuardActivePill() {
      const container = document.getElementById('fullGuardButtons');
      const pill = document.getElementById('fullGuardActivePill');
      if (!container || !pill) return;
      const doctorBtn = document.getElementById('smartBannerDoctorBtn');
      const doctorActive = Boolean(doctorBtn && doctorBtn.classList.contains('is-active'));
      const activeBtn = doctorActive
        ? doctorBtn
        : (_gdActiveTab.full ? document.getElementById('gdFullBtn-' + _gdActiveTab.full) : null);
      if (!activeBtn || typeof activeBtn.offsetLeft !== 'number') {
        container.classList.remove('has-sliding-pill');
        pill.style.opacity = '0';
        return;
      }
      const w = activeBtn.offsetWidth || 0;
      const h = activeBtn.offsetHeight || 0;
      if (w <= 0 || h <= 0) {
        container.classList.remove('has-sliding-pill');
        pill.style.opacity = '0';
        return;
      }
      container.classList.add('has-sliding-pill');
      pill.style.width = w + 'px';
      pill.style.height = h + 'px';
      pill.style.transform = 'translate3d(' + activeBtn.offsetLeft + 'px, ' + activeBtn.offsetTop + 'px, 0)';
      pill.style.opacity = '1';
    }

    function renderGuardDock(guardPulse) {
      if (guardPulse && typeof guardPulse === 'object') {
        _lastGuardPulse = guardPulse;
      }
      const buckets = gdGetComputedBuckets();

      for (let i = 0; i < GUARD_TABS.length; i++) {
        const tab = GUARD_TABS[i];
        const info = buckets[tab];
        const count = Number(info.count || 0);
        const sev = info.severity || 'ok';
        const tip = gdBuildTabTooltip(tab, buckets);

        // Lite Variant B tile
        const tile = document.getElementById('gdLiteTile-' + tab);
        const tileBadge = document.getElementById('gdLiteBadge-' + tab);
        if (tile) {
          tile.classList.toggle('is-active', _gdActiveTab.lite === tab);
          tile.classList.toggle('is-err', count > 0 && sev === 'err');
          tile.classList.toggle('is-warn', count > 0 && sev === 'warn');
          tile.classList.toggle('is-info', count > 0 && sev === 'info');
          tile.setAttribute('aria-selected', _gdActiveTab.lite === tab ? 'true' : 'false');
          if (typeof setTooltipTitle === 'function') setTooltipTitle(tile, tip);
          else tile.title = tip;
        }
        gdApplyBadge(tileBadge, count, sev);

        // Full Variant C rail button
        const railBtn = document.getElementById('gdFullBtn-' + tab);
        const railBadge = document.getElementById('gdFullBadge-' + tab);
        if (railBtn) {
          railBtn.classList.toggle('is-active', _gdActiveTab.full === tab);
          railBtn.setAttribute('aria-selected', _gdActiveTab.full === tab ? 'true' : 'false');
          if (typeof setTooltipTitle === 'function') setTooltipTitle(railBtn, tip);
          else railBtn.title = tip;
        }
        gdApplyBadge(railBadge, count, sev);
      }

      syncFullGuardActivePill();
      syncGuardScanButtons();
      renderGuardDrawer('lite', arguments[1]);
      renderGuardDrawer('full', arguments[1]);
    }

    function syncGuardScanButtons() {
      const liteBtn = document.getElementById('btnLiteSentinelCheck');
      if (liteBtn) {
        liteBtn.disabled = _gdAuditBusy || _sentinelActionBusy;
        liteBtn.textContent = (_gdAuditBusy || _sentinelActionBusy)
          ? L('↻ Проверка…', '↻ Scanning…')
          : L('↻ Проверить всё', '↻ Check all');
      }
      const fullBtn = document.getElementById('btnFullGuardAuditAll');
      if (fullBtn) {
        fullBtn.disabled = _gdAuditBusy || _sentinelActionBusy;
        const fullLbl = document.getElementById('btnFullGuardAuditAllLabel');
        if (fullLbl) {
          fullLbl.textContent = (_gdAuditBusy || _sentinelActionBusy)
            ? L('…', '…')
            : L('Всё', 'All');
        }
      }
    }

    function syncGuardDockFromSentinel(normalizedFindings, counts) {
      const list = Array.isArray(normalizedFindings) ? normalizedFindings : [];
      const sig = gdComputeBugsSig();
      if (list.length > 0) {
        if (!_gdActiveTab.lite && sig !== _gdDismissedBugsSig) {
          _gdActiveTab.lite = 'bugs';
          _gdAutoOpenedBugsLite = true;
        }
      } else {
        _gdDismissedBugsSig = '';
        if (_gdActiveTab.lite === 'bugs' && _gdAutoOpenedBugsLite && !_latestWiretapFault) {
          _gdActiveTab.lite = null;
          _gdAutoOpenedBugsLite = false;
        }
      }
      renderGuardDock(null);
    }

    function closeAllGuardMenus() {
      _gdOpenMenu = null;
      ['lite', 'full'].forEach(function (surf) {
        const menu = document.getElementById(surf === 'lite' ? 'liteGuardMenu' : 'fullGuardMenu');
        const btn = document.getElementById(surf === 'lite' ? 'btnLiteGuardMenu' : 'btnFullGuardMenu');
        if (menu) {
          menu.classList.remove('is-open');
          if (typeof animateDisclosurePanel === 'function' && menu.style.display !== 'none') {
            const rect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : null;
            if (rect && rect.height > 0 && typeof menu.animate === 'function' && !(typeof uiPrefersReducedMotion === 'function' && uiPrefersReducedMotion())) {
              const seq = (menu._gdMenuSeq || 0) + 1;
              menu._gdMenuSeq = seq;
              try {
                const anim = menu.animate(
                  [{ opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }, { opacity: 0, transform: 'translate3d(0,-4px,0) scale(0.96)' }],
                  { duration: 130, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
                );
                anim.onfinish = function () {
                  if (menu._gdMenuSeq === seq && !menu.classList.contains('is-open')) menu.style.display = 'none';
                };
              } catch {
                menu.style.display = 'none';
              }
            } else {
              menu.style.display = 'none';
            }
          } else {
            menu.style.display = 'none';
          }
        }
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }

    function toggleGuardMenu(surface) {
      const surf = surface === 'full' ? 'full' : 'lite';
      const wasOpen = _gdOpenMenu === surf;
      closeAllGuardMenus();
      if (wasOpen) return;
      const menu = document.getElementById(surf === 'lite' ? 'liteGuardMenu' : 'fullGuardMenu');
      const btn = document.getElementById(surf === 'lite' ? 'btnLiteGuardMenu' : 'btnFullGuardMenu');
      if (!menu) return;
      _gdOpenMenu = surf;
      menu._gdMenuSeq = (menu._gdMenuSeq || 0) + 1;
      menu.style.display = 'flex';
      menu.classList.add('is-open');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    }

    function toggleGuardTab(spec) {
      const parts = String(spec || '').split(':');
      const surf = parts[0] === 'full' ? 'full' : 'lite';
      const tab = parts[1] || 'bugs';
      if (GUARD_TABS.indexOf(tab) === -1) return;
      closeAllGuardMenus();

      let renderOpts = null;
      if (_gdActiveTab[surf] === tab) {
        _gdActiveTab[surf] = null;
        if (surf === 'lite' && tab === 'bugs') {
          _gdAutoOpenedBugsLite = false;
          _gdDismissedBugsSig = gdComputeBugsSig();
        }
      } else {
        _gdActiveTab[surf] = tab;
        if (surf === 'full' && typeof closeSetupDoctor === 'function') {
          const docBox = document.getElementById('setupDoctorBox');
          const docH = (docBox && docBox.style.display !== 'none')
            ? (typeof uiMeasureLayoutHeight === 'function'
                ? uiMeasureLayoutHeight(docBox)
                : (docBox.getBoundingClientRect ? docBox.getBoundingClientRect().height : 0))
            : 0;
          if (docH > 0) renderOpts = { prevHeightOverride: docH };
          closeSetupDoctor({ immediate: true });
        }
        if (surf === 'lite' && tab === 'bugs') {
          _gdAutoOpenedBugsLite = false;
        }
      }
      renderGuardDock(null, renderOpts);
    }

    function closeGuardDrawer(surface, opts) {
      const surf = surface === 'full' ? 'full' : 'lite';
      if (surf === 'lite' && _gdActiveTab.lite === 'bugs') {
        _gdAutoOpenedBugsLite = false;
        _gdDismissedBugsSig = gdComputeBugsSig();
      }
      _gdActiveTab[surf] = null;
      renderGuardDock(null, opts);
    }

    function resetGuardDockTransientState() {
      _lastGuardPulse = null;
      _gdDismissedBugsSig = '';
      _gdAutoOpenedBugsLite = false;
      _gdActiveTab = { lite: null, full: null };
      closeAllGuardMenus();
      renderGuardDock(null);
    }

    function gdMakeActionBtn(label, action, arg, extraClass, titleText, promptAttr) {
      return '<button type="button" class="win-btn gd-mini-btn' + (extraClass ? (' ' + extraClass) : '') + '"' +
        ' data-action="' + gdEsc(action) + '"' +
        (arg !== undefined && arg !== null && arg !== '' ? (' data-arg="' + gdEsc(arg) + '"') : '') +
        (promptAttr ? (' data-prompt="' + gdEsc(promptAttr) + '"') : '') +
        (titleText ? (' title="' + gdEsc(titleText) + '"') : '') +
        '>' + gdEsc(label) + '</button>';
    }

    function gdBuildDrawerModel(tab, surf, buckets) {
      let title = '';
      let tone = 'ok';
      let primaryBtn = '';
      let extraBtn = '';
      const rows = [];

      if (tab === 'bugs') {
        const b = buckets.bugs;
        tone = b.severity;
        title = b.count > 0
          ? L('Баги и Дозор · находок: ' + b.count, 'Bugs & Sentinel · findings: ' + b.count)
          : L('Баги и Дозор · чисто', 'Bugs & Sentinel · clean');
        if (surf === 'full' && b.sentinelList.length > 0) {
          primaryBtn = gdMakeActionBtn(L('Исправить всё', 'Fix all'), 'fixLiteSentinelFindings', '', 'is-primary-err', L('Отправить все находки на исправление в отдельный чат', 'Send all findings to a separate chat to fix'));
        } else if (b.wiretapList.length > 0 && b.sentinelList.length === 0) {
          primaryBtn = gdMakeActionBtn(L('Очистить сбои', 'Clear faults'), 'clearWiretapFaults', '', '', L('Очистить журнал сбоев Wiretap', 'Clear Wiretap fault log'));
        } else if (b.count === 0) {
          primaryBtn = gdMakeActionBtn(L('Проверить', 'Scan'), 'runGuardAudit', 'bugs', '', L('Запустить проверку Фонового Дозора', 'Run Background Sentinel scan'));
        }
        if (surf === 'full') {
          extraBtn = gdMakeActionBtn(L('↓ Дозор', '↓ Sentinel'), 'jumpGuardFullSection', 'sentinelSectionCard', '', L('Перейти к полному разделу Фонового Дозора', 'Jump to full Background Sentinel section'));
          for (let i = 0; i < Math.min(4, b.sentinelList.length); i++) {
            const sf = b.sentinelList[i];
            const tagTone = sf.category === 'bugbot' ? 'tone-err' : 'tone-warn';
            const lineTxt = (sf.loc ? (sf.loc + ' — ') : '') + (sf.desc || '');
            rows.push(
              '<div class="gd-item-row">' +
                '<div class="gd-item-left"><span class="gd-item-tag ' + tagTone + '">' + gdEsc(sf.tagLabel || 'Дозор') + '</span><span class="gd-item-text" title="' + gdEsc(lineTxt) + '">' + gdEsc(lineTxt) + '</span></div>' +
                '<div class="gd-item-btns">' + gdMakeActionBtn('Fix', 'fixSentinelFindingNow', '', '', L('Исправить в отдельном чате', 'Fix in a separate chat'), sf.prompt) + '</div>' +
              '</div>'
            );
          }
        }
        for (let w = 0; w < Math.min(2, b.wiretapList.length); w++) {
          const wf = b.wiretapList[w];
          if (!wf) continue;
          const wLoc = wf.file ? (wf.file + (wf.line ? ':' + wf.line : '')) : (wf.source || 'runtime');
          const wTxt = '[' + wLoc + '] ' + (wf.summary || L('Сбой процесса', 'Runtime fault'));
          const wPrompt = L('Исправь ошибку выполнения в ' + wLoc + ': ' + (wf.summary || ''), 'Fix runtime fault in ' + wLoc + ': ' + (wf.summary || ''));
          rows.push(
            '<div class="gd-item-row">' +
              '<div class="gd-item-left"><span class="gd-item-tag tone-err">Wiretap</span><span class="gd-item-text" title="' + gdEsc(wTxt) + '">' + gdEsc(wTxt) + '</span></div>' +
              '<div class="gd-item-btns">' + gdMakeActionBtn('Fix', 'fixGuardItemInChat', '', '', L('Исправить ошибку в отдельном чате', 'Fix fault in separate chat'), wPrompt) + '</div>' +
            '</div>'
          );
        }
        if (b.count === 0) {
          rows.push('<div class="gd-empty-note">' + L('✓ Контракты, BugBot, SimHash-клоны и Wiretap без ошибок.', '✓ Contracts, BugBot, SimHash clones, and Wiretap are clean.') + '</div>');
        }
      } else if (tab === 'shield') {
        const s = buckets.shield;
        tone = s.severity;
        title = L('AgentShield · Оценка ' + s.grade + ' (' + s.score + '/100)', 'AgentShield · Grade ' + s.grade + ' (' + s.score + '/100)');
        primaryBtn = s.count > 0
          ? gdMakeActionBtn(L('Исправить всё', 'Fix all'), 'fixGuardAllShieldInChat', '', 'is-primary-err', L('Отправить замечания AgentShield на исправление в отдельный чат', 'Send AgentShield issues to a separate chat'))
          : gdMakeActionBtn(L('Сканировать', 'Scan'), 'runGuardAudit', 'shield', '', L('Повторно проверить MCP, хуки и SKILL.md', 'Rescan MCP, hooks, and SKILL.md'));
        if (surf === 'full') {
          extraBtn = gdMakeActionBtn(L('↓ Щит', '↓ Shield'), 'jumpGuardFullSection', 'expertGuardrailsCard', '', L('Перейти к разделу AgentShield', 'Jump to AgentShield section'));
        }
        const list = Array.isArray(s.findings) ? s.findings : [];
        if (list.length === 0) {
          rows.push('<div class="gd-empty-note">' + L('✓ Конфиги MCP, хуки и SKILL.md чисты — утечек и инъекций нет.', '✓ MCP configs, hooks, and SKILL.md are clean — no leaks or injections.') + '</div>');
        } else {
          for (let i = 0; i < Math.min(4, list.length); i++) {
            const f = list[i];
            const tCls = (f.severity === 'critical' || f.severity === 'high') ? 'tone-err' : 'tone-warn';
            const fTxt = (f.file ? (f.file + ' — ') : '') + (f.message || f.ruleId || '');
            const fPrompt = L(
              'Исправь замечание безопасности AgentShield (' + (f.ruleId || f.severity) + ') в ' + (f.file || 'конфиге проекта') + ': ' + (f.message || ''),
              'Fix AgentShield security finding (' + (f.ruleId || f.severity) + ') in ' + (f.file || 'project config') + ': ' + (f.message || '')
            );
            rows.push(
              '<div class="gd-item-row">' +
                '<div class="gd-item-left"><span class="gd-item-tag ' + tCls + '">' + gdEsc(String(f.severity || 'warn').toUpperCase()) + '</span><span class="gd-item-text" title="' + gdEsc(fTxt) + '">' + gdEsc(fTxt) + '</span></div>' +
                '<div class="gd-item-btns">' + gdMakeActionBtn('Fix', 'fixGuardItemInChat', '', '', L('Исправить замечание в отдельном чате', 'Fix finding in separate chat'), fPrompt) + '</div>' +
              '</div>'
            );
          }
        }
      } else if (tab === 'instincts') {
        const inst = buckets.instincts;
        tone = inst.readyCount > 0 ? 'info' : 'ok';
        title = inst.readyCount > 0
          ? L('Инстинкты · готовы к навыку: ' + inst.readyCount, 'Instincts · ready to promote: ' + inst.readyCount)
          : L('Инстинкты проекта · всего: ' + inst.total, 'Project Instincts · total: ' + inst.total);
        if (inst.readyCount > 0) {
          primaryBtn = gdMakeActionBtn(L('Создать все (' + inst.readyCount + ')', 'Create all (' + inst.readyCount + ')'), 'evolveAllInstinctsFromDock', '', 'is-primary-info', L('Превратить все готовые инстинкты в постоянные навыки SKILL.md в 1 клик', 'Promote all ready instincts into permanent SKILL.md skills in 1 click'));
        } else {
          primaryBtn = gdMakeActionBtn(L('Обновить', 'Refresh'), 'runGuardAudit', 'instincts', '', L('Обновить список накопленных инстинктов', 'Refresh learned project instincts'));
        }
        if (surf === 'full') {
          extraBtn = gdMakeActionBtn(L('↓ Все', '↓ All'), 'jumpGuardFullSection', 'projectInstinctsWrap', '', L('Перейти к полному списку инстинктов', 'Jump to full instincts list'));
        }
        const items = Array.isArray(inst.items) ? inst.items : [];
        if (items.length === 0) {
          rows.push('<div class="gd-empty-note">' + L('Пока нет накопленных инстинктов — они формируются автоматически из повторяющихся правок.', 'No project instincts yet — they emerge automatically from recurring workspace patterns.') + '</div>');
        } else {
          for (let i = 0; i < Math.min(5, items.length); i++) {
            const it = items[i];
            const tagTxt = it.confidencePct + '% · x' + it.evidenceCount;
            const tagCls = it.readyForPromotion ? 'tone-info' : '';
            const promoBtn = it.readyForPromotion
              ? gdMakeActionBtn(L('+ Навык', '+ Skill'), 'promoteInstinctFromDock', it.id, 'is-primary-info', L('Сохранить инстинкт как постоянный навык SKILL.md', 'Promote instinct to permanent SKILL.md'))
              : '';
            const delBtn = gdMakeActionBtn('✕', 'deleteInstinctFromDock', it.id, '', L('Удалить инстинкт из памяти проекта', 'Delete instinct'));
            rows.push(
              '<div class="gd-item-row">' +
                '<div class="gd-item-left"><span class="gd-item-tag ' + tagCls + '">' + gdEsc(tagTxt) + '</span><span class="gd-item-text" title="' + gdEsc(it.pattern) + '">' + gdEsc(it.pattern) + '</span></div>' +
                '<div class="gd-item-btns">' + promoBtn + delBtn + '</div>' +
              '</div>'
            );
          }
        }
      } else if (tab === 'risks') {
        const r = buckets.risks;
        tone = r.severity;
        title = L('Риски · Грабли: ' + r.pitfallsCount + ' · Хрупких: ' + r.fragileCount + ' · CB ' + r.cbRepeats + '/3', 'Risks · Pitfalls: ' + r.pitfallsCount + ' · Fragile: ' + r.fragileCount + ' · CB ' + r.cbRepeats + '/3');
        if (r.cbStatus !== 'CLOSED') {
          primaryBtn = gdMakeActionBtn(L('Сбросить CB', 'Reset CB'), 'resetCircuitFromDock', '', 'is-primary-err', L('Сбросить сработавший Circuit Breaker', 'Reset tripped Circuit Breaker'));
        } else if (r.pitfallsCount > 0) {
          primaryBtn = gdMakeActionBtn(L('Очистить грабли', 'Clear pitfalls'), 'clearPitfallsFromDock', '', '', L('Очистить реестр грабель проекта', 'Clear workspace pitfall ledger'));
        } else if (r.fragileCount > 0) {
          primaryBtn = gdMakeActionBtn(L('Сброс хрупк.', 'Reset fragile'), 'resetFragilityFromDock', '', '', L('Сбросить счётчики хрупких файлов', 'Reset workspace file fragility'));
        }
        if (surf === 'full') {
          extraBtn = gdMakeActionBtn(L('↓ Грабли', '↓ Risks'), 'jumpGuardFullSection', 'intelligenceBayesianCard', '', L('Перейти к барьерам сбоев и хрупкости', 'Jump to Fault Barriers & Fragility'));
        }
        if (r.cbStatus !== 'CLOSED') {
          rows.push(
            '<div class="gd-item-row">' +
              '<div class="gd-item-left"><span class="gd-item-tag tone-err">CB ' + gdEsc(r.cbStatus) + '</span><span class="gd-item-text" title="' + gdEsc(r.cbReason || '') + '">' + gdEsc(r.cbReason || L('Зафиксирован цикл повторных ошибок', 'Repeated error loop detected')) + '</span></div>' +
              '<div class="gd-item-btns">' + gdMakeActionBtn(L('Сброс', 'Reset'), 'resetCircuitFromDock', '', '', L('Вернуть автомат в норму (0/3)', 'Reset breaker to OK (0/3)')) + '</div>' +
            '</div>'
          );
        }
        const frags = Array.isArray(r.fragileFiles) ? r.fragileFiles : [];
        for (let i = 0; i < Math.min(3, frags.length); i++) {
          const ff = frags[i];
          const fTxt = ff.file + ' (' + ff.failures + '/' + ff.runs + ')';
          rows.push(
            '<div class="gd-item-row">' +
              '<div class="gd-item-left"><span class="gd-item-tag tone-warn">' + gdEsc(ff.reliabilityPercent + '%') + '</span><span class="gd-item-text" title="' + gdEsc(fTxt) + '">' + gdEsc(fTxt) + '</span></div>' +
              '<div class="gd-item-btns">' + gdMakeActionBtn(L('Карта', 'Map'), 'openFragileInGraph', ff.file, '', L('Показать хрупкий файл и его зависимости на Карте проекта', 'Inspect fragile file in Project Map')) + '</div>' +
            '</div>'
          );
        }
        const pits = Array.isArray(r.pitfalls) ? r.pitfalls : [];
        for (let j = 0; j < Math.min(3, pits.length); j++) {
          const pf = pits[j];
          const pTxt = (pf.file ? ('[' + pf.file + '] ') : '') + (pf.lesson || '');
          rows.push(
            '<div class="gd-item-row">' +
              '<div class="gd-item-left"><span class="gd-item-tag tone-warn">' + L('Грабли', 'Pitfall') + '</span><span class="gd-item-text" title="' + gdEsc(pTxt) + '">' + gdEsc(pTxt) + '</span></div>' +
            '</div>'
          );
        }
        if (rows.length === 0) {
          rows.push('<div class="gd-empty-note">' + L('✓ Граблей и хрупких файлов нет · Circuit Breaker замкнут (0/3).', '✓ No pitfalls or fragile files · Circuit Breaker closed (0/3).') + '</div>');
        }
      } else {
        const e = buckets.env;
        tone = e.severity;
        title = L('Среда · Доктор ' + e.doctorScore + '/100 · GATES: ' + e.gatesUnmetCount + ' · Долг: ' + e.debtNoTriggerCount, 'Env · Doctor ' + e.doctorScore + '/100 · GATES: ' + e.gatesUnmetCount + ' · Debt: ' + e.debtNoTriggerCount);
        if (e.doctorCount > 0) {
          primaryBtn = gdMakeActionBtn(L('Починить всё', 'Fix all'), 'runHealthDoctorFixFromDock', 'fix_all', 'is-primary-err', L('Автоматически исправить найденные проблемы среды (Health-Doctor)', 'Auto-fix runtime environment issues (Health-Doctor)'));
        } else if (!e.gatesExists) {
          primaryBtn = gdMakeActionBtn(L('+ GATES.md', '+ GATES.md'), 'initGatesFromDock', '', '', L('Создать шаблон обязательных проверок GATES.md', 'Create GATES.md acceptance checklist'));
        } else {
          primaryBtn = gdMakeActionBtn(L('Проверить', 'Check'), 'runGuardAudit', 'env', '', L('Перепроверить Health-Doctor, GATES.md и техдолг', 'Recheck Health-Doctor, GATES.md, and tech debt'));
        }
        const docList = Array.isArray(e.doctorIssues) ? e.doctorIssues : [];
        for (let i = 0; i < Math.min(3, docList.length); i++) {
          const di = docList[i];
          const dTxt = isRu() ? (di.titleRu || di.titleEn) : (di.titleEn || di.titleRu);
          const fixBtn = (di.canAutoFix && di.fixAction)
            ? gdMakeActionBtn(L('Починить', 'Fix'), 'runHealthDoctorFixFromDock', di.fixAction, '', L('Авто-исправление в 1 клик', '1-click auto-fix'))
            : '';
          rows.push(
            '<div class="gd-item-row">' +
              '<div class="gd-item-left"><span class="gd-item-tag ' + (di.severity === 'high' ? 'tone-err' : 'tone-warn') + '">' + L('Доктор', 'Doctor') + '</span><span class="gd-item-text" title="' + gdEsc(dTxt) + '">' + gdEsc(dTxt) + '</span></div>' +
              '<div class="gd-item-btns">' + fixBtn + '</div>' +
            '</div>'
          );
        }
        const gateList = Array.isArray(e.gatesItems) ? e.gatesItems : [];
        for (let g = 0; g < Math.min(2, gateList.length); g++) {
          const gt = gateList[g] && gateList[g].text ? gateList[g].text : '';
          if (!gt) continue;
          rows.push(
            '<div class="gd-item-row">' +
              '<div class="gd-item-left"><span class="gd-item-tag tone-warn">GATES</span><span class="gd-item-text" title="' + gdEsc(gt) + '">' + gdEsc(gt) + '</span></div>' +
            '</div>'
          );
        }
        const debtList = Array.isArray(e.debtItems) ? e.debtItems : [];
        for (let d = 0; d < Math.min(2, debtList.length); d++) {
          const dm = debtList[d];
          const dmTxt = (dm.file ? (dm.file + (dm.line ? ':L' + dm.line : '') + ' — ') : '') + (dm.ceiling || 'shortcut:');
          const dmPrompt = L('Разбери и закрой метку техдолга shortcut: в ' + dmTxt, 'Resolve shortcut: tech debt marker in ' + dmTxt);
          rows.push(
            '<div class="gd-item-row">' +
              '<div class="gd-item-left"><span class="gd-item-tag ' + (dm.rotRisk ? 'tone-warn' : 'tone-ok') + '">' + L('Долг', 'Debt') + '</span><span class="gd-item-text" title="' + gdEsc(dmTxt) + '">' + gdEsc(dmTxt) + '</span></div>' +
              '<div class="gd-item-btns">' + gdMakeActionBtn('Fix', 'fixGuardItemInChat', '', '', L('Отправить на рефакторинг в отдельный чат', 'Send to separate chat to refactor'), dmPrompt) + '</div>' +
            '</div>'
          );
        }
        if (rows.length === 0) {
          rows.push('<div class="gd-empty-note">' + L('✓ Службы RAM/GPU, GATES.md и техдолг shortcut: в порядке.', '✓ RAM/GPU runtime, GATES.md, and shortcut: tech debt are clean.') + '</div>');
        }
      }

      return { title: title, tone: tone, primaryBtn: primaryBtn, extraBtn: extraBtn, rows: rows };
    }

    function renderGuardDrawer(surface, opts) {
      const surf = surface === 'full' ? 'full' : 'lite';
      const activeTab = _gdActiveTab[surf];
      const drawerEl = document.getElementById(surf === 'lite' ? 'liteGuardDrawer' : 'fullGuardDrawer');
      const headEl = document.getElementById(surf === 'lite' ? 'liteGuardDrawerHead' : 'fullGuardDrawerHead');
      const bodyEl = document.getElementById(surf === 'lite' ? 'liteGuardDrawerBody' : 'fullGuardDrawerBody');
      if (!drawerEl || !headEl || !bodyEl) return;

      const liteSum = surf === 'lite' ? document.getElementById('liteSentinelSummary') : null;
      const liteFind = surf === 'lite' ? document.getElementById('liteSentinelFindings') : null;

      if (!activeTab) {
        drawerEl.dataset.renderedTab = '';
        if (liteSum) liteSum.style.display = 'none';
        if (opts && opts.immediate) {
          if (typeof cancelDisclosureAnimation === 'function') cancelDisclosureAnimation(drawerEl);
          drawerEl.style.display = 'none';
          return;
        }
        if (typeof animateDisclosurePanel === 'function') {
          animateDisclosurePanel(drawerEl, false, { duration: 200 });
        } else {
          drawerEl.style.display = 'none';
        }
        return;
      }

      const wasOpen = drawerEl.style.display !== 'none';
      const prevTab = drawerEl.dataset.renderedTab || '';
      const prevH = wasOpen
        ? (typeof uiMeasureLayoutHeight === 'function'
            ? uiMeasureLayoutHeight(drawerEl)
            : (drawerEl.getBoundingClientRect ? drawerEl.getBoundingClientRect().height : 0))
        : 0;
      const overridePrevH = opts && Number(opts.prevHeightOverride) > 0 ? Number(opts.prevHeightOverride) : 0;
      const effectivePrevH = prevH > 0 ? prevH : overridePrevH;
      const isTabSwitch = Boolean(wasOpen && prevTab && prevTab !== activeTab);

      const buckets = gdGetComputedBuckets();
      const model = gdBuildDrawerModel(activeTab, surf, buckets);
      drawerEl.className = 'gd-drawer ' + (surf === 'lite' ? 'gd-lite-drawer' : 'gd-full-drawer') + ' tone-' + model.tone;
      drawerEl.dataset.renderedTab = activeTab;

      headEl.innerHTML =
        '<span class="gd-drawer-title" title="' + gdEsc(model.title) + '">' + gdEsc(model.title) + '</span>' +
        '<div class="gd-drawer-acts">' +
          model.primaryBtn +
          model.extraBtn +
          '<button type="button" class="win-btn gd-mini-btn" data-action="closeGuardDrawer" data-arg="' + surf + '" aria-label="' + L('Закрыть карман', 'Close drawer') + '" title="' + L('Свернуть карман', 'Collapse drawer') + '">✕</button>' +
        '</div>';

      if (surf === 'lite') {
        const showSenNodes = activeTab === 'bugs';
        if (liteSum) liteSum.style.display = showSenNodes ? 'block' : 'none';
        if (liteFind) {
          const hasSenItems = Array.isArray(_lastNormalizedSentinelFindings) && _lastNormalizedSentinelFindings.length > 0;
          liteFind.style.display = (showSenNodes && hasSenItems) ? 'flex' : 'none';
        }
        // In lite bugs tab, skip empty-note if Sentinel findings are already displayed above
        const skipEmptyForSen = showSenNodes && Array.isArray(_lastNormalizedSentinelFindings) && _lastNormalizedSentinelFindings.length > 0 && buckets.bugs.wiretapList.length === 0;
        bodyEl.innerHTML = skipEmptyForSen ? '' : model.rows.join('');
      } else {
        bodyEl.innerHTML = model.rows.join('');
      }

      if (typeof animateDisclosurePanel === 'function') {
        animateDisclosurePanel(drawerEl, true, {
          display: 'block',
          duration: 230,
          prevHeight: effectivePrevH > 0 ? effectivePrevH : undefined
        });
        if (isTabSwitch && typeof bodyEl.animate === 'function' && !(typeof uiPrefersReducedMotion === 'function' && uiPrefersReducedMotion())) {
          const prevIdx = GUARD_TABS.indexOf(prevTab);
          const nextIdx = GUARD_TABS.indexOf(activeTab);
          const dir = prevIdx >= 0 && nextIdx >= 0 && nextIdx < prevIdx ? -1 : 1;
          try {
            bodyEl.animate(
              [
                { opacity: 0.3, transform: 'translate3d(' + (dir * 10) + 'px, 0, 0)' },
                { opacity: 1, transform: 'translate3d(0, 0, 0)' }
              ],
              { duration: 170, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
            );
          } catch {}
        }
      } else {
        drawerEl.style.display = 'block';
      }
      if (typeof syncFullLeftRailStickyOffset === 'function') {
        syncFullLeftRailStickyOffset();
      }
    }

    async function runGuardAudit(scope) {
      if (_gdAuditBusy) return;
      const targetScope = (typeof scope === 'string' && scope.trim()) ? scope.trim().toLowerCase() : 'all';
      closeAllGuardMenus();
      _gdAuditBusy = true;
      syncGuardScanButtons();
      flashStatus(targetScope === 'all'
        ? L('Запускаем комплексную проверку защиты (0 тк)…', 'Running full local guard audit (0 tok)…')
        : L('Запускаем проверку контура: ' + targetScope + '…', 'Running guard check: ' + targetScope + '…'));
      try {
        const res = await panelFetch('/api/guard-audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: targetScope }),
        });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || L('Ошибка комплексной проверки', 'Guard audit failed'));
        }
        if (data.sentinel && typeof renderSentinelStatus === 'function') {
          if (lastPayloadCache) lastPayloadCache.sentinel = data.sentinel;
          renderSentinelStatus(data.sentinel, currentState);
        }
        if (data.wiretapFaults !== undefined && typeof renderWiretapAndQuota === 'function') {
          if (lastPayloadCache) lastPayloadCache.wiretapFaults = data.wiretapFaults;
          renderWiretapAndQuota(data.wiretapFaults, lastPayloadCache ? lastPayloadCache.quotaPacer : null);
        }
        if (data.guardPulse) {
          if (lastPayloadCache) lastPayloadCache.guardPulse = data.guardPulse;
          _lastGuardPulse = data.guardPulse;
          if (targetScope !== 'all' && GUARD_TABS.indexOf(targetScope) >= 0) {
            const isLiteNow = document.body && document.body.getAttribute('data-panel-view') === 'lite';
            _gdActiveTab[isLiteNow ? 'lite' : 'full'] = targetScope;
          }
          renderGuardDock(data.guardPulse);
        }
        flashStatus(L('Проверка защиты завершена ✓', 'Guard audit completed ✓'));
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка проверки защиты!', 'Guard audit error!'));
      } finally {
        _gdAuditBusy = false;
        syncGuardScanButtons();
      }
    }

    async function refreshGuardPulseSilent(force) {
      try {
        const res = await panelFetch('/api/guard-pulse' + (force ? '?force=1' : ''), { method: 'GET' });
        const data = await res.json();
        if (res && res.ok && data && data.ok && data.guardPulse) {
          if (lastPayloadCache) lastPayloadCache.guardPulse = data.guardPulse;
          renderGuardDock(data.guardPulse);
        }
      } catch {}
    }

    async function evolveAllInstinctsFromDock() {
      try {
        flashStatus(L('Создаём навыки из готовых инстинктов…', 'Promoting ready instincts to skills…'));
        const res = await panelFetch('/api/instincts/evolve-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || L('Ошибка создания навыков', 'Evolution failed'));
        }
        if (data.items && typeof renderProjectInstinctsList === 'function') {
          renderProjectInstinctsList(data.items);
        }
        if (data.guardPulse) {
          if (lastPayloadCache) lastPayloadCache.guardPulse = data.guardPulse;
          renderGuardDock(data.guardPulse);
        } else {
          await refreshGuardPulseSilent(true);
        }
        flashStatus(L('Создано навыков из инстинктов: ' + Number(data.promotedCount || 0) + ' ✓', 'Skills promoted from instincts: ' + Number(data.promotedCount || 0) + ' ✓'));
        if (typeof refreshAll === 'function') void refreshAll({ silent: true });
      } catch (err) {
        flashStatus((err && err.message) || L('Не удалось создать навыки из инстинктов', 'Failed to promote ready instincts'));
      }
    }

    async function promoteInstinctFromDock(instinctId) {
      if (!instinctId) return;
      if (typeof promoteInstinct === 'function') {
        await promoteInstinct(instinctId);
      }
      await refreshGuardPulseSilent(true);
    }

    async function deleteInstinctFromDock(instinctId) {
      if (!instinctId) return;
      if (typeof deleteInstinct === 'function') {
        await deleteInstinct(instinctId);
      }
      await refreshGuardPulseSilent(true);
    }

    function fixGuardItemInChat(promptText) {
      const clean = String(promptText || '').trim();
      if (!clean) return;
      if (typeof fixSentinelFindingNow === 'function') {
        fixSentinelFindingNow(clean);
      } else if (typeof applyComposerChip === 'function') {
        applyComposerChip(clean);
      }
    }

    function fixGuardAllShieldInChat() {
      const sh = (_lastGuardPulse && _lastGuardPulse.shield) || {};
      const list = Array.isArray(sh.findings) ? sh.findings : [];
      if (list.length === 0) return;
      const lines = list.slice(0, 6).map(function (f, idx) {
        return (idx + 1) + '. [' + String(f.severity || 'warn').toUpperCase() + ' · ' + (f.ruleId || '') + '] ' + (f.file || '') + ' — ' + (f.message || '');
      });
      const prompt = isRu()
        ? ('Проверь и устрани замечания безопасности AgentShield в проекте:\n' + lines.join('\n'))
        : ('Inspect and fix these AgentShield security findings in the workspace:\n' + lines.join('\n'));
      fixGuardItemInChat(prompt);
    }

    function sendDeepStressAuditToChat() {
      closeAllGuardMenus();
      const prompt = isRu()
        ? 'Проведи глубокий стресс-аудит безопасности, гонок, утечек и контрактов проекта (deep-stress-auditor) и выдай приоритетный список исправлений.'
        : 'Run a deep stress audit (deep-stress-auditor) covering security, concurrency, leaks, and API contracts, and list prioritized fixes.';
      fixGuardItemInChat(prompt);
    }

    async function runHealthDoctorFixFromDock(fixAction) {
      if (typeof runHealthDoctorFix === 'function') {
        await runHealthDoctorFix(fixAction || 'fix_all');
      } else {
        try {
          await panelFetch('/api/health-doctor/fix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fixAction: fixAction || 'fix_all' }),
          });
        } catch {}
      }
      await refreshGuardPulseSilent(true);
    }

    async function clearPitfallsFromDock() {
      if (typeof clearPitfalls === 'function') {
        await clearPitfalls();
      }
      await refreshGuardPulseSilent(true);
    }

    async function resetFragilityFromDock() {
      if (typeof resetWorkspaceFragility === 'function') {
        await resetWorkspaceFragility();
      }
      await refreshGuardPulseSilent(true);
    }

    async function resetCircuitFromDock() {
      if (typeof resetCircuitBreaker === 'function') {
        await resetCircuitBreaker();
      }
      await refreshGuardPulseSilent(true);
    }

    async function initGatesFromDock() {
      if (typeof initGatesMd === 'function') {
        await initGatesMd();
      }
      await refreshGuardPulseSilent(true);
    }

    function jumpGuardFullSection(targetId) {
      if (!targetId) return;
      if (typeof jumpToPanelSection === 'function') {
        jumpToPanelSection(targetId);
        return;
      }
      const el = document.getElementById(targetId);
      if (!el) return;
      const spoiler = el.closest ? el.closest('details') : null;
      if (spoiler && !spoiler.open) {
        spoiler.open = true;
      }
      if (el.classList && el.classList.contains('is-collapsed') && typeof togglePanelCardCollapse === 'function') {
        togglePanelCardCollapse(targetId);
      }
      if (typeof flushVisibleBlockRenders === 'function') flushVisibleBlockRenders();
      if (typeof maybeLoadMissingSectionsForBlock === 'function') maybeLoadMissingSectionsForBlock(targetId);
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    function openFragileInGraph(filePath) {
      if (typeof openProjectGraphModal === 'function') {
        const cleanFocus = typeof filePath === 'string'
          ? filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
          : '';
        void openProjectGraphModal(cleanFocus ? { focusFile: cleanFocus } : undefined);
      }
    }

    document.addEventListener('click', function (ev) {
      if (!_gdOpenMenu) return;
      const wrap = ev.target && ev.target.closest ? ev.target.closest('[data-gd-menu-wrap]') : null;
      if (!wrap) closeAllGuardMenus();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && _gdOpenMenu) {
        closeAllGuardMenus();
      }
    });
