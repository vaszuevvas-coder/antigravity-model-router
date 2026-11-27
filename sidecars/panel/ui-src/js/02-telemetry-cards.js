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
      return n.toLocaleString(isRu() ? 'ru-RU' : 'en-US');
    }

    function formatK(num) {
      const n = Number(num || 0);
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      if (n >= 1000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
      return String(Math.round(n));
    }

    function getSwarmModeLabel(modeKey) {
      const map = {
        auto_xl: L('Авто XL', 'Auto XL'),
        aggressive_l: L('Командный L+', 'Team L+'),
        auto_all: L('Авто все', 'Auto All'),
        always_ask: L('Спрашивать', 'Ask'),
        manual_only: L('По /swarm', 'On /swarm'),
        off: L('Рой выкл', 'Swarm Off')
      };
      return map[modeKey] || L('Авто XL', 'Auto XL');
    }

    function getSwarmTierHint(tierKey) {
      const map = {
        hydrogen_auto: L(
          'авторы правок автоматически сядут на быстрый Gemini 4 Hydrogen в ветках share',
          'workers automatically code on fast Gemini 4 Hydrogen in share workspaces'
        ),
        neon_auto: L(
          'авторы правок будут работать на мощной кодинг-модели Gemini 4 Neon в ветках share',
          'workers code on Gemini 4 Neon in share workspaces'
        ),
        argon_auto: L(
          'авторы правок будут работать на сбалансированном Gemini 4 Argon в ветках share',
          'workers code on balanced Gemini 4 Argon in share workspaces'
        ),
        carbon_auto: L(
          'авторы правок будут работать на старшем архитекторе Gemini 4 Carbon в ветках share',
          'workers code on flagship architect Gemini 4 Carbon in share workspaces'
        ),
        inherit: L(
          'все воркеры Роя будут наследовать выбранную в селекторе модель',
          'all Swarm workers inherit the currently selected chat model'
        )
      };
      return map[tierKey] || map.hydrogen_auto;
    }

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
      const tierHint = getSwarmTierHint(tierKey);
      const isSwarmActive = Boolean(sw && sw.active && sw.totalSpawned > 0);

      if (isSwarmActive) {
        dotEl.className = 'swarm-dot active';
        const titlePart = sw.title ? (L('«', '"') + sw.title + L('»', '"')) : L('Активный Рой', 'Active Swarm');
        headEl.textContent = titlePart + L(' · В строю: ', ' · Active: ') + sw.activeWorkers + L(' из ', ' of ') + sw.totalSpawned;
        badgeEl.className = 'swarm-pill';
        const neonPart = (sw.neonWorkers > 0) ? (' · Neon: ' + sw.neonWorkers) : '';
        badgeEl.textContent = 'Hydrogen: ' + (sw.hydrogenWorkers || 0) + neonPart + L(' · Проверок: ', ' · Verifiers: ') + (sw.verifiers || 0);

        const extras = [];
        extras.push(L('Авторов: ', 'Authors: ') + (sw.authors || 0));
        if (sw.verifiers > 0) extras.push(L('Ревизоров: ', 'Verifiers: ') + sw.verifiers);
        if (sw.supportWorkers > 0) extras.push(L('Монитор/Обзор: ', 'Monitor/Overview: ') + sw.supportWorkers);
        if (sw.channelsCount > 0) extras.push(L('Каналов: #', 'Channels: #') + sw.channelsCount);
        if (sw.modelSwitches > 0) extras.push(L('Смен модели (квота): ', 'Model switches (quota): ') + sw.modelSwitches);
        if (sw.boardPosts > 0) extras.push(L('Сообщений на доске: ', 'Board posts: ') + sw.boardPosts);
        detailsEl.textContent = extras.join(' · ');

        const aliveMembers = Array.isArray(sw.members) ? sw.members.filter((m) => m && m.alive) : [];
        if (aliveMembers.length > 0) {
          chipsBar.style.display = 'flex';
          chipsBar.innerHTML = aliveMembers.slice(0, 10).map((m) => {
            const cls = m.role === 'verifier' ? 'swarm-chip verifier' : (m.isHydrogen ? 'swarm-chip hydrogen' : (m.isNeon ? 'swarm-chip neon' : 'swarm-chip'));
            const wsBadge = m.workspace === 'share' ? ' [share]' : '';
            return '<span class="' + cls + '" title="' + L('Модель: ', 'Model: ') + escapeHtml(m.model || 'inherit') + '">@' + escapeHtml(m.name) + wsBadge + '</span>';
          }).join('');
        } else {
          chipsBar.style.display = 'none';
          chipsBar.innerHTML = '';
        }
      } else {
        dotEl.className = 'swarm-dot';
        badgeEl.className = 'swarm-pill idle';
        badgeEl.textContent = getSwarmModeLabel(modeKey);
        chipsBar.style.display = 'none';
        chipsBar.innerHTML = '';

        if (modeKey === 'off') {
          headEl.textContent = L('Командный Рой отключён', 'Agent Swarm disabled');
          detailsEl.textContent = L(
            'Все задачи выполняются одиночной моделью или штатным Оркестратором без подъёма доски Роя',
            'All tasks run on a single model or native Orchestrator without spawning a Swarm board'
          );
        } else if (modeKey === 'manual_only') {
          headEl.textContent = L('Дежурный режим · Запуск только вручную (/swarm)', 'Standby mode · Manual trigger only (/swarm)');
          detailsEl.textContent = L(
            'Защита фоновых воркеров от зависаний и страховка квот включатся сразу после команды /swarm',
            'Worker stall monitor and quota failover activate as soon as you type /swarm'
          );
        } else if (modeKey === 'always_ask') {
          headEl.textContent = L('Режим с подтверждением на задачах L и XL', 'Ask before spawning on L and XL tasks');
          detailsEl.textContent = L('Агент предложит подключить Рой перед стартом: ', 'Agent will suggest enabling Swarm before starting: ') + tierHint;
        } else if (modeKey === 'auto_all') {
          headEl.textContent = L('Максимальный Рой: подключается на многомодульных задачах', 'Max Swarm: enabled on multi-module tasks');
          detailsEl.textContent = L('Координатор планирует, а ', 'Coordinator plans while ') + tierHint;
        } else if (modeKey === 'aggressive_l') {
          headEl.textContent = L('Готов к запуску на многофайловых задачах (L и XL)', 'Ready for multi-file tasks (L and XL)');
          detailsEl.textContent = L('Координатор планирует на вашей модели, а ', 'Coordinator plans on your chat model while ') + tierHint;
        } else {
          headEl.textContent = L('Адаптивный режим: бережёт квоту на S/M/L, включает Рой на XL', 'Adaptive mode: saves quota on S/M/L, enables Swarm on XL');
          detailsEl.textContent = tierKey === 'hydrogen_auto'
            ? L(
                'На обычных задачах работает быстрый контур · На крупных XL (4+ модулей) поднимется экономный Hydrogen-Рой + Ревизор',
                'Fast single-agent loop for standard tasks · On XL (4+ modules), spawns economical Hydrogen Swarm + Verifier'
              )
            : (L('На крупных XL (4+ модулей) поднимется Рой: ', 'On large XL (4+ modules) Swarm spawns: ') + tierHint);
        }
      }
    }

    let _lastTelemetrySnapshot = null;

    function setHwTextIfChanged(el, nextText) {
      if (!el) return;
      const str = String(nextText ?? '');
      if (el.textContent !== str) {
        el.textContent = str;
      }
    }

    function updateHeaderSessionPill(t) {
      if (!t) return;
      const chatsCount = Number(t.totalChats || 0);
      const convoEl = document.getElementById('convoShortId');
      if (convoEl) {
        convoEl.textContent = chatsCount > 0
          ? L('Все чаты (' + chatsCount + ')', 'All Chats (' + chatsCount + ')')
          : L('Все чаты · Автопилот', 'All Chats · Autopilot');
        convoEl.title = L(
          'Сводная статистика собирается по всем открытым и завершённым диалогам без путаницы между параллельными чатами',
          'Aggregated telemetry across all active and past chats without mixing parallel conversations'
        );
      }
    }

    function syncSwarmHeaderPills(t, s) {
      const st = s || currentState || {};
      const badgeEl = document.getElementById('swarmStatusBadge');
      if (badgeEl) {
        const sw = t ? t.swarm : null;
        const modeKey = st.swarmMode ? st.swarmMode : 'auto_xl';
        const isSwarmActive = Boolean(sw && sw.active && sw.totalSpawned > 0);
        if (isSwarmActive) {
          badgeEl.className = 'swarm-pill';
          const neonPart = (sw.neonWorkers > 0) ? (' · Neon: ' + sw.neonWorkers) : '';
          badgeEl.textContent = 'Hydrogen: ' + (sw.hydrogenWorkers || 0) + neonPart + L(' · Проверок: ', ' · Verifiers: ') + (sw.verifiers || 0);
        } else {
          badgeEl.className = 'swarm-pill idle';
          badgeEl.textContent = getSwarmModeLabel(modeKey);
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
      const ramSaved = Number(bk.ram ?? t.ramSavedTokens ?? 0);
      const cpuSaved = Number(bk.cpu ?? t.cpuSavedTokens ?? 0);
      const gpuSaved = Number(bk.gpu ?? t.gpuSavedTokens ?? 0);
      const localSavedTotal = Number(t.totalSavedTokens ?? (ramSaved + cpuSaved + gpuSaved));
      if (savedTotalEl) {
        savedTotalEl.textContent = '~' + formatK(localSavedTotal) + L(' ток.', ' tok');
        savedTotalEl.title =
          L('Сэкономлено расширением: ~', 'Saved by extension: ~') + formatExactInt(localSavedTotal) + L(' ток. ', ' tok ') +
          '(RAM ~' + formatExactInt(ramSaved) +
          ' + CPU ~' + formatExactInt(cpuSaved) +
          ' + GPU ~' + formatExactInt(gpuSaved) + L(' ток.)', ' tok)');
      }
      const setBkCell = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = formatK(val || 0);
      };
      setBkCell('metricSavedRamVal', ramSaved);
      setBkCell('metricSavedCpuVal', cpuSaved);
      setBkCell('metricSavedGpuVal', gpuSaved);

      const summaryEl = document.getElementById('allChatsSummaryLabel');
      if (summaryEl) {
        if (ac && ac.steps > 0) {
          const acSaved = Number(ac.ramSavedTokens || 0);
          summaryEl.textContent =
            L('Текущий чат: ~', 'Current chat: ~') + formatExactInt(acSaved) +
            L(' ток. сэкономлено (контекст ', ' tok saved (context ') + formatK(ac.lastContextTokens || 0) + ')';
        } else {
          summaryEl.textContent = L(
            'Текущий чат: ожидание первого хода · Авто-перенос контекста в новый чат включён',
            'Current chat: awaiting first turn · Auto-handoff to new chats is active'
          );
        }
      }

      renderSwarmTelemetry(t.swarm, currentState);
    }

    let _roiScale = 'day';
    let _roiHoverIdx = -1;
    let _lastRoiTimeline = null;
    let _lastQuotaPacerSnap = null;
    let _roiAnimRaf = 0;
    let _roiAnimCurrentHeights = [];

    function getRoiLayerColors() {
      return {
        ram: '#8ec5c6',
        cpu: '#c87d55',
        gpu: '#f04848',
        grid: 'rgba(255, 255, 255, 0.06)',
        baseline: 'rgba(255, 255, 255, 0.14)',
        tick: '#9ca3af',
        tickActive: '#f3f4f6',
      };
    }

    function updateRoiHoverReadout(buckets) {
      const readoutEl = document.getElementById('roiHoverReadout');
      if (!readoutEl) return;
      if (!Array.isArray(buckets) || buckets.length === 0) {
        readoutEl.textContent = L('Нет накопленных данных за выбранный период', 'No saved token data for selected range');
        return;
      }
      if (_roiHoverIdx >= 0 && _roiHoverIdx < buckets.length) {
        const b = buckets[_roiHoverIdx];
        const lbl = isRu() ? (b.periodLabelRu || b.labelRu || '') : (b.periodLabelEn || b.labelEn || '');
        if (b.beforeInstall && !(b.total > 0)) {
          readoutEl.textContent = lbl + ' · ' + L('До запуска расширения (0 ток.)', 'Before extension activity (0 tok)');
          return;
        }
        readoutEl.textContent =
          lbl + ' · ' + L('Всего ~', 'Total ~') + formatK(b.total || 0) +
          ' (RAM ' + formatK(b.ram || 0) +
          ' · CPU ' + formatK(b.cpu || 0) +
          ' · GPU ' + formatK(b.gpu || 0) + ')';
        return;
      }
      readoutEl.textContent = L('Наведите на столбец для детализации по слоям', 'Hover a bar for per-layer breakdown');
    }

    function drawRoiCanvasFrame(buckets, animProgress) {
      const canvas = document.getElementById('roiTimelineCanvas');
      if (!canvas || typeof canvas.getContext !== 'function') return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
      const w = Math.max(220, Math.floor((rect && rect.width) || canvas.clientWidth || 320));
      const h = Math.max(88, Math.floor((rect && rect.height) || Number(canvas.getAttribute('height')) || 104));
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(2.5, window.devicePixelRatio) : 1;
      const targetW = Math.round(w * dpr);
      const targetH = Math.round(h * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const pal = getRoiLayerColors();
      const pad = { l: 8, r: 8, t: 8, b: 18 };
      const cw = Math.max(40, w - pad.l - pad.r);
      const ch = Math.max(30, h - pad.t - pad.b);

      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      for (let g = 0; g < 2; g++) {
        const gy = Math.round(pad.t + (ch / 2) * g) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.l, gy);
        ctx.lineTo(w - pad.r, gy);
        ctx.stroke();
      }
      ctx.strokeStyle = pal.baseline;
      const baseY = Math.round(pad.t + ch) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, baseY);
      ctx.lineTo(w - pad.r, baseY);
      ctx.stroke();

      if (!Array.isArray(buckets) || buckets.length === 0) return;
      const maxTotal = Math.max(1, ...buckets.map((b) => Number(b.total || 0))) * 1.12;
      const step = cw / buckets.length;
      const barW = Math.min(28, Math.max(10, step * 0.6));
      const easeP = Math.max(0, Math.min(1, Number(animProgress ?? 1)));

      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const x = pad.l + step * i + (step - barW) * 0.5;
        const rawTotal = Number(b.total || 0);
        const prevH = _roiAnimCurrentHeights[i] || 0;
        const targetTotalH = (rawTotal / maxTotal) * ch;
        const totalH = prevH + (targetTotalH - prevH) * easeP;
        if (easeP >= 1) _roiAnimCurrentHeights[i] = targetTotalH;

        ctx.globalAlpha = (_roiHoverIdx === -1 || _roiHoverIdx === i) ? 1 : 0.4;
        if (rawTotal > 0 && totalH > 0.5) {
          const segs = [
            { val: Number(b.ram || 0), col: pal.ram },
            { val: Number(b.cpu || 0), col: pal.cpu },
            { val: Number(b.gpu || 0), col: pal.gpu },
          ];
          let accY = pad.t + ch;
          for (let sIdx = 0; sIdx < segs.length; sIdx++) {
            const seg = segs[sIdx];
            if (seg.val <= 0) continue;
            const sh = Math.max(1.5, (seg.val / rawTotal) * totalH);
            accY -= sh;
            ctx.fillStyle = seg.col;
            ctx.fillRect(x, accY, barW, Math.max(1, sh - 0.8));
          }
        } else {
          ctx.fillStyle = pal.baseline;
          ctx.fillRect(x, pad.t + ch - 1.5, barW, 1.5);
        }
        ctx.globalAlpha = 1;
        const lbl = isRu() ? (b.labelRu || b.labelEn || '') : (b.labelEn || b.labelRu || '');
        ctx.fillStyle = _roiHoverIdx === i ? pal.tickActive : pal.tick;
        const fontPx = lbl.length > 7 ? '8.5px' : '9.5px';
        ctx.font = (_roiHoverIdx === i ? '700 ' : '600 ') + fontPx + ' ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(lbl, x + barW * 0.5, h - 2);
      }
    }

    function bindRoiCanvasEventsOnce() {
      const canvas = document.getElementById('roiTimelineCanvas');
      if (!canvas || canvas.dataset.roiBound === '1') return;
      canvas.dataset.roiBound = '1';
      canvas.addEventListener('mousemove', function (ev) {
        const scales = _lastRoiTimeline && _lastRoiTimeline.scales ? _lastRoiTimeline.scales : null;
        const buckets = scales && Array.isArray(scales[_roiScale]) ? scales[_roiScale] : [];
        if (!buckets.length) return;
        const rect = canvas.getBoundingClientRect();
        const relX = ev.clientX - rect.left - 8;
        const cw = Math.max(40, rect.width - 16);
        const idx = Math.max(0, Math.min(buckets.length - 1, Math.floor((relX / cw) * buckets.length)));
        if (idx !== _roiHoverIdx) {
          _roiHoverIdx = idx;
          updateRoiHoverReadout(buckets);
          drawRoiCanvasFrame(buckets, 1);
        }
      });
      canvas.addEventListener('mouseleave', function () {
        if (_roiHoverIdx !== -1) {
          _roiHoverIdx = -1;
          const scales = _lastRoiTimeline && _lastRoiTimeline.scales ? _lastRoiTimeline.scales : null;
          const buckets = scales && Array.isArray(scales[_roiScale]) ? scales[_roiScale] : [];
          updateRoiHoverReadout(buckets);
          drawRoiCanvasFrame(buckets, 1);
        }
      });
    }

    function renderQuotaBulletMeter(roiData, quotaPacer) {
      const qb = (roiData && roiData.quotaBullet) || {};
      const qp = quotaPacer || _lastQuotaPacerSnap || {};
      const pct = Math.max(0, Math.min(100, Math.round(Number(qb.utilizationPct ?? qp.utilizationPct ?? 0))));
      const rawProj = qb.projectedPct ?? qp.projectedPct;
      const proj = Number.isFinite(Number(rawProj))
        ? Math.max(pct, Math.min(100, Math.round(Number(rawProj))))
        : pct;
      const status = qb.status || qp.status || 'calm';
      const minsLeft = Number.isFinite(Number(qb.estimatedMinutesLeft ?? qp.estimatedMinutesLeft))
        ? Number(qb.estimatedMinutesLeft ?? qp.estimatedMinutesLeft)
        : 300;
      const turns5h = Math.max(0, Math.round(Number(qb.turnsLast5h ?? qp.turnsLast5h ?? qb.turnsLast60m ?? qp.turnsLast60m ?? 0)));
      const turns60m = Math.max(0, Math.round(Number(qb.turnsLast60m ?? qp.turnsLast60m ?? 0)));
      const tierLabel = (qb.subscriptionTier || qp.subscriptionTier) === 'ultra' ? 'Ultra' : 'Pro';

      const wrapEl = document.getElementById('roiQuotaBullet');
      const statusEl = document.getElementById('roiQuotaStatusLabel');
      const valEl = document.getElementById('roiQuotaValueLabel');
      const fillEl = document.getElementById('roiQuotaFill');
      const markEl = document.getElementById('roiQuotaProjMark');

      if (wrapEl) {
        wrapEl.title = L(
          'Локальная оценка темпа за 5 ч (не прямой API Google): ' + turns5h + ' ходов за 5 ч (' + turns60m + ' за час) · тариф ' + tierLabel + '. Считает реальные ходы пользователя с учётом веса модели.',
          'Local 5h pace estimate (not Google API quota): ' + turns5h + ' turns in 5h (' + turns60m + '/h) · ' + tierLabel + ' tier. Counts real user turns weighted by model.'
        );
      }
      if (statusEl) {
        const stLabel = status === 'critical'
          ? L('Критично', 'Critical')
          : (status === 'elevated' ? L('Повышен', 'Elevated') : L('Спокойно', 'Calm'));
        statusEl.textContent = L('Окно квоты (5 ч) · ', 'Quota window (5h) · ') + stLabel;
      }
      if (valEl) {
        if (turns5h === 0 && pct === 0) {
          valEl.textContent = '0% · ' + L('0 ходов за 5 ч', '0 turns / 5h');
        } else {
          const etaH = Math.floor(minsLeft / 60);
          const etaM = minsLeft % 60;
          const etaStr = minsLeft >= 300
            ? L('>5ч', '>5h')
            : (etaH > 0 ? ('~' + etaH + L('ч ', 'h ') + etaM + L('м', 'm')) : ('~' + etaM + L('м', 'm')));
          valEl.textContent = pct + '% · ' + L('+1ч: ', '+1h: ') + proj + '% · ' + etaStr;
        }
      }
      if (fillEl) {
        fillEl.style.width = pct + '%';
        fillEl.classList.toggle('is-elevated', status === 'elevated');
        fillEl.classList.toggle('is-critical', status === 'critical');
      }
      if (markEl) {
        if (proj > pct && pct < 100) {
          markEl.style.display = 'block';
          markEl.style.left = Math.min(98, proj) + '%';
        } else {
          markEl.style.display = 'none';
        }
      }
    }

    function renderRoiTimeline(roiData, quotaPacer, animateTransition) {
      if (roiData) _lastRoiTimeline = roiData;
      if (quotaPacer) _lastQuotaPacerSnap = quotaPacer;
      const activeData = _lastRoiTimeline;
      bindRoiCanvasEventsOnce();
      renderQuotaBulletMeter(activeData, _lastQuotaPacerSnap);

      document.querySelectorAll('#roiScaleGroup button').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.scale === _roiScale);
      });

      const scales = activeData && activeData.scales ? activeData.scales : null;
      const buckets = scales && Array.isArray(scales[_roiScale]) ? scales[_roiScale] : [];
      updateRoiHoverReadout(buckets);

      if (_roiAnimRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(_roiAnimRaf);
        _roiAnimRaf = 0;
      }

      const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!animateTransition || reducedMotion || typeof requestAnimationFrame !== 'function') {
        drawRoiCanvasFrame(buckets, 1);
        return;
      }

      const t0 = Date.now();
      const duration = 220;
      const tick = function () {
        const raw = Math.min(1, (Date.now() - t0) / duration);
        const eased = 1 - Math.pow(1 - raw, 3);
        drawRoiCanvasFrame(buckets, eased);
        if (raw < 1) {
          _roiAnimRaf = requestAnimationFrame(tick);
        } else {
          _roiAnimRaf = 0;
        }
      };
      _roiAnimRaf = requestAnimationFrame(tick);
    }

    function setRoiTimelineScale(scale) {
      const valid = (scale === 'week' || scale === 'month') ? scale : 'day';
      if (_roiScale === valid) return;
      _roiScale = valid;
      _roiHoverIdx = -1;
      renderRoiTimeline(_lastRoiTimeline, _lastQuotaPacerSnap, true);
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
          ? L('Создать изолированную копию репозитория git worktree', 'Create an isolated git worktree sandbox')
          : L('Включите «Изолированная Git-песочница» в экспертных параметрах', 'Enable "Isolated Git Sandbox" in Expert Settings');
      }
      if (!box) return;
      if (!wtEnabled) {
        box.innerHTML = '<span>' + L('Git-песочница отключена в экспертных параметрах', 'Git sandbox is disabled in Expert Settings') + '</span>';
        return;
      }
      if (!_latestWorktreesList || _latestWorktreesList.length === 0) {
        box.innerHTML = '<span>' + L('Изолированных песочниц не создано', 'No isolated sandboxes created') + '</span>';
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
              '<button type="button" class="win-btn" style="padding: 1px 5px; font-size: 10px;" data-action="worktreeAction" data-mode="promote" data-id="' + escapeHtml(wtId) + '" title="' + L('Перенести проверенные правки в проект (с бэкапом)', 'Promote verified edits to workspace (with backup)') + '">' + L('✓ Применить', '✓ Apply') + '</button>' +
              '<button type="button" class="win-btn" style="padding: 1px 5px; font-size: 10px;" data-action="worktreeAction" data-mode="discard" data-id="' + escapeHtml(wtId) + '" title="' + L('Удалить изолированную песочницу без изменений в проекте', 'Discard isolated sandbox without changing workspace') + '">✕</button>' +
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

      const snapsCountEl = document.getElementById('bugsTabCountSnaps');
      if (snapsCountEl) {
        const snapTotal = _checkpointsViewMode === 'turns' && _latestTurnCheckpointsList.length > 0
          ? _latestTurnCheckpointsList.length
          : _latestCheckpointsList.length;
        snapsCountEl.textContent = snapTotal > 0 ? String(snapTotal) : '';
      }

      document.querySelectorAll('#checkpointsViewGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === _checkpointsViewMode);
      });

      const container = document.getElementById('checkpointsContainer');
      if (!container) return;

      const showProjTag = _selectedWorkspaceMode === '__all__';
      const localeTag = isRu() ? 'ru-RU' : 'en-US';

      if (_checkpointsViewMode === 'turns' && _latestTurnCheckpointsList.length > 0) {
        let html = '';
        for (let i = 0; i < _latestTurnCheckpointsList.length; i++) {
          const t = _latestTurnCheckpointsList[i];
          const tId = t.turnId || ('turn_' + i);
          const tWs = t.workspaceRoot || '';
          const tProj = t.projectName || getWorkspaceBasename(tWs);
          const title = pickText(t, 'turnLabel', 'turnLabelEn', '') || (Array.isArray(t.files) && t.files[0]) || L('Правки хода', 'Turn edits');
          const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString(localeTag) : L('недавно', 'recently');
          const filesHint = (Array.isArray(t.files) ? t.files.slice(0, 3).join(', ') : '') + (t.filesCount > 3 ? (' +' + (t.filesCount - 3)) : '');
          const diffExtra = (_activeTurnDiffPreview && _activeTurnDiffPreview.turnId === tId)
            ? (' · +' + (_activeTurnDiffPreview.totalAdded || 0) + '/-' + (_activeTurnDiffPreview.totalRemoved || 0) + L(' стр.', ' lines'))
            : '';
          const projBadge = (showProjTag && tProj)
            ? ('<button type="button" class="cp-project-badge" data-action="selectPanelWorkspaceChip" data-ws="' + escapeHtml(tWs) + '" title="' + L('Переключиться на проект ', 'Switch to project ') + escapeHtml(tWs || tProj) + '">' + escapeHtml(tProj) + '</button>')
            : '';
          const btnHtml = t.allRestored
            ? '<span style="font-size: 10px; color: var(--accent-cyan); flex-shrink: 0;">' + L('✓ Восст. хода', '✓ Turn restored') + '</span>'
            : '<div style="display: flex; gap: 3px; flex-shrink: 0;">' +
                '<button type="button" class="win-btn" style="padding: 1px 5px; font-size: 10px;" data-action="showTurnDiff" data-id="' + escapeHtml(tId) + '" data-ws="' + escapeHtml(tWs) + '" title="' + L('Показать статистику изменений за ход', 'Show diff summary for this turn') + '">Diff</button>' +
                '<button type="button" class="win-btn" style="padding: 1px 6px; font-size: 10px;" data-action="rollbackTurnById" data-id="' + escapeHtml(tId) + '" data-ws="' + escapeHtml(tWs) + '">' + L('↶ Ход', '↶ Turn') + '</button>' +
              '</div>';
          html +=
            '<div class="checkpoint-item">' +
              '<div class="checkpoint-info">' +
                '<div class="checkpoint-file" title="' + escapeHtml(filesHint) + '">' + escapeHtml(title) + '</div>' +
                '<div class="checkpoint-meta">' + projBadge + escapeHtml(time) + ' · ' + escapeHtml(String(t.filesCount || 0)) + L(' ф. (', ' f. (') + escapeHtml(filesHint || '—') + ')' + escapeHtml(diffExtra) + '</div>' +
              '</div>' +
              btnHtml +
            '</div>';
        }
        container.innerHTML = html;
        return;
      }

      const list = _latestCheckpointsList;
      if (!list || !list.length) {
        container.innerHTML = '<div style="color: var(--text-sub); font-size: 11px; padding: 4px;">' + L('Снимки файлов для выбранного проекта не найдены', 'No file snapshots found for the selected project') + '</div>';
        return;
      }
      let html = '';
      for (let i = 0; i < list.length; i++) {
        const cp = list[i];
        const cpId = cp.id || cp.checkpointId || ('cp_' + i);
        const cpWs = cp.workspaceRoot || '';
        const cpProj = cp.projectName || getWorkspaceBasename(cpWs);
        const file = cp.fileName || cp.file || cp.filePath || L('Файл', 'File');
        const fullPath = cp.filePath || file;
        const time = cp.time || (cp.timestamp ? new Date(cp.timestamp).toLocaleTimeString(localeTag) : L('недавно', 'recently'));
        const isRestored = !!cp.restored;
        const rawStatus = cp.status === 'сохранён' ? L('сохранён', 'saved') : cp.status;
        const status = isRestored ? L('откачен ✓', 'rolled back ✓') : (rawStatus || L('сохранён', 'saved'));
        const projBadge = (showProjTag && cpProj)
          ? ('<button type="button" class="cp-project-badge" data-action="selectPanelWorkspaceChip" data-ws="' + escapeHtml(cpWs) + '" title="' + L('Переключиться на проект ', 'Switch to project ') + escapeHtml(cpWs || cpProj) + '">' + escapeHtml(cpProj) + '</button>')
          : '';
        const btnHtml = isRestored
          ? '<span style="font-size: 10px; color: var(--accent-cyan); flex-shrink: 0;">' + L('✓ Восст.', '✓ Restored') + '</span>'
          : '<button type="button" class="win-btn" style="padding: 1px 6px; font-size: 10px; flex-shrink: 0;" data-action="rollbackSpecific" data-id="' + escapeHtml(cpId) + '" data-ws="' + escapeHtml(cpWs) + '">' + L('Откат', 'Rollback') + '</button>';
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
          emptyEl.textContent = L('Ничего не найдено по запросу «', 'No matches found for "') + currentSkillQuery + L('»', '"');
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
      const sigParts = [getUiLanguage()];
      for (let i = 0; i < discoveredSkills.length; i++) {
        const sk = discoveredSkills[i];
        if (modes[sk.id] === 'off') offCount++;
        const humanTitle = pickText(sk, 'title', 'titleEn', sk.id);
        const humanHint = pickText(sk, 'hint', 'hintEn', '');
        sigParts.push(String(sk.id || '') + '\x1f' + String(humanTitle) + '\x1f' + String(humanHint));
      }

      const summaryLabel = document.getElementById('skillsSummaryLabel');
      if (summaryLabel) {
        summaryLabel.textContent = offCount > 0
          ? (L('Авто: ', 'Auto: ') + (discoveredSkills.length - offCount) + L(', Выкл: ', ', Off: ') + offCount)
          : (L('Все ', 'All ') + discoveredSkills.length + L(' в умном Авто-режиме', ' in Smart Auto mode'));
      }

      if (!discoveredSkills.length) {
        _lastSkillsDomSig = '';
        container.innerHTML = '<div style="color: var(--text-sub); font-size: 11px; padding: 4px;">' + L('Все возможности управляются ИИ-автопилотом', 'All capabilities are managed by AI Autopilot') + '</div>';
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
        const humanTitle = pickText(sk, 'title', 'titleEn', sk.id);
        const humanHint = pickText(sk, 'hint', 'hintEn', '');
        const searchHay = (String(humanTitle) + ' ' + String(sk.title || '') + ' ' + String(sk.titleEn || '') + ' ' + String(sk.id || '') + ' ' + String(humanHint)).toLowerCase();

        rowsHtml +=
          '<div class="skill-item" data-skill-id="' + escapeHtml(sk.id) + '" data-search="' + escapeHtml(searchHay) + '">' +
            '<div class="skill-info" title="' + escapeHtml(humanHint) + '">' +
              '<div class="skill-title">' +
                '<span>' + escapeHtml(humanTitle) + '</span>' +
                '<span class="skill-id-tag">' + escapeHtml(sk.id) + '</span>' +
              '</div>' +
              '<div class="skill-hint">' + escapeHtml(humanHint) + '</div>' +
            '</div>' +
            '<div class="skill-mode-group">' +
              '<button type="button" class="skill-btn' + (mode === 'auto' ? ' active-auto' : '') + '" data-action="setSkillMode" data-skill="' + escapeHtml(sk.id) + '" data-mode="auto" title="' + L('ИИ сам включает этот навык только тогда, когда вы просите подходящую задачу', 'AI activates this skill automatically only when your task matches') + '">' + L('Авто', 'Auto') + '</button>' +
              '<button type="button" class="skill-btn' + (mode === 'off' ? ' active-off' : '') + '" data-action="setSkillMode" data-skill="' + escapeHtml(sk.id) + '" data-mode="off" title="' + L('Временно запретить использование этого навыка', 'Temporarily disable this skill') + '">' + L('Выкл', 'Off') + '</button>' +
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
      const reason = pickText(cb, 'reason', 'reasonEn', '');

      if (st === 'TRIPPED') {
        dot.className = 'circuit-dot tripped';
        badge.textContent = L('БЛОКИРОВКА ЦИКЛА (', 'LOOP TRIPPED (') + (count || 3) + '/3)';
        badge.style.color = 'var(--status-err)';
        reasonEl.hidden = false;
        reasonEl.textContent = reason || L('Автомат сработал: обнаружено 3-кратное зацикливание правок!', 'Circuit tripped: 3 consecutive edit loops detected!');
      } else if (st === 'WARNING') {
        dot.className = 'circuit-dot warning';
        badge.textContent = L('ВНИМАНИЕ (', 'WARNING (') + count + '/3)';
        badge.style.color = 'var(--status-warn)';
        reasonEl.hidden = false;
        reasonEl.textContent = reason || L('Повторяющиеся ошибки в шагах: риск срабатывания стоп-крана.', 'Repeated step errors: risk of tripping circuit breaker.');
      } else {
        dot.className = 'circuit-dot closed';
        badge.textContent = L('НОРМА (', 'OK (') + count + '/3)';
        badge.style.color = 'var(--status-ok)';
        reasonEl.hidden = true;
        reasonEl.textContent = reason || L('Автомат замкнут. Защита от зацикливания правок активна.', 'Circuit closed. Edit-loop protection is active.');
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
      const totalSuffix = epoch > 0 && totalTok > 0 ? (L(' (всего ', ' (total ') + formatK(totalTok) + ')') : '';

      label.textContent = L('Эпоха #', 'Epoch #') + epoch + ' · ' + fill + L('% от ', '% of ') + threshK + totalSuffix;
      bar.style.width = fill + '%';
      bar.style.setProperty('--fill-scale', (fill / 100).toFixed(4));
      bar.classList.toggle('is-crit', fill >= 90);
      bar.classList.toggle('is-warn', fill >= 70 && fill < 90);
      bar.classList.toggle('is-ok', fill < 70);

      const topEpochPill = document.getElementById('topEpochAlertPill');
      const wsCapsule = document.getElementById('wsSwitcherCapsule');
      if (topEpochPill) {
        if (fill >= 70) {
          topEpochPill.style.display = 'inline-flex';
          topEpochPill.className = 'ws-epoch-seg ' + (fill >= 90 ? 'is-crit' : 'is-warn');
          topEpochPill.textContent = fill + '%';
          topEpochPill.style.setProperty('--epoch-fill', fill + '%');
          const epochTip = L(
            'Контекст эпохи #' + epoch + ': ' + fill + '% от ' + threshK + totalSuffix + ' — нажмите, чтобы открыть настройки порога сжатия',
            'Epoch #' + epoch + ' context: ' + fill + '% of ' + threshK + totalSuffix + ' — click to open compaction settings'
          );
          if (typeof setTooltipTitle === 'function') setTooltipTitle(topEpochPill, epochTip);
          else topEpochPill.title = epochTip;
          topEpochPill.setAttribute('aria-label', epochTip);
        } else {
          topEpochPill.style.display = 'none';
        }
      }
      if (wsCapsule) {
        wsCapsule.classList.toggle('has-epoch', fill >= 70);
      }
      const coreTabDot = document.getElementById('fullTabCoreDot');
      if (coreTabDot) {
        coreTabDot.style.display = fill >= 70 ? 'inline-block' : 'none';
        coreTabDot.className = 'full-tab-alert-dot' + (fill >= 90 ? '' : ' is-warn');
      }
    }

    function syncFooterPluginVersion(pluginVersion) {
      if (!pluginVersion) return;
      const cleanVer = String(pluginVersion).trim();
      if (!cleanVer) return;
      const el = document.getElementById('footerPluginVersion');
      if (el) el.textContent = 'The Tunnel v' + cleanVer;
    }

    let _latestPitfallsList = [];

    function renderPitfalls(pitfalls) {
      if (Array.isArray(pitfalls)) _latestPitfallsList = pitfalls;
      const list = Array.isArray(pitfalls) ? pitfalls : _latestPitfallsList;
      const tabCountEl = document.getElementById('bugsTabCountPitfalls');
      if (tabCountEl) {
        tabCountEl.textContent = list.length > 0 ? String(list.length) : '';
      }
      const container = document.getElementById('pitfallsContainer');
      if (!container) return;

      if (!list || list.length === 0) {
        container.innerHTML = '<div style="color: var(--text-sub); font-size: 10.5px; padding: 2px;">' + L('Пока нет зафиксированных сбоев/откатов', 'No recorded failures or rollbacks yet') + '</div>';
        return;
      }

      let html = '';
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const rawText = typeof item === 'string' ? item : (item.rule || item.message || JSON.stringify(item));
        const cleanText = String(rawText || '').replace(/\s+/g, ' ').trim();
        const tagMatch = cleanText.match(/^\[([^\]]+)\]\s*(.+)$/);
        let fileBadge = '';
        let bodyText = cleanText;
        if (tagMatch) {
          fileBadge = '<span class="bento-file-tag">' + escapeHtml(tagMatch[1]) + '</span>';
          bodyText = tagMatch[2];
        }
        bodyText = bodyText.replace(/\\\\\?\\([A-Za-z]:\\[^\s|]+)/g, function (_, p) {
          const parts = p.split(/[\\/]/).filter(Boolean);
          return parts.length > 2 ? ('…\\' + parts.slice(-2).join('\\')) : p;
        });
        html +=
          '<div class="pitfall-item bento-pitfall-row" title="' + escapeHtml(cleanText) + '">' +
            '<span class="pitfall-bullet">!</span>' +
            '<div class="bento-pitfall-body">' +
              fileBadge +
              '<span class="pitfall-text bento-clamp-2">' + escapeHtml(bodyText) + '</span>' +
            '</div>' +
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
          badge.textContent = L('Откл.', 'Off');
        } else {
          const astCnt = curStats && Number(curStats.astCachedFilesCount || 0);
          badge.textContent = rList.length + L(' рец.', ' rec.') + (astCnt > 0 ? ' · AST:' + astCnt : '');
        }
      }
      if (extStatsEl) {
        if (!sqlEnabled) {
          extStatsEl.textContent = L('NVMe-память отключена', 'NVMe memory disabled');
        } else {
          const stObj = curStats && typeof curStats === 'object' ? curStats : {};
          const epCnt = Number(stObj.sessionEpisodesCount || 0);
          const ccrCnt = Number(stObj.ccrBlobsCount || 0);
          const repCnt = Number(stObj.repairBucketsCount || 0);
          const instCnt = Number(stObj.instinctsCount || 0);
          extStatsEl.textContent =
            L('Эпизоды: ', 'Episodes: ') + epCnt +
            L(' · CCR-блобы: ', ' · CCR blobs: ') + ccrCnt +
            ' · RepairKV: ' + repCnt +
            L(' · Инстинкты: ', ' · Instincts: ') + instCnt;
        }
      }
      if (recBox) {
        if (!sqlEnabled) {
          recBox.innerHTML = '<div style="color: var(--text-sub); font-size: 10.5px; padding: 2px;">' + L('NVMe-память (SQLite) отключена в настройках', 'NVMe memory (SQLite) is disabled in settings') + '</div>';
        } else if (rList.length === 0) {
          recBox.innerHTML = '<div style="color: var(--text-sub); font-size: 10.5px; padding: 2px;">' + L('Рецепты записываются автоматически при починке тестов', 'Win recipes are recorded automatically when failing tests pass') + '</div>';
        } else {
          const dedupMap = new Map();
          for (let i = 0; i < rList.length; i++) {
            const r = rList[i] || {};
            const errTxt = String(r.errorExcerpt || '').trim();
            const fixTxt = String(r.fixSummary || '').trim();
            const key = errTxt.toLowerCase().slice(0, 96) + '|' + fixTxt.toLowerCase().slice(0, 96);
            const curHits = Math.max(1, Number(r.hits || 1));
            if (dedupMap.has(key)) {
              const prev = dedupMap.get(key);
              prev.hits += curHits;
            } else {
              dedupMap.set(key, { errorExcerpt: errTxt, fixSummary: fixTxt, hits: curHits });
            }
          }
          const uniqueRecipes = Array.from(dedupMap.values()).slice(0, 8);
          recBox.innerHTML = uniqueRecipes.map(function (r) {
            let fixDisplay = r.fixSummary;
            if (isRu()) {
              const m = fixDisplay.match(/^Passing verification \(([^)]+)\) cleared (\d+) pitfall\(s\)$/i);
              if (m) {
                fixDisplay = 'Проверка (' + m[1] + ') закрыла граблей: ' + m[2];
              }
            }
            const fullLabel = (r.errorExcerpt ? r.errorExcerpt + ' → ' : '') + fixDisplay;
            let shortExcerpt = r.errorExcerpt;
            if (shortExcerpt && shortExcerpt.indexOf(',') !== -1) {
              const parts = shortExcerpt.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
              if (parts.length > 2) {
                shortExcerpt = parts.slice(0, 2).join(', ') + ' +' + (parts.length - 2) + L(' ф.', ' f.');
              }
            }
            let shortFix = fixDisplay;
            if (shortFix.length > 96) {
              shortFix = shortFix.slice(0, 93).trim() + '…';
            }
            const label = (shortExcerpt ? shortExcerpt + ' → ' : '') + shortFix;
            const hitsBadge = r.hits > 1 ? '<span class="recipe-hits-badge">×' + r.hits + '</span>' : '';
            return '<div class="pitfall-item bento-recipe-row" title="' + escapeHtml(fullLabel) + '"><span class="pitfall-bullet is-win">✓</span><span class="pitfall-text bento-clamp-2">' + escapeHtml(label) + hitsBadge + '</span></div>';
          }).join('');
        }
      }
      if (peerBox) {
        if (!sqlEnabled) {
          peerBox.innerHTML = '<span>' + L('Кросс-репо поиск приостановлен', 'Cross-repo search paused') + '</span>';
        } else if (pList.length === 0) {
          peerBox.innerHTML = '<span>' + L('Связанных репозиториев нет', 'No linked repositories') + '</span>';
        } else {
          peerBox.innerHTML = pList.map(function (p) {
            const pPath = typeof p === 'string' ? p : (p.path || '');
            const pLbl = typeof p === 'string' ? p : (p.label || pPath);
            return '<span class="composer-chip-btn" style="margin:2px 4px 2px 0; display:inline-flex; align-items:center; gap:4px;">' +
              escapeHtml(pLbl) +
              ' <button type="button" class="win-btn" style="padding:0 4px;font-size:10px;" data-action="removeFederatedPeer" data-arg="' + escapeHtml(pPath) + '">×</button>' +
              '</span>';
          }).join('');
        }
      }
    }

    const BLOCK_REQUIRED_SECTIONS = {
      skillsSectionCard: ['skills'],
      agentModeCard: ['circuit'],
      swarmBehaviorCard: ['swarm'],
      swarmTelemetryCard: ['swarm'],
      gpuRamCard: ['hw'],
      expertRamGpuFieldset: ['hw'],
      sentinelSectionCard: ['hw'],
      checkpointsCard: ['checkpoints'],
      intelligenceBayesianCard: ['bayesian', 'circuit'],
      expertCircuitBox: ['circuit'],
      memoryContextCard: ['compaction'],
      expertPitfallsBox: ['pitfalls'],
      expertKnowledgeBox: ['pitfalls'],
      expertGuardrailsCard: ['compaction'],
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
      if (document.body && document.body.getAttribute('data-panel-view') === 'full') {
        const curTab = normalizePanelFullTab(document.body.getAttribute('data-full-tab'));
        const tabHost = el.closest ? el.closest('[data-tab-panel]') : null;
        const ownTab = tabHost && typeof tabHost.getAttribute === 'function' ? tabHost.getAttribute('data-tab-panel') : '';
        if (ownTab && ownTab !== curTab) return false;
      }
      if (_blockObserverReady && _visibleBlockIds.size > 0) {
        if (_visibleBlockIds.has(blockId)) return true;
        const tabHost = el.closest ? el.closest('[data-tab-panel]') : null;
        if (tabHost && tabHost.id && _visibleBlockIds.has(tabHost.id)) {
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
      const isLiteView = document.body && document.body.getAttribute('data-panel-view') === 'lite';
      if (isLiteView || isBlockRenderable('gpuRamCard') || isBlockRenderable('expertRamGpuFieldset')) {
        runHwOnce();
        return;
      }
      if (typeof syncHeaderHardwareLivePills === 'function') {
        syncHeaderHardwareLivePills(gpu, ramCache, s, cpu);
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
          scheduleBlockRender('memoryContextCard', function () {
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
      if (document.body && document.body.getAttribute('data-panel-view') === 'lite') {
        return ['core', 'swarm', 'hw'];
      }
      const curTab = normalizePanelFullTab(document.body && document.body.getAttribute('data-full-tab'));
      const secs = ['core', 'hw'];
      if (curTab === 'behavior' || curTab === 'economy') {
        secs.push('swarm');
      }
      if (curTab === 'behavior' || curTab === 'bugs') {
        secs.push('circuit');
      }
      if (curTab === 'bugs') {
        secs.push('checkpoints');
        secs.push('bayesian');
      }
      if (curTab === 'memory' || curTab === 'settings') {
        secs.push('compaction');
      }
      if (curTab === 'memory') {
        secs.push('pitfalls');
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
        lastPayloadCache = lastPayloadCache ? Object.assign({}, lastPayloadCache, payload) : payload;
      }
      syncLoadedSectionsFromPayload(payload);
      if (payload && payload.pluginVersion) {
        syncFooterPluginVersion(payload.pluginVersion);
      }
      if (payload && (payload.knownWorkspaces || payload.activeWorkspace || payload.autoWorkspace)) {
        const prevWsKey = typeof normalizeWsClientKey === 'function' ? normalizeWsClientKey(_activeWorkspaceResolved) : String(_activeWorkspaceResolved || '');
        const nextWsRaw = (payload && typeof payload.activeWorkspace === 'string' && payload.activeWorkspace) ? payload.activeWorkspace : '';
        const nextWsKey = nextWsRaw ? (typeof normalizeWsClientKey === 'function' ? normalizeWsClientKey(nextWsRaw) : nextWsRaw) : '';
        if (prevWsKey && nextWsKey && prevWsKey !== nextWsKey) {
          if (typeof resetSentinelTransientState === 'function') resetSentinelTransientState();
          if (typeof resetGuardDockTransientState === 'function') resetGuardDockTransientState();
        }
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

      applyAgentModeBoxes(isAdvisor);

      document.querySelectorAll('#confirmThresholdGroup button, #liteConfirmThresholdGroup button').forEach((btn) => {
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
      document.querySelectorAll('#swarmModeGroup button, #liteSwarmModeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeSwarmMode);
      });

      const rawSwarmTier = s.swarmWorkerTier || 'hydrogen_auto';
      const activeSwarmTier = activeSubTier === 'pro' && rawSwarmTier === 'carbon_auto'
        ? 'neon_auto'
        : (activeSubTier === 'pro' && rawSwarmTier === 'argon_auto' ? 'hydrogen_auto' : rawSwarmTier);
      document.querySelectorAll('#swarmWorkerTierGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeSwarmTier);
      });

      document.body.setAttribute('data-panel-theme', 'glass_teal');

      const activeLang = (wizModalOpen && wizLangPreviewDirty)
        ? normalizeUiLanguage(wizDraft.uiLanguage || s.uiLanguage)
        : normalizeUiLanguage(s.uiLanguage);
      if (typeof applyUiLanguageDom === 'function') {
        applyUiLanguageDom(activeLang);
      }

      const activeViewMode = (wizModalOpen && wizViewModePreviewDirty)
        ? normalizePanelViewMode(wizDraft.panelViewMode || s.panelViewMode)
        : normalizePanelViewMode(s.panelViewMode);
      applyPanelViewModeDom(activeViewMode, !(wizModalOpen && wizViewModePreviewDirty));

      if (_panelFullTabUserSelected && _panelFullTabActiveLocal) {
        if (currentState && typeof currentState === 'object') {
          currentState.panelFullTab = _panelFullTabActiveLocal;
        }
        applyPanelFullTabDom(_panelFullTabActiveLocal, false);
      } else {
        applyPanelFullTabDom(s.panelFullTab, Boolean(s.panelFullTab));
      }

      if (typeof applyPanelUiScaleDom === 'function') {
        applyPanelUiScaleDom(s.panelUiScale || 'auto', true);
      }

      const swVerifierEl = document.getElementById('chk-swarmAutoVerifier');
      if (swVerifierEl) swVerifierEl.checked = s.swarmAutoVerifier !== false;
      const swQuotaEl = document.getElementById('chk-swarmQuotaFailover');
      if (swQuotaEl) swQuotaEl.checked = s.swarmQuotaFailover !== false;

      const designGateOn = s.uiDesignPreviewGate !== false;
      document.querySelectorAll('#uiDesignGateGroup button, #liteUiDesignGateGroup button').forEach((btn) => {
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

      const activeAutoSpecMode = (s.autoSpecMode === 'off' || s.autoSpecMode === 'always') ? s.autoSpecMode : 'auto';
      const activeAutoSpecOutput = s.autoSpecOutput === 'chat' ? 'chat' : 'thinking';
      document.querySelectorAll('#autoSpecModeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeAutoSpecMode);
      });
      document.querySelectorAll('#autoSpecOutputGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeAutoSpecOutput);
      });
      const autoSpecHintEl = document.getElementById('autoSpecModeHint');
      if (autoSpecHintEl) {
        const outSuffixRu = activeAutoSpecOutput === 'chat'
          ? ' Вывод промпта: компактным блоком в чат перед выполнением.'
          : ' Вывод промпта: скрытно в размышлениях (<thinking>).';
        const outSuffixEn = activeAutoSpecOutput === 'chat'
          ? ' Output: compact prompt shown in chat before executing.'
          : ' Output: silent in <thinking>.';
        if (activeAutoSpecMode === 'off') {
          autoSpecHintEl.textContent = L(
            'Режим «Выкл»: скрытый внутренний промпт не собирается (можно включить разово через /spec в чате).',
            '"Off" mode: silent internal spec prompt is disabled (trigger once with /spec in chat).'
          );
        } else if (activeAutoSpecMode === 'always') {
          autoSpecHintEl.textContent = L(
            'Режим «Всегда»: перед любыми правками агент компилирует детальный промпт по файлам, контрактам и проверкам.' + outSuffixRu,
            '"Always" mode: before any code edit, the agent compiles a detailed file/contract/verify prompt.' + outSuffixEn
          );
        } else {
          autoSpecHintEl.textContent = L(
            'Режим «Авто M+»: на задачах M/L/XL агент сам собирает промпт по файлам, строкам и контрактам и сразу идёт по нему.' + outSuffixRu,
            '"Auto M+" mode: on M/L/XL tasks the agent compiles a file/line/contract prompt and executes against it.' + outSuffixEn
          );
        }
      }

      const activeLeanMode = (s.leanMode === 'off' || s.leanMode === 'lite' || s.leanMode === 'ultra') ? s.leanMode : 'full';
      document.querySelectorAll('#leanModeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeLeanMode);
      });
      const leanHintEl = document.getElementById('leanModeHint');
      if (leanHintEl) {
        if (activeLeanMode === 'off') {
          leanHintEl.textContent = L(
            'Режим «Выкл»: правила экономии нового кода Ponytail отключены.',
            '"Off" mode: Ponytail code-reuse ladder is disabled.'
          );
        } else if (activeLeanMode === 'lite') {
          leanHintEl.textContent = L(
            'Режим «Lite»: подсказывает компактные альтернативы на базе существующих функций проекта.',
            '"Lite" mode: suggests compact alternatives reusing existing repo helpers.'
          );
        } else if (activeLeanMode === 'ultra') {
          leanHintEl.textContent = L(
            'Режим «Ultra»: жёстко оспаривает лишние абстракции и новые зависимости до правок.',
            '"Ultra" mode: strictly challenges redundant abstractions and deps before editing.'
          );
        } else {
          leanHintEl.textContent = L(
            'Режим «Full»: 7-ступенчатая лестница переиспользования кода и метки shortcut:.',
            '"Full" mode: 7-step code-reuse ladder with explicit shortcut: markers.'
          );
        }
      }

      const activeTerseMode = (s.terseMode === 'caveman' || s.terseMode === 'ultracave') ? s.terseMode : 'off';
      document.querySelectorAll('#terseModeGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === activeTerseMode);
      });
      const terseHintEl = document.getElementById('terseModeHint');
      if (terseHintEl) {
        if (activeTerseMode === 'caveman') {
          terseHintEl.textContent = L(
            'Режим «Caveman»: стандарт ASD-STE100 (до 20 слов во фразе, без воды; код не сокращается).',
            '"Caveman" mode: ASD-STE100 brevity (<=20 words/sentence, zero filler; code untouched).'
          );
        } else if (activeTerseMode === 'ultracave') {
          terseHintEl.textContent = L(
            'Режим «Ultra»: сверхплотный телеграфный ответ до 12 слов во фразе (код без сокращений).',
            '"Ultra" mode: ultra-dense <=12 words/sentence telegraphic replies (code untouched).'
          );
        } else {
          terseHintEl.textContent = L(
            'Режим «Выкл»: стандартный лаконичный стиль ответов без жёсткого лимита слов.',
            '"Off" mode: standard concise replies without strict per-sentence word cap.'
          );
        }
      }
      const grillHintEl = document.getElementById('grillModeHint');
      if (grillHintEl) {
        if (activeGrillMode === 'off') {
          grillHintEl.textContent = L(
            'Режим «Выкл»: детальный опрос не предлагается (можно включить разово кнопкой «Опрос» в Композере).',
            '"Off" mode: deep interview is not offered automatically (you can trigger it once via "Grill-Me" in Composer).'
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
      if (typeof syncTogglePresetsUi === 'function') syncTogglePresetsUi(s);

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
        _lastTelemetrySnapshot = payload.telemetry;
        updateHeaderSessionPill(payload.telemetry);
        syncSwarmHeaderPills(payload.telemetry, s);
        scheduleBlockRender('swarmTelemetryCard', function () {
          renderTelemetry(payload.telemetry);
          renderRoiTimeline(payload.roiTimeline || _lastRoiTimeline, payload.quotaPacer || _lastQuotaPacerSnap, false);
        });
      } else {
        syncSwarmHeaderPills(null, s);
        scheduleBlockRender('swarmTelemetryCard', function () {
          renderSwarmTelemetry(null, s);
          if (_lastRoiTimeline) renderRoiTimeline(_lastRoiTimeline, payload ? payload.quotaPacer : _lastQuotaPacerSnap, false);
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
        scheduleBlockRender('memoryContextCard', function () {
          renderCompaction(payload.compaction);
        });
      }
      if (payload && payload.pitfalls !== undefined) {
        renderPitfalls(payload.pitfalls);
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
      const curThresh = String(s.compactionTokenThreshold || 120000);
      document.querySelectorAll('#compactionThresholdGroup button').forEach(function (btn) {
        const isActive = btn.dataset.val === curThresh;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      applyHookProfileOverridesToUi(activeHookProfile, s);
      const hwSnapCtx = typeof _lastHwRenderCtx !== 'undefined' ? _lastHwRenderCtx : null;
      const resolvedGpuForRender = (payload && payload.gpu !== undefined)
        ? payload.gpu
        : ((lastPayloadCache && lastPayloadCache.gpu !== undefined) ? lastPayloadCache.gpu : (hwSnapCtx ? hwSnapCtx.gpu : null));
      const resolvedRamForRender = (payload && payload.ramCache !== undefined)
        ? payload.ramCache
        : ((lastPayloadCache && lastPayloadCache.ramCache !== undefined) ? lastPayloadCache.ramCache : (hwSnapCtx ? hwSnapCtx.ramCache : null));
      const resolvedCpuForRender = (payload && payload.cpu !== undefined)
        ? payload.cpu
        : ((lastPayloadCache && lastPayloadCache.cpu !== undefined) ? lastPayloadCache.cpu : (hwSnapCtx ? hwSnapCtx.cpu : null));

      if (typeof syncHwHeaderSummaryBadge === 'function') {
        syncHwHeaderSummaryBadge(s, resolvedGpuForRender, resolvedRamForRender);
      }
      const hasAnyHwData = Boolean(
        (payload && (payload.gpu !== undefined || payload.ramCache !== undefined || payload.cpu !== undefined)) ||
        resolvedGpuForRender ||
        resolvedRamForRender ||
        resolvedCpuForRender
      );
      if (
        !(payload && payload._uiLayoutOnly === true) &&
        hasAnyHwData
      ) {
        scheduleHwBlockRender(
          resolvedGpuForRender,
          resolvedRamForRender,
          s,
          resolvedCpuForRender
        );
      }
      if (payload && payload.sentinel !== undefined) {
        if (typeof syncSentinelNormalizedFindings === 'function') {
          syncSentinelNormalizedFindings(payload.sentinel);
        }
        scheduleBlockRender('sentinelSectionCard', function () {
          renderSentinelStatus(payload.sentinel, s);
        });
      }
      if (payload && payload.guardPulse !== undefined && typeof renderGuardDock === 'function') {
        renderGuardDock(payload.guardPulse);
      }
      renderTaskProgressAndHud(payload ? payload.taskProgress : null, payload ? payload.floatingHud : null, s);

      // Смарт-баннер разговорного ИИ-пилота, профиль воркспейса и авто-запуск Мастера
      if (payload && payload.projectDetection) {
        detectedProjectInfo = payload.projectDetection;
      }
      renderSmartPilotBanner(detectedProjectInfo);
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
            'Разведка ИИ-Пилота активна (' + activeCount + ' из ' + guardrailModules.length + ' ключевых контуров включено)',
            'AI Pilot scouting active (' + activeCount + ' of ' + guardrailModules.length + ' core contours enabled)'
          );
        }

        updateAutopilotLiveText(s, payload ? payload.circuitBreaker : null);
      }
      if (typeof syncDebugLoggerHeaderUi === 'function') {
        syncDebugLoggerHeaderUi(s, payload ? payload.debugLogStatus : null);
      }
      if (typeof scheduleSyncAllSlidingPills === 'function') {
        scheduleSyncAllSlidingPills();
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
        t.ramSavedTokens || 0,
        t.cpuSavedTokens || 0,
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
        (gpu.pullStatus && gpu.pullStatus.active) ? 1 : 0,
        (gpu.pullStatus && gpu.pullStatus.completedCount) || 0,
        (gpu.pullStatus && gpu.pullStatus.currentPercent) || 0,
        (gpu.pullStatus && gpu.pullStatus.error) || '',
        (gpu.pullStatus && gpu.pullStatus.dismissed) ? 1 : 0,
        (gpu.ollamaInstallStatus && gpu.ollamaInstallStatus.active) ? 1 : 0,
        (gpu.ollamaInstallStatus && gpu.ollamaInstallStatus.phase) || '',
        (gpu.ollamaInstallStatus && gpu.ollamaInstallStatus.percent) || 0,
        (gpu.ollamaInstallStatus && gpu.ollamaInstallStatus.error) || '',
        (gpu.ollamaInstallStatus && gpu.ollamaInstallStatus.dismissed) ? 1 : 0,
        cpuTel.rerankCalls || 0,
        cpuTel.workerBatches || 0,
        cpuTel.lastRerankMs || 0,
        (cpuTel.sbflLocalizations || 0) + (cpuTel.bitapHealedPatches || 0) + (cpuTel.pprBridgeQueries || 0),
        (cpu.liveActivity && cpu.liveActivity.opSeq) || 0,
        (cpu.liveActivity && cpu.liveActivity.inFlightCount) || 0,
        (cpu.liveActivity && cpu.liveActivity.isWorking) ? 1 : 0,
        (cpu.liveActivity && cpu.liveActivity.isAfterglow) ? 1 : 0,
        (cpu.liveActivity && cpu.liveActivity.currentOp) || '',
        (cpu.pool && cpu.pool.busyWorkers) || 0,
        ram.active ? 1 : 0,
        ram.cacheUsedMb || 0,
        ram.hits || 0,
        ram.slices || 0,
        ram.searches || 0,
        (ram.liveActivity && ram.liveActivity.opSeq) || 0,
        (ram.liveActivity && ram.liveActivity.activeOps) || 0,
        (ram.liveActivity && ram.liveActivity.isWorking) ? 1 : 0,
        (ram.liveActivity && ram.liveActivity.lastOp) || '',
        (data.hardwareCeilings && data.hardwareCeilings.maxVramMb) || 0,
        (data.hardwareCeilings && data.hardwareCeilings.maxRamBudgetMb) || 0,
        (data.hardwareCeilings && data.hardwareCeilings.maxCpuThreads) || 0,
        bay.totalRuns || 0,
        sen.enabled === false ? 0 : 1,
        getUiLanguage(),
        sen.state || 'idle',
        sen.currentTaskRu || '',
        sen.currentTaskEn || '',
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
        data.projectDetection ? (data.projectDetection.labelEn || '') : '',
        data.guardPulse ? (
          (data.guardPulse.bugs ? data.guardPulse.bugs.count : 0) + ':' +
          (data.guardPulse.shield ? (data.guardPulse.shield.count + ':' + data.guardPulse.shield.score) : '0') + ':' +
          (data.guardPulse.instincts ? (data.guardPulse.instincts.readyCount + '/' + data.guardPulse.instincts.total) : '0') + ':' +
          (data.guardPulse.risks ? data.guardPulse.risks.count : 0) + ':' +
          (data.guardPulse.env ? data.guardPulse.env.count : 0)
        ) : '',
        Array.isArray(data.knownWorkspaces) ? data.knownWorkspaces.map(function (w) { return (w.workspaceRoot || '') + ':' + (w.checkpointsCount || 0) + ':' + (w.status || ''); }).join(',') : '',
      ].join('|');
    }

    function renderSmartPilotBanner(info) {
      if (info && typeof info === 'object') {
        detectedProjectInfo = info;
      }
      if (typeof syncWorkspaceSwitcherBadge === 'function') {
        syncWorkspaceSwitcherBadge();
      }
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
        renderSmartPilotBanner(detectedProjectInfo);
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
        if (data.roiTimeline !== undefined) lastPayloadCache.roiTimeline = data.roiTimeline;
        if (data.wiretapFaults !== undefined) lastPayloadCache.wiretapFaults = data.wiretapFaults;
        if (data.quotaPacer !== undefined) lastPayloadCache.quotaPacer = data.quotaPacer;
        if (data.circuitBreaker !== undefined) lastPayloadCache.circuitBreaker = data.circuitBreaker;
        if (data.compaction !== undefined) lastPayloadCache.compaction = data.compaction;
        if (data.ramCache !== undefined) lastPayloadCache.ramCache = data.ramCache;
        if (data.gpu !== undefined) lastPayloadCache.gpu = data.gpu;
        if (data.cpu !== undefined) lastPayloadCache.cpu = data.cpu;
        if (data.sentinel !== undefined) lastPayloadCache.sentinel = data.sentinel;
        if (data.guardPulse !== undefined) lastPayloadCache.guardPulse = data.guardPulse;
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
      _lastTelemetrySnapshot = data.telemetry;
      updateHeaderSessionPill(data.telemetry);
      syncSwarmHeaderPills(data.telemetry, currentState);
      scheduleBlockRender('swarmTelemetryCard', function () {
        renderTelemetry(data.telemetry);
        if (data.roiTimeline || _lastRoiTimeline) {
          renderRoiTimeline(data.roiTimeline || _lastRoiTimeline, data.quotaPacer || _lastQuotaPacerSnap, false);
        }
      });
      if (data.circuitBreaker !== undefined) {
        scheduleBlockRender('expertCircuitBox', function () {
          renderCircuitBreaker(data.circuitBreaker);
        });
        updateAutopilotLiveText(currentState, data.circuitBreaker);
      }
      if (data.compaction !== undefined) {
        scheduleBlockRender('memoryContextCard', function () {
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
        const isLiteViewNow = document.body && document.body.getAttribute('data-panel-view') === 'lite';
        scheduleBlockRender(isLiteViewNow ? 'liteQuickCard' : 'sentinelSectionCard', function () {
          renderSentinelStatus(data.sentinel, currentState);
        });
      }
      if (data.guardPulse !== undefined && typeof renderGuardDock === 'function') {
        renderGuardDock(data.guardPulse);
      }
      if (data.bayesian !== undefined) {
        scheduleBlockRender('intelligenceBayesianCard', function () {
          renderBayesian(data.bayesian, currentState);
        });
      }
      if (data.taskProgress || data.floatingHud) {
        renderTaskProgressAndHud(data.taskProgress, data.floatingHud, currentState);
      }
      if (data.composerHandoff && typeof applyExternalComposerHandoff === 'function') {
        applyExternalComposerHandoff(data.composerHandoff);
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
        if (typeof refreshSidecarOpenWorkspacesFast === 'function') {
          await refreshSidecarOpenWorkspacesFast(false);
        }
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
    let pgStatusToastTimer = null;
    let _lastComposerHandoffSeq = 0;

    function insertIntoLocalSmartComposer(opts) {
      const safe = opts && typeof opts === 'object' ? opts : {};
      const tokens = Array.isArray(safe.tokens) ? safe.tokens.filter(Boolean) : [];
      const draftQ = String(safe.prompt || '').trim();
      const rawText = String(safe.text || '').trim();
      if (document.body && document.body.getAttribute('data-panel-view') === 'full' && typeof setPanelFullTab === 'function') {
        const curTab = document.body.getAttribute('data-full-tab') || 'cockpit';
        if (curTab !== 'cockpit') {
          setPanelFullTab('cockpit', { silent: true, skipAutoExpand: true });
        }
      }
      const compCard = document.getElementById('smartComposerCard');
      if (compCard && compCard.classList.contains('is-collapsed')) {
        compCard.classList.remove('is-collapsed');
      }
      const compInput = document.getElementById('smartComposerInput');
      if (!compInput) return false;
      let cur = compInput.value || '';
      if (tokens.length > 0 || draftQ) {
        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          if (cur.indexOf(tok) === -1) {
            const sep = cur && !/\s$/.test(cur) ? (draftQ ? '\n' : ' ') : '';
            cur = cur + sep + tok;
          }
        }
        if (draftQ && cur.indexOf(draftQ) === -1) {
          const sep = cur && !/\s$/.test(cur) ? ' ' : '';
          cur = cur + sep + draftQ;
        }
        compInput.value = (draftQ || !cur || /\s$/.test(cur)) ? cur : (cur + ' ');
      } else if (rawText) {
        const sep = cur && !/\s$/.test(cur) ? '\n' : '';
        compInput.value = cur.indexOf(rawText) !== -1 ? cur : (cur + sep + rawText);
      }
      if (typeof _smartLastDraft !== 'undefined') {
        _smartLastDraft = compInput.value;
      }
      if (typeof renderSmartComposerMirror === 'function') {
        renderSmartComposerMirror();
      }
      if (compCard && typeof compCard.scrollIntoView === 'function') {
        try { compCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
      }
      try { compInput.focus(); } catch {}
      return true;
    }

    function applyExternalComposerHandoff(handoff) {
      if (!handoff || typeof handoff !== 'object') return false;
      if (typeof pgIsStandaloneView === 'function' && pgIsStandaloneView()) return false;
      const seq = Number(handoff.seq || 0);
      if (!seq || seq <= _lastComposerHandoffSeq) return false;
      _lastComposerHandoffSeq = seq;
      const ok = insertIntoLocalSmartComposer(handoff);
      if (ok) {
        flashStatus(L('Вопрос из Карты проекта добавлен в Композер ✓', 'Project Map question added to Composer ✓'));
      }
      return ok;
    }

    function flashStatus(text) {
      const pill = document.getElementById('statusPill');
      if (pill) {
        pill.textContent = text;
        if (flashStatusTimer) clearTimeout(flashStatusTimer);
        flashStatusTimer = setTimeout(() => {
          flashStatusTimer = null;
          pill.textContent = L('Готово · Синхронизировано', 'Ready · Synced');
        }, 2500);
      }
      const pgToast = document.getElementById('pgStatusToast');
      const pgModal = document.getElementById('projectGraphModal');
      const isPgVisible = Boolean(
        (document.body && document.body.classList && document.body.classList.contains('pg-standalone')) ||
        (pgModal && pgModal.classList && pgModal.classList.contains('open'))
      );
      if (pgToast && isPgVisible) {
        pgToast.textContent = text;
        pgToast.hidden = false;
        if (pgStatusToastTimer) clearTimeout(pgStatusToastTimer);
        pgStatusToastTimer = setTimeout(() => {
          pgStatusToastTimer = null;
          pgToast.hidden = true;
        }, 3200);
      }
    }

    let _pendingUpdatePatch = null;
    let _updateFlushInFlight = false;
    let _updateBatchWaiters = [];
    let _batchRollbackSnap = null;

    function cloneRollbackSnap(st) {
      const s = (st && typeof st === 'object') ? st : {};
      return Object.assign({}, s, {
        skillModes: Object.assign({}, s.skillModes || {}),
        panelCollapsedCards: Object.assign({}, s.panelCollapsedCards || {}),
        panelOpenSpoilers: Object.assign({}, s.panelOpenSpoilers || {}),
      });
    }

    function mergeStatePatches(target, src) {
      const out = Object.assign({}, target || {});
      if (!src || typeof src !== 'object') return out;
      for (const k of Object.keys(src)) {
        if (k === 'skillModes' && src.skillModes && typeof src.skillModes === 'object') {
          if (src.replaceSkillModes) {
            out.skillModes = Object.assign({}, src.skillModes);
          } else {
            out.skillModes = Object.assign({}, out.skillModes || {}, src.skillModes);
          }
        } else if ((k === 'panelCollapsedCards' || k === 'panelOpenSpoilers') && src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
          // Complete DOM boolean maps: clone latest snapshot so omitting a key expands/closes cleanly without resurrecting stale entries.
          out[k] = Object.assign({}, src[k]);
        } else {
          out[k] = src[k];
        }
      }
      if (src.replaceSkillModes) {
        out.replaceSkillModes = true;
      }
      return out;
    }

    async function flushPendingStateUpdates() {
      if (_updateFlushInFlight) return;
      _updateFlushInFlight = true;
      try {
        while (_pendingUpdatePatch) {
          const patchToSend = _pendingUpdatePatch;
          const waiters = _updateBatchWaiters;
          _pendingUpdatePatch = null;
          _updateBatchWaiters = [];
          const rollbackSnap = _batchRollbackSnap || cloneRollbackSnap(currentState);
          let ok = false;
          const useFastUpdate = Boolean(
            patchToSend &&
            !patchToSend.rootDir &&
            !patchToSend.workspaceScope &&
            !patchToSend.skillModes &&
            !patchToSend.replaceSkillModes
          );
          try {
            const res = await panelFetch('/api/update', {
              method: 'POST',
              headers: useFastUpdate ? { 'x-panel-fast-update': '1' } : undefined,
              body: JSON.stringify(patchToSend),
            });
            if (!res || !res.ok) {
              throw new Error('HTTP ' + (res ? res.status : 'err'));
            }
            const updated = await res.json();
            if (!updated || updated.ok === false || !updated.state) {
              throw new Error((updated && updated.error) ? updated.error : L('Ответ сервера без state', 'Server response missing state'));
            }
            if (patchToSend && patchToSend.panelFullTab && updated.state && updated.state.panelFullTab !== patchToSend.panelFullTab) {
              updated.state.panelFullTab = normalizePanelFullTab(patchToSend.panelFullTab);
            }
            // Refresh rollback baseline to confirmed server state for any trailing queued batch.
            _batchRollbackSnap = cloneRollbackSnap(updated.state);
            const sentKeys = patchToSend && typeof patchToSend === 'object' ? Object.keys(patchToSend) : [];
            const isLayoutOnlySent = isUiLayoutOnlyPatch(patchToSend);
            const payloadForRender = updated.fast === true && lastPayloadCache
              ? Object.assign({}, lastPayloadCache, updated, isLayoutOnlySent ? { _uiLayoutOnly: true } : null)
              : Object.assign({}, updated, (updated.fast === true && isLayoutOnlySent) ? { _uiLayoutOnly: true } : null);
            if (updated.fast === true && lastPayloadCache) {
              lastPayloadCache = payloadForRender;
            }
            if (!_pendingUpdatePatch) {
              renderPayload(payloadForRender);
              if (!(sentKeys.length === 1 && sentKeys[0] === 'panelFullTab')) {
                flashStatus(L('Сохранено в router-state.json ✓', 'Saved to router-state.json ✓'));
              }
            } else if (updated.state) {
              currentState = mergeStatePatches(updated.state, _pendingUpdatePatch);
            }
            ok = true;
          } catch (err) {
            console.error(err);
            if (!_pendingUpdatePatch) {
              renderPayload(Object.assign({}, lastPayloadCache || {}, { state: rollbackSnap }));
              flashStatus(L('Ошибка записи: ', 'Save error: ') + (err && err.message ? err.message : L('сбой', 'failed')));
            }
            ok = false;
          }
          for (let i = 0; i < waiters.length; i++) {
            try { waiters[i](ok); } catch {}
          }
        }
      } finally {
        _batchRollbackSnap = null;
        _updateFlushInFlight = false;
      }
    }

    function isUiLayoutOnlyPatch(patch) {
      if (!patch || typeof patch !== 'object') return false;
      const keys = Object.keys(patch);
      return keys.length > 0 && keys.every(function (k) {
        return k === 'panelCollapsedCards' || k === 'panelOpenSpoilers' || k === 'panelBlockOrder' || k === 'panelFullTab';
      });
    }

    function updateState(patch, opts) {
      const skipOptimistic = Boolean(opts && opts.skipOptimistic);
      if (!_batchRollbackSnap) {
        _batchRollbackSnap = cloneRollbackSnap(currentState);
      }
      const optimistic = mergeStatePatches(currentState, patch);
      if (patch && patch.skillModes) {
        const mergedModes = patch.replaceSkillModes ? {} : Object.assign({}, currentState.skillModes || {});
        for (const k of Object.keys(patch.skillModes)) {
          if (patch.skillModes[k] === 'auto') delete mergedModes[k];
          else mergedModes[k] = patch.skillModes[k];
        }
        optimistic.skillModes = mergedModes;
      }
      if (!skipOptimistic) {
        const optPayload = Object.assign({}, lastPayloadCache || {}, { state: optimistic });
        if (isUiLayoutOnlyPatch(patch)) {
          optPayload._uiLayoutOnly = true;
        }
        renderPayload(optPayload);
      }
      _pendingUpdatePatch = mergeStatePatches(_pendingUpdatePatch, patch);
      return new Promise((resolve) => {
        _updateBatchWaiters.push(resolve);
        void flushPendingStateUpdates();
      });
    }

    let _agentModeLastAdvisor = null;

    function animateSubSettingsBox(box, shouldShow) {
      if (!box) return;
      const seq = (box._subSettingsSeq || 0) + 1;
      box._subSettingsSeq = seq;
      let inFlightH = 0;
      let inFlightOpacity = null;
      if (box._subSettingsAnim) {
        inFlightH = typeof uiMeasureLayoutHeight === 'function' ? uiMeasureLayoutHeight(box) : 0;
        if (typeof getComputedStyle === 'function') {
          try { inFlightOpacity = getComputedStyle(box).opacity; } catch {}
        }
        try { box._subSettingsAnim.cancel(); } catch {}
        box._subSettingsAnim = null;
      }

      if (typeof uiCanAnimateEl !== 'function' || !uiCanAnimateEl(box)) {
        box.classList.remove('is-animating');
        box.classList.toggle('visible', shouldShow);
        box.style.overflow = '';
        return;
      }

      if (shouldShow) {
        box.classList.add('visible', 'is-animating');
        const cs = typeof getComputedStyle === 'function' ? getComputedStyle(box) : null;
        const targetH = typeof uiMeasureLayoutHeight === 'function' ? uiMeasureLayoutHeight(box) : 0;
        if (targetH <= 0) {
          box.classList.remove('is-animating');
          return;
        }
        const mt = cs ? cs.marginTop : '8px';
        const pt = cs ? cs.paddingTop : '8px';
        const startH = inFlightH > 0 ? inFlightH : 0;
        const startOpacity = inFlightOpacity !== null ? inFlightOpacity : 0;
        try {
          const anim = box.animate(
            [
              {
                height: startH + 'px',
                opacity: startOpacity,
                marginTop: inFlightH > 0 ? mt : '0px',
                paddingTop: inFlightH > 0 ? pt : '0px',
                transform: 'translate3d(0, -4px, 0)'
              },
              {
                height: targetH + 'px',
                opacity: 1,
                marginTop: mt,
                paddingTop: pt,
                transform: 'translate3d(0, 0, 0)'
              }
            ],
            { duration: 240, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
          );
          box._subSettingsAnim = anim;
          anim.onfinish = function () {
            if (box._subSettingsSeq !== seq) return;
            box._subSettingsAnim = null;
            box.classList.remove('is-animating');
            box.style.overflow = '';
            if (typeof scheduleSyncAllSlidingPills === 'function') scheduleSyncAllSlidingPills();
            if (typeof syncFullLeftRailStickyOffset === 'function') syncFullLeftRailStickyOffset();
          };
        } catch {
          box.classList.remove('is-animating');
        }
        return;
      }

      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(box) : null;
      const startH = inFlightH > 0 ? inFlightH : (typeof uiMeasureLayoutHeight === 'function' ? uiMeasureLayoutHeight(box) : 0);
      box.classList.remove('visible');
      if (startH <= 0) {
        box.classList.remove('is-animating');
        return;
      }
      box.classList.add('is-animating');
      const mt = cs ? cs.marginTop : '8px';
      const pt = cs ? cs.paddingTop : '8px';
      const startOpacity = inFlightOpacity !== null ? inFlightOpacity : 1;
      try {
        const anim = box.animate(
          [
            { height: startH + 'px', opacity: startOpacity, marginTop: mt, paddingTop: pt, transform: 'translate3d(0, 0, 0)' },
            { height: '0px', opacity: 0, marginTop: '0px', paddingTop: '0px', transform: 'translate3d(0, -4px, 0)' }
          ],
          { duration: 200, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
        );
        box._subSettingsAnim = anim;
        anim.onfinish = function () {
          if (box._subSettingsSeq !== seq) return;
          box._subSettingsAnim = null;
          box.classList.remove('is-animating');
          box.style.overflow = '';
          if (typeof syncFullLeftRailStickyOffset === 'function') syncFullLeftRailStickyOffset();
        };
      } catch {
        box.classList.remove('is-animating');
      }
    }

    function applyAgentModeBoxes(isAdvisor) {
      const advCard = document.getElementById('mode-advisor');
      const autoCard = document.getElementById('mode-autopilot');
      const advBox = document.getElementById('advisorBox');
      const autoBox = document.getElementById('autopilotBox');
      if (advCard) advCard.className = 'mode-card' + (isAdvisor ? ' active-card' : '');
      if (autoCard) autoCard.className = 'mode-card' + (!isAdvisor ? ' active-card' : '');
      const shouldAnimate = _agentModeLastAdvisor !== null && _agentModeLastAdvisor !== isAdvisor;
      if (advBox) {
        if (shouldAnimate) animateSubSettingsBox(advBox, isAdvisor);
        else {
          advBox.classList.remove('is-animating');
          advBox.classList.toggle('visible', isAdvisor);
        }
      }
      if (autoBox) {
        if (shouldAnimate) animateSubSettingsBox(autoBox, !isAdvisor);
        else {
          autoBox.classList.remove('is-animating');
          autoBox.classList.toggle('visible', !isAdvisor);
        }
      }
      _agentModeLastAdvisor = isAdvisor;
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

    const PANEL_VIEW_STORAGE_KEY = 'ag_panel_view_mode_v1';
    const LITE_HW_MASK_STORAGE_KEY = 'ag_lite_hw_mask_v1';
    let _liteLastHwMask = null;

    function applyPanelViewModeDom(mode, syncStorage) {
      const valid = 'full';
      if (document.body) {
        document.body.setAttribute('data-panel-view', valid);
      }
      if (syncStorage) {
        try {
          localStorage.setItem(PANEL_VIEW_STORAGE_KEY, valid);
        } catch {}
      }
      if (typeof syncSmartComposerSizeAndScroll === 'function') {
        syncSmartComposerSizeAndScroll();
      }
      return valid;
    }

    function setPanelViewMode() {
      const valid = applyPanelViewModeDom('full', true);
      wizDraft.panelViewMode = valid;
      wizViewModePreviewDirty = false;
      void updateState({ panelViewMode: valid });
      flushVisibleBlockRenders();
      for (let i = 0; i < DEFAULT_PANEL_BLOCK_ORDER.length; i++) {
        maybeLoadMissingSectionsForBlock(DEFAULT_PANEL_BLOCK_ORDER[i]);
      }
      void pollTelemetryTick();
      if (typeof renderGuardDock === 'function') {
        renderGuardDock(lastPayloadCache ? lastPayloadCache.guardPulse : null);
      }
    }

    const PANEL_FULL_TAB_STORAGE_KEY = 'tunnel.panelFullTab';
    let _panelFullTabUserSelected = false;
    let _panelFullTabActiveLocal = null;
    const VALID_PANEL_FULL_TABS = new Set(['cockpit', 'behavior', 'economy', 'hardware', 'bugs', 'memory', 'settings']);
    const LEGACY_PANEL_FULL_TAB_MAP = {
      core: 'settings',
      all: 'cockpit',
    };
    const FULL_TAB_OWNED_BLOCKS = {
      cockpit: ['smartComposerCard'],
      behavior: ['agentModeCard', 'skillProfilesFieldset', 'swarmBehaviorCard'],
      economy: ['swarmTelemetryCard'],
      hardware: ['gpuRamCard', 'expertRamGpuFieldset'],
      bugs: ['sentinelSectionCard', 'checkpointsCard', 'intelligenceBayesianCard', 'expertCircuitBox', 'expertPitfallsBox'],
      memory: ['memoryContextCard', 'expertKnowledgeBox'],
      settings: ['skillsSectionCard', 'expertGuardrailsCard', 'expertProfileCard'],
    };

    let _bugsSubTabActive = 'snaps';
    let _memorySubTabActive = 'recipes';

    function setBugsSubTab(sub) {
      const valid = (sub === 'fragile' || sub === 'pitfalls') ? sub : 'snaps';
      _bugsSubTabActive = valid;
      if (document.body) {
        document.body.setAttribute('data-bugs-subtab', valid);
      }
      document.querySelectorAll('#bugsSubTabsBar [data-bugs-tab]').forEach(function (btn) {
        const on = btn.getAttribute('data-bugs-tab') === valid;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (typeof refreshBlockVisibilityObserver === 'function') refreshBlockVisibilityObserver();
      if (typeof flushVisibleBlockRenders === 'function') flushVisibleBlockRenders();
      if (valid === 'pitfalls') {
        if (typeof maybeLoadMissingSectionsForBlock === 'function') maybeLoadMissingSectionsForBlock('expertPitfallsBox');
        renderPitfalls();
      } else if (valid === 'fragile') {
        if (typeof maybeLoadMissingSectionsForBlock === 'function') maybeLoadMissingSectionsForBlock('intelligenceBayesianCard');
      } else {
        if (typeof maybeLoadMissingSectionsForBlock === 'function') maybeLoadMissingSectionsForBlock('checkpointsCard');
      }
      if (typeof scheduleSyncAllSlidingPills === 'function') scheduleSyncAllSlidingPills();
    }

    function setMemorySubTab(sub) {
      const valid = (sub === 'instincts' || sub === 'peers') ? sub : 'recipes';
      _memorySubTabActive = valid;
      if (document.body) {
        document.body.setAttribute('data-memory-subtab', valid);
      }
      document.querySelectorAll('#memorySubTabsBar [data-memory-tab]').forEach(function (btn) {
        const on = btn.getAttribute('data-memory-tab') === valid;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (valid === 'instincts' && typeof loadProjectInstincts === 'function') {
        void loadProjectInstincts({ silent: true });
      }
      if (typeof scheduleSyncAllSlidingPills === 'function') scheduleSyncAllSlidingPills();
    }

    function normalizePanelFullTab(rawTab) {
      const s = typeof rawTab === 'string' ? rawTab.trim().toLowerCase() : '';
      const mapped = LEGACY_PANEL_FULL_TAB_MAP[s] || s;
      return VALID_PANEL_FULL_TABS.has(mapped) ? mapped : 'cockpit';
    }

    function getFullTabForElementId(elId) {
      const id = String(elId || '').trim();
      if (!id) return 'cockpit';
      const el = document.getElementById(id);
      if (el && typeof el.closest === 'function') {
        const host = el.closest('[data-tab-panel]');
        const attrTab = host && typeof host.getAttribute === 'function' ? host.getAttribute('data-tab-panel') : '';
        if (attrTab && VALID_PANEL_FULL_TABS.has(attrTab)) return attrTab;
      }
      const tabKeys = Object.keys(FULL_TAB_OWNED_BLOCKS);
      for (let i = 0; i < tabKeys.length; i++) {
        if (FULL_TAB_OWNED_BLOCKS[tabKeys[i]].indexOf(id) !== -1) {
          return tabKeys[i];
        }
      }
      let cur = el ? el.parentElement : null;
      while (cur) {
        if (cur.id) {
          for (let i = 0; i < tabKeys.length; i++) {
            if (FULL_TAB_OWNED_BLOCKS[tabKeys[i]].indexOf(cur.id) !== -1) {
              return tabKeys[i];
            }
          }
        }
        cur = cur.parentElement;
      }
      return 'cockpit';
    }

    function applyPanelFullTabDom(tab, syncStorage) {
      let raw = tab;
      if (!raw) {
        try {
          raw = localStorage.getItem(PANEL_FULL_TAB_STORAGE_KEY) || '';
        } catch {}
      }
      const valid = normalizePanelFullTab(raw);
      _panelFullTabActiveLocal = valid;
      if (document.body) {
        document.body.setAttribute('data-full-tab', valid);
        if (!document.body.getAttribute('data-bugs-subtab')) {
          document.body.setAttribute('data-bugs-subtab', _bugsSubTabActive);
        }
        if (!document.body.getAttribute('data-memory-subtab')) {
          document.body.setAttribute('data-memory-subtab', _memorySubTabActive);
        }
      }
      document.querySelectorAll('#fullTabsBar [data-full-tab]').forEach(function (btn) {
        const active = btn.getAttribute('data-full-tab') === valid;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (syncStorage) {
        try {
          localStorage.setItem(PANEL_FULL_TAB_STORAGE_KEY, valid);
        } catch {}
      }
      if (valid === 'cockpit' && typeof syncSmartComposerSizeAndScroll === 'function') {
        syncSmartComposerSizeAndScroll();
      }
      if (typeof scheduleSyncAllSlidingPills === 'function') {
        scheduleSyncAllSlidingPills();
      }
      if (typeof ensureHwB4Loop === 'function') {
        ensureHwB4Loop();
      }
      return valid;
    }

    function setPanelFullTab(tab, opts) {
      _panelFullTabUserSelected = true;
      const valid = applyPanelFullTabDom(tab, true);
      _panelFullTabActiveLocal = valid;
      if (!opts || !opts.preserveScroll) {
        const wbScroller = document.querySelector('.full-workspace-shell > .window-body');
        if (wbScroller) wbScroller.scrollTop = 0;
      }
      if (currentState && typeof currentState === 'object') {
        currentState.panelFullTab = valid;
      }
      void updateState({ panelFullTab: valid });
      if (typeof refreshBlockVisibilityObserver === 'function') refreshBlockVisibilityObserver();
      if (typeof flushVisibleBlockRenders === 'function') flushVisibleBlockRenders();
      if (typeof maybeLoadMissingSectionsForBlock === 'function') {
        const owned = FULL_TAB_OWNED_BLOCKS[valid] || [];
        for (let i = 0; i < owned.length; i++) {
          maybeLoadMissingSectionsForBlock(owned[i]);
        }
      }
      if (valid === 'memory' && typeof loadProjectInstincts === 'function') {
        void loadProjectInstincts({ silent: true });
      }
      if (valid === 'bugs' && typeof refreshGatesStatus === 'function') {
        void refreshGatesStatus({ silent: true });
      }
      if (valid !== 'cockpit' && typeof pollTelemetryTick === 'function') {
        void pollTelemetryTick();
      }
      if (!opts || !opts.silent) {
        const tabLabels = {
          cockpit: L('Раздел: Умный чат ✓', 'Tab: Smart Chat ✓'),
          behavior: L('Раздел: Поведение ✓', 'Tab: Behavior ✓'),
          economy: L('Раздел: Статистика ✓', 'Tab: Stats ✓'),
          hardware: L('Раздел: ПК ✓', 'Tab: PC ✓'),
          bugs: L('Раздел: Баги ✓', 'Tab: Bugs ✓'),
          memory: L('Раздел: Память ✓', 'Tab: Memory ✓'),
          settings: L('Раздел: Настройки ✓', 'Tab: Settings ✓'),
        };
        flashStatus(tabLabels[valid] || tabLabels.cockpit);
      }
    }

    const PANEL_UI_SCALE_STORAGE_KEY = 'tunnel.panelUiScale';
    const PANEL_UI_SCALE_CYCLE = ['auto', '100', '115', '130', '90'];
    let _activePanelUiScaleMode = 'auto';

    function normalizePanelUiScale(rawScale) {
      const s = (typeof rawScale === 'string' || typeof rawScale === 'number')
        ? String(rawScale).trim().toLowerCase()
        : '';
      return (s === '90' || s === '100' || s === '115' || s === '130' || s === 'auto') ? s : 'auto';
    }

    function computeAutoUiScale(metricsOverride) {
      const m = (metricsOverride && typeof metricsOverride === 'object') ? metricsOverride : null;
      const winObj = typeof window !== 'undefined' ? window : null;
      const dpr = Math.max(1, Number(m ? m.devicePixelRatio : (winObj && winObj.devicePixelRatio)) || 1);
      const rawScreenW = Number(m ? m.screenWidth : (winObj && winObj.screen && winObj.screen.width)) || 0;
      const rawScreenH = Number(m ? m.screenHeight : (winObj && winObj.screen && winObj.screen.height)) || 0;
      const vpW = Number(m ? m.innerWidth : (winObj && winObj.innerWidth)) || 0;
      const vpH = Number(m ? m.innerHeight : (winObj && winObj.innerHeight)) || 0;
      const screenW = Math.max(rawScreenW, vpW);
      const screenH = Math.max(rawScreenH, vpH);
      if (screenW <= 0) return 1;

      const physW = Math.round(screenW * dpr);
      const physH = Math.round(screenH * dpr);
      let scale = 1;

      if (physW >= 3400 || physH >= 1900) {
        if (dpr <= 1.1) scale = 1.25;
        else if (dpr <= 1.6) scale = 1.14;
        else scale = 1.04;
      } else if (physW >= 2400 || physH >= 1350) {
        if (dpr <= 1.1) scale = 1.12;
        else if (dpr <= 1.35) scale = 1.06;
        else scale = 1.0;
      }

      if (vpW > 0 && vpW < 360) {
        scale = Math.min(scale, 1.06);
      }
      return Math.round(scale * 100) / 100;
    }

    function applyPanelUiScaleDom(mode, syncStorage) {
      const valid = normalizePanelUiScale(mode);
      _activePanelUiScaleMode = valid;
      const factor = valid === 'auto' ? computeAutoUiScale() : Number(valid) / 100;
      if (document.documentElement && document.documentElement.style) {
        if (typeof document.documentElement.style.setProperty === 'function') {
          document.documentElement.style.setProperty('--panel-ui-scale', String(factor));
        } else {
          document.documentElement.style['--panel-ui-scale'] = String(factor);
        }
      }
      if (document.body) {
        document.body.setAttribute('data-panel-scale', valid);
      }
      const pct = Math.round(factor * 100);
      const btnText = valid === 'auto'
        ? (pct === 100 ? L('Авто', 'Auto') : (L('Авто ', 'Auto ') + pct + '%'))
        : (valid + '%');
      const scaleBtnIds = ['panelUiScaleBtn', 'pgUiScaleBtn'];
      for (let i = 0; i < scaleBtnIds.length; i++) {
        const btn = document.getElementById(scaleBtnIds[i]);
        if (btn) {
          btn.textContent = btnText;
          btn.setAttribute('data-scale-factor', String(factor));
        }
      }
      if (syncStorage) {
        try {
          localStorage.setItem(PANEL_UI_SCALE_STORAGE_KEY, valid);
        } catch {}
      }
      if (typeof syncSmartComposerSizeAndScroll === 'function') {
        syncSmartComposerSizeAndScroll();
      }
      if (typeof syncFullLeftRailStickyOffset === 'function') {
        syncFullLeftRailStickyOffset();
      }
      if (typeof pgState === 'object' && pgState && pgState.open) {
        try {
          if (typeof pgSyncCanvasSize === 'function') pgSyncCanvasSize();
          if (typeof pgDrawGraph === 'function') pgDrawGraph();
        } catch {}
      }
      return valid;
    }

    function setPanelUiScale(mode) {
      const valid = applyPanelUiScaleDom(mode, true);
      if (currentState && typeof currentState === 'object') {
        currentState.panelUiScale = valid;
      }
      void updateState({ panelUiScale: valid });
      const label = valid === 'auto'
        ? L('Авто (', 'Auto (') + Math.round(computeAutoUiScale() * 100) + '%)'
        : (valid + '%');
      flashStatus(L('Масштаб интерфейса: ', 'UI scale: ') + label + ' ✓');
    }

    function cyclePanelUiScale() {
      const cur = normalizePanelUiScale((currentState && currentState.panelUiScale) || _activePanelUiScaleMode);
      const idx = PANEL_UI_SCALE_CYCLE.indexOf(cur);
      const next = PANEL_UI_SCALE_CYCLE[(idx + 1) % PANEL_UI_SCALE_CYCLE.length];
      setPanelUiScale(next);
    }

    function readLiteHwMask() {
      if (_liteLastHwMask && (_liteLastHwMask.ram || _liteLastHwMask.gpu)) {
        return _liteLastHwMask;
      }
      try {
        const raw = localStorage.getItem(LITE_HW_MASK_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && (parsed.ram || parsed.gpu)) {
            _liteLastHwMask = { ram: Boolean(parsed.ram), gpu: Boolean(parsed.gpu) };
            return _liteLastHwMask;
          }
        }
      } catch {}
      return { ram: true, gpu: true };
    }

    function saveLiteHwMask(ramOn, gpuOn) {
      if (!ramOn && !gpuOn) return;
      _liteLastHwMask = { ram: Boolean(ramOn), gpu: Boolean(gpuOn) };
      try {
        localStorage.setItem(LITE_HW_MASK_STORAGE_KEY, JSON.stringify(_liteLastHwMask));
      } catch {}
    }

    function toggleLiteRamGpuMaster() {
      const ramOn = currentState.ramCacheEnabled !== false;
      const gpuOn = Boolean(currentState.gpuEnabled);
      if (ramOn || gpuOn) {
        saveLiteHwMask(ramOn, gpuOn);
        void updateState({ ramCacheEnabled: false, gpuEnabled: false });
        flashStatus(L('RAM + GPU на паузе', 'RAM + GPU paused'));
        return;
      }
      const mask = readLiteHwMask();
      const nextRam = mask.ram || !mask.gpu;
      const nextGpu = Boolean(mask.gpu);
      void updateState({ ramCacheEnabled: nextRam, gpuEnabled: nextGpu });
      flashStatus(L('RAM + GPU включены ✓', 'RAM + GPU enabled ✓'));
    }

    function applyOptimisticHwToggle(patch, chkId, chkVal) {
      if (currentState && typeof currentState === 'object') {
        Object.assign(currentState, patch);
      }
      if (chkId) {
        const chkEl = document.getElementById(chkId);
        if (chkEl) chkEl.checked = Boolean(chkVal);
      }
      if (typeof syncTogglePresetsUi === 'function') {
        syncTogglePresetsUi(currentState);
      }
      if (_lastHwRenderCtx && typeof updateLiveHardwareOpticalUi === 'function') {
        updateLiveHardwareOpticalUi(
          _lastHwRenderCtx.gpu,
          _lastHwRenderCtx.ollResolved,
          _lastHwRenderCtx.ramCache,
          currentState,
          _lastHwRenderCtx.capGb,
          _lastHwRenderCtx.ramBudgetMb,
          _lastHwRenderCtx.cpu
        );
      }
      void updateState(patch);
    }

    function toggleLiteRamOnly() {
      const nextRam = currentState.ramCacheEnabled === false;
      const curGpu = Boolean(currentState.gpuEnabled);
      if (nextRam || curGpu) saveLiteHwMask(nextRam, curGpu);
      applyOptimisticHwToggle({ ramCacheEnabled: nextRam }, 'chk-ramCacheEnabled', nextRam);
      flashStatus(nextRam ? L('RAM-кэш включён ✓', 'RAM cache enabled ✓') : L('RAM-кэш выключен', 'RAM cache disabled'));
    }

    function toggleLiteGpuOnly() {
      const curRam = currentState.ramCacheEnabled !== false;
      const nextGpu = !Boolean(currentState.gpuEnabled);
      if (curRam || nextGpu) saveLiteHwMask(curRam, nextGpu);
      applyOptimisticHwToggle({ gpuEnabled: nextGpu }, 'chk-gpuEnabled', nextGpu);
      flashStatus(nextGpu ? L('Локальный GPU включён ✓', 'Local GPU enabled ✓') : L('Локальный GPU выключен', 'Local GPU disabled'));
    }

    function toggleLiteCpuOnly() {
      const nextCpu = currentState.cpuMulticoreEnabled === false;
      applyOptimisticHwToggle({ cpuMulticoreEnabled: nextCpu }, 'chk-cpuMulticoreEnabled', nextCpu);
      flashStatus(nextCpu ? L('CPU-пул потоков включён ✓', 'CPU thread pool enabled ✓') : L('CPU-пул потоков выключен', 'CPU thread pool disabled'));
    }

    function toggleOption(key, val) {
      if (currentState && typeof currentState === 'object') {
        currentState[key] = Boolean(val);
      }
      if (typeof syncTogglePresetsUi === 'function') {
        syncTogglePresetsUi(currentState);
      }
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
        if (typeof refreshSidecarOpenWorkspacesFast === 'function') {
          await refreshSidecarOpenWorkspacesFast(false);
        }
        _loadedPanelSections.clear();
        const res = await panelFetch('/api/state?adaptive=1', { method: 'GET' });
        const data = await res.json();
        if (!res || !res.ok || !data || typeof data !== 'object' || data.error || data.ok === false) {
          throw new Error((data && data.error) ? data.error : L('Ошибка ответа сервера', 'Server response error'));
        }
        renderPayload(data);
        telemetryLastSig = buildTelemetrySignature(data);
        if (!_loadedPanelSections.has('hw')) {
          void ensurePanelSectionsLoaded(['hw']);
        }
        if (!silent) {
          flashStatus(L('Телеметрия, ROI и скиллы обновлены ✓', 'Telemetry, ROI & skills updated ✓'));
        }
      } catch (e) {
        console.error('Refresh error:', e);
      } finally {
        scheduleTelemetryPoll();
      }
    }

    async function rollbackLastCheckpoint() {
      try {
        flashStatus(L('Откат последней правки...', 'Rolling back last edit...'));
        const res = await panelFetch('/api/rollback', {
          method: 'POST',
          body: JSON.stringify({ checkpointId: 'latest' }),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus(L('Откат выполнен успешно ✓', 'Rollback completed ✓'));
          await refreshAll({ silent: true });
        } else {
          flashStatus(L('Откат: ', 'Rollback: ') + (result ? (result.message || result.error) : L('нет снимков', 'no snapshots')));
        }
      } catch (err) {
        flashStatus(L('Ошибка при вызове отката!', 'Error invoking rollback!'));
      }
    }

    async function rollbackSpecific(cpId, wsRoot) {
      try {
        flashStatus(L('Откат чекпоинта...', 'Rolling back snapshot...'));
        const payload = { checkpointId: cpId };
        if (wsRoot) payload.rootDir = wsRoot;
        const res = await panelFetch('/api/rollback', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus(L('Снимок ', 'Snapshot ') + cpId + L(' восстановлен ✓', ' restored ✓'));
          await refreshAll({ silent: true });
        } else {
          flashStatus(L('Ошибка отката: ', 'Rollback error: ') + (result ? (result.message || result.error) : L('сбой', 'failed')));
        }
      } catch (err) {
        flashStatus(L('Ошибка вызова rollback!', 'Error calling rollback!'));
      }
    }

    function setCheckpointsViewMode(mode) {
      _checkpointsViewMode = mode === 'files' ? 'files' : 'turns';
      renderCheckpoints();
    }

    async function rollbackTurnById(turnId, wsRoot) {
      try {
        flashStatus(L('Откат всех правок хода...', 'Rolling back turn edits...'));
        const payload = { turnId: turnId || 'latest' };
        if (wsRoot) payload.rootDir = wsRoot;
        const res = await panelFetch('/api/checkpoints/rollback-turn', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false) {
          flashStatus(L('Откат хода выполнен (', 'Turn rolled back (') + (result.count || 0) + L(' ф.) ✓', ' f.) ✓'));
          _activeTurnDiffPreview = null;
          await refreshAll({ silent: true });
        } else {
          flashStatus(L('Откат хода: ', 'Turn rollback: ') + (result ? (result.error || L('нет снимков', 'no snapshots')) : L('сбой', 'failed')));
        }
      } catch {
        flashStatus(L('Ошибка вызова rollback-turn!', 'Error calling rollback-turn!'));
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
          flashStatus(L('Ход: +', 'Turn: +') + (data.totalAdded || 0) + '/-' + (data.totalRemoved || 0) + L(' строк (', ' lines (') + ((data.files && data.files.length) || 0) + L(' ф.)', ' f.)'));
        }
      } catch {}
    }

    async function worktreeAction(mode, id) {
      try {
        flashStatus(mode === 'create'
          ? L('Создание Git-песочницы...', 'Creating Git sandbox...')
          : mode === 'promote'
            ? L('Перенос правок из песочницы...', 'Applying sandbox edits...')
            : L('Обновление Git-песочницы...', 'Updating Git sandbox...'));
        const res = await panelFetch('/api/worktree/action', {
          method: 'POST',
          body: JSON.stringify({ action: mode || 'list', id: id || '' }),
        });
        const data = await res.json();
        if (Array.isArray(data && data.worktrees)) {
          renderShadowWorktrees(data.worktrees);
        }
        if (res && res.ok && data && data.ok !== false) {
          flashStatus(mode === 'promote'
            ? L('Правки перенесены с чекпоинтом ✓', 'Edits applied with snapshot ✓')
            : mode === 'create'
              ? L('Git-песочница создана ✓', 'Git sandbox created ✓')
              : L('Песочница обновлена ✓', 'Sandbox updated ✓'));
          if (mode === 'promote') await refreshAll({ silent: true });
        } else {
          flashStatus('Worktree: ' + ((data && data.error) || L('операция не выполнена', 'operation failed')));
        }
      } catch {
        flashStatus(L('Ошибка обращения к Git-песочнице!', 'Error accessing Git sandbox!'));
      }
    }

    async function resetCircuitBreaker() {
      try {
        flashStatus(L('Сброс автомата Circuit Breaker...', 'Resetting Circuit Breaker...'));
        const res = await panelFetch('/api/circuit-reset', { method: 'POST' });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ? data.error : L('Сбой сброса', 'Reset failed'));
        }
        if (data.circuitBreaker) {
          renderCircuitBreaker(data.circuitBreaker);
        }
        flashStatus(L('Circuit Breaker сброшен в НОРМУ ✓', 'Circuit Breaker reset to OK ✓'));
        await refreshAll({ silent: true });
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка сброса Circuit Breaker!', 'Error resetting Circuit Breaker!'));
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
        metaEl.textContent = L('Отключён', 'Disabled');
        domEl.textContent = L('Bayesian v2 приостановлен пользователем.', 'Bayesian v2 paused by user.');
        fragileEl.innerHTML = '';
        return;
      }
      if (!bayesian) {
        metaEl.textContent = L('Нет данных', 'No data');
        return;
      }

      const conf = Number(bayesian.overallConfidencePercent ?? 0);
      const runs = Number(bayesian.totalRuns ?? 0);
      const fpPct = bayesian.overallFirstPassPercent !== undefined ? Number(bayesian.overallFirstPassPercent) : null;
      const expTurns = bayesian.overallExpectedTurns !== undefined ? Number(bayesian.overallExpectedTurns) : null;
      const shortFp = fpPct !== null ? (L(' · 1-й проход: ', ' · 1st-pass: ') + fpPct + '%') : '';
      metaEl.textContent = L('Доверие: ', 'Trust: ') + conf + '%' + shortFp;
      const detailParts = [L('Запусков: ', 'Runs: ') + runs];
      if (expTurns !== null) detailParts.push('~' + expTurns.toFixed(1) + L(' итер.', ' iter.'));
      if (Number(bayesian.contextualUpdates || 0) > 0) detailParts.push(L('конт. модель: ', 'ctx model: ') + Number(bayesian.contextualUpdates));
      metaEl.title = detailParts.join(' · ');

      const domainsRaw = Array.isArray(bayesian.domains)
        ? bayesian.domains
        : Object.entries(bayesian.domains || {}).map(([name, info]) => ({ name, ...(info || {}) }));
      const topDomains = [...domainsRaw]
        .filter((d) => Number(d?.runs || 0) > 0 || Number(d?.confidencePercent || 0) > 0)
        .sort((a, b) => Number(b?.runs || 0) - Number(a?.runs || 0))
        .slice(0, 6);
      domEl.textContent = topDomains.length > 0
        ? L('Домены: ', 'Domains: ') + topDomains.map((d) => {
            const label = pickText(d, 'label', 'labelEn', d.name || d.domain || d.key || L('Общий', 'General'));
            const fpPart = (Number(d.runs || 0) > 0 && d.firstPassPercent !== undefined) ? (L(', 1п:', ', 1p:') + Number(d.firstPassPercent) + '%') : '';
            return label + ' (' + (d.confidencePercent ?? 0) + '%' + fpPart + ')';
          }).join(' · ')
        : (L('Домены: базовый априорный профиль (', 'Domains: baseline prior profile (') + conf + '%)');

      const fragile = Array.isArray(bayesian.fragileFiles) ? bayesian.fragileFiles : [];
      const fragileCountEl = document.getElementById('bugsTabCountFragile');
      if (fragileCountEl) {
        fragileCountEl.textContent = fragile.length > 0 ? String(fragile.length) : '';
      }
      if (fragile.length === 0) {
        fragileEl.innerHTML = '<span style="color: var(--status-ok); font-weight:600;">' + L('✓ Хрупких файлов с повторными сбоями не зафиксировано', '✓ No fragile files with repeat failures recorded') + '</span>';
      } else {
        fragileEl.innerHTML =
          fragile
            .map((f) => {
              const isCrit = f.reliabilityPercent < 60;
              const pillCls = isCrit ? 'bento-risk-pill is-err' : 'bento-risk-pill is-warn';
              const deps = f.dependentsCount > 0 ? (' · ' + Number(f.dependentsCount) + L(' св.', ' deps')) : '';
              const fullTitle = L('Надёжность ', 'Reliability ') + Number(f.reliabilityPercent) + '% · ' + L('сбоев ', 'fails ') + Number(f.failures || 0) + '/' + Number(f.runs || 0) + (f.dependentsCount > 0 ? (L(' · связей: ', ' · deps: ') + Number(f.dependentsCount)) : '');
              return (
                '<div class="bento-list-row" title="' + escHtml(fullTitle) + '">' +
                  '<code class="bento-file-path">' + escHtml(f.file) + '</code>' +
                  '<span class="' + pillCls + '">' + Number(f.reliabilityPercent) + '%' + deps + '</span>' +
                '</div>'
              );
            })
            .join('');
      }
    }

    async function resetWorkspaceFragility() {
      try {
        flashStatus(L('Сброс хрупкости файлов выбранного проекта...', 'Resetting workspace file fragility...'));
        const res = await panelFetch('/api/bayesian-reset', {
          method: 'POST',
          body: JSON.stringify({ onlyFragility: true }),
        });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ? data.error : L('Сбой сброса', 'Reset failed'));
        }
        if (data.summary) {
          renderBayesian(data.summary, currentState);
        }
        flashStatus(L('Хрупкость файлов проекта сброшена ✓', 'Workspace file fragility reset ✓'));
        await refreshAll({ silent: true });
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка сброса хрупкости проекта!', 'Error resetting workspace fragility!'));
      }
    }

    async function resetBayesianPriors() {
      try {
        flashStatus(L('Сброс весов Байесовского доверия...', 'Resetting Bayesian confidence priors...'));
        const res = await panelFetch('/api/bayesian-reset', { method: 'POST' });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ? data.error : L('Сбой сброса', 'Reset failed'));
        }
        if (data.summary) {
          renderBayesian(data.summary, currentState);
        }
        flashStatus(L('Веса доверия сброшены к базовым ✓', 'Bayesian confidence priors reset ✓'));
        await refreshAll({ silent: true });
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка сброса весов доверия!', 'Error resetting confidence weights!'));
      }
    }

    async function compactDigest() {
      try {
        flashStatus(L('Сборка дайджеста контекста...', 'Building context digest...'));
        const res = await panelFetch('/api/compact-digest', {
          method: 'POST',
          body: JSON.stringify({ manual: true }),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus(L('Дайджест контекста собран ✓', 'Context digest built ✓'));
          await refreshAll({ silent: true });
        } else {
          flashStatus(L('Дайджест: ', 'Digest: ') + (result ? (result.message || result.error) : L('ошибка', 'error')));
        }
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка сборки дайджеста!', 'Error building digest!'));
      }
    }

    async function refreshRepoMap() {
      try {
        flashStatus(L('Обновление AST-карты проекта...', 'Refreshing project AST RepoMap...'));
        const res = await panelFetch('/api/repomap', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus(L('Карта проекта обновлена ✓', 'RepoMap updated ✓'));
        } else {
          flashStatus(L('Карта проекта: ', 'RepoMap: ') + (result ? (result.message || result.error) : L('ошибка', 'error')));
        }
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка обновления карты проекта!', 'Error refreshing RepoMap!'));
      }
    }

    async function clearPitfalls() {
      try {
        flashStatus(L('Очистка реестра граблей...', 'Clearing pitfall ledger...'));
        const res = await panelFetch('/api/pitfalls-clear', { method: 'POST' });
        const result = await res.json();
        if (res && res.ok && result && result.ok !== false && !result.error) {
          flashStatus(L('Реестр граблей очищен ✓', 'Pitfall ledger cleared ✓'));
          renderPitfalls([]);
          await refreshAll({ silent: true });
        } else {
          flashStatus(L('Ошибка очистки граблей!', 'Error clearing pitfalls!'));
        }
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка очистки реестра!', 'Error clearing pitfall ledger!'));
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
          flashStatus(L('Рецепты побед очищены ✓', 'Win recipes cleared ✓'));
        }
      } catch {}
    }

    async function addFederatedPeer() {
      const inp = document.getElementById('federatedPeerInput');
      const val = inp ? String(inp.value || '').trim() : '';
      if (!val) {
        flashStatus(L('Укажите путь к папке связанного репозитория', 'Enter the path to the companion repository'));
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
          flashStatus(L('Репозиторий связан ✓', 'Repository linked ✓'));
        } else {
          flashStatus(L('Федерация: ', 'Federation: ') + ((result && result.error) || L('папка не найдена', 'folder not found')));
        }
      } catch {
        flashStatus(L('Ошибка привязки репозитория', 'Error linking repository'));
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
          flashStatus(L('Связь удалена ✓', 'Link removed ✓'));
        } else {
          flashStatus(L('Федерация: ', 'Federation: ') + ((result && result.error) || L('не удалось удалить связь', 'failed to remove link')));
        }
      } catch {
        flashStatus(L('Ошибка удаления связи репозитория', 'Error removing repository link'));
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

    const HOOK_PROFILE_DEFAULT_FALSE_KEYS = new Set([
      'mutationGuardEnabled',
      'composerVoiceEnabled',
      'sentinelShadowTests',
    ]);

    function applyHookProfileOverridesToUi(profile, stateObj) {
      const clean = (profile === 'minimal' || profile === 'strict') ? profile : 'standard';
      const overrides = HOOK_PROFILE_UI_OVERRIDES[clean] || {};
      const st = (stateObj && typeof stateObj === 'object') ? stateObj : (currentState || {});
      const profLabel = clean === 'minimal' ? L('Лёгкий', 'Minimal') : L('Строгий', 'Strict');
      for (let i = 0; i < HOOK_PROFILE_OVERRIDE_KEYS.length; i++) {
        const key = HOOK_PROFILE_OVERRIDE_KEYS[i];
        const el = document.getElementById('chk-' + key);
        if (!el) continue;
        const row = el.closest ? el.closest('label') : null;
        if (row && !row.hasAttribute('data-orig-title-saved')) {
          const i18nOrig = (typeof I18N_ORIG_ATTRS !== 'undefined' && I18N_ORIG_ATTRS.get(row)) ? I18N_ORIG_ATTRS.get(row).title : '';
          const rawTitle = i18nOrig || row.getAttribute('title') || '';
          const ruTitle = rawTitle;
          const enTitle = (typeof translateUiString === 'function' && typeof UI_RU_TO_EN_ATTR !== 'undefined' && /[А-Яа-яЁё]/.test(ruTitle))
            ? translateUiString(ruTitle, UI_RU_TO_EN_ATTR)
            : ruTitle;
          row.setAttribute('data-orig-title-ru', ruTitle);
          row.setAttribute('data-orig-title-en', enTitle);
          row.setAttribute('data-orig-title-saved', '1');
        }
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          el.checked = Boolean(overrides[key]);
          el.disabled = true;
          if (row) {
            row.setAttribute('title', L('Управляется активным профилем хуков («' + profLabel + '»)', 'Managed by active hook profile ("' + profLabel + '")'));
          }
        } else {
          el.disabled = false;
          el.checked = HOOK_PROFILE_DEFAULT_FALSE_KEYS.has(key) ? Boolean(st[key]) : st[key] !== false;
          if (row) {
            const origTitle = L(
              row.getAttribute('data-orig-title-ru') || '',
              row.getAttribute('data-orig-title-en') || row.getAttribute('data-orig-title-ru') || ''
            );
            if (origTitle) row.setAttribute('title', origTitle);
            else row.removeAttribute('title');
          }
        }
      }
      if (typeof syncTogglePresetsUi === 'function') {
        syncTogglePresetsUi(st);
      }
      if (typeof syncUnifiedPresetUi === 'function') {
        syncUnifiedPresetUi(st);
      }
    }

    const TOGGLE_PRESET_GROUPS = {
      hw: {
        groupElId: null,
        customPillId: null,
        badgeElId: 'hwEnginesCountBadge',
        keys: [
          'gpuSemanticSearch', 'gpuAutoDistillLogs', 'gpuPostEditCritic',
          'cpuTrigramIndex', 'cpuCrossRerank', 'cpuParallelVerify',
          'cpuSotaEngines', 'ramSotaEngines', 'gpuWarmHostRamCache',
        ],
        presets: {
          eco: {
            gpuSemanticSearch: false,
            gpuAutoDistillLogs: true,
            gpuPostEditCritic: false,
            cpuTrigramIndex: true,
            cpuCrossRerank: false,
            cpuParallelVerify: false,
            cpuSotaEngines: false,
            ramSotaEngines: false,
            gpuWarmHostRamCache: false,
          },
          balanced: {
            gpuSemanticSearch: true,
            gpuAutoDistillLogs: true,
            gpuPostEditCritic: true,
            cpuTrigramIndex: true,
            cpuCrossRerank: true,
            cpuParallelVerify: true,
            cpuSotaEngines: true,
            ramSotaEngines: false,
            gpuWarmHostRamCache: false,
          },
          max: {
            gpuSemanticSearch: true,
            gpuAutoDistillLogs: true,
            gpuPostEditCritic: true,
            cpuTrigramIndex: true,
            cpuCrossRerank: true,
            cpuParallelVerify: true,
            cpuSotaEngines: true,
            ramSotaEngines: true,
            gpuWarmHostRamCache: true,
          },
        },
        labels: {
          eco: ['Ускорение: Эконом', 'Acceleration: Eco'],
          balanced: ['Ускорение: Баланс', 'Acceleration: Balanced'],
          max: ['Ускорение: Максимум', 'Acceleration: Max'],
        },
      },
      sentinel: {
        groupElId: 'sentinelPresetGroup',
        customPillId: 'sentinelPresetCustomPill',
        badgeElId: 'sentinelEnginesCountBadge',
        keys: [
          'sentinelEnabled', 'sentinelShadowGuard', 'sentinelLocalBugBot',
          'sentinelSymbolCards', 'sentinelSpeculativeWarm', 'sentinelShadowTests',
          'lspBridgeEnabled', 'runtimeWiretapEnabled',
        ],
        presets: {
          off: { sentinelEnabled: false },
          quiet: {
            sentinelEnabled: true,
            sentinelShadowGuard: true,
            sentinelLocalBugBot: false,
            sentinelSymbolCards: false,
            sentinelSpeculativeWarm: true,
            sentinelShadowTests: false,
            lspBridgeEnabled: true,
            runtimeWiretapEnabled: true,
          },
          full: {
            sentinelEnabled: true,
            sentinelShadowGuard: true,
            sentinelLocalBugBot: true,
            sentinelSymbolCards: true,
            sentinelSpeculativeWarm: true,
            sentinelShadowTests: false,
            lspBridgeEnabled: true,
            runtimeWiretapEnabled: true,
          },
          max: {
            sentinelEnabled: true,
            sentinelShadowGuard: true,
            sentinelLocalBugBot: true,
            sentinelSymbolCards: true,
            sentinelSpeculativeWarm: true,
            sentinelShadowTests: true,
            lspBridgeEnabled: true,
            runtimeWiretapEnabled: true,
          },
        },
        labels: {
          off: ['Дозор: Выкл', 'Sentinel: Off'],
          quiet: ['Дозор: Тихий', 'Sentinel: Quiet'],
          full: ['Дозор: Полный', 'Sentinel: Full'],
          max: ['Дозор: Максимум', 'Sentinel: Max'],
        },
      },
      intel: {
        groupElId: 'intelPresetGroup',
        customPillId: 'intelPresetCustomPill',
        badgeElId: 'intelBudgetCountBadge',
        keys: [
          'repoMap', 'pageRankGraph', 'zeroTurnSlices', 'sessionHandoff',
          'pitfallLedger', 'thinkingLimiter', 'bayesianRouter', 'toolPruning',
          'readDedup', 'obsMasking', 'historyCompaction', 'quotaPacerEnabled',
        ],
        presets: {
          base: {
            repoMap: true,
            pageRankGraph: false,
            zeroTurnSlices: true,
            sessionHandoff: true,
            pitfallLedger: true,
            thinkingLimiter: true,
            bayesianRouter: false,
            toolPruning: true,
            readDedup: true,
            obsMasking: true,
            historyCompaction: true,
            quotaPacerEnabled: false,
          },
          full: {
            repoMap: true,
            pageRankGraph: true,
            zeroTurnSlices: true,
            sessionHandoff: true,
            pitfallLedger: true,
            thinkingLimiter: true,
            bayesianRouter: true,
            toolPruning: true,
            readDedup: true,
            obsMasking: true,
            historyCompaction: true,
            quotaPacerEnabled: true,
          },
          raw: {
            repoMap: true,
            pageRankGraph: false,
            zeroTurnSlices: false,
            sessionHandoff: false,
            pitfallLedger: false,
            thinkingLimiter: false,
            bayesianRouter: false,
            toolPruning: false,
            readDedup: false,
            obsMasking: false,
            historyCompaction: false,
            quotaPacerEnabled: false,
          },
        },
        labels: {
          base: ['Разведка: Базовый', 'Intel: Basic'],
          full: ['Разведка: Полный', 'Intel: Full'],
          raw: ['Разведка: Без экономии', 'Intel: Raw'],
        },
      },
      safety: {
        groupElId: 'safetyPresetGroup',
        customPillId: 'safetyPresetCustomPill',
        badgeElId: 'safetyContoursCountBadge',
        keys: [
          'diffOnly', 'transactionalPatch', 'shadowCheckpoints', 'shadowWorktreeEnabled',
          'blastRadius', 'selfVerify', 'cascadeVerify', 'testImpactVerify',
          'circuitBreaker', 'securityGuard', 'configProtection', 'mutationGuardEnabled',
        ],
        presets: {
          light: {
            diffOnly: true,
            transactionalPatch: true,
            shadowCheckpoints: true,
            shadowWorktreeEnabled: false,
            blastRadius: false,
            selfVerify: true,
            cascadeVerify: false,
            testImpactVerify: false,
            circuitBreaker: true,
            securityGuard: true,
            configProtection: false,
            mutationGuardEnabled: false,
          },
          standard: {
            diffOnly: true,
            transactionalPatch: true,
            shadowCheckpoints: true,
            shadowWorktreeEnabled: true,
            blastRadius: true,
            selfVerify: true,
            cascadeVerify: true,
            testImpactVerify: true,
            circuitBreaker: true,
            securityGuard: true,
            configProtection: true,
            mutationGuardEnabled: false,
          },
          strict: {
            diffOnly: true,
            transactionalPatch: true,
            shadowCheckpoints: true,
            shadowWorktreeEnabled: true,
            blastRadius: true,
            selfVerify: true,
            cascadeVerify: true,
            testImpactVerify: true,
            circuitBreaker: true,
            securityGuard: true,
            configProtection: true,
            mutationGuardEnabled: true,
          },
        },
        labels: {
          light: ['Защита правок: Лёгкий', 'Edit Safety: Light'],
          standard: ['Защита правок: Стандарт', 'Edit Safety: Standard'],
          strict: ['Защита правок: Параноик', 'Edit Safety: Paranoid'],
        },
      },
    };

    function getEffectiveToggleFlag(key, stateObj) {
      const chk = document.getElementById('chk-' + key);
      if (chk) return Boolean(chk.checked);
      const st = (stateObj && typeof stateObj === 'object') ? stateObj : (currentState || {});
      return HOOK_PROFILE_DEFAULT_FALSE_KEYS.has(key) ? Boolean(st[key]) : st[key] !== false;
    }

    function syncTogglePresetsUi(stateObj) {
      const st = (stateObj && typeof stateObj === 'object') ? stateObj : (currentState || {});
      const groupKeys = Object.keys(TOGGLE_PRESET_GROUPS);
      for (let g = 0; g < groupKeys.length; g++) {
        const gKey = groupKeys[g];
        const cfg = TOGGLE_PRESET_GROUPS[gKey];
        if (!cfg) continue;

        const effectiveMap = Object.create(null);
        let activeCount = 0;
        for (let i = 0; i < cfg.keys.length; i++) {
          const k = cfg.keys[i];
          const val = getEffectiveToggleFlag(k, st);
          effectiveMap[k] = val;
          if (val) activeCount++;
        }

        const badgeEl = document.getElementById(cfg.badgeElId);
        if (badgeEl) {
          const shownCount = (gKey === 'sentinel' && !effectiveMap.sentinelEnabled) ? 0 : activeCount;
          badgeEl.textContent = shownCount + '/' + cfg.keys.length;
        }

        let matchedPreset = null;
        if (gKey === 'sentinel' && !effectiveMap.sentinelEnabled) {
          matchedPreset = 'off';
        } else {
          const presetIds = Object.keys(cfg.presets);
          for (let p = 0; p < presetIds.length; p++) {
            const pId = presetIds[p];
            if (gKey === 'sentinel' && pId === 'off') continue;
            const pMap = cfg.presets[pId];
            let allMatch = true;
            for (let i = 0; i < cfg.keys.length; i++) {
              const k = cfg.keys[i];
              if (Boolean(effectiveMap[k]) !== Boolean(pMap[k])) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) {
              matchedPreset = pId;
              break;
            }
          }
        }

        const btnGroup = cfg.groupElId ? document.getElementById(cfg.groupElId) : null;
        if (btnGroup) {
          btnGroup.querySelectorAll('button').forEach((btn) => {
            btn.classList.toggle('active', Boolean(matchedPreset) && btn.dataset.val === matchedPreset);
          });
        }
        const customPill = cfg.customPillId ? document.getElementById(cfg.customPillId) : null;
        if (customPill) {
          customPill.style.display = matchedPreset ? 'none' : 'inline-flex';
        }
      }
      syncUnifiedPresetUi(st);
      if (typeof scheduleSyncAllSlidingPills === 'function') {
        scheduleSyncAllSlidingPills();
      }
    }

    const UNIFIED_PRESETS = {
      eco: {
        hw: 'eco',
        sentinel: 'quiet',
        intel: 'base',
        safety: 'light',
        hookProfile: 'minimal',
        labelRu: 'Эконом',
        labelEn: 'Eco',
        summaryRu: 'Ускорение: Эконом · Дозор: Тихий · Хуки: Лёгкий · Разведка: Базовый · Защита: Лёгкий',
        summaryEn: 'Accel: Eco · Sentinel: Quiet · Hooks: Minimal · Intel: Basic · Safety: Light',
      },
      balance: {
        hw: 'balanced',
        sentinel: 'full',
        intel: 'full',
        safety: 'standard',
        hookProfile: 'standard',
        labelRu: 'Баланс',
        labelEn: 'Balance',
        summaryRu: 'Ускорение: Баланс · Дозор: Полный · Хуки: Стандарт · Разведка: Полный · Защита: Стандарт',
        summaryEn: 'Accel: Balanced · Sentinel: Full · Hooks: Standard · Intel: Full · Safety: Standard',
      },
      turbo: {
        hw: 'max',
        sentinel: 'max',
        intel: 'full',
        safety: 'strict',
        hookProfile: 'strict',
        labelRu: 'Турбо',
        labelEn: 'Turbo',
        summaryRu: 'Ускорение: Максимум · Дозор: Максимум · Хуки: Строгий · Разведка: Полный · Защита: Параноик',
        summaryEn: 'Accel: Max · Sentinel: Max · Hooks: Strict · Intel: Full · Safety: Paranoid',
      },
    };

    function detectUnifiedPreset(stateObj) {
      const st = (stateObj && typeof stateObj === 'object') ? stateObj : (currentState || {});
      const activeHookProf = (st.hookProfile === 'minimal' || st.hookProfile === 'strict') ? st.hookProfile : 'standard';
      const hookOverrides = HOOK_PROFILE_UI_OVERRIDES[activeHookProf] || {};
      const keys = ['eco', 'balance', 'turbo'];
      for (let idx = 0; idx < keys.length; idx++) {
        const pKey = keys[idx];
        const def = UNIFIED_PRESETS[pKey];
        if (def.hookProfile !== activeHookProf) continue;
        let matchesAll = true;
        const groups = ['hw', 'sentinel', 'intel', 'safety'];
        for (let g = 0; g < groups.length; g++) {
          const gName = groups[g];
          const cfg = TOGGLE_PRESET_GROUPS[gName];
          const targetMap = cfg && cfg.presets ? cfg.presets[def[gName]] : null;
          if (!cfg || !targetMap) {
            matchesAll = false;
            break;
          }
          for (let kIdx = 0; kIdx < cfg.keys.length; kIdx++) {
            const flagKey = cfg.keys[kIdx];
            const expectedVal = Object.prototype.hasOwnProperty.call(hookOverrides, flagKey)
              ? Boolean(hookOverrides[flagKey])
              : Boolean(targetMap[flagKey]);
            const actualVal = getEffectiveToggleFlag(flagKey, st);
            if (actualVal !== expectedVal) {
              matchesAll = false;
              break;
            }
          }
          if (!matchesAll) break;
        }
        if (matchesAll) return pKey;
      }
      return null;
    }

    function syncUnifiedPresetUi(stateObj) {
      const st = (stateObj && typeof stateObj === 'object') ? stateObj : (currentState || {});
      const matched = detectUnifiedPreset(st);
      document.querySelectorAll('#unifiedPresetGroup button[data-unified-preset]').forEach((btn) => {
        btn.classList.toggle('active', Boolean(matched) && btn.getAttribute('data-unified-preset') === matched);
      });
      const customPill = document.getElementById('unifiedPresetCustomPill');
      if (customPill) {
        customPill.style.display = matched ? 'none' : 'inline-flex';
      }
      const sumEl = document.getElementById('unifiedPresetSummary');
      const summaryText = (matched && UNIFIED_PRESETS[matched])
        ? L(UNIFIED_PRESETS[matched].summaryRu, UNIFIED_PRESETS[matched].summaryEn)
        : L('Своя связка · ', 'Custom mix · ') + (st.hookProfile === 'minimal'
            ? L('Хуки: Лёгкий', 'Hooks: Minimal')
            : (st.hookProfile === 'strict' ? L('Хуки: Строгий', 'Hooks: Strict') : L('Хуки: Стандарт', 'Hooks: Standard')));
      if (sumEl) {
        sumEl.textContent = summaryText;
      }
      const presetBarEl = document.getElementById('unifiedPresetBar');
      if (presetBarEl) {
        const tipVal = L('Единый профиль', 'Unified Profile') + ' · ' + summaryText;
        if (typeof setTooltipTitle === 'function') setTooltipTitle(presetBarEl, tipVal);
        else presetBarEl.title = tipVal;
      }
      if (typeof scheduleSyncAllSlidingPills === 'function') {
        scheduleSyncAllSlidingPills();
      }
    }

    function applyUnifiedPreset(presetKey) {
      const def = UNIFIED_PRESETS[presetKey];
      if (!def) return;
      const patch = Object.assign(
        {},
        TOGGLE_PRESET_GROUPS.hw.presets[def.hw],
        TOGGLE_PRESET_GROUPS.sentinel.presets[def.sentinel],
        TOGGLE_PRESET_GROUPS.intel.presets[def.intel],
        TOGGLE_PRESET_GROUPS.safety.presets[def.safety],
        { hookProfile: def.hookProfile }
      );
      if (currentState && typeof currentState === 'object') {
        Object.assign(currentState, patch);
      }
      const patchKeys = Object.keys(patch);
      for (let i = 0; i < patchKeys.length; i++) {
        const k = patchKeys[i];
        if (k === 'hookProfile') continue;
        const chk = document.getElementById('chk-' + k);
        if (chk) {
          chk.checked = Boolean(patch[k]);
        }
      }
      document.querySelectorAll('#hookProfileGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === def.hookProfile);
      });
      const hookProfileHintEl = document.getElementById('hookProfileHint');
      if (hookProfileHintEl) {
        if (def.hookProfile === 'minimal') {
          hookProfileHintEl.textContent = L(
            'Профиль «Лёгкий»: оставлены базовые щиты для максимальной скорости на простых правках.',
            '"Minimal" profile: keeps essential guards for maximum speed on quick edits.'
          );
        } else if (def.hookProfile === 'strict') {
          hookProfileHintEl.textContent = L(
            'Профиль «Строгий»: принудительно активны все щиты, LSP и защита конфигов линтеров.',
            '"Strict" profile: forces all shields, LSP, and linter config protection ON.'
          );
        } else {
          hookProfileHintEl.textContent = L(
            'Профиль «Стандарт»: действуют ваши индивидуальные переключатели контуров.',
            '"Standard" profile: uses your individual contour toggles below.'
          );
        }
      }
      applyHookProfileOverridesToUi(def.hookProfile, currentState);
      if (typeof syncSentinelCheckboxes === 'function') {
        syncSentinelCheckboxes(currentState);
      } else {
        syncTogglePresetsUi(currentState);
      }
      syncUnifiedPresetUi(currentState);
      void updateState(patch);
      if (typeof flashStatus === 'function') {
        flashStatus(L('Профиль «' + def.labelRu + '» применён ✓', 'Profile "' + def.labelEn + '" applied ✓'));
      }
    }

    function applyTogglePreset(spec) {
      const parts = String(spec || '').split(':');
      const gKey = parts[0] || '';
      const pId = parts[1] || '';
      const cfg = TOGGLE_PRESET_GROUPS[gKey];
      if (!cfg || !cfg.presets[pId]) return;

      const presetMap = cfg.presets[pId];
      const patch = Object.assign({}, presetMap);
      const patchKeys = Object.keys(patch);

      const st = (currentState && typeof currentState === 'object') ? currentState : {};
      const activeHookProf = (st.hookProfile === 'minimal' || st.hookProfile === 'strict') ? st.hookProfile : 'standard';
      if (activeHookProf !== 'standard' && patchKeys.some((k) => HOOK_PROFILE_OVERRIDE_KEYS.indexOf(k) !== -1)) {
        patch.hookProfile = 'standard';
      }

      if (currentState && typeof currentState === 'object') {
        Object.assign(currentState, patch);
      }

      for (let i = 0; i < patchKeys.length; i++) {
        const k = patchKeys[i];
        if (k === 'hookProfile') continue;
        const chk = document.getElementById('chk-' + k);
        if (chk) {
          chk.checked = Boolean(patch[k]);
        }
      }

      if (patch.hookProfile) {
        document.querySelectorAll('#hookProfileGroup button').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.val === 'standard');
        });
        const hookProfileHintEl = document.getElementById('hookProfileHint');
        if (hookProfileHintEl) {
          hookProfileHintEl.textContent = L(
            'Профиль «Стандарт»: действуют ваши индивидуальные переключатели контуров.',
            '"Standard" profile: uses your individual contour toggles below.'
          );
        }
        applyHookProfileOverridesToUi('standard', currentState);
      } else {
        applyHookProfileOverridesToUi(activeHookProf, currentState);
      }

      if (gKey === 'sentinel' && typeof syncSentinelCheckboxes === 'function') {
        syncSentinelCheckboxes(currentState);
      } else {
        syncTogglePresetsUi(currentState);
      }

      void updateState(patch);
      const lblPair = cfg.labels && cfg.labels[pId];
      if (lblPair && typeof flashStatus === 'function') {
        flashStatus(L(lblPair[0], lblPair[1]) + ' ✓');
      }
    }

    function setHookProfile(profile) {
      const clean = (profile === 'minimal' || profile === 'strict') ? profile : 'standard';
      document.querySelectorAll('#hookProfileGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === clean);
      });
      applyHookProfileOverridesToUi(clean, currentState);
      void updateState({ hookProfile: clean });
    }

    function setCompactionThreshold(rawVal) {
      const n = Math.round(Number(rawVal) || 120000);
      const clean = Math.max(16000, Math.min(500000, n));
      const cleanStr = String(clean);
      document.querySelectorAll('#compactionThresholdGroup button').forEach(function (btn) {
        const isActive = btn.dataset.val === cleanStr;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      if (typeof scheduleSyncAllSlidingPills === 'function') {
        scheduleSyncAllSlidingPills();
      }
      void updateState({ compactionTokenThreshold: clean });
      flashStatus(L('Порог сжатия эпохи: ', 'Epoch compaction threshold: ') + Math.round(clean / 1000) + 'k ✓');
    }

    let _lastAgentShieldData = null;
    let _lastProjectInstinctsData = null;
    let _lastSetupDoctorData = null;
    let _lastSessionEpisodesData = null;
    let _lastGatesData = null;
    let _lastGraphifyData = null;
    let _lastShortcutDebtData = null;
    let _lastGraphDebtKind = '';

    function renderAgentShieldData(data) {
      if (!data) return;
      _lastAgentShieldData = data;
      const badge = document.getElementById('agentShieldBadge');
      const sumEl = document.getElementById('agentShieldSummary');
      if (badge) {
        badge.textContent = String(data.score ?? 100) + '/100 (' + (data.grade || 'A') + ')';
        badge.className = 'swarm-pill ' + ((data.counts && data.counts.critical > 0) ? 'warn' : (data.score >= 90 ? 'idle' : 'active'));
      }
      if (sumEl) {
        sumEl.hidden = false;
        const findings = Array.isArray(data.findings) ? data.findings : [];
        const summaryTxt = pickText(data, 'summaryRu', 'summaryEn', '');
        if (findings.length === 0) {
          sumEl.textContent = summaryTxt || L('Угроз не обнаружено', 'No threats detected');
        } else {
          sumEl.innerHTML = '<div>' + escapeHtml(summaryTxt) + '</div>' +
            findings.slice(0, 6).map(function (f) {
              return '<div class="pitfall-item"><span class="pitfall-bullet">!</span><span><strong>[' +
                escapeHtml(String(f.severity || '').toUpperCase()) + ']</strong> ' + escapeHtml(pickText(f, 'message', 'messageEn', f.message || '')) +
                '</span></div>';
            }).join('');
        }
      }
    }

    async function runAgentShield() {
      const badge = document.getElementById('agentShieldBadge');
      const sumEl = document.getElementById('agentShieldSummary');
      if (badge) {
        badge.textContent = L('Проверка...', 'Scanning...');
        badge.className = 'swarm-pill active';
      }
      try {
        const res = await panelFetch('/api/shield', { method: 'GET' });
        const data = await res.json();
        if (!res || !res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || L('Ошибка аудита AgentShield', 'AgentShield audit error'));
        }
        renderAgentShieldData(data);
        flashStatus(L('Аудит AgentShield завершён ✓', 'AgentShield audit completed ✓'));
      } catch (err) {
        if (badge) {
          badge.textContent = L('Ошибка', 'Error');
          badge.className = 'swarm-pill warn';
        }
        if (sumEl) {
          sumEl.hidden = false;
          sumEl.textContent = (err && err.message) ? err.message : L('Сбой запуска AgentShield', 'Failed to run AgentShield');
        }
      }
    }

    function renderProjectInstinctsList(items) {
      const box = document.getElementById('projectInstinctsList');
      if (!box) return;
      const list = Array.isArray(items) ? items : [];
      _lastProjectInstinctsData = list;
      if (list.length === 0) {
        box.innerHTML = '<div>' + L('Пока нет накопленных инстинктов для текущего проекта.', 'No learned instincts for this workspace yet.') + '</div>';
        return;
      }
      box.innerHTML = list.slice(0, 12).map(function (it) {
        const pct = Math.round(Number(it.effectiveConfidence || it.confidence || 0) * 100);
        const promoBtn = (!it.promotedSkill && it.readyForPromotion)
          ? '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;" data-action="promoteInstinct" data-arg="' + escapeHtml(it.id) + '" title="' + L('Что делает: превращает этот накопленный паттерн в постоянный файл навыка SKILL.md.\nЗачем: правило закрепится в проекте навсегда, а не только как наблюдение.', 'What it does: promotes this learned pattern into a permanent SKILL.md skill.\nWhy: locks the habit into the project permanently.') + '">' + L('В навык', 'Promote') + '</button>'
          : (it.promotedSkill ? '<span style="color:var(--status-ok);" title="' + L('Этот инстинкт уже сохранён как постоянный навык проекта', 'This instinct is already promoted to a permanent project skill') + '">✓ ' + escapeHtml(it.promotedSkill) + '</span>' : '');
        const delBtn = '<button type="button" class="win-btn" style="padding:1px 5px;font-size:10px;" data-action="deleteInstinct" data-arg="' + escapeHtml(it.id) + '" title="' + L('Удалить этот инстинкт из памяти проекта', 'Remove this instinct from project memory') + '">✕</button>';
        let patternText = String(it.pattern || '');
        if (isRu()) {
          const m = patternText.match(/^Inspect surrounding callers and invariants in ([^\s]+) once before applying multi-pass edits$/i);
          if (m) {
            patternText = 'Перед многошаговой правкой ' + m[1] + ' проверять вызывающий код и инварианты за один проход';
          }
        }
        return '<div class="pitfall-item" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;" title="' + L('Накопленный паттерн работы в проекте: процент — уверенность модели, (xN) — сколько раз правило подтвердилось. При готовности появится кнопка «В навык».', 'Learned workspace pattern: % is confidence, (xN) is observation count. When ready, a Promote button appears.') + '">' +
          '<span style="min-width:0;flex:1 1 160px;word-break:break-word;"><strong>' + pct + '%</strong> (x' + Number(it.evidenceCount || 1) + ') ' + escapeHtml(patternText) + '</span>' +
          '<span style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">' + promoBtn + delBtn + '</span>' +
          '</div>';
      }).join('');
    }

    function jumpToPanelSection(blockId) {
      const id = String(blockId || '').trim();
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (document.body && document.body.getAttribute('data-panel-view') === 'full' && typeof getFullTabForElementId === 'function' && typeof setPanelFullTab === 'function') {
        const curTab = document.body.getAttribute('data-full-tab') || 'cockpit';
        const ownerTab = getFullTabForElementId(id);
        if (curTab !== 'all' && curTab !== ownerTab) {
          setPanelFullTab(ownerTab, { silent: true, skipAutoExpand: true, preserveScroll: true });
        }
      }
      if (id === 'checkpointsCard') setBugsSubTab('snaps');
      else if (id === 'bayesianWidget') setBugsSubTab('fragile');
      else if (id === 'expertPitfallsBox' || id === 'pitfallsContainer') setBugsSubTab('pitfalls');
      else if (id === 'projectInstinctsWrap' || id === 'projectInstinctsList') setMemorySubTab('instincts');
      else if (id === 'victoryRecipesContainer' || id === 'sessionEpisodesContainer') setMemorySubTab('recipes');
      else if (id === 'federatedPeersContainer' || id === 'federatedPeerInput') setMemorySubTab('peers');
      let cur = el.parentElement;
      while (cur) {
        if (cur.tagName === 'DETAILS' && !cur.open) {
          cur.open = true;
        }
        if (cur.classList && cur.classList.contains('is-inline-accordion') && cur.id && !cur.classList.contains('is-open') && typeof setInlineSectionOpen === 'function') {
          setInlineSectionOpen(cur.id, true, false);
        }
        cur = cur.parentElement;
      }
      if (el.tagName === 'DETAILS' && !el.open) {
        el.open = true;
      }
      if (el.classList && el.classList.contains('is-inline-accordion') && el.id && !el.classList.contains('is-open') && typeof setInlineSectionOpen === 'function') {
        setInlineSectionOpen(el.id, true, false);
      }
      if (el.classList && el.classList.contains('is-collapsed') && typeof togglePanelCardCollapse === 'function') {
        togglePanelCardCollapse(id);
      }
      if (typeof flushVisibleBlockRenders === 'function') flushVisibleBlockRenders();
      if (typeof maybeLoadMissingSectionsForBlock === 'function') maybeLoadMissingSectionsForBlock(id);
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (el.classList) {
        el.classList.add('is-jump-flash');
        setTimeout(function () {
          el.classList.remove('is-jump-flash');
        }, 1200);
      }
    }

    async function loadProjectInstincts(opts) {
      const silent = Boolean(opts && opts.silent);
      try {
        const res = await panelFetch('/api/instincts', { method: 'GET' });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          renderProjectInstinctsList(data.items || []);
          if (data.stats) renderKnowledgeHub(undefined, undefined, data.stats);
          if (!silent) flashStatus(L('Список инстинктов обновлён ✓', 'Project instincts refreshed ✓'));
        }
      } catch {
        if (!silent) flashStatus(L('Ошибка загрузки инстинктов проекта', 'Error loading project instincts'));
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
          flashStatus(L('Инстинкт повышен в навык ', 'Instinct promoted to skill ') + (data.skillSlug || '') + ' ✓');
          await refreshAll({ silent: true });
        } else {
          flashStatus(L('Не удалось повысить инстинкт: ', 'Failed to promote instinct: ') + ((data && data.error) || L('ошибка', 'error')));
        }
      } catch {
        flashStatus(L('Ошибка повышения инстинкта в навык', 'Error promoting instinct to skill'));
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
          flashStatus(L('Инстинкт удалён ✓', 'Instinct deleted ✓'));
        } else {
          flashStatus(L('Удаление инстинкта: ', 'Delete instinct: ') + ((data && data.error) || L('не найден', 'not found')));
        }
      } catch {
        flashStatus(L('Ошибка удаления инстинкта', 'Error deleting instinct'));
      }
    }

    let _setupDoctorAutoCloseTimer = 0;
    let _lastHealthDoctorData = null;
    let _lastHealthDoctorLog = [];
    let _setupDoctorLoadSeq = 0;

    function closeSetupDoctor(opts) {
      _setupDoctorLoadSeq += 1;
      if (_setupDoctorAutoCloseTimer) {
        clearTimeout(_setupDoctorAutoCloseTimer);
        _setupDoctorAutoCloseTimer = 0;
      }
      const box = document.getElementById('setupDoctorBox');
      const btn = document.getElementById('smartBannerDoctorBtn');
      if (btn) {
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('is-active');
      }
      if (typeof syncFullGuardActivePill === 'function') syncFullGuardActivePill();
      if (box) {
        box.classList.remove('is-rescanning');
        box.style.minHeight = '';
        if (opts && opts.immediate) {
          if (typeof cancelDisclosureAnimation === 'function') cancelDisclosureAnimation(box);
          box.style.display = 'none';
        } else if (typeof animateDisclosurePanel === 'function') {
          animateDisclosurePanel(box, false, { duration: 200 });
        } else {
          box.style.display = 'none';
        }
      }
    }

    function renderSetupDoctorReport(rec, health, fixLog) {
      const box = document.getElementById('setupDoctorBox');
      if (!box) return;
      if (rec !== undefined) _lastSetupDoctorData = rec;
      if (health !== undefined) _lastHealthDoctorData = health;
      if (Array.isArray(fixLog)) _lastHealthDoctorLog = fixLog;
      const activeRec = _lastSetupDoctorData;
      const activeHealth = _lastHealthDoctorData;
      if (!activeRec || activeRec.ok === false) {
        box.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">' +
            '<span style="color: var(--status-warn);">' + L('Не удалось проанализировать стек проекта: ', 'Failed to analyze project stack: ') +
              escapeHtml((activeRec && activeRec.error) || L('ошибка', 'error')) + '</span>' +
            '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;flex-shrink:0;" data-action="closeSetupDoctor" title="' + L('Свернуть диагностику', 'Collapse diagnostics') + '" aria-label="' + L('Свернуть диагностику', 'Collapse diagnostics') + '">✕</button>' +
          '</div>';
        return;
      }
      const st = activeRec.stack || {};
      const langs = Array.isArray(st.languages) && st.languages.length ? st.languages.join(', ') : L('авто', 'auto');
      const fws = Array.isArray(st.frameworks) && st.frameworks.length ? (' · ' + st.frameworks.join(', ')) : '';
      const hyg = Array.isArray(activeRec.projectHygieneSuggestions) ? activeRec.projectHygieneSuggestions : [];
      const skills = Array.isArray(activeRec.recommendedLocalSkills) ? activeRec.recommendedLocalSkills : [];
      const ext = Array.isArray(activeRec.externalIntegrations) ? activeRec.externalIntegrations : [];
      const recProf = activeRec.recommendedHookProfile || 'standard';
      const profLabel = recProf === 'strict' ? L('Строгий', 'Strict') : (recProf === 'minimal' ? L('Лёгкий', 'Minimal') : L('Стандарт', 'Standard'));
      const profReason = pickText(activeRec, 'hookProfileReasonRu', 'hookProfileReasonEn', '');
      const applyableKinds = new Set(['hook_profile', 'agentignore', 'design_md', 'gates_md']);

      let html =
        '<div data-setup-doctor-body="1">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">' +
          '<strong style="color:var(--accent-cyan);">' + L('Диагностика стека · ', 'Setup Doctor · ') + escapeHtml(langs + fws) + ' (' + Number(st.totalFiles || 0) + L(' ф.)', ' files)') + '</strong>' +
          '<div style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">' +
            '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;" data-action="loadSetupDoctor">' + L('↻ Пересканировать', '↻ Rescan') + '</button>' +
            '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;" data-action="closeSetupDoctor" title="' + L('Свернуть диагностику', 'Collapse diagnostics') + '" aria-label="' + L('Свернуть диагностику', 'Collapse diagnostics') + '">✕</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;color:var(--text-sub);">' +
          '<span style="min-width:0;flex:1 1 170px;">' + L('Рекомендованный профиль: ', 'Recommended profile: ') + '<strong>' + escapeHtml(profLabel) + '</strong>' +
          (profReason ? (' — ' + escapeHtml(profReason)) : '') + '</span>' +
          '<button type="button" class="win-btn" style="padding:1px 7px;font-size:10px;" data-action="applySetupDoctorItem" data-arg="hook_profile">' + L('Применить профиль', 'Apply profile') + '</button>' +
        '</div>';

      if (hyg.length > 0) {
        html += hyg.slice(0, 4).map(function (h) {
          const canApply = applyableKinds.has(h.kind);
          const btnHtml = canApply
            ? '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;flex-shrink:0;" data-action="applySetupDoctorItem" data-arg="' + escapeHtml(h.kind) + '">' + L('Применить', 'Apply') + '</button>'
            : '';
          return '<div class="pitfall-item" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">' +
            '<span style="min-width:0;flex:1 1 160px;">' + escapeHtml(pickText(h, 'titleRu', 'titleEn', h.kind || '')) + '</span>' +
            btnHtml +
            '</div>';
        }).join('');
      } else {
        html += '<div style="color:var(--status-ok);font-size:10.5px;">' + L('✓ Базовая гигиена проекта (`.agentignore` / конфиги) в порядке', '✓ Baseline project hygiene (.agentignore / configs) looks good') + '</div>';
      }

      if (skills.length > 0) {
        html += '<div style="margin-top:4px;font-size:10.5px;color:var(--text-sub);">' + L('Навыки под стек: ', 'Stack skills: ') +
          skills.slice(0, 4).map(function (s) { return '<code>' + escapeHtml(s.slug) + '</code>'; }).join(', ') +
          '</div>';
      }
      if (ext.length > 0) {
        html += '<div style="margin-top:2px;font-size:10.5px;color:var(--text-sub);">' + L('Интеграции: ', 'Integrations: ') +
          ext.slice(0, 4).map(function (e) { return escapeHtml(pickText(e, 'name', 'nameEn', e.id)); }).join(', ') +
          '</div>';
      }

      if (activeHealth && activeHealth.ok) {
        const hIssues = Array.isArray(activeHealth.issues) ? activeHealth.issues : [];
        const hScore = Number(activeHealth.score ?? 100);
        const hasHigh = hIssues.some(function (i) { return i.severity === 'high'; });
        const scoreCls = hasHigh ? 'health-doctor-score is-high' : (hIssues.length > 0 ? 'health-doctor-score is-warn' : 'health-doctor-score');
        html += '<div class="health-doctor-section" id="healthDoctorSection">';
        html += '<div class="health-doctor-head">' +
          '<div style="display:inline-flex;align-items:center;gap:6px;">' +
            '<strong>' + L('Здоровье систем · Auto-Fix', 'Runtime Health · Auto-Fix') + '</strong>' +
            '<span class="' + scoreCls + '">' + hScore + '/100</span>' +
          '</div>' +
          (hIssues.length > 0
            ? '<button type="button" class="win-btn active" style="padding:1px 7px;font-size:10px;" data-action="runHealthDoctorFix" data-arg="fix_all">' + L('Починить всё (1 клик)', 'Fix all (1-click)') + '</button>'
            : '<span style="color:var(--status-ok);font-size:10px;">' + L('✓ Все службы в норме', '✓ All systems healthy') + '</span>') +
          '</div>';
        if (hIssues.length > 0) {
          html += hIssues.map(function (it) {
            const sevCol = it.severity === 'high' ? 'var(--status-err)' : (it.severity === 'warn' ? 'var(--status-warn)' : 'var(--text-sub)');
            return '<div class="pitfall-item" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">' +
              '<span style="min-width:0;flex:1 1 160px;color:' + sevCol + ';" title="' + escapeHtml(pickText(it, 'detailRu', 'detailEn', '')) + '">' +
                escapeHtml(pickText(it, 'titleRu', 'titleEn', it.id)) +
              '</span>' +
              (it.canAutoFix
                ? '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;flex-shrink:0;" data-action="runHealthDoctorFix" data-arg="' + escapeHtml(it.fixAction) + '">' + L('Исправить', 'Fix') + '</button>'
                : '') +
              '</div>';
          }).join('');
        }
        if (_lastHealthDoctorLog.length > 0) {
          html += '<div class="health-doctor-log">' +
            _lastHealthDoctorLog.map(function (entry) {
              return '<div>' + (entry.ok ? '✓ ' : '✕ ') + escapeHtml(pickText(entry, 'messageRu', 'messageEn', entry.action || '')) + '</div>';
            }).join('') +
            '</div>';
        }
        html += '</div>';
      }

      html += '</div>';
      box.innerHTML = html;
    }

    async function runHealthDoctorFix(fixAction) {
      if (!fixAction) return;
      try {
        flashStatus(L('Запуск авто-исправления Health-Doctor...', 'Running Health-Doctor auto-fix...'));
        const res = await panelFetch('/api/health-doctor/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fixAction: fixAction }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          renderSetupDoctorReport(_lastSetupDoctorData, data.health || _lastHealthDoctorData, Array.isArray(data.log) ? data.log : []);
          flashStatus(L('Health-Doctor: выполнено исправлений ', 'Health-Doctor: fixes applied ') + Number(data.applied || 0) + ' ✓');
          await refreshAll({ silent: true });
        } else {
          flashStatus('Health-Doctor: ' + ((data && data.error) || L('не удалось выполнить', 'failed')));
        }
      } catch {
        flashStatus(L('Ошибка авто-исправления Health-Doctor', 'Health-Doctor auto-fix error'));
      }
    }

    async function loadSetupDoctor() {
      const box = document.getElementById('setupDoctorBox');
      if (!box) return;
      const loadSeq = ++_setupDoctorLoadSeq;
      if (_setupDoctorAutoCloseTimer) {
        clearTimeout(_setupDoctorAutoCloseTimer);
        _setupDoctorAutoCloseTimer = 0;
      }
      const guardDrawer = document.getElementById('fullGuardDrawer');
      const outgoingGuardH = (guardDrawer && guardDrawer.style.display !== 'none')
        ? (typeof uiMeasureLayoutHeight === 'function'
            ? uiMeasureLayoutHeight(guardDrawer)
            : (guardDrawer.getBoundingClientRect ? guardDrawer.getBoundingClientRect().height : 0))
        : 0;
      if (typeof closeGuardDrawer === 'function') {
        closeGuardDrawer('full', { immediate: true });
      }
      const doctorBtn = document.getElementById('smartBannerDoctorBtn');
      if (doctorBtn) {
        doctorBtn.setAttribute('aria-expanded', 'true');
        doctorBtn.classList.add('is-active');
      }
      if (typeof syncFullGuardActivePill === 'function') syncFullGuardActivePill();
      const hasExistingReport = box.style.display !== 'none' && Boolean(box.querySelector('[data-setup-doctor-body]'));
      if (hasExistingReport) {
        const rawPrevH = typeof uiMeasureLayoutHeight === 'function'
          ? uiMeasureLayoutHeight(box)
          : (box.getBoundingClientRect ? box.getBoundingClientRect().height : 0);
        const prevH = Number.isFinite(rawPrevH) ? Math.ceil(rawPrevH) : 0;
        if (prevH > 0) box.style.minHeight = prevH + 'px';
        box.classList.add('is-rescanning');
        const rescanBtn = box.querySelector('[data-action="loadSetupDoctor"]');
        if (rescanBtn) {
          rescanBtn.disabled = true;
          rescanBtn.textContent = L('↻ Анализ...', '↻ Scanning...');
        }
      } else {
        box.innerHTML = '<div class="setup-doctor-loading">' + L('Анализ стека и здоровья систем...', 'Analyzing project stack & runtime health...') + '</div>';
        if (typeof animateDisclosurePanel === 'function') {
          animateDisclosurePanel(box, true, {
            display: 'block',
            duration: 220,
            prevHeight: outgoingGuardH > 0 ? outgoingGuardH : undefined
          });
        } else {
          box.style.display = 'block';
        }
      }
      try {
        const [recSettled, healthSettled] = await Promise.allSettled([
          panelFetch('/api/setup-recommendations', { method: 'GET' }).then((r) => r.json()),
          panelFetch('/api/health-doctor', { method: 'GET' }).then((r) => r.json()),
        ]);
        if (loadSeq !== _setupDoctorLoadSeq) return;
        const data = recSettled.status === 'fulfilled' ? recSettled.value : { ok: false, error: L('Ошибка запроса Setup Doctor', 'Setup Doctor request failed') };
        const healthData = healthSettled.status === 'fulfilled' ? healthSettled.value : null;
        _lastHealthDoctorLog = [];
        const prevBoxH = typeof uiMeasureLayoutHeight === 'function'
          ? uiMeasureLayoutHeight(box)
          : (box.getBoundingClientRect ? box.getBoundingClientRect().height : 0);
        renderSetupDoctorReport(data, healthData, []);
        if (typeof animateDisclosurePanel === 'function' && box.style.display !== 'none' && prevBoxH > 0) {
          animateDisclosurePanel(box, true, { display: 'block', duration: 210, prevHeight: prevBoxH });
        }
      } catch {
        if (loadSeq !== _setupDoctorLoadSeq) return;
        renderSetupDoctorReport({ ok: false, error: L('Ошибка запроса Setup Doctor', 'Setup Doctor request failed') }, null, []);
      } finally {
        const releaseLock = function () {
          box.classList.remove('is-rescanning');
          box.style.minHeight = '';
        };
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(releaseLock);
        } else {
          releaseLock();
        }
      }
    }

    function toggleSetupDoctor() {
      const box = document.getElementById('setupDoctorBox');
      if (!box) return;
      if (box.style.display !== 'none' && box.innerHTML.trim()) {
        closeSetupDoctor();
        return;
      }
      void loadSetupDoctor();
    }

    async function applySetupDoctorItem(kind) {
      if (!kind) return;
      const applyableKinds = new Set(['agentignore', 'design_md', 'gates_md']);
      try {
        flashStatus(L('Применение рекомендации Setup Doctor...', 'Applying Setup Doctor recommendation...'));
        const res = await panelFetch('/api/setup-recommendations/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: kind }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          if (data.recommendation) renderSetupDoctorReport(data.recommendation);
          flashStatus((pickText(data, 'detail', 'detailEn', '') || L('Рекомендация применена', 'Recommendation applied')) + ' ✓');
          await refreshAll({ silent: true });
          if (kind === 'gates_md') void refreshGatesStatus({ silent: true });
          const remHyg = Array.isArray(data.recommendation && data.recommendation.projectHygieneSuggestions)
            ? data.recommendation.projectHygieneSuggestions
            : [];
          const hasRemainingApplyable = remHyg.some(function (h) { return h && applyableKinds.has(h.kind); });
          if (kind === 'hook_profile' || !hasRemainingApplyable) {
            const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (_setupDoctorAutoCloseTimer) clearTimeout(_setupDoctorAutoCloseTimer);
            if (reducedMotion) {
              closeSetupDoctor();
            } else {
              _setupDoctorAutoCloseTimer = setTimeout(closeSetupDoctor, 240);
            }
          }
        } else {
          flashStatus('Setup Doctor: ' + ((data && (pickText(data, 'detail', 'detailEn', '') || data.error)) || L('не удалось применить', 'failed to apply')));
        }
      } catch {
        flashStatus(L('Ошибка применения рекомендации Setup Doctor', 'Error applying Setup Doctor recommendation'));
      }
    }

    function toggleSkillRegistryDrawer() {
      const drawer = document.getElementById('skillRegistryDrawer');
      if (!drawer) return;
      const open = drawer.style.display === 'none';
      if (typeof animateDisclosurePanel === 'function') {
        animateDisclosurePanel(drawer, open, { display: 'block', duration: 220 });
      } else {
        drawer.style.display = open ? 'block' : 'none';
      }
      if (open) {
        const inp = document.getElementById('extSkillSourceInput');
        if (inp && typeof inp.focus === 'function') {
          try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
        }
      }
    }

    async function searchExternalSkills() {
      const srcInp = document.getElementById('extSkillSourceInput');
      const resBox = document.getElementById('skillRegistryResults');
      const query = srcInp ? String(srcInp.value || '').trim() : '';
      if (resBox) {
        resBox.innerHTML = '<div>' + L('Поиск по локальному и внешнему каталогу...', 'Searching local and remote catalog...') + '</div>';
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
          resBox.innerHTML = '<div>' + L('Совпадений не найдено.', 'No matches found.') +
            (data && data.offlineFallback ? L(' (Внешний каталог офлайн — можно ввести owner/repo вручную и нажать «Проверить и импортировать».)', ' (Remote catalog offline — enter owner/repo manually and click "Audit & import".)') : '') +
            '</div>';
          return;
        }
        let html = '';
        if (locals.length > 0) {
          html += '<div style="margin-bottom:4px;font-weight:600;color:var(--status-ok);">' + L('Локально установлено: ', 'Installed locally: ') +
            locals.slice(0, 6).map(function (m) { return '<code>' + escapeHtml(m.slug || m.id || m.name) + '</code>'; }).join(', ') +
            '</div>';
        }
        if (remotes.length > 0) {
          html += remotes.slice(0, 6).map(function (m) {
            const btn = m.sourceRepo
              ? '<button type="button" class="win-btn" style="padding:1px 6px;font-size:10px;flex-shrink:0;" data-action="importExternalSkill" data-source="' +
                escapeHtml(m.sourceRepo) + '" data-slug="' + escapeHtml(m.slug || '') + '">' +
                (m.alreadyInstalled ? L('Обновить', 'Update') : L('Импорт', 'Import')) + '</button>'
              : '';
            return '<div class="pitfall-item" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">' +
              '<span style="min-width:0;flex:1 1 150px;"><strong>' + escapeHtml(m.slug || m.name) + '</strong>' +
              (m.sourceRepo ? ' · <code>' + escapeHtml(m.sourceRepo) + '</code>' : '') +
              (m.description ? (' — ' + escapeHtml(m.description.slice(0, 90))) : '') +
              '</span>' + btn + '</div>';
          }).join('');
        }
        if (data && data.offlineFallback) {
          html += '<div style="color:var(--text-sub);font-size:10px;margin-top:2px;">' + L('Внешний реестр недоступен (offline fallback).', 'Remote registry unavailable (offline fallback).') + '</div>';
        }
        resBox.innerHTML = html;
        flashStatus(L('Поиск навыков завершён ✓', 'Skill search complete ✓'));
      } catch {
        if (resBox) resBox.innerHTML = '<div style="color:var(--status-warn);">' + L('Ошибка поиска по каталогу навыков', 'Error searching skill catalog') + '</div>';
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
        flashStatus(L('Укажите источник (owner/repo или локальную папку) и slug навыка', 'Specify source (owner/repo or local folder) and skill slug'));
        return;
      }
      if (resBox) resBox.innerHTML = '<div>' + L('Карантинная проверка AgentShield для ', 'AgentShield quarantine audit for ') + '<code>' + escapeHtml(slug) + '</code>...</div>';
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
            resBox.innerHTML = '<div style="color:var(--status-ok);">' + L('✓ Навык ', '✓ Skill ') + '<code>' + escapeHtml(data.slug || slug) + '</code>' + L(' прошёл карантин AgentShield и установлен.', ' passed AgentShield quarantine and was installed.') + '</div>';
          }
          flashStatus(L('Навык ', 'Skill ') + (data.slug || slug) + L(' импортирован ✓', ' imported ✓'));
          await refreshAll({ silent: true });
        } else {
          const reasons = Array.isArray(data && data.reasons) ? data.reasons : [];
          const msg = (data && data.securityBlocked ? L('Заблокировано AgentShield: ', 'Blocked by AgentShield: ') : L('Импорт отклонён: ', 'Import rejected: ')) +
            (reasons.length ? reasons.slice(0, 3).join('; ') : ((data && data.error) || L('не прошёл проверку', 'failed audit')));
          if (resBox) resBox.innerHTML = '<div style="color:var(--status-warn);">' + escapeHtml(msg) + '</div>';
          flashStatus(L('Импорт навыка отклонён', 'Skill import rejected'));
        }
      } catch {
        if (resBox) resBox.innerHTML = '<div style="color:var(--status-warn);">' + L('Ошибка карантинного импорта навыка', 'Skill quarantine import error') + '</div>';
      }
    }

    function renderSessionEpisodesData(items) {
      const box = document.getElementById('sessionEpisodesContainer');
      if (!box) return;
      const list = Array.isArray(items) ? items : [];
      _lastSessionEpisodesData = list;
      if (list.length === 0) {
        box.innerHTML = '<div style="color:var(--text-sub);padding:2px;">' + L('Пока нет записанных эпизодов прошлых сессий.', 'No recorded session episodes yet.') + '</div>';
        return;
      }
      box.innerHTML = list.map(function (ep) {
        const filesStr = Array.isArray(ep.files) && ep.files.length ? (' · ' + ep.files.slice(0, 2).join(', ')) : '';
        return '<div class="pitfall-item"><span class="pitfall-bullet">•</span><span style="min-width:0;word-break:break-word;"><strong>[' +
          escapeHtml((ep.date || '') + ' · ' + (ep.kind || 'session')) + ']</strong> ' +
          escapeHtml((ep.title || ep.shortId || '') + filesStr) + '</span></div>';
      }).join('');
    }

    async function loadSessionEpisodes() {
      const box = document.getElementById('sessionEpisodesContainer');
      if (!box) return;
      box.innerHTML = '<div style="color:var(--text-sub);padding:2px;">' + L('Загрузка эпизодов памяти...', 'Loading memory episodes...') + '</div>';
      if (typeof animateDisclosurePanel === 'function') {
        animateDisclosurePanel(box, true, { display: 'block', duration: 210 });
      } else {
        box.style.display = 'block';
      }
      try {
        const res = await panelFetch('/api/knowledge/episodes?limit=12', { method: 'GET' });
        const data = await res.json();
        const items = Array.isArray(data && data.items) ? data.items : [];
        if (data && data.stats) renderKnowledgeHub(undefined, undefined, data.stats);
        const prevH = typeof uiMeasureLayoutHeight === 'function'
          ? uiMeasureLayoutHeight(box)
          : (box.getBoundingClientRect ? box.getBoundingClientRect().height : 0);
        renderSessionEpisodesData(items);
        if (typeof animateDisclosurePanel === 'function' && prevH > 0) {
          animateDisclosurePanel(box, true, { display: 'block', duration: 210, prevHeight: prevH });
        }
        if (items.length > 0) {
          flashStatus(L('Загружено эпизодов памяти: ', 'Loaded memory episodes: ') + items.length + ' ✓');
        }
      } catch {
        box.innerHTML = '<div style="color:var(--status-warn);padding:2px;">' + L('Ошибка загрузки эпизодов памяти', 'Error loading memory episodes') + '</div>';
      }
    }

    async function resetComboCooldowns() {
      try {
        const res = await panelFetch('/api/quota/reset-cooldowns', { method: 'POST', body: '{}' });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          if (data.quotaPacer) renderWiretapAndQuota(undefined, data.quotaPacer);
          flashStatus(L('Временные паузы Combo сброшены ✓', 'Combo cooldowns reset ✓'));
        } else {
          flashStatus('Combo: ' + ((data && data.error) || L('ошибка сброса', 'reset error')));
        }
      } catch {
        flashStatus(L('Ошибка сброса пауз Combo', 'Error resetting Combo cooldowns'));
      }
    }

    function renderGatesStatusData(data) {
      const badge = document.getElementById('gatesStatusBadge');
      if (!badge || !data) return;
      _lastGatesData = data;
      if (data.exists === false) {
        badge.textContent = L('GATES.md: файл не создан', 'GATES.md: not created');
        badge.style.color = 'var(--text-sub)';
      } else {
        badge.textContent = 'GATES.md: ' + Number(data.metCount || 0) + '/' + Number(data.total || 0) + L(' выполнено', ' met');
        badge.style.color = Number(data.unmetCount || 0) > 0 ? 'var(--status-warn)' : 'var(--status-ok)';
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
          renderGatesStatusData(data);
          if (!silent) flashStatus(L('Статус GATES.md обновлён ✓', 'GATES.md status updated ✓'));
        }
      } catch {
        if (!silent) flashStatus(L('Ошибка проверки GATES.md', 'Error checking GATES.md'));
      }
    }

    async function initGatesMd() {
      try {
        const res = await panelFetch('/api/gates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok) {
          renderGatesStatusData(Object.assign({ exists: true, unmetCount: 0 }, data));
          flashStatus(L('Журнал GATES.md готов ✓', 'GATES.md created ✓'));
        } else {
          flashStatus('GATES.md: ' + ((data && data.error) || L('ошибка создания', 'creation error')));
        }
      } catch {
        flashStatus(L('Ошибка создания GATES.md', 'Error creating GATES.md'));
      }
    }

    function syncGraphDebtButtonsActiveState(kind) {
      const btnGraph = document.querySelector('[data-action="loadGraphifyOverview"]');
      const btnDebt = document.querySelector('[data-action="loadShortcutDebt"]');
      const isGraph = kind === 'graph';
      const isDebt = kind === 'debt';
      if (btnGraph) {
        btnGraph.classList.toggle('active', isGraph);
        btnGraph.setAttribute('aria-expanded', isGraph ? 'true' : 'false');
      }
      if (btnDebt) {
        btnDebt.classList.toggle('active', isDebt);
        btnDebt.setAttribute('aria-expanded', isDebt ? 'true' : 'false');
      }
      if (typeof syncAllSlidingPillsNow === 'function') {
        syncAllSlidingPillsNow();
      }
    }

    function closeGraphDebtDrawer() {
      const drawer = document.getElementById('graphDebtDrawer');
      _lastGraphDebtKind = '';
      syncGraphDebtButtonsActiveState('');
      if (!drawer) return;
      if (typeof animateDisclosurePanel === 'function') {
        animateDisclosurePanel(drawer, false, { duration: 190 });
      } else {
        drawer.style.display = 'none';
      }
    }

    function renderGraphifyData(data) {
      const drawer = document.getElementById('graphDebtDrawer');
      const badge = document.getElementById('graphDebtStatusBadge');
      if (!drawer || !data) return;
      _lastGraphifyData = data;
      _lastGraphDebtKind = 'graph';
      syncGraphDebtButtonsActiveState('graph');
      const warmth = data.cacheWarmth || {};
      const warmthLabel = warmth.status === 'warm'
        ? (L('Кэш тёплый (', 'Cache warm (') + Number(warmth.remainingSeconds || 0) + L('с)', 's)'))
        : warmth.status === 'cooling'
          ? (L('Кэш остывает (', 'Cache cooling (') + Number(warmth.remainingSeconds || 0) + L('с)', 's)'))
          : L('Кэш холодный', 'Cache cold');
      const reuse = data.reuse || {};
      const reuseLabel = reuse.reusePct !== null && reuse.reusePct !== undefined
        ? ('Reuse: ' + Number(reuse.reusePct) + '% (' + Number(reuse.reusedCount || 0) + L(' исп. / ', ' used / ') + Number(reuse.newCount || 0) + L(' нов.)', ' new)'))
        : 'Reuse: —';
      if (badge) {
        badge.textContent = 'Q=' + Number(data.modularityQ || 0) + ' · ' + Number((data.clusters || []).length) + L(' класт. · ', ' clust. · ') + reuseLabel;
        badge.style.color = '';
      }
      const clustersHtml = (data.clusters || []).slice(0, 6).map(function (c) {
        const wPct = Math.min(100, Math.max(14, Math.round((Number(c.size || 1) / Math.max(1, Number(data.fileCount || 1))) * 100)));
        return '<div style="margin-bottom:4px;">' +
          '<div style="display:flex;justify-content:space-between;gap:6px;">' +
            '<strong>' + escapeHtml(c.label || c.id) + '</strong>' +
            '<span style="color:var(--text-sub);">' + Number(c.size || 0) + L(' ф. · hub: ', ' f. · hub: ') + escapeHtml((c.hubFile || '').split('/').pop()) + '</span>' +
          '</div>' +
          '<div style="height:4px;background:var(--border-subtle);border-radius:var(--r-xs);overflow:hidden;margin-top:2px;">' +
            '<div style="height:100%;width:' + wPct + '%;background:var(--accent-cyan);"></div>' +
          '</div>' +
        '</div>';
      }).join('');
      const godsHtml = (data.godNodes || []).slice(0, 4).map(function (g) {
        return '<span class="swarm-pill idle" style="margin:1px 3px 1px 0;">[HUB] ' + escapeHtml(g.file) + ' (in:' + Number(g.inDegree || 0) + ')</span>';
      }).join('');
      const bridgesHtml = (data.bridges || []).slice(0, 4).map(function (b) {
        const confTone = b.confidence === 'AMBIGUOUS' ? 'var(--status-warn)' : 'var(--accent-cyan)';
        return '<div style="margin-top:2px;word-break:break-word;">' +
          '<span style="color:' + confTone + ';font-weight:600;">[' + escapeHtml(b.confidence || 'EXTRACTED') + ']</span> ' +
          escapeHtml(b.fromFile + ':L' + (b.callSiteLine || 1) + ' → ' + b.toFile + (b.toSymbol ? '#' + b.toSymbol : '')) +
        '</div>';
      }).join('');
      const closeBtnHtml = '<button type="button" class="win-btn gd-mini-btn" data-action="closeGraphDebtDrawer" aria-label="' + L('Свернуть карточку', 'Collapse drawer') + '" title="' + L('Свернуть карточку', 'Collapse drawer') + '">✕</button>';
      drawer.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:6px;color:var(--text-sub);">' +
          '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;flex:1;min-width:0;">' +
            '<span>' + escapeHtml(warmthLabel) + '</span>' +
            '<span>' + escapeHtml(reuseLabel) + ' · ' + escapeHtml(data.topologyHash || '') + '</span>' +
          '</div>' +
          closeBtnHtml +
        '</div>' +
        (godsHtml ? '<div style="margin-bottom:6px;">' + godsHtml + '</div>' : '') +
        (clustersHtml || '<div style="color:var(--text-sub);">' + L('Кластеры не обнаружены', 'No clusters detected') + '</div>') +
        (bridgesHtml ? '<div style="margin-top:6px;border-top:1px solid var(--border-subtle);padding-top:4px;"><strong>' + L('Межкластерные мосты:', 'Cross-cluster bridges:') + '</strong>' + bridgesHtml + '</div>' : '');
    }

    async function loadGraphifyOverview(opts) {
      const drawer = document.getElementById('graphDebtDrawer');
      if (!drawer) return;
      if (!(opts && opts.force) && drawer.style.display !== 'none' && _lastGraphDebtKind === 'graph') {
        closeGraphDebtDrawer();
        return;
      }
      _lastGraphDebtKind = 'graph';
      syncGraphDebtButtonsActiveState('graph');
      drawer.innerHTML = '<div style="color:var(--text-sub);">' + L('Построение графа архитектуры Graphify v2...', 'Building Graphify v2 architecture graph...') + '</div>';
      if (typeof animateDisclosurePanel === 'function') {
        animateDisclosurePanel(drawer, true, { display: 'block', duration: 210 });
      } else {
        drawer.style.display = 'block';
      }
      try {
        const res = await panelFetch('/api/graph', { method: 'GET' });
        const data = await res.json();
        if (!res || !res.ok || !data || !data.ok) {
          drawer.innerHTML = '<div style="color:var(--status-warn);">' + L('Граф недоступен: ', 'Graph unavailable: ') + escapeHtml((data && data.error) || L('ошибка', 'error')) + '</div>';
          return;
        }
        const prevH = typeof uiMeasureLayoutHeight === 'function'
          ? uiMeasureLayoutHeight(drawer)
          : (drawer.getBoundingClientRect ? drawer.getBoundingClientRect().height : 0);
        renderGraphifyData(data);
        if (typeof animateDisclosurePanel === 'function' && prevH > 0) {
          animateDisclosurePanel(drawer, true, { display: 'block', duration: 210, prevHeight: prevH });
        }
        flashStatus(L('Карта архитектуры Graphify v2 обновлена ✓', 'Graphify v2 architecture map updated ✓'));
      } catch {
        drawer.innerHTML = '<div style="color:var(--status-warn);">' + L('Ошибка загрузки графа архитектуры', 'Error loading architecture graph') + '</div>';
      }
    }

    function renderShortcutDebtData(data) {
      const drawer = document.getElementById('graphDebtDrawer');
      const badge = document.getElementById('graphDebtStatusBadge');
      if (!drawer || !data) return;
      _lastShortcutDebtData = data;
      _lastGraphDebtKind = 'debt';
      syncGraphDebtButtonsActiveState('debt');
      const items = Array.isArray(data.items) ? data.items : [];
      if (badge) {
        badge.textContent = L('Техдолг shortcut: ', 'Shortcut debt: ') + items.length + ' (no-trigger: ' + Number(data.noTriggerCount || 0) + ')';
        badge.style.color = Number(data.noTriggerCount || 0) > 0 ? 'var(--status-warn)' : 'var(--status-ok)';
      }
      const closeBtnHtml = '<button type="button" class="win-btn gd-mini-btn" data-action="closeGraphDebtDrawer" aria-label="' + L('Свернуть карточку', 'Collapse drawer') + '" title="' + L('Свернуть карточку', 'Collapse drawer') + '">✕</button>';
      if (items.length === 0) {
        drawer.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">' +
            '<span>' + escapeHtml(L(
              '✓ Осознанный техдолг (shortcut:) не обнаружен. Чистый реестр (' + Number(data.scannedFiles || 0) + ' файлов).',
              '✓ No deliberate shortcut: debt found. Clean ledger (' + Number(data.scannedFiles || 0) + ' files).'
            )) + '</span>' +
            closeBtnHtml +
          '</div>';
        return;
      }
      const rowsHtml = items.slice(0, 25).map(function (it) {
        const warnTag = it.rotRisk ? ' <strong style="color:var(--status-warn);">[no-trigger]</strong>' : '';
        const upg = it.upgradeTrigger ? (' · <em>' + escapeHtml(it.upgradeTrigger) + '</em>') : '';
        return '<div class="pitfall-item"><span class="pitfall-bullet">•</span><span style="min-width:0;word-break:break-word;">' +
          '<strong>' + escapeHtml(it.file + ':' + it.line) + '</strong> — ' + escapeHtml(it.ceiling || '') + upg + warnTag +
        '</span></div>';
      }).join('');
      drawer.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px;color:var(--text-sub);">' +
          '<span>' + escapeHtml(L('Найдено меток shortcut: ', 'Shortcut markers found: ') + items.length) + '</span>' +
          closeBtnHtml +
        '</div>' +
        rowsHtml;
    }

    async function loadShortcutDebt(opts) {
      const drawer = document.getElementById('graphDebtDrawer');
      if (!drawer) return;
      if (!(opts && opts.force) && drawer.style.display !== 'none' && _lastGraphDebtKind === 'debt') {
        closeGraphDebtDrawer();
        return;
      }
      _lastGraphDebtKind = 'debt';
      syncGraphDebtButtonsActiveState('debt');
      drawer.innerHTML = '<div style="color:var(--text-sub);">' + L('Сканирование меток техдолга shortcut:...', 'Scanning shortcut: tech debt markers...') + '</div>';
      if (typeof animateDisclosurePanel === 'function') {
        animateDisclosurePanel(drawer, true, { display: 'block', duration: 210 });
      } else {
        drawer.style.display = 'block';
      }
      try {
        const res = await panelFetch('/api/debt', { method: 'GET' });
        const data = await res.json();
        if (!res || !res.ok || !data || !data.ok) {
          drawer.innerHTML = '<div style="color:var(--status-warn);">' + L('Ошибка сканирования техдолга', 'Error scanning tech debt') + '</div>';
          return;
        }
        const prevH = typeof uiMeasureLayoutHeight === 'function'
          ? uiMeasureLayoutHeight(drawer)
          : (drawer.getBoundingClientRect ? drawer.getBoundingClientRect().height : 0);
        renderShortcutDebtData(data);
        if (typeof animateDisclosurePanel === 'function' && prevH > 0) {
          animateDisclosurePanel(drawer, true, { display: 'block', duration: 210, prevHeight: prevH });
        }
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
          flashStatus(L('Техдолг shortcut: 0 меток ✓', 'Shortcut debt: 0 markers ✓'));
        } else {
          flashStatus(L('Найдено меток shortcut: ', 'Found shortcut markers: ') + items.length + ' ✓');
        }
      } catch {
        drawer.innerHTML = '<div style="color:var(--status-warn);">' + L('Ошибка чтения реестра техдолга', 'Error reading tech debt ledger') + '</div>';
      }
    }

    function flushAllRendersForLanguageChange() {
      const s = (typeof currentState === 'object' && currentState) ? currentState : {};
      const p = (typeof lastPayloadCache === 'object' && lastPayloadCache) ? lastPayloadCache : null;

      if (typeof _lastSkillsDomSig !== 'undefined') _lastSkillsDomSig = '';
      if (typeof telemetryLastSig !== 'undefined') telemetryLastSig = '';

      const pendingKeys = Object.keys(_pendingBlockRenders);
      for (let i = 0; i < pendingKeys.length; i++) {
        const k = pendingKeys[i];
        const fn = _pendingBlockRenders[k];
        delete _pendingBlockRenders[k];
        if (typeof fn === 'function') {
          try { fn(); } catch {}
        }
      }

      if (typeof discoveredSkills !== 'undefined' && Array.isArray(discoveredSkills) && typeof renderSkills === 'function') {
        try { renderSkills(discoveredSkills, s.skillModes || {}); } catch {}
      }
      if (typeof renderCheckpoints === 'function') {
        try {
          renderCheckpoints(
            p && Array.isArray(p.checkpoints) ? p.checkpoints : undefined,
            p && Array.isArray(p.turnCheckpoints) ? p.turnCheckpoints : undefined,
            p && Array.isArray(p.shadowWorktrees) ? p.shadowWorktrees : undefined
          );
        } catch {}
      }
      const telSnap = (p && p.telemetry) || (typeof _lastTelemetrySnapshot !== 'undefined' ? _lastTelemetrySnapshot : null);
      if (telSnap && typeof renderTelemetry === 'function') {
        try { renderTelemetry(telSnap); } catch {}
      } else if (typeof renderSwarmTelemetry === 'function') {
        try { renderSwarmTelemetry(p && p.telemetry ? p.telemetry.swarm : null, s); } catch {}
      }
      if (p && p.circuitBreaker !== undefined && typeof renderCircuitBreaker === 'function') {
        try { renderCircuitBreaker(p.circuitBreaker); } catch {}
      }
      if (p && p.compaction !== undefined && typeof renderCompaction === 'function') {
        try { renderCompaction(p.compaction); } catch {}
      }
      if (typeof renderGuardDock === 'function') {
        try { renderGuardDock(p && p.guardPulse ? p.guardPulse : null); } catch {}
      }
      if (p && p.pitfalls !== undefined && typeof renderPitfalls === 'function') {
        try { renderPitfalls(p.pitfalls); } catch {}
      }
      if (typeof renderKnowledgeHub === 'function') {
        try {
          if (p) renderKnowledgeHub(p.victoryRecipes, p.federatedPeers, p.knowledgeStats);
          else renderKnowledgeHub();
        } catch {}
      }
      if (p && p.bayesian !== undefined && typeof renderBayesian === 'function') {
        try { renderBayesian(p.bayesian, s); } catch {}
      }
      if (typeof renderSentinelStatus === 'function') {
        try { renderSentinelStatus(p ? p.sentinel : null, s); } catch {}
      }
      const hwCtx = typeof _lastHwRenderCtx !== 'undefined' ? _lastHwRenderCtx : null;
      if ((p && (p.gpu !== undefined || p.ramCache !== undefined || p.cpu !== undefined)) || hwCtx) {
        const effGpu = p && p.gpu !== undefined ? p.gpu : (hwCtx ? hwCtx.gpu : null);
        const effRam = p && p.ramCache !== undefined ? p.ramCache : (hwCtx ? hwCtx.ramCache : null);
        const effCpu = p && p.cpu !== undefined ? p.cpu : (hwCtx ? hwCtx.cpu : null);
        if (typeof renderGpuAndRam === 'function') {
          try { renderGpuAndRam(effGpu, effRam, s, effCpu); } catch {}
        }
        if (typeof syncHwHeaderSummaryBadge === 'function') {
          try { syncHwHeaderSummaryBadge(s, effGpu, effRam); } catch {}
        }
        if (hwCtx && typeof updateLiveHardwareOpticalUi === 'function') {
          try {
            updateLiveHardwareOpticalUi(
              hwCtx.gpu,
              hwCtx.ollResolved,
              hwCtx.ramCache,
              s,
              hwCtx.capGb,
              hwCtx.ramBudgetMb,
              hwCtx.cpu
            );
          } catch {}
        }
      }
      if (typeof renderWiretapAndQuota === 'function') {
        try { renderWiretapAndQuota(p ? p.wiretapFaults : undefined, p ? p.quotaPacer : undefined); } catch {}
      }
      if (typeof renderTaskProgressAndHud === 'function') {
        try { renderTaskProgressAndHud(p ? p.taskProgress : null, p ? p.floatingHud : null, s); } catch {}
      }
      if (typeof detectedProjectInfo !== 'undefined' && detectedProjectInfo && typeof renderSmartPilotBanner === 'function') {
        try { renderSmartPilotBanner(detectedProjectInfo); } catch {}
      }

      if (_lastSetupDoctorData) {
        const docBox = document.getElementById('setupDoctorBox');
        if (docBox && docBox.style.display !== 'none') {
          try { renderSetupDoctorReport(_lastSetupDoctorData); } catch {}
        }
      }
      if (_lastAgentShieldData) {
        try { renderAgentShieldData(_lastAgentShieldData); } catch {}
      }
      if (_lastGatesData) {
        try { renderGatesStatusData(_lastGatesData); } catch {}
      }
      if (_lastProjectInstinctsData !== null) {
        try { renderProjectInstinctsList(_lastProjectInstinctsData); } catch {}
      }
      if (_lastSessionEpisodesData !== null) {
        const epBox = document.getElementById('sessionEpisodesContainer');
        if (epBox && epBox.style.display !== 'none') {
          try { renderSessionEpisodesData(_lastSessionEpisodesData); } catch {}
        }
      }
      const gdDrawer = document.getElementById('graphDebtDrawer');
      if (gdDrawer && gdDrawer.style.display !== 'none') {
        if (_lastGraphDebtKind === 'graph' && _lastGraphifyData) {
          try { renderGraphifyData(_lastGraphifyData); } catch {}
        } else if (_lastGraphDebtKind === 'debt' && _lastShortcutDebtData) {
          try { renderShortcutDebtData(_lastShortcutDebtData); } catch {}
        }
      }
    }

    const EXPERT_GPU_INPUT_IDS = [
      'inp-gpuEndpoint',
      'inp-gpuKeepAlive',
      'inp-gpuEmbedKeepAlive',
      'inp-gpuContextTokens',
      'inp-gpuOllamaDir',
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

