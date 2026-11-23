    function resolvePanelOllamaVram(oll, hw) {
      const rawList = Array.isArray(oll && oll.loadedModels) ? oll.loadedModels : [];
      if (rawList.length === 0) {
        return { loadedModels: [], loadedVramMb: Number((oll && oll.loadedVramMb) || 0) };
      }
      const tagMbMap = {};
      if (Array.isArray(oll && oll.downloadedModels)) {
        for (let i = 0; i < oll.downloadedModels.length; i++) {
          const dm = oll.downloadedModels[i];
          const rawName = String((dm && dm.name) || '').trim().toLowerCase();
          if (!rawName) continue;
          const normName = rawName.indexOf(':') >= 0 ? rawName : (rawName + ':latest');
          const sizeMb = Math.round((Number(dm && dm.sizeGb) || 0) * 1024);
          if (sizeMb > 0) tagMbMap[normName] = sizeMb;
        }
      }
      let fixedMb = 0;
      let reconciledSumMb = 0;
      let rawReconciledSum = 0;
      const items = rawList.map((m) => {
        const name = String((m && m.name) || '');
        const rawVramMb = Math.max(0, Number((m && m.rawVramMb !== undefined ? m.rawVramMb : m && m.vramMb) || 0));
        let vramMb = Math.max(0, Number((m && m.vramMb) || 0));
        let isReconciledCandidate = Boolean(m && m.reconciledVram);
        if (!isReconciledCandidate && vramMb > 0) {
          const lower = name.trim().toLowerCase();
          const normName = lower.indexOf(':') >= 0 ? lower : (lower + ':latest');
          const tagMb = tagMbMap[normName] || 0;
          if (tagMb > 0 && vramMb < tagMb * 0.85) {
            vramMb = Math.round(tagMb + vramMb);
            isReconciledCandidate = vramMb > rawVramMb;
          }
        }
        if (isReconciledCandidate) {
          reconciledSumMb += vramMb;
          rawReconciledSum += rawVramMb;
        } else {
          fixedMb += vramMb;
        }
        return { name, vramMb, rawVramMb, isReconciledCandidate, expiresAt: (m && m.expiresAt) || null };
      });

      if (hw && hw.vramReliable && Number(hw.usedMb) > 0 && fixedMb + reconciledSumMb > Number(hw.usedMb) && reconciledSumMb > 0) {
        const avail = Math.max(0, Number(hw.usedMb) - fixedMb);
        const cap = Math.max(rawReconciledSum, avail);
        let sumRec = 0;
        for (let i = 0; i < items.length; i++) {
          if (!items[i].isReconciledCandidate) continue;
          const scaled = Math.round((items[i].vramMb / reconciledSumMb) * avail);
          items[i].vramMb = Math.max(Math.min(items[i].rawVramMb, avail), scaled);
          sumRec += items[i].vramMb;
        }
        if (sumRec > cap) {
          let excess = sumRec - cap;
          for (let i = 0; i < items.length && excess > 0; i++) {
            if (!items[i].isReconciledCandidate) continue;
            const floor = Math.min(items[i].rawVramMb, avail);
            const cut = Math.min(excess, Math.max(0, items[i].vramMb - floor));
            items[i].vramMb -= cut;
            excess -= cut;
          }
        }
      }

      const loadedModels = items.map((it) => ({
        name: it.name,
        vramMb: it.vramMb,
        rawVramMb: it.rawVramMb,
        reconciledVram: it.vramMb > it.rawVramMb,
        expiresAt: it.expiresAt,
      }));
      const loadedVramMb = loadedModels.reduce((acc, it) => acc + (it.vramMb || 0), 0);
      return { loadedModels, loadedVramMb };
    }

    function computeClientMaxRamMb(totalRamMb) {
      const mb = Math.max(1024, Number(totalRamMb) || 8192);
      if (mb <= 5120) return 2048;
      if (mb <= 8700) return 4096;
      if (mb <= 12800) return 6144;
      if (mb <= 17500) return 8192;
      if (mb <= 26000) return 12288;
      if (mb <= 35000) return 16384;
      if (mb <= 52000) return 24576;
      return 32768;
    }

    function computeClientMaxVramMb(gpuHw) {
      const totalMb = Math.max(0, Number(gpuHw && gpuHw.totalMb) || 0);
      const usable = Boolean(gpuHw && (gpuHw.available || gpuHw.isDiscrete || gpuHw.vendor === 'apple') && totalMb >= 3500);
      if (!usable) return 4096;
      if (totalMb >= 30720) return 32768;
      if (totalMb >= 22528) return 24576;
      if (totalMb >= 15360) return 16384;
      if (totalMb >= 13312) return 14336;
      if (totalMb >= 11264) return 12288;
      if (totalMb >= 7168) return 8192;
      if (totalMb >= 5120) return 6144;
      return 4096;
    }

    function resolveClientHardwareCeilings(gpu, ramCache, cpu) {
      const base = currentHardwareCeilings || (currentHardwareProfile && currentHardwareProfile.hardwareCeilings) || null;
      const gpuHw = (gpu && gpu.hardware) || (currentHardwareProfile && currentHardwareProfile.gpu) || null;
      const cpuHw = (cpu && cpu.hardware) || null;
      const hpSys = (currentHardwareProfile && currentHardwareProfile.system) || null;

      const totalRamMb = Number((ramCache && ramCache.totalRamMb) || (base && base.totalRamMb) || (hpSys && hpSys.totalRamMb) || 0);
      const logicalCores = Number((cpuHw && cpuHw.logicalCores) || (base && base.logicalCores) || (hpSys && hpSys.logicalCores) || 0);
      const hasGpuInfo = Boolean((gpuHw && (gpuHw.name || gpuHw.totalMb !== undefined || gpuHw.available !== undefined)) || base);

      if (!base && !totalRamMb && !logicalCores && !hasGpuInfo) {
        return null;
      }

      const gpuTotalVramMb = Number((gpuHw && gpuHw.totalMb) || (base && base.gpuTotalVramMb) || 0);
      const gpuAvailable = gpuHw
        ? Boolean((gpuHw.available || gpuHw.isDiscrete || gpuHw.vendor === 'apple') && gpuTotalVramMb >= 3500)
        : Boolean(base && base.gpuAvailable);
      const maxVramMb = gpuHw && (gpuHw.totalMb > 0 || gpuHw.available !== undefined)
        ? computeClientMaxVramMb(gpuHw)
        : Number((base && base.maxVramMb) || 4096);
      const maxRamBudgetMb = totalRamMb > 0
        ? computeClientMaxRamMb(totalRamMb)
        : Number((base && base.maxRamBudgetMb) || 32768);
      const maxCpuThreads = logicalCores > 0
        ? Math.max(2, Math.min(64, Math.round(logicalCores) - 4))
        : Number((base && base.maxCpuThreads) || 64);

      const resolved = {
        totalRamMb: totalRamMb || 0,
        totalRamGb: totalRamMb > 0 ? Math.max(1, Math.round(totalRamMb / 1024)) : 0,
        logicalCores: logicalCores || 0,
        gpuAvailable,
        gpuTotalVramMb,
        maxVramMb,
        maxRamBudgetMb,
        maxCpuThreads,
      };
      currentHardwareCeilings = resolved;
      return resolved;
    }

    function applyButtonGroupCeiling(groupSelector, maxVal, activeVal) {
      const hasCap = Number.isFinite(maxVal) && maxVal > 0;
      document.querySelectorAll(groupSelector + ' button:not(.hw-dynamic-cap-btn)').forEach((btn) => {
        const val = Number(btn.dataset.val);
        const overCap = hasCap && val > maxVal;
        btn.classList.toggle('hw-cap-hidden', overCap);
        btn.hidden = overCap;
        btn.disabled = overCap;
        btn.classList.toggle('active', !overCap && val === activeVal);
      });
    }

    function applyCpuThreadsGroupCeiling(maxThreads, activeVal) {
      const group = document.getElementById('cpuThreadsCapGroup');
      if (!group) return;
      const hasCap = Number.isFinite(maxThreads) && maxThreads > 0;
      const staticBtns = Array.from(group.querySelectorAll('button:not(.hw-dynamic-cap-btn)'));
      let hasExactCapBtn = false;

      staticBtns.forEach((btn) => {
        const val = Number(btn.dataset.val);
        const overCap = hasCap && val > maxThreads;
        btn.classList.toggle('hw-cap-hidden', overCap);
        btn.hidden = overCap;
        btn.disabled = overCap;
        if (!overCap && val === maxThreads) hasExactCapBtn = true;
        btn.classList.toggle('active', !overCap && val === activeVal);
      });

      let dynBtn = group.querySelector('.hw-dynamic-cap-btn');
      if (hasCap && !hasExactCapBtn) {
        if (!dynBtn) {
          dynBtn = document.createElement('button');
          dynBtn.type = 'button';
          dynBtn.className = 'win-btn hw-dynamic-cap-btn';
          dynBtn.setAttribute('data-action', 'setCpuMaxThreads');
          group.appendChild(dynBtn);
        }
        const capStr = String(maxThreads);
        dynBtn.dataset.val = capStr;
        dynBtn.setAttribute('data-arg', capStr);
        dynBtn.textContent = capStr;
        dynBtn.hidden = false;
        dynBtn.disabled = false;
        dynBtn.classList.remove('hw-cap-hidden');
        dynBtn.classList.toggle('active', activeVal === maxThreads);
      } else if (dynBtn) {
        dynBtn.remove();
      }
    }

    function renderGpuAndRam(gpu, ramCache, s, cpu) {
      const cfg = (gpu && gpu.config) || {};
      const cpuCfg = (cpu && cpu.config) || {};
      const ceilings = resolveClientHardwareCeilings(gpu, ramCache, cpu);
      const rawCapMb = Number((s && s.gpuMaxVramMb) || cfg.gpuMaxVramMb || 4096);
      const capMb = ceilings && ceilings.maxVramMb ? Math.min(rawCapMb, ceilings.maxVramMb) : rawCapMb;
      const capGb = Math.round(capMb / 1024);
      const rawRamMb = Number((s && s.ramMaxBudgetMb) || (ramCache && ramCache.budgetMb) || 4096);
      const ramBudgetMb = ceilings && ceilings.maxRamBudgetMb ? Math.min(rawRamMb, ceilings.maxRamBudgetMb) : rawRamMb;
      const rawCpuThreads = Number((s && s.cpuMaxThreads) || cpuCfg.cpuMaxThreads || 6);
      const cpuMaxThreads = ceilings && ceilings.maxCpuThreads ? Math.min(rawCpuThreads, ceilings.maxCpuThreads) : rawCpuThreads;

      const chkGpu = document.getElementById('chk-gpuEnabled');
      if (chkGpu) chkGpu.checked = Boolean(s && s.gpuEnabled);
      const chkSem = document.getElementById('chk-gpuSemanticSearch');
      if (chkSem) chkSem.checked = s.gpuSemanticSearch !== false;
      const chkLog = document.getElementById('chk-gpuAutoDistillLogs');
      if (chkLog) chkLog.checked = s.gpuAutoDistillLogs !== false;
      const chkCritic = document.getElementById('chk-gpuPostEditCritic');
      if (chkCritic) chkCritic.checked = s.gpuPostEditCritic !== false;

      const chkCpuPool = document.getElementById('chk-cpuMulticoreEnabled');
      if (chkCpuPool) chkCpuPool.checked = s.cpuMulticoreEnabled !== false;
      const chkCpuTri = document.getElementById('chk-cpuTrigramIndex');
      if (chkCpuTri) chkCpuTri.checked = s.cpuTrigramIndex !== false;
      const chkCpuRerank = document.getElementById('chk-cpuCrossRerank');
      if (chkCpuRerank) chkCpuRerank.checked = s.cpuCrossRerank !== false;
      const chkCpuVer = document.getElementById('chk-cpuParallelVerify');
      if (chkCpuVer) chkCpuVer.checked = s.cpuParallelVerify !== false;
      const chkCpuSota = document.getElementById('chk-cpuSotaEngines');
      if (chkCpuSota) chkCpuSota.checked = s.cpuSotaEngines !== false;
      const chkRamSota = document.getElementById('chk-ramSotaEngines');
      if (chkRamSota) chkRamSota.checked = s.ramSotaEngines !== false;
      const chkGpuWarmRam = document.getElementById('chk-gpuWarmHostRamCache');
      if (chkGpuWarmRam) chkGpuWarmRam.checked = s.gpuWarmHostRamCache !== false;

      syncSentinelCheckboxes(s);
      renderSentinelStatus(lastPayloadCache ? lastPayloadCache.sentinel : null, s);

      applyCpuThreadsGroupCeiling(ceilings ? ceilings.maxCpuThreads : null, cpuMaxThreads);

      const chkRam = document.getElementById('chk-ramCacheEnabled');
      if (chkRam) chkRam.checked = s.ramCacheEnabled !== false;
      const chkWarm = document.getElementById('chk-ramAutoWarmOnSessionStart');
      if (chkWarm) chkWarm.checked = s.ramAutoWarmOnSessionStart !== false;
      const chkAutoStart = document.getElementById('chk-gpuAutoStart');
      if (chkAutoStart) chkAutoStart.checked = s.gpuAutoStart !== false;
      const chkPreAdvice = document.getElementById('chk-gpuShowPreTaskAdvice');
      if (chkPreAdvice) chkPreAdvice.checked = s.gpuShowPreTaskAdvice !== false;
      const chkUnloadExit = document.getElementById('chk-gpuUnloadOnExit');
      if (chkUnloadExit) chkUnloadExit.checked = s.gpuUnloadOnExit !== false;

      applyButtonGroupCeiling('#gpuVramCapGroup', ceilings ? ceilings.maxVramMb : null, capMb);
      applyButtonGroupCeiling('#ramBudgetMainGroup', ceilings ? ceilings.maxRamBudgetMb : null, ramBudgetMb);
      applyButtonGroupCeiling('#ramBudgetGroup', ceilings ? ceilings.maxRamBudgetMb : null, ramBudgetMb);

      const vramHintEl = document.getElementById('gpuVramCapHint');
      if (vramHintEl) {
        if (ceilings) {
          vramHintEl.textContent = ceilings.gpuAvailable
            ? ('(до ' + Math.round(ceilings.maxVramMb / 1024) + ' ГБ)')
            : '(GPU не найдена · мин. 4 ГБ)';
        } else {
          vramHintEl.textContent = '';
        }
      }
      const ramHintEl = document.getElementById('ramBudgetCapHint');
      if (ramHintEl) {
        ramHintEl.textContent = ceilings && ceilings.totalRamGb > 0
          ? ('(до ' + Math.round(ceilings.maxRamBudgetMb / 1024) + ' из ' + ceilings.totalRamGb + ' ГБ ОЗУ)')
          : '';
      }
      const cpuHintEl = document.getElementById('cpuThreadsCapHint');
      if (cpuHintEl) {
        cpuHintEl.textContent = ceilings && ceilings.logicalCores > 0
          ? ('(до ' + ceilings.maxCpuThreads + ' из ' + ceilings.logicalCores + ' пот.)')
          : '';
      }

      syncExpertInput('inp-gpuEndpoint', (s && s.gpuEndpoint) || cfg.gpuEndpoint || 'http://127.0.0.1:11434');
      syncExpertInput('inp-gpuChatModel', (s && s.gpuChatModel) || cfg.gpuChatModel || 'gemma4:12b');
      syncExpertInput('inp-gpuEmbedModel', (s && s.gpuEmbedModel) || cfg.gpuEmbedModel || 'qwen3-embedding:0.6b');
      syncExpertInput('inp-gpuKeepAlive', (s && s.gpuKeepAlive) || cfg.gpuKeepAlive || '15m');
      syncExpertInput('inp-gpuEmbedKeepAlive', (s && s.gpuEmbedKeepAlive) || cfg.gpuEmbedKeepAlive || '90m');
      syncExpertInput('inp-gpuContextTokens', (s && s.gpuContextTokens) || cfg.gpuContextTokens || 4096);
      syncExpertInput('inp-gpuModelsDir', (s && s.gpuModelsDir !== undefined) ? s.gpuModelsDir : (cfg.gpuModelsDir || ''));

      const ramSubEl = document.getElementById('ramCacheSubLine');

      const enabled = Boolean(s && s.gpuEnabled);
      const oll = (gpu && gpu.ollama) || {};
      const hw = (gpu && gpu.hardware) || {};
      const tel = (gpu && gpu.telemetry) || {};

      const legendEl = document.getElementById('gpuRamSectionLegend');
      if (legendEl) {
        const ramGbLbl = Math.max(1, Math.round(ramBudgetMb / 1024));
        const gpuLbl = hw && hw.available && hw.name
          ? (hw.name.replace(/NVIDIA GeForce |AMD Radeon |Intel\(R\) /i, '').trim() + ' (до ' + capGb + ' ГБ)')
          : (enabled ? ('Локальный GPU (до ' + capGb + ' ГБ)') : 'Контур CPU + In-RAM');
        legendEl.textContent = '🎮 ' + gpuLbl + ' и память проекта (' + ramGbLbl + ' ГБ RAM)';
      }

      const ollResolved = resolvePanelOllamaVram(oll, hw);
      const vramFit = computeClientVramFit(s, cfg, oll, ollResolved, gpu && gpu.vramFit);
      syncGpuModelSelects(s, cfg, oll, ollResolved, vramFit);
      renderGpuVramFitAlert(s, vramFit);
      renderGpuCascadePullStatus(gpu ? gpu.pullStatus : null, gpu, s);

      if (ramSubEl) {
        const instSuffix = ramCache && ramCache.active && Number(ramCache.instancesCount || 1) > 1
          ? (' · Демонов ОЗУ: ' + ramCache.instancesCount)
          : '';
        const sotaInfo = ramCache && ramCache.sota ? ramCache.sota : null;
        const sotaOpsCount = sotaInfo
          ? (Number(sotaInfo.memoHits || 0) + Number(sotaInfo.repairRecalls || 0))
          : 0;
        const sotaSuffix = (sotaInfo && (Number(sotaInfo.memoHits || 0) > 0 || Number(sotaInfo.repairRecalls || 0) > 0))
          ? (' · Мемо/RepairKV: +' + sotaOpsCount)
          : '';
        const hostWarmedLbl = formatHostRamWarmedLabel(tel.hostRamWarmedMb);
        const ddr5Suffix = (hostWarmedLbl && (!s || s.gpuWarmHostRamCache !== false))
          ? (' · DDR5 GGUF: ' + hostWarmedLbl)
          : '';
        ramSubEl.textContent =
          'Векторный индекс: проиндексировано ' +
          (tel.indexedFiles || 0) +
          ' файлов (' +
          (tel.indexedChunks || 0) +
          ' фрагментов)' +
          instSuffix +
          sotaSuffix +
          ddr5Suffix;
      }

      updateLiveHardwareOpticalUi(gpu, ollResolved, ramCache, s, capGb, ramBudgetMb, cpu);
    }

    function syncHwHeaderSummaryBadge(s, gpu, ramCache, isWorkingOverride) {
      const badgeEl = document.getElementById('hwCardHeaderSummaryBadge');
      if (!badgeEl) return;
      const st = s || currentState || {};
      const ramOn = st.ramCacheEnabled !== false;
      const gpuOn = Boolean(st.gpuEnabled);
      const ramGb = Math.max(1, Math.round(Number(st.ramMaxBudgetMb || (ramCache && ramCache.budgetMb) || 4096) / 1024));
      const vramGb = Math.max(2, Math.round(Number(st.gpuMaxVramMb || (gpu && gpu.config && gpu.config.gpuMaxVramMb) || 4096) / 1024));
      if (isWorkingOverride) {
        badgeEl.className = 'swarm-pill active';
        badgeEl.textContent = '⚡ В работе';
        return;
      }
      badgeEl.className = 'swarm-pill idle';
      if (ramOn && gpuOn) {
        badgeEl.textContent = ramGb + ' ГБ RAM · ' + vramGb + ' ГБ GPU';
      } else if (ramOn) {
        badgeEl.textContent = ramGb + ' ГБ RAM · CPU';
      } else if (gpuOn) {
        badgeEl.textContent = vramGb + ' ГБ GPU';
      } else {
        badgeEl.textContent = 'CPU-режим';
      }
    }

    function formatHostRamWarmedLabel(mb) {
      const num = Number(mb || 0);
      if (!Number.isFinite(num) || num <= 0) return '';
      return num >= 1024 ? ((num / 1024).toFixed(1) + ' ГБ') : (Math.round(num) + ' МБ');
    }

    const RAM_AFTERGLOW_MS = 3200;
    const GPU_AFTERGLOW_MS = 2400;
    const CPU_AFTERGLOW_MS = 2800;
    let _hwAfterglowDecayTimer = null;
    let _lastUiRamOpSeq = -1;
    let _lastUiRamPulseAt = 0;
    let _lastUiGpuOpSeq = -1;
    let _lastUiGpuPulseAt = 0;
    let _lastUiCpuOpSeq = -1;
    let _lastUiCpuPulseAt = 0;
    let _lastHwRenderCtx = null;

    function formatRamLiveOpRu(live) {
      if (!live) return '';
      const op = String(live.lastOp || '');
      const opNames = {
        ram_slice: 'Срез кода',
        ram_search: 'Поиск в ОЗУ',
        hybrid_search: 'Гибридный поиск',
        ram_context_pack: 'Пакет контекста',
        gold_context: 'Gold-контекст',
        session_repomap: 'Карта символов',
        ram_hit: 'Чтение буфера',
        speculative_prefetch: 'Спекулятивный префетч',
        repair_kv: 'Память RepairKV',
        memo_hit: 'Мемоизация ACON',
      };
      const base = opNames[op] || 'Обращение к ОЗУ';
      const tgt = live.lastTarget ? (' · ' + live.lastTarget) : '';
      const burst = Number(live.burstCount || 0) > 1 ? (' (+' + live.burstCount + ' хитов)') : '';
      const ms = Number(live.lastLatencyMs || 0) > 0 ? (' · ' + live.lastLatencyMs + ' мс') : '';
      return base + tgt + burst + ms;
    }

    function formatGpuLiveOpRu(live, fallbackModel) {
      if (!live) return '';
      if (live.currentDetail) {
        const msTag = (!live.isWorking && Number(live.lastLatencyMs || 0) > 0)
          ? (' (' + live.lastLatencyMs + ' мс)')
          : '';
        return live.currentDetail + msTag;
      }
      const m = live.currentModel || fallbackModel || 'Ollama';
      if (live.currentOp === 'autocomplete') return 'Умный ввод (' + m + ')';
      if (live.currentOp === 'distill') return 'Дистилляция на ' + m;
      if (live.currentOp === 'vector_index') return 'Индексация векторов (' + m + ')';
      if (live.currentOp === 'semantic_embed') return 'Семантический поиск (' + m + ')';
      return 'Расчёт на ' + m;
    }

    function formatCpuLiveOpRu(live) {
      if (!live) return 'Расчёт в пуле потоков';
      const op = String(live.currentOp || '');
      let base = String(live.currentDetail || '').trim();
      if (!base) {
        if (op.indexOf('parseMetadataBatch') === 0) base = 'Разбор AST и триграмм';
        else if (op.indexOf('chunkVectorsBatch') === 0) base = 'Нарезка чанков векторов';
        else if (op.indexOf('syntaxCheckBatch') === 0) base = 'Проверка синтаксиса';
        else if (op.indexOf('auditFilesBatch') === 0) base = 'Стресс-аудит кода';
        else if (op === 'cross_rerank') base = 'CPU Cross-Reranker';
        else if (op === 'parallel_verify') base = 'Параллельная проверка';
        else if (op === 'ddmin_parallel') base = 'Минимизация ddmin';
        else base = 'Задача пула потоков';
      }
      const msTag = (!live.isWorking && Number(live.lastLatencyMs || 0) > 0)
        ? (' · ' + live.lastLatencyMs + ' мс')
        : '';
      return base + msTag;
    }

    function formatHwCapPctLabel(usedVal, maxVal) {
      const used = Math.max(0, Number(usedVal) || 0);
      const cap = Math.max(1, Number(maxVal) || 1);
      if (used <= 0) return '0%';
      const pct = (used / cap) * 100;
      if (pct > 0 && pct < 1) return '<1%';
      return Math.min(999, Math.round(pct)) + '%';
    }

    function updateLiveHardwareOpticalUi(gpu, ollResolved, ramCache, s, capGb, ramBudgetMb, cpu) {
      _lastHwRenderCtx = { gpu, ollResolved, ramCache, s, capGb, ramBudgetMb, cpu };
      const now = Date.now();
      const ramEnabled = !(s && s.ramCacheEnabled === false) && !(ramCache && ramCache.enabled === false);
      const ramWarm = Boolean(ramEnabled && ramCache && ramCache.active);
      const ramLive = (ramCache && ramCache.liveActivity) || {};

      if (ramWarm && Number(ramLive.opSeq || 0) > 0) {
        if (_lastUiRamOpSeq === -1) {
          _lastUiRamOpSeq = Number(ramLive.opSeq || 0);
          if (ramLive.isWorking && Number(ramLive.msSinceLast ?? 99999) <= RAM_AFTERGLOW_MS) {
            _lastUiRamPulseAt = now - Number(ramLive.msSinceLast || 0);
          }
        } else if (Number(ramLive.opSeq) !== _lastUiRamOpSeq) {
          _lastUiRamOpSeq = Number(ramLive.opSeq);
          _lastUiRamPulseAt = now;
        }
      }

      const ramPulseAge = _lastUiRamPulseAt > 0 ? (now - _lastUiRamPulseAt) : 999999;
      const ramWorking = Boolean(
        ramWarm && (Number(ramLive.activeOps || 0) > 0 || ramPulseAge <= RAM_AFTERGLOW_MS)
      );
      const ramRatio = Number(ramLive.activeOps || 0) > 0
        ? 1
        : (ramPulseAge <= RAM_AFTERGLOW_MS ? Math.max(0.06, 1 - ramPulseAge / RAM_AFTERGLOW_MS) : 0);

      const gpuEnabled = Boolean(s && s.gpuEnabled);
      const oll = (gpu && gpu.ollama) || {};
      const gpuLive = (gpu && gpu.liveActivity) || {};
      const loadedVramMb = Number((ollResolved && ollResolved.loadedVramMb) || 0);
      const gpuWarmInVram = Boolean(gpuEnabled && oll.running && loadedVramMb > 0);

      if (gpuEnabled && Number(gpuLive.opSeq || 0) > 0) {
        if (_lastUiGpuOpSeq === -1) {
          _lastUiGpuOpSeq = Number(gpuLive.opSeq || 0);
          if ((gpuLive.isWorking || gpuLive.isAfterglow) && Number(gpuLive.msSinceLast ?? 99999) <= GPU_AFTERGLOW_MS) {
            _lastUiGpuPulseAt = now - Number(gpuLive.msSinceLast || 0);
          }
        } else if (Number(gpuLive.opSeq) !== _lastUiGpuOpSeq) {
          _lastUiGpuOpSeq = Number(gpuLive.opSeq);
          _lastUiGpuPulseAt = now;
        }
      }

      const gpuInFlight = Number(gpuLive.inFlightCount || 0) > 0 || Boolean(gpuLive.isWorking);
      if (gpuInFlight) {
        _lastUiGpuPulseAt = now;
      }
      const gpuPulseAge = _lastUiGpuPulseAt > 0 ? (now - _lastUiGpuPulseAt) : 999999;
      const gpuWorking = Boolean(gpuEnabled && (gpuInFlight || gpuPulseAge <= GPU_AFTERGLOW_MS));
      const gpuRatio = gpuInFlight
        ? 1
        : (gpuPulseAge <= GPU_AFTERGLOW_MS ? Math.max(0.06, 1 - gpuPulseAge / GPU_AFTERGLOW_MS) : 0);

      const cpuPoolOn = !(s && s.cpuMulticoreEnabled === false);
      const cpuEnabled = Boolean(
        cpuPoolOn ||
        !(s && s.cpuTrigramIndex === false) ||
        !(s && s.cpuCrossRerank === false) ||
        !(s && s.cpuParallelVerify === false)
      );
      const cpuHw = (cpu && cpu.hardware) || {};
      const cpuTel = (cpu && cpu.telemetry) || {};
      const cpuPool = (cpu && cpu.pool) || {};
      const cpuLive = (cpu && cpu.liveActivity) || {};
      const cpuCfg = (cpu && cpu.config) || {};
      const cfgThreads = Number((s && s.cpuMaxThreads) || cpuCfg.cpuMaxThreads || 12);
      const effThreads = cpuPoolOn ? Math.max(1, Number(cpuHw.effectiveMaxThreads || cfgThreads)) : 1;
      const logCores = Math.max(effThreads, Number(cpuHw.logicalCores || effThreads));

      if (cpuEnabled && Number(cpuLive.opSeq || 0) > 0) {
        if (_lastUiCpuOpSeq === -1) {
          _lastUiCpuOpSeq = Number(cpuLive.opSeq || 0);
          if ((cpuLive.isWorking || cpuLive.isAfterglow) && Number(cpuLive.msSinceLast ?? 99999) <= CPU_AFTERGLOW_MS) {
            _lastUiCpuPulseAt = now - Number(cpuLive.msSinceLast || 0);
          }
        } else if (Number(cpuLive.opSeq) !== _lastUiCpuOpSeq) {
          _lastUiCpuOpSeq = Number(cpuLive.opSeq);
          _lastUiCpuPulseAt = now;
        }
      }

      const cpuInFlight =
        Number(cpuLive.inFlightCount || 0) > 0 ||
        Number(cpuPool.busyWorkers || 0) > 0 ||
        Boolean(cpuLive.isWorking);
      if (cpuInFlight) {
        _lastUiCpuPulseAt = now;
      }
      const cpuPulseAge = _lastUiCpuPulseAt > 0 ? (now - _lastUiCpuPulseAt) : 999999;
      const cpuWorking = Boolean(cpuEnabled && (cpuInFlight || cpuPulseAge <= CPU_AFTERGLOW_MS));
      const cpuRatio = cpuInFlight
        ? 1
        : (cpuPulseAge <= CPU_AFTERGLOW_MS ? Math.max(0.06, 1 - cpuPulseAge / CPU_AFTERGLOW_MS) : 0);

      _hwHasLiveActivity = ramWorking || gpuWorking || cpuWorking || _gpuPullActiveUi;
      syncHwHeaderSummaryBadge(s, gpu, ramCache, ramWorking || gpuWorking || cpuWorking);

      // 1. Верхние мини-пилюли в шапке прогресса
      const topRamPill = document.getElementById('topRamLivePill');
      const topRamTxt = document.getElementById('topRamLiveText');
      if (topRamPill && topRamTxt) {
        if (!ramEnabled) {
          topRamPill.className = 'hw-live-pill is-off';
          topRamTxt.textContent = 'RAM · Выкл';
        } else if (ramWorking) {
          const shortOp = ramLive.lastOp === 'ram_slice' ? 'Срез кода' : (ramLive.lastOp === 'ram_search' ? 'Поиск' : 'Чтение');
          topRamPill.className = 'hw-live-pill is-working-ram';
          topRamTxt.textContent = 'RAM · ⚡ ' + shortOp;
        } else if (ramWarm) {
          topRamPill.className = 'hw-live-pill is-standby';
          topRamTxt.textContent = 'RAM · В фоне (' + Math.round(ramCache.cacheUsedMb || 0) + ' МБ)';
        } else {
          topRamPill.className = 'hw-live-pill is-off';
          topRamTxt.textContent = 'RAM · Ожидание';
        }
      }

      const topGpuPill = document.getElementById('topGpuLivePill');
      const topGpuTxt = document.getElementById('topGpuLiveText');
      if (topGpuPill && topGpuTxt) {
        if (!gpuEnabled) {
          topGpuPill.className = 'hw-live-pill is-off';
          topGpuTxt.textContent = 'GPU · Выкл';
        } else if (gpuWorking) {
          const activeModShort = String(gpuLive.currentModel || (s && s.gpuChatModel) || 'Ollama').split(':')[0];
          topGpuPill.className = 'hw-live-pill is-working-gpu';
          topGpuTxt.textContent = 'GPU · 🔥 ' + activeModShort;
        } else if (gpuWarmInVram) {
          topGpuPill.className = 'hw-live-pill is-standby';
          topGpuTxt.textContent = 'GPU · В фоне (' + (loadedVramMb / 1024).toFixed(1) + ' ГБ)';
        } else {
          topGpuPill.className = 'hw-live-pill is-off';
          topGpuTxt.textContent = oll.running ? 'GPU · Выгружена' : 'GPU · Сон';
        }
      }

      const topCpuPill = document.getElementById('topCpuLivePill');
      const topCpuTxt = document.getElementById('topCpuLiveText');
      if (topCpuPill && topCpuTxt) {
        if (!cpuEnabled) {
          topCpuPill.className = 'hw-live-pill is-off';
          topCpuTxt.textContent = 'CPU · Выкл';
        } else if (cpuWorking) {
          const opRaw = String(cpuLive.currentOp || '');
          const shortCpuOp = opRaw === 'cross_rerank'
            ? 'Rerank'
            : (opRaw === 'parallel_verify' || opRaw === 'ddmin_parallel' ? 'Проверка' : 'Воркеры');
          topCpuPill.className = 'hw-live-pill is-working-cpu';
          topCpuTxt.textContent = 'CPU · ⚡ ' + shortCpuOp;
        } else {
          topCpuPill.className = 'hw-live-pill is-standby';
          topCpuTxt.textContent = 'CPU · В фоне (' + effThreads + ' пот.)';
        }
      }

      // 2. Оптические карточки внутри gpuRamCard (Liquid Silk: гидро-мениск и световоды)
      const ramCard = document.getElementById('ramLiveUnitCard');
      const ramBadge = document.getElementById('ramUnitStateBadge');
      const ramMetric = document.getElementById('ramUnitMetricVal');
      const ramOp = document.getElementById('ramUnitOpText');
      const ramFill = document.getElementById('ramUnitAfterglowFill');
      const ramCapPct = document.getElementById('ramUnitCapPct');
      syncRamSavedPillFromState(ramCache);
      if (ramCard && ramBadge && ramMetric && ramOp && ramFill) {
        const usedMb = ramCache && ramCache.active ? (ramCache.cacheUsedMb || 0) : 0;
        const capRam = Math.max(256, Number(ramBudgetMb || (ramCache && ramCache.budgetMb) || 4096));
        const rawRamFrac = Math.max(0, Math.min(1, usedMb / capRam));
        ramMetric.textContent = usedMb + ' / ' + capRam + ' МБ';
        if (ramCapPct) {
          ramCapPct.textContent = !ramEnabled ? 'Выкл' : formatHwCapPctLabel(usedMb, capRam);
        }
        if (!ramEnabled) {
          ramCard.className = 'hw-optical-unit ram-unit is-off';
          ramBadge.textContent = '⚪ Выкл';
          ramOp.textContent = 'In-RAM буфер отключён в настройках';
          ramFill.style.setProperty('--hw-fill', '0');
        } else if (ramWorking) {
          const workFill = Math.min(1, Math.max(rawRamFrac, usedMb > 0 ? 0.08 : 0.04, 0.16 + 0.56 * ramRatio));
          ramCard.className = 'hw-optical-unit ram-unit is-working';
          ramBadge.textContent = '⚡ В работе';
          ramOp.textContent = formatRamLiveOpRu(ramLive);
          ramFill.style.setProperty('--hw-fill', workFill.toFixed(3));
        } else if (ramWarm) {
          const wsArr = Array.isArray(ramCache.workspaces) ? ramCache.workspaces : [];
          const filesCount = wsArr.reduce((acc, w) => acc + (Number(w && w.files) || 0), 0);
          const standbyFill = usedMb > 0 ? Math.max(0.065, rawRamFrac) : 0.045;
          ramCard.className = 'hw-optical-unit ram-unit is-standby';
          ramBadge.textContent = '🟡 В фоне';
          ramOp.textContent = filesCount > 0
            ? ('Прогрето в ОЗУ: ' + filesCount + ' файлов · ждёт запроса')
            : ('Демон активен · ждёт обращений (хитов: ' + (ramCache.hits || 0) + ')');
          ramFill.style.setProperty('--hw-fill', standbyFill.toFixed(3));
        } else {
          ramCard.className = 'hw-optical-unit ram-unit is-off';
          ramBadge.textContent = '⚪ Спит';
          ramOp.textContent = 'Автостарт при первом обращении ИИ';
          ramFill.style.setProperty('--hw-fill', '0.032');
        }
      }

      const gpuCard = document.getElementById('gpuLiveUnitCard');
      const gpuBadge = document.getElementById('gpuUnitStateBadge');
      const gpuMetric = document.getElementById('gpuUnitMetricVal');
      const gpuSavedPill = document.getElementById('gpuUnitSavedPill');
      const gpuOp = document.getElementById('gpuUnitOpText');
      const gpuFill = document.getElementById('gpuUnitAfterglowFill');
      const gpuCapPct = document.getElementById('gpuUnitCapPct');
      const gpuTel = (gpu && gpu.telemetry) || {};
      const gpuHw = (gpu && gpu.hardware) || {};
      const gpuGuard = (gpu && gpu.thermalGuard) || {};
      if (gpuSavedPill) {
        const savedGpuTok = Math.max(
          Number(gpuTel.savedTokensEstimate || 0),
          Number((_lastTelemetrySnapshot && _lastTelemetrySnapshot.gpuSavedTokens) || 0)
        );
        gpuSavedPill.textContent = '~' + formatK(savedGpuTok) + ' ток.';
        gpuSavedPill.title =
          'Экономия видеомодели GPU: ~' + formatExactInt(savedGpuTok) + ' ток. ' +
          '(сжатий логов: ' + formatExactInt(gpuTel.distillCalls || 0) +
          ' · семантических поисков: ' + formatExactInt(gpuTel.semanticSearches || 0) + ')';
      }
      if (gpuCard && gpuBadge && gpuMetric && gpuOp && gpuFill) {
        const usedVramGb = (loadedVramMb / 1024).toFixed(1);
        const capVramMb = Math.max(256, Number(capGb || 4) * 1024);
        const rawGpuFrac = Math.max(0, Math.min(1, loadedVramMb / capVramMb));
        const liveUtilPct = Math.max(0, Math.min(100, Math.round(Number(gpuHw.utilPct || 0))));
        const liveTempC = Math.max(0, Math.round(Number(gpuHw.tempC || 0)));
        const hwSensorsSuffix = (gpuEnabled && gpuHw.available && (liveTempC > 0 || liveUtilPct > 0))
          ? (' · ' + liveUtilPct + '% · ' + (liveTempC > 0 ? (liveTempC + '°C') : '—'))
          : '';
        gpuMetric.textContent = usedVramGb + ' / ' + capGb + ' ГБ';
        if (gpuCapPct) {
          gpuCapPct.textContent = !gpuEnabled
            ? 'Выкл'
            : (formatHwCapPctLabel(loadedVramMb, capVramMb) + hwSensorsSuffix);
        }
        gpuMetric.title = gpuHw.available
          ? (
            gpuHw.name +
            ' · Модели Ollama: ' + usedVramGb + ' ГБ' +
            ' · Всего на GPU: ' + ((gpuHw.usedMb || 0) / 1024).toFixed(1) + ' / ' + ((gpuHw.totalMb || 0) / 1024).toFixed(1) + ' ГБ' +
            ' (свободно ' + ((gpuHw.freeMb || 0) / 1024).toFixed(1) + ' ГБ) · Ядро: ' + liveUtilPct + '% · ' + liveTempC + '°C'
          )
          : '';
        if (!gpuEnabled) {
          gpuCard.className = 'hw-optical-unit gpu-unit is-off';
          gpuBadge.textContent = '⚪ Выкл';
          gpuOp.textContent = 'Локальный GPU-помощник выключен';
          gpuOp.title = '';
          gpuFill.style.setProperty('--hw-fill', '0');
        } else if (gpuGuard.throttled && !gpuWorking) {
          const isThermal = gpuGuard.reason === 'thermal_throttle';
          gpuCard.className = 'hw-optical-unit gpu-unit is-standby is-over-cap';
          gpuBadge.textContent = isThermal ? ('🌡️ ' + liveTempC + '°C') : ('🎮 GPU ' + liveUtilPct + '%');
          gpuOp.textContent = isThermal
            ? ('Пауза по перегреву GPU (' + liveTempC + '°C) · фоновые задачи приостановлены')
            : ('Внешняя нагрузка GPU (' + liveUtilPct + '%) · фоновый индекс отложен');
          gpuOp.title = gpuGuard.message || '';
          gpuFill.style.setProperty('--hw-fill', Math.max(0.08, rawGpuFrac).toFixed(3));
        } else if (gpuWorking) {
          const liveText = formatGpuLiveOpRu(gpuLive, (s && s.gpuChatModel) || 'gemma4:12b');
          const workVramFill = Math.min(1, Math.max(rawGpuFrac, loadedVramMb > 0 ? 0.08 : 0.18 + 0.58 * gpuRatio));
          gpuCard.className = 'hw-optical-unit gpu-unit is-working';
          gpuBadge.textContent = gpuInFlight ? '🔥 В работе' : '⚡ Завершено';
          gpuOp.textContent = liveText;
          gpuOp.title = liveText;
          gpuFill.style.setProperty('--hw-fill', workVramFill.toFixed(3));
        } else if (gpuWarmInVram) {
          const names = Array.isArray(ollResolved && ollResolved.loadedModels)
            ? ollResolved.loadedModels.map((m) => m.name).join(' + ')
            : 'модель';
          const isOverCap = loadedVramMb > (capGb * 1024 + 128);
          const hostWarmedLbl = formatHostRamWarmedLabel(gpuTel.hostRamWarmedMb);
          const ddr5WarmOn = Boolean(hostWarmedLbl && (!s || s.gpuWarmHostRamCache !== false));
          gpuCard.className = isOverCap ? 'hw-optical-unit gpu-unit is-standby is-over-cap' : 'hw-optical-unit gpu-unit is-standby';
          gpuBadge.textContent = isOverCap ? '⚠️ Сверх лимита' : '🟡 В фоне';
          if (isOverCap) {
            gpuOp.textContent = 'Превышен лимит ' + capGb + ' ГБ · требуется выгрузка или компактная модель';
          } else {
            gpuOp.textContent = 'Дежурит в VRAM · расчётов сейчас нет';
            if (ddr5WarmOn) gpuOp.textContent = 'Дежурит в VRAM · DDR5 GGUF: ' + hostWarmedLbl;
          }
          gpuOp.title = 'В видеопамяти: ' + names + (ddr5WarmOn ? (' · Прогрето в DDR5 ОЗУ: ' + hostWarmedLbl) : '');
          gpuFill.style.setProperty('--hw-fill', (isOverCap ? 1 : Math.max(0.065, rawGpuFrac)).toFixed(3));
        } else {
          const hostWarmedLbl = formatHostRamWarmedLabel(gpuTel.hostRamWarmedMb);
          const ddr5WarmOn = Boolean(hostWarmedLbl && (!s || s.gpuWarmHostRamCache !== false));
          gpuCard.className = 'hw-optical-unit gpu-unit is-off';
          gpuBadge.textContent = oll.running ? '⚪ Выгружена' : '⚪ Спит';
          gpuOp.textContent = oll.running
            ? (ddr5WarmOn ? ('0 ГБ в VRAM · в DDR5 ОЗУ: ' + hostWarmedLbl) : '0 ГБ в видеопамяти · ждёт задачи')
            : 'Сервер Ollama в режиме ожидания';
          gpuOp.title = (oll.running && ddr5WarmOn)
            ? ('Веса GGUF прогреты в системной DDR5 ОЗУ (' + hostWarmedLbl + ') для быстрого подъёма в VRAM')
            : '';
          gpuFill.style.setProperty('--hw-fill', '0.032');
        }
      }

      const cpuCard = document.getElementById('cpuLiveUnitCard');
      const cpuBadge = document.getElementById('cpuUnitStateBadge');
      const cpuMetric = document.getElementById('cpuUnitMetricVal');
      const cpuSavedPill = document.getElementById('cpuUnitSavedPill');
      const cpuOp = document.getElementById('cpuUnitOpText');
      const cpuFill = document.getElementById('cpuUnitAfterglowFill');
      const cpuCapPct = document.getElementById('cpuUnitCapPct');
      const wsListForCpu = Array.isArray(ramCache && ramCache.workspaces) ? ramCache.workspaces : [];
      const triCount = (cpu && Number(cpu.ramTrigramsIndexed)) ||
        wsListForCpu.reduce((sum, w) => sum + (Number(w && w.trigramsIndexed) || 0), 0);
      const totalBatches = Number(cpuTel.workerBatches || 0);
      const lastRerankMs = Number(cpuTel.lastRerankMs || 0);
      if (cpuSavedPill) {
        if (triCount > 0) {
          cpuSavedPill.textContent = formatK(triCount) + ' тригр.';
        } else if (totalBatches > 0) {
          cpuSavedPill.textContent = formatExactInt(totalBatches) + ' батч.';
        } else {
          cpuSavedPill.textContent = '0 тригр.';
        }
        cpuSavedPill.title =
          'Индекс триграмм BM25F: ' + formatExactInt(triCount) +
          ' · Батчей воркеров: ' + formatExactInt(totalBatches) +
          ' · Вызовов Rerank: ' + formatExactInt(cpuTel.rerankCalls || 0) +
          (lastRerankMs > 0 ? (' (' + lastRerankMs + ' мс)') : '');
      }
      if (cpuCard && cpuBadge && cpuMetric && cpuOp && cpuFill) {
        const rawActiveThreads = cpuInFlight
          ? Math.max(1, Number(cpuLive.activeThreads || cpuPool.busyWorkers || 1))
          : (cpuWorking ? Math.max(1, Number(cpuLive.recentThreads || 1)) : 0);
        const shownThreads = cpuEnabled ? Math.min(effThreads, rawActiveThreads) : 0;
        const threadFrac = Math.max(0, Math.min(1, shownThreads / Math.max(1, effThreads)));
        cpuMetric.textContent = shownThreads + ' / ' + effThreads + ' потоков';
        if (cpuCapPct) {
          cpuCapPct.textContent = !cpuEnabled ? 'Выкл' : (Math.round(threadFrac * 100) + '%');
        }
        cpuMetric.title =
          'Лимит пула: ' + effThreads + ' из ' + logCores + ' логических потоков' +
          ' · Активно в пуле: ' + Number(cpuPool.activeWorkers || 0) +
          ' · Пик нагрузки: ' + Math.max(Number(cpuTel.peakWorkersUsed || 0), shownThreads) + ' пот.';
        if (!cpuEnabled) {
          cpuCard.className = 'hw-optical-unit cpu-unit is-off';
          cpuBadge.textContent = '⚪ Выкл';
          cpuOp.textContent = 'Контур CPU-сопроцессора отключён в настройках';
          cpuOp.title = '';
          cpuFill.style.setProperty('--hw-fill', '0');
        } else if (cpuWorking) {
          const liveCpuText = formatCpuLiveOpRu(cpuLive);
          const workCpuFill = Math.min(1, Math.max(threadFrac, shownThreads > 0 ? 0.08 : 0.04, 0.16 + 0.56 * cpuRatio));
          cpuCard.className = 'hw-optical-unit cpu-unit is-working';
          cpuBadge.textContent = cpuInFlight ? '⚡ В работе' : '⚡ Завершено';
          cpuOp.textContent = liveCpuText;
          cpuOp.title = liveCpuText;
          cpuFill.style.setProperty('--hw-fill', workCpuFill.toFixed(3));
        } else {
          const batchStat = totalBatches > 0 ? (' · батчей: ' + totalBatches) : '';
          const rerankStat = lastRerankMs > 0 ? (' · rerank ' + lastRerankMs + ' мс') : '';
          cpuCard.className = 'hw-optical-unit cpu-unit is-standby';
          cpuBadge.textContent = '🟡 В фоне';
          cpuOp.textContent = (!cpuPoolOn ? 'Пул потоков выкл · активен быстрый индекс' : 'Дежурит в пуле · внутренних задач сейчас нет') + batchStat + rerankStat;
          cpuOp.title = cpuOp.textContent;
          cpuFill.style.setProperty('--hw-fill', threadFrac > 0 ? Math.max(0.04, threadFrac).toFixed(3) : '0');
        }
      }

      if (_hwAfterglowDecayTimer) {
        clearTimeout(_hwAfterglowDecayTimer);
        _hwAfterglowDecayTimer = null;
      }
      if (
        (ramWorking && Number(ramLive.activeOps || 0) === 0) ||
        (gpuWorking && !gpuInFlight) ||
        (cpuWorking && !cpuInFlight)
      ) {
        _hwAfterglowDecayTimer = setTimeout(function () {
          if (_lastHwRenderCtx && document.visibilityState !== 'hidden') {
            const c = _lastHwRenderCtx;
            updateLiveHardwareOpticalUi(c.gpu, c.ollResolved, c.ramCache, c.s, c.capGb, c.ramBudgetMb, c.cpu);
          }
        }, 160);
      }
    }

    function scrollToGpuRamCard() {
      const card = document.getElementById('gpuRamCard');
      if (!card) return;
      const spoiler = card.closest('details');
      if (spoiler && !spoiler.open) {
        spoiler.open = true;
      }
      if (card.classList.contains('is-collapsed')) {
        togglePanelCardCollapse('gpuRamCard');
      }
      flushVisibleBlockRenders();
      maybeLoadMissingSectionsForBlock('gpuRamCard');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    async function setGpuVramCap(mb) {
      const rawMb = Number(mb || 4096);
      const maxVram = currentHardwareCeilings && currentHardwareCeilings.maxVramMb ? Number(currentHardwareCeilings.maxVramMb) : 32768;
      const targetMb = Math.max(2048, Math.min(maxVram, rawMb));
      document.querySelectorAll('#gpuVramCapGroup button').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.val) === targetMb);
      });
      // Skip intermediate optimistic render so mismatched previous chat model does not flash a transient VRAM alert
      if (typeof clearExpertGpuInputsDirty === 'function') clearExpertGpuInputsDirty();
      const saved = await updateState({ gpuMaxVramMb: targetMb }, { skipOptimistic: true });
      if (!saved) {
        const rollbackMb = Number((currentState && currentState.gpuMaxVramMb) || 4096);
        document.querySelectorAll('#gpuVramCapGroup button').forEach((btn) => {
          btn.classList.toggle('active', Number(btn.dataset.val) === rollbackMb);
        });
        return;
      }
      const capGb = Math.max(2, Math.round(targetMb / 1024));
      const snapGpu = (lastPayloadCache && lastPayloadCache.gpu) || null;
      const snapOll = (snapGpu && snapGpu.ollama) || {};
      const snapHw = (snapGpu && snapGpu.hardware) || {};
      const resolved = resolvePanelOllamaVram(snapOll, snapHw);
      if (resolved.loadedVramMb > targetMb + 128) {
        try {
          const res = await panelFetch('/api/gpu', {
            method: 'POST',
            body: JSON.stringify({ action: 'enforce_cap' }),
          });
          const data = res && res.ok ? await res.json() : null;
          const afterLoaded = Number((data && data.gpu && data.gpu.ollama && data.gpu.ollama.loadedVramMb) || 0);
          if (afterLoaded > targetMb + 128) {
            await panelFetch('/api/gpu', {
              method: 'POST',
              body: JSON.stringify({ action: 'unload' }),
            });
          }
          await refreshAll();
        } catch {}
      }
      const postGpu = (lastPayloadCache && lastPayloadCache.gpu) || null;
      const postFit = computeClientVramFit(
        currentState,
        (postGpu && postGpu.config) || {},
        (postGpu && postGpu.ollama) || {},
        resolvePanelOllamaVram((postGpu && postGpu.ollama) || {}, (postGpu && postGpu.hardware) || {}),
        postGpu && postGpu.vramFit
      );
      if (currentState && currentState.gpuEnabled && postFit.needsModelDownload) {
        flashStatus('Лимит ' + capGb + ' ГБ: подходящая модель не скачана — нажмите «Каскад моделей»');
      } else {
        const pairTxt = currentState && currentState.gpuChatModel
          ? (' · ' + currentState.gpuChatModel + ' + ' + (currentState.gpuEmbedModel || 'qwen3-embedding:0.6b'))
          : '';
        flashStatus('Лимит VRAM: ' + capGb + ' ГБ' + pairTxt + ' ✓');
      }
    }

    function setRamBudget(mb) {
      const maxRam = currentHardwareCeilings && currentHardwareCeilings.maxRamBudgetMb ? Number(currentHardwareCeilings.maxRamBudgetMb) : 32768;
      const safeMb = Math.max(512, Math.min(maxRam, Number(mb || 4096)));
      updateState({ ramMaxBudgetMb: safeMb });
    }

    function setCpuMaxThreads(threads) {
      const maxThreads = currentHardwareCeilings && currentHardwareCeilings.maxCpuThreads ? Number(currentHardwareCeilings.maxCpuThreads) : 64;
      const safeThreads = Math.max(1, Math.min(maxThreads, Number(threads || 6)));
      updateState({ cpuMaxThreads: safeThreads });
    }

    async function saveExpertGpuConfig() {
      const ep = String((document.getElementById('inp-gpuEndpoint') || {}).value || '').trim();
      if (ep && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?(\/|$)/i.test(ep)) {
        flashStatus('Ошибка: gpuEndpoint разрешён только для localhost/127.0.0.1!');
        return;
      }
      const patch = {
        gpuChatModel: String((document.getElementById('inp-gpuChatModel') || {}).value || 'gemma4:12b').trim(),
        gpuEmbedModel: String((document.getElementById('inp-gpuEmbedModel') || {}).value || 'qwen3-embedding:0.6b').trim(),
        gpuKeepAlive: String((document.getElementById('inp-gpuKeepAlive') || {}).value || '15m').trim(),
        gpuEmbedKeepAlive: String((document.getElementById('inp-gpuEmbedKeepAlive') || {}).value || '90m').trim(),
        gpuContextTokens: Number((document.getElementById('inp-gpuContextTokens') || {}).value || 4096),
        gpuModelsDir: String((document.getElementById('inp-gpuModelsDir') || {}).value || '').trim(),
      };
      if (ep) patch.gpuEndpoint = ep;
      if (typeof clearExpertGpuInputsDirty === 'function') clearExpertGpuInputsDirty();
      const saved = await updateState(patch);
      if (saved) {
        flashStatus('Параметры Ollama и RAM сохранены ✓');
      }
    }

    async function runGpuPanelAction(action) {
      const msgMap = {
        warm: 'Индексация проекта в векторный поиск на GPU...',
        unload: 'Выгрузка нейросетей из видеопамяти...',
        test_distill: 'Тестовое сжатие лога на локальной GPU...',
      };
      try {
        flashStatus(msgMap[action] || 'Выполнение GPU-операции...');
        const res = await panelFetch('/api/gpu', {
          method: 'POST',
          body: JSON.stringify({ action: action }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok !== false && !data.error) {
          if (action === 'test_distill') {
            flashStatus('GPU-тест OK (' + (data.latencyMs || 0) + ' мс) ✓');
          } else if (action === 'unload') {
            flashStatus('VRAM освобождена ✓');
          } else {
            flashStatus('Проиндексировано: ' + (data.totalFiles || 0) + ' файлов ✓');
          }
          await refreshAll();
        } else {
          flashStatus('GPU: ' + (data && data.error ? data.error : 'ошибка'));
        }
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка обращения к локальной GPU!');
      }
    }

    async function backupProfile() {
      try {
        flashStatus('Сохранение слепка профиля...');
        const res = await panelFetch('/api/profile-backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'backup' })
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok && !result.error) {
          flashStatus('Слепок сохранён ✓ (' + result.keysSaved + ' настроек)');
        } else {
          flashStatus('Ошибка: ' + (result ? (result.error || 'сбой бэкапа') : 'сбой'));
        }
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка сохранения слепка!');
      }
    }

    async function restoreProfile() {
      try {
        flashStatus('Восстановление профиля...');
        const res = await panelFetch('/api/profile-backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restore' })
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok && !result.error) {
          flashStatus('Профиль восстановлен ✓ (' + result.restoredKeys + ' настроек)');
          await refreshAll();
        } else {
          flashStatus('Ошибка: ' + (result ? (result.error || 'слепок не найден') : 'сбой'));
        }
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка восстановления профиля!');
      }
    }

    async function autoCalibrateHardware() {
      try {
        flashStatus('Сканирование железа ПК и авто-калибровка лимитов...');
        const res = await panelFetch('/api/hardware', {
          method: 'POST',
          body: JSON.stringify({ action: 'auto_apply', subscriptionTier: currentState.subscriptionTier || 'pro' }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok && !data.error) {
          if (data.hardwareProfile) currentHardwareProfile = data.hardwareProfile;
          await refreshAll();
          flashStatus('Лимиты CPU / RAM / GPU адаптированы под ваш ПК ✓');
        } else {
          flashStatus('Ошибка калибровки: ' + (data && data.error ? data.error : 'сбой'));
        }
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка обращения к сканеру железа!');
      }
    }

    let _openCustomSelectId = '';
    let _openCustomSelectFocusIdx = -1;

    function getCustomSelectTrigger(selId) {
      if (selId === 'sel-panelWorkspace') return document.getElementById('btn-panelWorkspace');
      if (selId === 'sel-gpuChatModel') return document.getElementById('btn-gpuChatModel');
      if (selId === 'sel-gpuEmbedModel') return document.getElementById('btn-gpuEmbedModel');
      return null;
    }

    function syncCustomSelectTrigger(selId) {
      const sel = document.getElementById(selId);
      const trigger = getCustomSelectTrigger(selId);
      if (!sel || !trigger) return;
      const valEl = trigger.querySelector('.lg-select-trigger-text');
      const selectedOpt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      const labelText = selectedOpt ? String(selectedOpt.textContent || selectedOpt.value || '') : String(sel.value || '');
      if (valEl) valEl.textContent = labelText || 'Выбрать модель';
    }

    function highlightCustomSelectOption(idx) {
      const menu = document.getElementById('lgCustomSelectMenu');
      if (!menu) return;
      const items = Array.from(menu.querySelectorAll('.lg-select-option'));
      if (items.length === 0) {
        _openCustomSelectFocusIdx = -1;
        return;
      }
      const nextIdx = Math.max(0, Math.min(items.length - 1, idx));
      _openCustomSelectFocusIdx = nextIdx;
      items.forEach(function (btn, i) {
        btn.classList.toggle('is-focused', i === nextIdx);
      });
      const activeBtn = items[nextIdx];
      if (activeBtn && activeBtn.scrollIntoView) {
        activeBtn.scrollIntoView({ block: 'nearest' });
      }
    }

    function closeCustomSelectMenu(restoreFocus) {
      if (!_openCustomSelectId) return;
      const prevId = _openCustomSelectId;
      const trigger = getCustomSelectTrigger(prevId);
      const menu = document.getElementById('lgCustomSelectMenu');
      _openCustomSelectId = '';
      _openCustomSelectFocusIdx = -1;
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
      }
      if (menu) {
        menu.classList.remove('is-open');
        menu.setAttribute('aria-hidden', 'true');
        menu.hidden = true;
        menu.innerHTML = '';
      }
      if (restoreFocus && trigger && typeof trigger.focus === 'function') {
        try { trigger.focus({ preventScroll: true }); } catch {}
      }
    }

    function commitCustomSelectOption(selId, value) {
      const sel = document.getElementById(selId);
      const nextVal = String(value || '').trim();
      closeCustomSelectMenu(true);
      if (!sel || !nextVal) return;
      const changed = sel.value !== nextVal;
      sel.value = nextVal;
      syncCustomSelectTrigger(selId);
      if (changed) {
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function openCustomSelectMenu(selId) {
      const sel = document.getElementById(selId);
      const trigger = getCustomSelectTrigger(selId);
      const menu = document.getElementById('lgCustomSelectMenu');
      if (!sel || !trigger || !menu) return;

      if (_openCustomSelectId && _openCustomSelectId !== selId) {
        closeCustomSelectMenu(false);
      }

      menu.innerHTML = '';
      const opts = Array.from(sel.options || []);
      let selectedIdx = 0;

      opts.forEach(function (opt, idx) {
        const isSelected = opt.value === sel.value;
        if (isSelected) selectedIdx = idx;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lg-select-option' + (isSelected ? ' is-selected' : '');
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        btn.setAttribute('data-select-value', opt.value);

        const mainEl = document.createElement('span');
        mainEl.className = 'lg-select-opt-main';

        const checkEl = document.createElement('span');
        checkEl.className = 'lg-select-opt-check';
        checkEl.textContent = '✓';

        const nameEl = document.createElement('span');
        nameEl.className = 'lg-select-opt-name';
        nameEl.textContent = opt.dataset.name || opt.textContent || opt.value;

        mainEl.appendChild(checkEl);
        mainEl.appendChild(nameEl);
        btn.appendChild(mainEl);

        const sizeText = opt.dataset.size || '';
        const vramText = opt.dataset.vram || '';
        const missingText = opt.dataset.missing || '';
        if (sizeText || vramText || missingText) {
          const metaEl = document.createElement('span');
          metaEl.className = 'lg-select-opt-meta';
          if (sizeText) {
            const sizeBadge = document.createElement('span');
            sizeBadge.className = 'lg-select-opt-badge';
            sizeBadge.textContent = sizeText;
            metaEl.appendChild(sizeBadge);
          }
          if (vramText) {
            const vramBadge = document.createElement('span');
            vramBadge.className = 'lg-select-opt-badge is-vram';
            vramBadge.textContent = vramText;
            metaEl.appendChild(vramBadge);
          }
          if (missingText) {
            const missBadge = document.createElement('span');
            missBadge.className = 'lg-select-opt-badge is-missing';
            missBadge.textContent = missingText;
            metaEl.appendChild(missBadge);
          }
          btn.appendChild(metaEl);
        }

        menu.appendChild(btn);
      });

      if (opts.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.style.padding = '8px 10px';
        emptyEl.style.fontSize = '11px';
        emptyEl.style.color = 'var(--text-muted)';
        emptyEl.textContent = 'Нет доступных моделей';
        menu.appendChild(emptyEl);
      }

      menu.classList.remove('is-open');
      menu.hidden = false;
      menu.setAttribute('aria-hidden', 'false');

      const rect = trigger.getBoundingClientRect();
      const maxViewportW = Math.max(180, window.innerWidth - 16);
      const desiredW = Math.min(maxViewportW, Math.max(rect.width, 238));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - desiredW - 8));
      menu.style.width = Math.round(desiredW) + 'px';
      menu.style.left = Math.round(left) + 'px';
      menu.style.maxHeight = '228px';

      const naturalH = Math.min(menu.scrollHeight || 160, 228);
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 10);
      const spaceAbove = Math.max(0, rect.top - 10);
      const placeTop = spaceBelow < naturalH && spaceAbove > spaceBelow;

      if (placeTop) {
        const allowedH = Math.max(96, Math.min(228, spaceAbove));
        const usedH = Math.min(naturalH, allowedH);
        menu.style.maxHeight = Math.round(allowedH) + 'px';
        menu.style.top = Math.round(Math.max(8, rect.top - usedH - 5)) + 'px';
        menu.setAttribute('data-placement', 'top');
      } else {
        const allowedH = Math.max(96, Math.min(228, spaceBelow));
        menu.style.maxHeight = Math.round(allowedH) + 'px';
        menu.style.top = Math.round(rect.bottom + 5) + 'px';
        menu.setAttribute('data-placement', 'bottom');
      }

      _openCustomSelectId = selId;
      trigger.setAttribute('aria-expanded', 'true');
      highlightCustomSelectOption(selectedIdx);

      window.requestAnimationFrame(function () {
        if (_openCustomSelectId === selId && !menu.hidden) {
          menu.classList.add('is-open');
        }
      });
    }

    function toggleCustomSelect(selId) {
      if (!selId) return;
      if (_openCustomSelectId === selId) {
        closeCustomSelectMenu(true);
      } else {
        openCustomSelectMenu(selId);
      }
    }

    function isOllamaEmbedModelName(name) {
      return /(?:^|[/:_-])(?:embed|embedding|bge|nomic|mxbai|snowflake|minilm|e5)/i.test(String(name || ''));
    }

    function normPanelOllamaTag(name) {
      const clean = String(name || '').trim().toLowerCase();
      if (!clean) return '';
      return clean.includes(':') ? clean : (clean + ':latest');
    }

    function estimateClientModelVramMb(name, downloaded, loadedMap) {
      const clean = String(name || '').trim();
      if (!clean) return 0;
      const norm = normPanelOllamaTag(clean);
      if (loadedMap && loadedMap.has(norm) && loadedMap.get(norm) > 0) {
        return Math.round(loadedMap.get(norm));
      }
      const isEmbed = isOllamaEmbedModelName(clean);
      const found = Array.isArray(downloaded)
        ? downloaded.find(function (m) { return normPanelOllamaTag(m && m.name) === norm; })
        : null;
      if (found && Number(found.sizeGb) > 0) {
        const diskMb = Number(found.sizeGb) * 1024;
        return isEmbed ? Math.max(256, Math.round(diskMb * 1.15 + 250)) : Math.max(512, Math.round(diskMb * 1.12 + 220));
      }
      const pm = /(?:^|[:_-])e?(\d+(?:\.\d+)?)b(?=$|[:_-])/i.exec(clean);
      if (pm) {
        const pb = Number(pm[1]);
        if (Number.isFinite(pb) && pb > 0) {
          return isEmbed ? Math.max(256, Math.round(pb * 1100 + 250)) : Math.max(600, Math.round(pb * 680 + 450));
        }
      }
      return 0;
    }

    function computeClientVramFit(s, cfg, oll, ollResolved, serverFit) {
      const capMb = Math.max(2048, Math.min(32768, Number((s && s.gpuMaxVramMb) || (cfg && cfg.gpuMaxVramMb) || 4096)));
      const capGb = Math.max(2, Math.round(capMb / 1024));
      const curChat = String((s && s.gpuChatModel) || (cfg && cfg.gpuChatModel) || 'gemma4:12b').trim();
      const curEmbed = String((s && s.gpuEmbedModel) || (cfg && cfg.gpuEmbedModel) || 'qwen3-embedding:0.6b').trim();
      const loadedVramMb = Number((ollResolved && ollResolved.loadedVramMb) || 0);

      if (
        serverFit &&
        Number(serverFit.capMb) === capMb &&
        String(serverFit.selectedChatModel || '') === curChat
      ) {
        return serverFit;
      }

      const downloaded = Array.isArray(oll && oll.downloadedModels) ? oll.downloadedModels : [];
      const loadedMap = new Map();
      const loadedList = Array.isArray(ollResolved && ollResolved.loadedModels) ? ollResolved.loadedModels : [];
      loadedList.forEach(function (m) {
        if (m && m.name) loadedMap.set(normPanelOllamaTag(m.name), Number(m.vramMb) || 0);
      });

      const semOn = !(s && s.gpuSemanticSearch === false);
      const embedEst = semOn && curEmbed ? (estimateClientModelVramMb(curEmbed, downloaded, loadedMap) || 950) : 0;
      const maxEmbedShareMb = Math.max(1536, Math.round(capMb * 0.45));
      const embedReserveMb = embedEst > 0 && embedEst <= capMb ? Math.min(maxEmbedShareMb, embedEst) : 0;
      const chatVramBudgetMb = Math.max(1280, capMb - embedReserveMb);
      const selectedEst = estimateClientModelVramMb(curChat, downloaded, loadedMap);
      const selectedNorm = normPanelOllamaTag(curChat);
      const tagsKnown = downloaded.length > 0 || Boolean(oll && oll.running);
      const selectedDownloaded = downloaded.some(function (m) { return normPanelOllamaTag(m && m.name) === selectedNorm; });
      const selectedSizeFits = selectedEst === 0 || selectedEst <= (chatVramBudgetMb + 128);
      const selectedChatFits = selectedSizeFits && (!tagsKnown || selectedDownloaded);

      const compat = downloaded
        .filter(function (m) { return m && m.name && !isOllamaEmbedModelName(m.name); })
        .map(function (m) {
          return { name: m.name, sizeGb: m.sizeGb, estVramMb: estimateClientModelVramMb(m.name, downloaded, loadedMap) };
        })
        .filter(function (m) { return m.estVramMb > 0 && m.estVramMb <= (chatVramBudgetMb + 128); })
        .sort(function (a, b) { return b.estVramMb - a.estVramMb; });

      const bestFallbackChatModel = compat[0] ? compat[0].name : '';
      const recommendedPullModel = capMb < 11264 ? 'qwen3:4b' : 'gemma4:12b';
      const overBudgetLoaded = loadedVramMb > (capMb + 128);
      const needsModelDownload = Boolean(
        s && s.gpuEnabled !== false && (!selectedSizeFits || (tagsKnown && !selectedDownloaded)) && compat.length === 0
      );

      return {
        capMb: capMb,
        capGb: capGb,
        chatVramBudgetMb: chatVramBudgetMb,
        embedReserveMb: embedReserveMb,
        loadedVramMb: loadedVramMb,
        overBudgetLoaded: overBudgetLoaded,
        selectedChatModel: curChat,
        selectedChatDownloaded: selectedDownloaded,
        selectedChatEstVramMb: selectedEst,
        selectedSizeFits: selectedSizeFits,
        selectedChatFits: selectedChatFits,
        compatibleChatModels: compat,
        bestFallbackChatModel: bestFallbackChatModel,
        needsModelDownload: needsModelDownload,
        recommendedPullModel: recommendedPullModel,
      };
    }

    function renderGpuVramFitAlert(s, vramFit) {
      const box = document.getElementById('gpuVramFitAlert');
      const titleEl = document.getElementById('gpuVramFitTitle');
      const descEl = document.getElementById('gpuVramFitDesc');
      const fallbackBtn = document.getElementById('btnApplyFallbackGpuModel');
      const promptBtn = document.getElementById('btnVramFitPrompt');
      if (!box || !titleEl || !descEl) return;

      const enabled = Boolean(s && s.gpuEnabled);
      if (!enabled || !vramFit || (vramFit.selectedChatFits && !vramFit.overBudgetLoaded)) {
        box.style.display = 'none';
        return;
      }

      box.style.display = 'flex';
      const estGbText = vramFit.selectedChatEstVramMb > 0
        ? (' (~' + (vramFit.selectedChatEstVramMb / 1024).toFixed(1) + ' ГБ в VRAM)')
        : '';

      if (vramFit.needsModelDownload) {
        titleEl.textContent = '⚠️ Нет подходящей модели под лимит ' + vramFit.capGb + ' ГБ VRAM';
        descEl.textContent =
          'Выбранная модель ' + vramFit.selectedChatModel + estGbText +
          ' не помещается в лимит ' + vramFit.capGb + ' ГБ — её загрузка строго заблокирована, сжатие переведено на CPU. ' +
          'Скачайте компактную модель (например, ' + vramFit.recommendedPullModel + ').';
        if (fallbackBtn) fallbackBtn.style.display = 'none';
        if (promptBtn) promptBtn.textContent = '💬 Подобрать в чате';
      } else if (!vramFit.selectedChatFits && vramFit.bestFallbackChatModel) {
        titleEl.textContent = '⚠️ Модель ' + vramFit.selectedChatModel + ' превышает лимит ' + vramFit.capGb + ' ГБ VRAM';
        descEl.textContent =
          'Модель требует' + (estGbText || (' > ' + vramFit.capGb + ' ГБ')) +
          '. Для работы в пределах лимита переключитесь на скачанную ' + vramFit.bestFallbackChatModel + '.';
        if (fallbackBtn) {
          fallbackBtn.style.display = 'inline-flex';
          fallbackBtn.setAttribute('data-arg', vramFit.bestFallbackChatModel);
          fallbackBtn.textContent = 'Включить ' + vramFit.bestFallbackChatModel;
        }
        if (promptBtn) promptBtn.textContent = '💬 Подобрать в чате';
      } else if (vramFit.overBudgetLoaded) {
        titleEl.textContent = '⚠️ В VRAM занято ' + (vramFit.loadedVramMb / 1024).toFixed(1) + ' ГБ при лимите ' + vramFit.capGb + ' ГБ';
        descEl.textContent = 'В видеопамяти остаётся тяжёлая модель сверх установленного лимита — выгрузите её или подберите более лёгкую модель.';
        if (fallbackBtn) fallbackBtn.style.display = 'none';
        if (promptBtn) promptBtn.textContent = '💬 Подобрать в чате';
      }
    }

    let _gpuPullActiveUi = false;

    function renderGpuCascadePullStatus(pullStatus, gpu, s) {
      const box = document.getElementById('gpuCascadePullBox');
      const titleEl = document.getElementById('gpuCascadePullTitle');
      const fillEl = document.getElementById('gpuCascadePullFill');
      const subEl = document.getElementById('gpuCascadePullSub');
      const toolbarRow = document.getElementById('gpuCascadeToolbarRow');
      const toolbarBtn = document.getElementById('btnPullCascadeToolbar');
      const wasActive = _gpuPullActiveUi;
      const isActive = Boolean(pullStatus && pullStatus.active);
      _gpuPullActiveUi = isActive;

      if (wasActive && !isActive) {
        setTimeout(function () { refreshAll(); }, 250);
      }

      const gpuSnap = gpu || (lastPayloadCache && lastPayloadCache.gpu) || null;
      const st = s || currentState || {};
      const gpuOn = Boolean(st && st.gpuEnabled);
      const ollRunning = Boolean(gpuSnap && gpuSnap.ollama && gpuSnap.ollama.running);
      const cascadeStatus = (gpuSnap && gpuSnap.cascadeStatus) || null;
      const missingCount = Number((cascadeStatus && cascadeStatus.missingCount) || 0);
      const missingGb = Number((cascadeStatus && cascadeStatus.approxMissingDiskGb) || 0);
      const missingModels = Array.isArray(cascadeStatus && cascadeStatus.missingModels) ? cascadeStatus.missingModels : [];
      const showCascadeBtn = Boolean(gpuOn && ollRunning && missingCount > 0 && !isActive);

      if (toolbarRow) {
        toolbarRow.style.display = showCascadeBtn ? 'flex' : 'none';
      }
      if (toolbarBtn) {
        toolbarBtn.disabled = isActive;
        if (showCascadeBtn) {
          toolbarBtn.textContent = '⬇️ Докачать каскад (' + missingCount + (missingGb > 0 ? (' · ~' + missingGb.toFixed(1) + ' ГБ') : '') + ')';
          toolbarBtn.title = missingModels.length > 0
            ? ('Не скачаны модели каскада: ' + missingModels.join(', ') + ' — нажмите, чтобы скачать в фоне')
            : 'Скачать недостающие модели каскада под все лимиты вашей видеокарты (с автофоллбэком на Hugging Face)';
        }
      }
      if (!box) return;

      const recentlyFinished = Boolean(
        !isActive &&
        pullStatus &&
        pullStatus.finishedAt &&
        (Date.now() - Number(pullStatus.finishedAt || 0)) < 12000 &&
        pullStatus.statusText
      );
      if (!isActive && !recentlyFinished) {
        box.style.display = 'none';
        return;
      }

      box.style.display = 'flex';
      const total = Math.max(1, Number(pullStatus.totalCount || 1));
      const done = Math.max(0, Number(pullStatus.completedCount || 0));
      const curPct = Math.max(0, Math.min(100, Number(pullStatus.currentPercent || 0)));
      const overallPct = isActive
        ? Math.min(99, Math.round(((done + curPct / 100) / total) * 100))
        : 100;

      if (titleEl) {
        titleEl.textContent = isActive
          ? ('⬇️ Загрузка каскада моделей (' + Math.min(done + 1, total) + '/' + total + ')')
          : (pullStatus.error ? '⚠️ Загрузка каскада завершена с ошибками' : '✓ Каскад моделей готов');
      }
      if (fillEl) {
        fillEl.style.width = overallPct + '%';
      }
      if (subEl) {
        const srcBadge = pullStatus.source === 'huggingface' ? ' [Hugging Face]' : (pullStatus.source === 'ollama' ? ' [Ollama]' : '');
        subEl.textContent = (pullStatus.statusText || 'Выполняется загрузка...') + srcBadge + (pullStatus.error && !isActive ? (' · ' + pullStatus.error) : '');
      }
    }

    async function startGpuCascadePull(mode, selectedCapMb) {
      try {
        const pullMode = mode === 'active_only' ? 'active_only' : 'cascade';
        flashStatus('Запуск загрузки каскада моделей...');
        const res = await panelFetch('/api/gpu', {
          method: 'POST',
          body: JSON.stringify({
            action: 'pull_cascade',
            mode: pullMode,
            selectedCapMb: Number(selectedCapMb || (currentState && currentState.gpuMaxVramMb) || 4096),
          }),
        });
        const data = await res.json();
        if (data && data.ok) {
          renderGpuCascadePullStatus(data.pullStatus);
          if (data.pullStatus && data.pullStatus.active) {
            flashStatus('Каскад моделей качается в фоне...');
            scheduleTelemetryPoll();
          } else if (data.pullStatus && data.pullStatus.statusText) {
            flashStatus(data.pullStatus.statusText);
          }
        } else {
          flashStatus('Ошибка запуска загрузки: ' + (data && data.error ? data.error : 'неизвестно'));
        }
      } catch (e) {
        flashStatus('Ошибка связи с сервером панели');
      }
    }

    async function cancelGpuCascadePull() {
      try {
        const res = await panelFetch('/api/gpu', {
          method: 'POST',
          body: JSON.stringify({ action: 'pull_cancel' }),
        });
        const data = await res.json();
        if (data && data.ok) {
          renderGpuCascadePullStatus(data.pullStatus);
          flashStatus('Загрузка каскада отменена');
        }
      } catch {}
    }

    function syncGpuModelSelects(s, cfg, oll, ollResolved, vramFit) {
      const downloaded = Array.isArray(oll && oll.downloadedModels) ? oll.downloadedModels : [];
      const loadedMap = new Map();
      const loadedList = Array.isArray(ollResolved && ollResolved.loadedModels) ? ollResolved.loadedModels : [];
      loadedList.forEach(function (m) {
        if (m && m.name) loadedMap.set(String(m.name), Number(m.vramMb) || 0);
      });

      const curChat = String((s && s.gpuChatModel) || (cfg && cfg.gpuChatModel) || 'gemma4:12b').trim();
      const curEmbed = String((s && s.gpuEmbedModel) || (cfg && cfg.gpuEmbedModel) || 'qwen3-embedding:0.6b').trim();
      const chatBudgetMb = vramFit ? Number(vramFit.chatVramBudgetMb || 0) : 0;
      const capGb = vramFit ? Number(vramFit.capGb || 4) : 4;

      const chatList = downloaded.filter(function (m) { return m && m.name && !isOllamaEmbedModelName(m.name); });
      const embedList = downloaded.filter(function (m) { return m && m.name && isOllamaEmbedModelName(m.name); });

      function fillSelect(selId, items, currentVal, checkBudget) {
        const sel = document.getElementById(selId);
        if (!sel) return;
        const opts = [];
        const seen = new Set();
        items.forEach(function (m) {
          const name = String(m.name || '').trim();
          if (!name || seen.has(name)) return;
          seen.add(name);
          const vramMb = loadedMap.get(name) || 0;
          const sizeText = Number(m.sizeGb) > 0 ? (Number(m.sizeGb).toFixed(1) + ' ГБ') : '';
          const vramText = vramMb > 0 ? ('VRAM ' + (vramMb / 1024).toFixed(1) + ' ГБ') : '';
          const parts = [];
          if (sizeText) parts.push(sizeText);
          if (vramMb > 0) parts.push('в VRAM ' + (vramMb / 1024).toFixed(1) + ' ГБ');
          if (checkBudget && chatBudgetMb > 0) {
            const estMb = estimateClientModelVramMb(name, downloaded, loadedMap);
            if (estMb > chatBudgetMb + 128) {
              parts.push('⚠️ > ' + capGb + ' ГБ');
            }
          }
          const label = parts.length > 0 ? (name + ' (' + parts.join(' · ') + ')') : name;
          opts.push({ value: name, label: label, sizeText: sizeText, vramText: vramText, missingText: '' });
        });
        if (currentVal && !seen.has(currentVal)) {
          const vramMb = loadedMap.get(currentVal) || 0;
          const vramText = vramMb > 0 ? ('VRAM ' + (vramMb / 1024).toFixed(1) + ' ГБ') : '';
          const missingText = vramMb <= 0 && oll && oll.running ? 'не скачана' : '';
          const estMb = checkBudget && chatBudgetMb > 0 ? estimateClientModelVramMb(currentVal, downloaded, loadedMap) : 0;
          const overTag = estMb > chatBudgetMb + 128 ? (' · ⚠️ > ' + capGb + ' ГБ') : '';
          const suffix = vramMb > 0
            ? (' (в VRAM ' + (vramMb / 1024).toFixed(1) + ' ГБ' + overTag + ')')
            : (missingText ? (' (' + missingText + overTag + ')') : (overTag ? (' (' + overTag.replace(/^ · /, '') + ')') : ''));
          opts.unshift({ value: currentVal, label: currentVal + suffix, sizeText: '', vramText: vramText, missingText: missingText });
        }
        const sig = currentVal + '|' + opts.map(function (o) { return o.value + ':' + o.label; }).join(';');
        if (_openCustomSelectId === selId || document.activeElement === sel) return;
        if (sel.getAttribute('data-opts-sig') !== sig) {
          sel.innerHTML = '';
          opts.forEach(function (o) {
            const optEl = document.createElement('option');
            optEl.value = o.value;
            optEl.textContent = o.label;
            optEl.dataset.name = o.value;
            if (o.sizeText) optEl.dataset.size = o.sizeText;
            if (o.vramText) optEl.dataset.vram = o.vramText;
            if (o.missingText) optEl.dataset.missing = o.missingText;
            sel.appendChild(optEl);
          });
          sel.setAttribute('data-opts-sig', sig);
        }
        if (currentVal && sel.value !== currentVal) {
          sel.value = currentVal;
        }
        syncCustomSelectTrigger(selId);
      }

      fillSelect('sel-gpuChatModel', chatList, curChat, true);
      fillSelect('sel-gpuEmbedModel', embedList, curEmbed, false);
    }

    async function selectGpuModel(key, modelName) {
      if (key !== 'gpuChatModel' && key !== 'gpuEmbedModel') return;
      const clean = String(modelName || '').trim();
      if (!clean) return;
      const expertInputId = key === 'gpuChatModel' ? 'inp-gpuChatModel' : 'inp-gpuEmbedModel';
      const expertEl = document.getElementById(expertInputId);
      if (expertEl) expertEl.value = clean;
      const patch = {};
      patch[key] = clean;
      const saved = await updateState(patch);
      if (saved) {
        flashStatus('Модель GPU выбрана: ' + clean + ' ✓');
      }
    }

    function canSendToSidecarChat() {
      return Boolean(
        window.sidecar &&
        window.sidecar.agent &&
        (
          (window.sidecar.conversationId && typeof window.sidecar.agent.sendMessage === 'function') ||
          typeof window.sidecar.agent.startConversation === 'function'
        )
      );
    }

    async function getSidecarWorkspaceUrisFast() {
      try {
        if (window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
          const res = await Promise.race([
            window.sidecar.getWorkspaceUris(),
            new Promise(function (resolve) { setTimeout(function () { resolve([]); }, 350); })
          ]);
          if (Array.isArray(res)) return res;
        }
      } catch {}
      return [];
    }

    function extractSidecarConvIdFromClientPayload(payload, depth) {
      const lvl = Number(depth || 0);
      if (!payload || typeof payload !== 'object' || lvl > 4) return '';
      const keys = ['conversationId', 'conversation_id', 'newConversationId', 'rootConversationId'];
      for (let i = 0; i < keys.length; i += 1) {
        const v = payload[keys[i]];
        if (typeof v === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(v.trim())) {
          return v.trim();
        }
      }
      const subKeys = ['response', 'newConversation', 'new_conversation', 'conversation', 'metadata', 'payload'];
      for (let j = 0; j < subKeys.length; j += 1) {
        const sub = payload[subKeys[j]];
        if (sub && typeof sub === 'object') {
          const found = extractSidecarConvIdFromClientPayload(sub, lvl + 1);
          if (found) return found;
        }
      }
      return '';
    }

    function focusSidecarConversationIfPossible(convId) {
      const cleanId = typeof convId === 'string' ? convId.trim() : '';
      if (!cleanId) return;
      try {
        if (window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleConversation === 'function') {
          window.sidecar.ui.toggleConversation(cleanId);
        }
      } catch {}
    }

    async function copyTextToClipboardSafe(text) {
      const str = String(text || '');
      if (!str) return false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(str);
          return true;
        }
      } catch {}
      let ta = null;
      const prevActive = document.activeElement;
      try {
        ta = document.createElement('textarea');
        ta.value = str;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, str.length);
        const ok = Boolean(document.execCommand && document.execCommand('copy'));
        if (ok) return true;
      } catch {} finally {
        if (ta && ta.parentNode) {
          try { ta.parentNode.removeChild(ta); } catch {}
        }
        if (prevActive && typeof prevActive.focus === 'function') {
          try { prevActive.focus(); } catch {}
        }
      }
      return false;
    }

    let _activeFallbackSidecarConvId = '';

    async function dispatchPromptToChatDetailed(promptText, sentStatus, copiedStatus, newChatStatus) {
      const directConvId = (window.sidecar && window.sidecar.conversationId)
        || _activeFallbackSidecarConvId
        || '';
      const wsUris = await getSidecarWorkspaceUrisFast();
      const pinnedWs = (_selectedWorkspaceMode !== '__auto__' && _selectedWorkspaceMode !== '__all__')
        ? _selectedWorkspaceMode
        : '';
      const rootDir = pinnedWs || (detectedProjectInfo && detectedProjectInfo.workspaceRoot) || _activeWorkspaceResolved || '';
      let lastErr = '';

      try {
        const apiRes = await panelFetch('/api/chat-send', {
          method: 'POST',
          body: JSON.stringify({
            message: promptText,
            conversationId: directConvId,
            workspaceUris: wsUris,
            rootDir: rootDir,
            allowNewConversation: true,
          }),
        });
        if (apiRes && apiRes.ok) {
          const data = await apiRes.json();
          if (data && data.ok) {
            const targetCid = data.conversationId || directConvId || '';
            if (data.mode === 'new_conversation') {
              if (targetCid) {
                _activeFallbackSidecarConvId = targetCid;
                focusSidecarConversationIfPossible(targetCid);
              }
              const msgNew = newChatStatus || 'Открыт новый чат и отправлен запрос ✓';
              flashStatus(msgNew);
              return { sent: true, copied: false, mode: 'new_conversation', conversationId: targetCid, statusText: msgNew, queue: data.queue || null };
            }
            const msgSent = sentStatus || 'Запрос отправлен в активный чат ✓';
            flashStatus(msgSent);
            return { sent: true, copied: false, mode: 'existing_conversation', conversationId: targetCid, statusText: msgSent, queue: data.queue || null };
          }
          if (data && data.error) lastErr = String(data.error);
          if (data && data.dropped) {
            return { sent: false, copied: false, dropped: true, mode: 'dropped', conversationId: '', statusText: lastErr || 'Старая задача сброшена очередью', error: lastErr, queue: data.queue || null };
          }
        }
      } catch (err) {
        if (err && err.message) lastErr = String(err.message);
      }

      // Direct client-side Sidecar SDK fallback (works even before server.mjs sidecar process restarts)
      if (canSendToSidecarChat()) {
        try {
          if (directConvId && typeof window.sidecar.agent.sendMessage === 'function') {
            await window.sidecar.agent.sendMessage(promptText, directConvId);
            const msgDirect = sentStatus || 'Запрос отправлен в активный чат ✓';
            flashStatus(msgDirect);
            return { sent: true, copied: false, mode: 'existing_conversation', conversationId: directConvId, statusText: msgDirect };
          }
          if (typeof window.sidecar.agent.startConversation === 'function') {
            const startRes = await window.sidecar.agent.startConversation(promptText);
            const startedCid = extractSidecarConvIdFromClientPayload(startRes, 0);
            if (startedCid) {
              _activeFallbackSidecarConvId = startedCid;
              focusSidecarConversationIfPossible(startedCid);
            }
            const msgStarted = newChatStatus || 'Открыт новый чат и отправлен запрос ✓';
            flashStatus(msgStarted);
            return { sent: true, copied: false, mode: 'new_conversation', conversationId: startedCid, statusText: msgStarted };
          }
        } catch (err) {
          console.error(err);
          if (err && err.message) lastErr = String(err.message);
        }
      }

      const copied = await copyTextToClipboardSafe(promptText);
      const fallbackMsg = copied
        ? (copiedStatus || 'Текст скопирован в буфер — вставьте в чат (Ctrl+V) ✓')
        : ('Не удалось отправить в чат' + (lastErr ? (': ' + lastErr) : ' — откройте активный чат и повторите'));
      flashStatus(fallbackMsg);
      return { sent: false, copied: copied, mode: 'clipboard', conversationId: '', statusText: fallbackMsg, error: lastErr };
    }

    async function dispatchPromptToChatOrClipboard(promptText, sentStatus, copiedStatus) {
      const res = await dispatchPromptToChatDetailed(promptText, sentStatus, copiedStatus);
      return Boolean(res && res.sent);
    }

    async function sendVramFitModelPrompt() {
      const capMb = Number((currentState && currentState.gpuMaxVramMb) || 4096);
      const capGb = Math.max(2, Math.round(capMb / 1024));
      try {
        flashStatus('Подготовка запроса на подбор модели под ' + capGb + ' ГБ VRAM...');
        const res = await panelFetch('/api/hardware', {
          method: 'POST',
          body: JSON.stringify({
            action: 'vram_fit_prompt',
            force: true,
            subscriptionTier: wizDraft.subscriptionTier || currentState.subscriptionTier || 'pro'
          }),
        });
        const data = await res.json();
        let promptText = (data && data.ok && data.isVramFitPrompt && data.promptText) ? data.promptText : '';
        if (!promptText) {
          const snapGpu = (data && data.gpu) || (lastPayloadCache && lastPayloadCache.gpu) || {};
          const oll = (snapGpu && snapGpu.ollama) || {};
          const installed = Array.isArray(oll.downloadedModels)
            ? oll.downloadedModels.map(function (m) { return m.name + (m.sizeGb ? (' (' + m.sizeGb + ' GB)') : ''); }).join(', ')
            : 'не обнаружены';
          const curChat = String((currentState && currentState.gpuChatModel) || 'gemma4:12b');
          const curEmbed = String((currentState && currentState.gpuEmbedModel) || 'qwen3-embedding:0.6b');
          const recModel = capMb < 11264 ? 'qwen3:4b' : 'gemma4:12b';
          promptText = [
            'Я ограничил лимит видеопамяти до **' + capGb + ' ГБ (' + capMb + ' МБ)**, но среди установленных моделей Ollama (' + installed + ') нет чат-модели, которая помещается в этот лимит вместе с `' + curEmbed + '` (текущая `' + curChat + '` заблокирована).',
            '1. Подбери 2–3 компактные модели Ollama для роли `gpuChatModel` (сжатие логов и кода), которые гарантированно влезут в **' + capGb + ' ГБ VRAM** вместе с `' + curEmbed + '` (например, `' + recModel + '` или аналоги), укажи команды `ollama pull ...`.',
            '2. После моего подтверждения скачай выбранную модель и обнови `gpuChatModel` в `~/.gemini/config/plugins/antigravity-model-router/router-state.json`, не изменяя исходный код плагина.'
          ].join('\n');
        }
        if (data && data.hardwareProfile) {
          currentHardwareProfile = data.hardwareProfile;
        }
        await dispatchPromptToChatOrClipboard(
          promptText,
          'Запрос на подбор модели под ' + capGb + ' ГБ отправлен в активный чат ✓',
          'Активный чат недоступен — запрос подбора модели скопирован в буфер ✓'
        );
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка подготовки запроса подбора модели');
      }
    }

    async function prepareModelSearchPrompt() {
      try {
        flashStatus('Сбор списка моделей Ollama и параметров GPU...');
        const res = await panelFetch('/api/hardware', {
          method: 'POST',
          body: JSON.stringify({
            action: 'model_search_prompt',
            force: true,
            subscriptionTier: wizDraft.subscriptionTier || currentState.subscriptionTier || 'pro'
          }),
        });
        const data = await res.json();
        if (!data || !data.ok || !data.promptText) {
          flashStatus('Не удалось сформировать задание поиска моделей');
          return;
        }
        if (data.hardwareProfile) {
          currentHardwareProfile = data.hardwareProfile;
        }
        await dispatchPromptToChatOrClipboard(
          data.promptText,
          'Запрос на поиск актуальных моделей отправлен в активный чат ✓',
          'Активный чат недоступен — запрос скопирован в буфер, вставьте его в чат ✓'
        );
      } catch (err) {
        console.error(err);
        flashStatus('Ошибка подготовки поиска моделей');
      }
    }

    async function sendHardwareTunePrompt() {
      try {
        flashStatus('Сборка паспорта системы для ИИ-оптимизации...');
        const res = await panelFetch('/api/hardware', {
          method: 'POST',
          body: JSON.stringify({
            action: 'prompt',
            force: true,
            subscriptionTier: wizDraft.subscriptionTier || currentState.subscriptionTier || 'pro'
          }),
        });
        const data = await res.json();
        if (!data || !data.ok || !data.promptText) {
          flashStatus('Не удалось сформировать промпт диагностики');
          return;
        }
        if (data.hardwareProfile) {
          currentHardwareProfile = data.hardwareProfile;
        }
        const modal = document.getElementById('onboardingWizardModal');
        if (modal && modal.classList.contains('visible')) {
          await finishOnboardingWizard();
        }
        await dispatchPromptToChatOrClipboard(
          data.promptText,
          'Паспорт ПК отправлен в активный чат для ИИ-оптимизации ✓',
          'Промпт скопирован в буфер! Откройте новый чат и нажмите Вставить ✓'
        );
      } catch (err) {
        console.error(err);
        flashStatus('Сбой отправки промпта диагностики');
      }
    }

