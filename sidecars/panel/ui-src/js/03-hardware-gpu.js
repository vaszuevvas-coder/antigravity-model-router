    function setHwTooltipTitle(el, text) {
      if (!el) return;
      if (typeof setTooltipTitle === 'function') {
        setTooltipTitle(el, text);
      } else {
        el.title = String(text == null ? '' : text);
      }
    }

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

    const VRAM_LIMIT_PRESETS = [4096, 6144, 8192, 12288, 14336, 16384, 24576, 32768];
    const RAM_LIMIT_PRESETS = [1024, 2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768];
    const CPU_THREAD_PRESETS = [2, 4, 6, 10, 12, 16, 24, 32, 48, 64];

    function syncHwLimitSelect(selId, presets, maxVal, activeVal, formatLabel, includeExactCap) {
      const sel = document.getElementById(selId);
      if (!sel) return;
      const hasCap = Number.isFinite(maxVal) && maxVal > 0;
      const vals = [];
      for (let i = 0; i < presets.length; i++) {
        const v = presets[i];
        if (!hasCap || v <= maxVal) vals.push(v);
      }
      if (includeExactCap && hasCap && vals.indexOf(maxVal) === -1) {
        vals.push(maxVal);
      }
      if (Number.isFinite(activeVal) && activeVal > 0 && (!hasCap || activeVal <= maxVal) && vals.indexOf(activeVal) === -1) {
        vals.push(activeVal);
      }
      if (vals.length === 0 && presets.length > 0) {
        vals.push(presets[0]);
      }
      vals.sort(function (a, b) { return a - b; });
      const effectiveVal = vals.indexOf(activeVal) !== -1 ? activeVal : vals[vals.length - 1];
      const nextSig = vals.map(function (v) { return v + ':' + formatLabel(v); }).join('|');
      if (sel.dataset.limitOptsSig !== nextSig) {
        sel.innerHTML = '';
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i];
          const opt = document.createElement('option');
          opt.value = String(v);
          opt.textContent = formatLabel(v);
          sel.appendChild(opt);
        }
        sel.dataset.limitOptsSig = nextSig;
      }
      sel.value = String(effectiveVal);
      syncCustomSelectTrigger(selId);
    }

    function syncAllHwLimitSelects(ceilings, capMb, ramBudgetMb, cpuMaxThreads) {
      const maxVram = ceilings ? ceilings.maxVramMb : null;
      const maxRam = ceilings ? ceilings.maxRamBudgetMb : null;
      const maxCpu = ceilings ? ceilings.maxCpuThreads : null;
      const fmtGb = function (v) { return Math.round(v / 1024) + L(' ГБ', ' GB'); };
      const fmtCpu = function (v) { return v + L(' пот.', ' thr.'); };

      syncHwLimitSelect('sel-gpuVramCap', VRAM_LIMIT_PRESETS, maxVram, capMb, fmtGb, false);
      syncHwLimitSelect('sel-ramBudgetMain', RAM_LIMIT_PRESETS, maxRam, ramBudgetMb, fmtGb, false);
      syncHwLimitSelect('sel-cpuThreadsCap', CPU_THREAD_PRESETS, maxCpu, cpuMaxThreads, fmtCpu, true);
    }

    const CLIENT_RAM_GRACE_MS = 20000;
    const CLIENT_RAM_GRACE_MAX_MISSES = 4;
    let _lastActiveRamSnap = { ts: 0, data: null };
    let _clientRamInactiveMisses = 0;

    function resolveEffectiveClientRamSnap(ramCache, s) {
      const ramOn = !(s && s.ramCacheEnabled === false);
      if (!ramOn) {
        _lastActiveRamSnap = { ts: 0, data: null };
        _clientRamInactiveMisses = 0;
        return ramCache;
      }
      if (ramCache && ramCache.active === true) {
        _lastActiveRamSnap = { ts: Date.now(), data: ramCache };
        _clientRamInactiveMisses = 0;
        return ramCache;
      }
      if (
        _lastActiveRamSnap.data &&
        (Date.now() - _lastActiveRamSnap.ts <= CLIENT_RAM_GRACE_MS) &&
        _clientRamInactiveMisses < CLIENT_RAM_GRACE_MAX_MISSES
      ) {
        _clientRamInactiveMisses += 1;
        return Object.assign({}, _lastActiveRamSnap.data, {
          enabled: true,
          budgetMb: (ramCache && ramCache.budgetMb) || _lastActiveRamSnap.data.budgetMb,
          totalRamMb: (ramCache && ramCache.totalRamMb) || _lastActiveRamSnap.data.totalRamMb,
        });
      }
      return ramCache;
    }

    function syncHeaderHardwareLivePills(gpu, ramCache, s, cpu) {
      const prevHwCtx = _lastHwRenderCtx;
      if (!gpu && prevHwCtx && prevHwCtx.gpu) gpu = prevHwCtx.gpu;
      if (!ramCache && prevHwCtx && prevHwCtx.ramCache) ramCache = prevHwCtx.ramCache;
      if (!cpu && prevHwCtx && prevHwCtx.cpu) cpu = prevHwCtx.cpu;
      ramCache = resolveEffectiveClientRamSnap(ramCache, s);
      const cfg = (gpu && gpu.config) || {};
      const ceilings = resolveClientHardwareCeilings(gpu, ramCache, cpu);
      const rawCapMb = Number((s && s.gpuMaxVramMb) || cfg.gpuMaxVramMb || 4096);
      const capMb = ceilings && ceilings.maxVramMb ? Math.min(rawCapMb, ceilings.maxVramMb) : rawCapMb;
      const capGb = Math.round(capMb / 1024);
      const rawRamMb = Number((s && s.ramMaxBudgetMb) || (ramCache && ramCache.budgetMb) || 4096);
      const ramBudgetMb = ceilings && ceilings.maxRamBudgetMb ? Math.min(rawRamMb, ceilings.maxRamBudgetMb) : rawRamMb;
      const oll = (gpu && gpu.ollama) || {};
      const hw = (gpu && gpu.hardware) || {};
      const ollResolved = resolvePanelOllamaVram(oll, hw);
      _gpuPullActiveUi = Boolean(gpu && gpu.pullStatus && gpu.pullStatus.active);
      updateLiveHardwareOpticalUi(gpu, ollResolved, ramCache, s, capGb, ramBudgetMb, cpu, { headerOnly: true });
    }

    function renderGpuAndRam(gpu, ramCache, s, cpu) {
      const prevHwCtx = _lastHwRenderCtx;
      if (!gpu && prevHwCtx && prevHwCtx.gpu) gpu = prevHwCtx.gpu;
      if (!ramCache && prevHwCtx && prevHwCtx.ramCache) ramCache = prevHwCtx.ramCache;
      if (!cpu && prevHwCtx && prevHwCtx.cpu) cpu = prevHwCtx.cpu;
      ramCache = resolveEffectiveClientRamSnap(ramCache, s);
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
      const chkHfMirror = document.getElementById('chk-gpuPreferHfMirror');
      if (chkHfMirror) chkHfMirror.checked = Boolean(s && s.gpuPreferHfMirror);

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

      if (typeof syncTogglePresetsUi === 'function') {
        syncTogglePresetsUi(s);
      }

      syncAllHwLimitSelects(ceilings, capMb, ramBudgetMb, cpuMaxThreads);

      const vramHintEl = document.getElementById('gpuVramCapHint');
      const vramHintText = ceilings
        ? (ceilings.gpuAvailable
          ? (L('(до ', '(up to ') + Math.round(ceilings.maxVramMb / 1024) + L(' ГБ)', ' GB)'))
          : L('(GPU не найдена · мин. 4 ГБ)', '(No GPU detected · min 4 GB)'))
        : '';
      if (vramHintEl) {
        vramHintEl.textContent = vramHintText;
      }
      const ramHintEl = document.getElementById('ramBudgetCapHint');
      const ramHintText = ceilings && ceilings.totalRamGb > 0
        ? (L('(до ', '(up to ') + Math.round(ceilings.maxRamBudgetMb / 1024) + L(' из ', ' of ') + ceilings.totalRamGb + L(' ГБ ОЗУ)', ' GB RAM)'))
        : '';
      if (ramHintEl) {
        ramHintEl.textContent = ramHintText;
      }
      const cpuHintEl = document.getElementById('cpuThreadsCapHint');
      const cpuHintText = ceilings && ceilings.logicalCores > 0
        ? (L('(до ', '(up to ') + ceilings.maxCpuThreads + L(' из ', ' of ') + ceilings.logicalCores + L(' пот.)', ' thr.)'))
        : '';
      if (cpuHintEl) {
        cpuHintEl.textContent = cpuHintText;
      }

      const btnVramCap = document.getElementById('btn-gpuVramCap');
      if (btnVramCap) {
        setHwTooltipTitle(btnVramCap, L('Лимит видеопамяти GPU (VRAM)', 'GPU VRAM limit') + (vramHintText ? (' ' + vramHintText) : ''));
      }
      const btnRamCap = document.getElementById('btn-ramBudgetMain');
      if (btnRamCap) {
        setHwTooltipTitle(btnRamCap, L('Лимит оперативной памяти In-RAM', 'In-RAM cache limit') + (ramHintText ? (' ' + ramHintText) : ''));
      }
      const btnCpuCap = document.getElementById('btn-cpuThreadsCap');
      if (btnCpuCap) {
        setHwTooltipTitle(btnCpuCap, L('Лимит потоков процессора (CPU-пул)', 'CPU worker pool thread cap') + (cpuHintText ? (' ' + cpuHintText) : ''));
      }
      const ramLimitLbl = document.getElementById('ramUnitLimitLabel');
      if (ramLimitLbl) {
        setHwTextIfChanged(ramLimitLbl, L('Лимит', 'Limit'));
        setHwTooltipTitle(ramLimitLbl, L('Лимит оперативной памяти для кэша проекта In-RAM', 'System RAM cap for In-RAM project cache') + (ramHintText ? (' ' + ramHintText) : ''));
      }
      const gpuLimitLbl = document.getElementById('gpuUnitLimitLabel');
      if (gpuLimitLbl) {
        setHwTextIfChanged(gpuLimitLbl, 'VRAM');
        setHwTooltipTitle(gpuLimitLbl, L('Лимит видеопамяти GPU (Ollama)', 'GPU VRAM cap (Ollama)') + (vramHintText ? (' ' + vramHintText) : ''));
      }
      const cpuLimitLbl = document.getElementById('cpuUnitLimitLabel');
      if (cpuLimitLbl) {
        setHwTextIfChanged(cpuLimitLbl, L('Потоки', 'Threads'));
        setHwTooltipTitle(cpuLimitLbl, L('Лимит потоков пула CPU для AST, чанков и проверок', 'CPU pool thread cap for AST, chunks, and checks') + (cpuHintText ? (' ' + cpuHintText) : ''));
      }
      const gpuSwitchLbl = document.getElementById('gpuEnableSwitchLabel');
      if (gpuSwitchLbl) {
        setHwTooltipTitle(gpuSwitchLbl, L('Включить или выключить локального GPU-помощника (Ollama)', 'Enable or disable local GPU copilot (Ollama)'));
      }
      if (chkGpu) {
        chkGpu.setAttribute('aria-label', L('Включить GPU-помощник', 'Enable GPU copilot'));
      }
      const cpuSwitchLbl = document.getElementById('cpuEnableSwitchLabel');
      if (cpuSwitchLbl) {
        setHwTooltipTitle(cpuSwitchLbl, L('Включить или выключить многопоточный пул CPU', 'Enable or disable multi-core CPU worker pool'));
      }
      if (chkCpuPool) {
        chkCpuPool.setAttribute('aria-label', L('Включить пул потоков CPU', 'Enable CPU worker pool'));
      }

      syncExpertInput('inp-gpuEndpoint', (s && s.gpuEndpoint) || cfg.gpuEndpoint || 'http://127.0.0.1:11434');
      syncExpertInput('inp-gpuChatModel', (s && s.gpuChatModel) || cfg.gpuChatModel || 'gemma4:12b');
      syncExpertInput('inp-gpuEmbedModel', (s && s.gpuEmbedModel) || cfg.gpuEmbedModel || 'qwen3-embedding:0.6b');
      syncExpertInput('inp-gpuKeepAlive', (s && s.gpuKeepAlive) || cfg.gpuKeepAlive || '15m');
      syncExpertInput('inp-gpuEmbedKeepAlive', (s && s.gpuEmbedKeepAlive) || cfg.gpuEmbedKeepAlive || '90m');
      syncExpertInput('inp-gpuContextTokens', (s && s.gpuContextTokens) || cfg.gpuContextTokens || 4096);
      syncExpertInput('inp-gpuModelsDir', (s && s.gpuModelsDir !== undefined) ? s.gpuModelsDir : (cfg.gpuModelsDir || ''));
      syncExpertInput('inp-gpuOllamaDir', (s && s.gpuOllamaDir !== undefined) ? s.gpuOllamaDir : (cfg.gpuOllamaDir || ''));

      const enabled = Boolean(s && s.gpuEnabled);
      const oll = (gpu && gpu.ollama) || {};
      const hw = (gpu && gpu.hardware) || {};
      const tel = (gpu && gpu.telemetry) || {};

      const legendEl = document.getElementById('gpuRamSectionLegend');
      if (legendEl) {
        const ramGbLbl = Math.max(1, Math.round(ramBudgetMb / 1024));
        const gpuLbl = hw && hw.available && hw.name
          ? (hw.name.replace(/NVIDIA GeForce |AMD Radeon |Intel\(R\) /i, '').trim() + L(' (до ', ' (up to ') + capGb + L(' ГБ)', ' GB)'))
          : (enabled ? (L('Локальный GPU (до ', 'Local GPU (up to ') + capGb + L(' ГБ)', ' GB)')) : L('Контур CPU + In-RAM', 'CPU + In-RAM Mode'));
        legendEl.textContent = gpuLbl + L(' и память проекта (', ' & Project Memory (') + ramGbLbl + L(' ГБ RAM)', ' GB RAM)');
      }

      const ollResolved = resolvePanelOllamaVram(oll, hw);
      const vramFit = computeClientVramFit(s, cfg, oll, ollResolved, gpu && gpu.vramFit);
      syncGpuModelSelects(s, cfg, oll, ollResolved, vramFit);
      renderGpuVramFitAlert(s, vramFit);
      renderGpuCascadePullStatus(gpu ? gpu.pullStatus : null, gpu, s);
      renderGpuOllamaInstallStatus(gpu ? gpu.ollamaInstallStatus : null, gpu, s);

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
        badgeEl.textContent = L('В работе', 'Active');
        return;
      }
      badgeEl.className = 'swarm-pill idle';
      if (ramOn && gpuOn) {
        badgeEl.textContent = ramGb + L(' ГБ RAM · ', ' GB RAM · ') + vramGb + L(' ГБ GPU', ' GB GPU');
      } else if (ramOn) {
        badgeEl.textContent = ramGb + L(' ГБ RAM · CPU', ' GB RAM · CPU');
      } else if (gpuOn) {
        badgeEl.textContent = vramGb + L(' ГБ GPU', ' GB GPU');
      } else {
        badgeEl.textContent = L('CPU-режим', 'CPU mode');
      }
    }

    function formatHostRamWarmedLabel(mb) {
      const num = Number(mb || 0);
      if (!Number.isFinite(num) || num <= 0) return '';
      return num >= 1024 ? ((num / 1024).toFixed(1) + L(' ГБ', ' GB')) : (Math.round(num) + L(' МБ', ' MB'));
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
      const opNamesEn = {
        ram_slice: 'Code slice',
        ram_search: 'RAM search',
        hybrid_search: 'Hybrid search',
        ram_context_pack: 'Context pack',
        gold_context: 'Gold context',
        session_repomap: 'Symbol RepoMap',
        ram_hit: 'Buffer read',
        speculative_prefetch: 'Speculative prefetch',
        repair_kv: 'RepairKV cache',
        memo_hit: 'ACON memoization',
      };
      const base = isRu() ? (opNames[op] || 'Обращение к ОЗУ') : (opNamesEn[op] || 'RAM access');
      const tgt = live.lastTarget ? (' · ' + live.lastTarget) : '';
      const burst = Number(live.burstCount || 0) > 1 ? (' (+' + live.burstCount + L(' хитов)', ' hits)')) : '';
      const ms = Number(live.lastLatencyMs || 0) > 0 ? (' · ' + live.lastLatencyMs + L(' мс', ' ms')) : '';
      return base + tgt + burst + ms;
    }

    function formatGpuLiveOpRu(live, fallbackModel) {
      if (!live) return '';
      const detail = pickText(live, 'currentDetail', 'currentDetailEn', '');
      if (detail) {
        const msTag = (!live.isWorking && Number(live.lastLatencyMs || 0) > 0)
          ? (' (' + live.lastLatencyMs + L(' мс)', ' ms)'))
          : '';
        return detail + msTag;
      }
      const m = live.currentModel || fallbackModel || 'Ollama';
      if (live.currentOp === 'autocomplete') return L('Умный ввод (', 'Smart input (') + m + ')';
      if (live.currentOp === 'distill') return L('Дистилляция на ', 'Distilling on ') + m;
      if (live.currentOp === 'vector_index') return L('Индексация векторов (', 'Vector indexing (') + m + ')';
      if (live.currentOp === 'semantic_embed') return L('Семантический поиск (', 'Semantic search (') + m + ')';
      return L('Расчёт на ', 'Inference on ') + m;
    }

    function formatCpuLiveOpRu(live) {
      if (!live) return L('Расчёт в пуле потоков', 'Running in thread pool');
      const op = String(live.currentOp || '');
      let base = String(pickText(live, 'currentDetail', 'currentDetailEn', '') || '').trim();
      if (!base) {
        if (op.indexOf('parseMetadataBatch') === 0) base = L('Разбор AST и триграмм', 'Parsing AST & trigrams');
        else if (op.indexOf('chunkVectorsBatch') === 0) base = L('Нарезка чанков векторов', 'Chunking vector slices');
        else if (op.indexOf('syntaxCheckBatch') === 0) base = L('Проверка синтаксиса', 'Syntax verification');
        else if (op.indexOf('auditFilesBatch') === 0) base = L('Стресс-аудит кода', 'Code stress audit');
        else if (op === 'cross_rerank') base = 'CPU Cross-Reranker';
        else if (op === 'parallel_verify') base = L('Параллельная проверка', 'Parallel verification');
        else if (op === 'ddmin_parallel') base = L('Минимизация ddmin', 'ddmin minimization');
        else base = L('Задача пула потоков', 'Worker pool task');
      }
      const msTag = (!live.isWorking && Number(live.lastLatencyMs || 0) > 0)
        ? (' · ' + live.lastLatencyMs + L(' мс', ' ms'))
        : '';
      return base + msTag;
    }

    function setHwMetricSplit(el, primaryText, capText) {
      if (!el) return;
      const p = String(primaryText == null ? '' : primaryText);
      const c = String(capText == null ? '' : capText);
      const raw = c ? (p + ' ' + c) : p;
      if (el.dataset && el.dataset.hwRaw === raw && el.childElementCount >= 1) return;
      if (el.dataset) el.dataset.hwRaw = raw;
      while (el.firstChild) el.removeChild(el.firstChild);
      const valSpan = document.createElement('span');
      valSpan.className = 'hw-metric-val';
      valSpan.textContent = p;
      el.appendChild(valSpan);
      if (c) {
        const capSpan = document.createElement('span');
        capSpan.className = 'hw-metric-cap';
        capSpan.textContent = ' ' + c;
        el.appendChild(capSpan);
      }
    }

    const _hwB4Units = {
      ram: { level: 0, target: 0, mode: 'off' },
      gpu: { level: 0, target: 0, mode: 'off' },
      cpu: { level: 0, target: 0, mode: 'off' },
    };
    const _hwB4CanvasIds = { ram: 'ramB4Canvas', gpu: 'gpuB4Canvas', cpu: 'cpuB4Canvas' };
    const _hwB4Colors = { ram: [148, 163, 184], gpu: [77, 139, 140], cpu: [240, 72, 72], over: [239, 68, 68] };
    const _hwB4Rates = { ram: { scan: 0.48, wave: 2.8 }, gpu: { scan: 0.65, wave: 3.8 }, cpu: { scan: 0.92, wave: 6.0 } };
    let _hwB4RafId = 0;
    let _hwB4LastTs = 0;
    let _hwB4LifecycleBound = false;

    function hwB4PrefersReducedMotion() {
      try {
        return Boolean(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch {
        return false;
      }
    }

    function hwB4IsCardCollapsed() {
      const card = document.getElementById('gpuRamCard');
      if (card && card.classList.contains('is-collapsed')) return true;
      if (document.body && document.body.getAttribute('data-panel-view') === 'full') {
        const tab = document.body.getAttribute('data-full-tab') || 'cockpit';
        if (tab !== 'hardware') return true;
      }
      return false;
    }

    function drawHwB4Rect(ctx, x, y, w, h, r) {
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, w, h);
      }
    }

    function drawHwB4Canvas(unit, cv, d, t, reducedMotion) {
      if (!cv || typeof cv.getContext !== 'function' || typeof cv.getBoundingClientRect !== 'function') return;
      const rect = cv.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 8) return;
      const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
      const w = Math.max(60, Math.round(rect.width * dpr));
      const h = Math.max(16, Math.round(rect.height * dpr));
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);

      const midY = h / 2;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.fillRect(0, midY - 0.5 * dpr, w, Math.max(1, dpr));

      const count = 26;
      const gap = Math.max(2 * dpr, w * 0.015);
      const bw = Math.max(1.5 * dpr, (w - gap * (count - 1)) / count);
      const radius = 1.4 * dpr;
      const dotH = 3 * dpr;

      if (d.mode === 'off') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        for (let i = 0; i < count; i++) {
          drawHwB4Rect(ctx, i * (bw + gap), midY - dotH / 2, bw, dotH, radius);
        }
        return;
      }

      const lit = Math.max(d.target > 0.005 ? 1 : 0, Math.round(d.level * count));
      const rgb = d.mode === 'over' ? _hwB4Colors.over : _hwB4Colors[unit];
      const rates = _hwB4Rates[unit];
      const active = d.mode === 'working' || d.mode === 'over';
      const mult = d.mode === 'over' ? 1.25 : 1.0;
      const scan = ((t * rates.scan * mult) % 1.35) * Math.max(1, lit);

      for (let i = 0; i < count; i++) {
        const x = i * (bw + gap);
        if (i >= lit) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
          drawHwB4Rect(ctx, x, midY - dotH / 2, bw, dotH, radius);
          continue;
        }
        let halfH;
        let alpha;
        if (reducedMotion) {
          halfH = Math.max(2.5 * dpr, h * 0.34);
          alpha = 0.78;
        } else if (!active) {
          const idleWave = 0.5 + 0.5 * Math.sin(t * 1.4 - i * 0.45);
          halfH = Math.max(2.2 * dpr, h * (0.14 + 0.08 * idleWave));
          alpha = 0.48;
        } else {
          const focus = Math.max(0, 1 - Math.abs(i - scan) / 3.4);
          const wave = 0.5 + 0.5 * Math.sin(t * rates.wave * mult - i * 0.55);
          halfH = Math.max(2.5 * dpr, (h * 0.46) * (0.28 + focus * 0.46 + wave * 0.26));
          alpha = 0.52 + focus * 0.45;
        }
        const isTip = i === lit - 1 && active && !reducedMotion;
        ctx.fillStyle = isTip
          ? '#ffffff'
          : ('rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha.toFixed(3) + ')');
        drawHwB4Rect(ctx, x, midY - halfH, bw, halfH * 2, radius);
      }
    }

    function drawAllHwB4Static() {
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      const reduced = hwB4PrefersReducedMotion();
      for (const unit of ['ram', 'gpu', 'cpu']) {
        const d = _hwB4Units[unit];
        d.level = d.target;
        drawHwB4Canvas(unit, document.getElementById(_hwB4CanvasIds[unit]), d, t, reduced);
      }
    }

    function stopHwB4Loop() {
      if (_hwB4RafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(_hwB4RafId);
      }
      _hwB4RafId = 0;
      _hwB4LastTs = 0;
    }

    function hwB4Tick(now) {
      _hwB4RafId = 0;
      const reduced = hwB4PrefersReducedMotion();
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const allOff = _hwB4Units.ram.mode === 'off' && _hwB4Units.gpu.mode === 'off' && _hwB4Units.cpu.mode === 'off';
      if (hidden || hwB4IsCardCollapsed() || allOff || reduced) {
        if (!hidden && !hwB4IsCardCollapsed()) drawAllHwB4Static();
        _hwB4LastTs = 0;
        return;
      }
      const dt = _hwB4LastTs ? Math.min(0.05, (now - _hwB4LastTs) / 1000) : 0.016;
      _hwB4LastTs = now;
      const t = now / 1000;
      for (const unit of ['ram', 'gpu', 'cpu']) {
        const d = _hwB4Units[unit];
        d.level += (d.target - d.level) * Math.min(1, dt * 6);
        drawHwB4Canvas(unit, document.getElementById(_hwB4CanvasIds[unit]), d, t, false);
      }
      _hwB4RafId = requestAnimationFrame(hwB4Tick);
    }

    function bindHwB4LifecycleOnce() {
      if (_hwB4LifecycleBound || typeof document === 'undefined') return;
      _hwB4LifecycleBound = true;
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') stopHwB4Loop();
        else ensureHwB4Loop();
      });
      const card = document.getElementById('gpuRamCard');
      if (card && typeof MutationObserver === 'function') {
        const mo = new MutationObserver(function () {
          if (hwB4IsCardCollapsed()) stopHwB4Loop();
          else ensureHwB4Loop();
        });
        mo.observe(card, { attributes: true, attributeFilter: ['class'] });
      }
    }

    function ensureHwB4Loop() {
      bindHwB4LifecycleOnce();
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (hidden || hwB4IsCardCollapsed()) {
        stopHwB4Loop();
        return;
      }
      const reduced = hwB4PrefersReducedMotion();
      const allOff = _hwB4Units.ram.mode === 'off' && _hwB4Units.gpu.mode === 'off' && _hwB4Units.cpu.mode === 'off';
      if (reduced || allOff || typeof requestAnimationFrame !== 'function') {
        stopHwB4Loop();
        drawAllHwB4Static();
        return;
      }
      if (!_hwB4RafId) {
        _hwB4LastTs = 0;
        _hwB4RafId = requestAnimationFrame(hwB4Tick);
      }
    }

    function syncHwB4Unit(unit, targetFrac, mode) {
      const d = _hwB4Units[unit];
      if (!d) return;
      d.target = Math.max(0, Math.min(1, Number(targetFrac) || 0));
      d.mode = mode || 'off';
      if (d.mode === 'off') d.level = 0;
    }

    function formatHwCapPctLabel(usedVal, maxVal) {
      const used = Math.max(0, Number(usedVal) || 0);
      const cap = Math.max(1, Number(maxVal) || 1);
      if (used <= 0) return '0%';
      const pct = (used / cap) * 100;
      if (pct > 0 && pct < 1) return '<1%';
      return Math.min(999, Math.round(pct)) + '%';
    }

    function scheduleHwAfterglowDecay(ramWorking, ramLive, gpuWorking, gpuInFlight, cpuWorking, cpuInFlight) {
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
            updateLiveHardwareOpticalUi(c.gpu, c.ollResolved, c.ramCache, c.s, c.capGb, c.ramBudgetMb, c.cpu, {
              headerOnly: Boolean(c.headerOnly),
            });
          }
        }, 160);
      }
    }

    function updateLiveHardwareOpticalUi(gpu, ollResolved, ramCache, s, capGb, ramBudgetMb, cpu, opts) {
      const headerOnly = Boolean(opts && opts.headerOnly);
      _lastHwRenderCtx = { gpu, ollResolved, ramCache, s, capGb, ramBudgetMb, cpu, headerOnly };
      const now = Date.now();
      const ramEnabled = (s && typeof s.ramCacheEnabled === 'boolean')
        ? s.ramCacheEnabled
        : !(ramCache && ramCache.enabled === false);
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

      // 1. Верхние мини-пилюли в шапке прогресса и переключатели Lite
      let ramPillCls = 'is-off';
      let ramPillText = L('RAM · Ожидание', 'RAM · Idle');
      if (!ramEnabled) {
        ramPillCls = 'is-off';
        ramPillText = L('RAM · Выкл', 'RAM · Off');
      } else if (ramWorking) {
        const shortOp = ramLive.lastOp === 'ram_slice' ? L('Срез кода', 'Slice') : (ramLive.lastOp === 'ram_search' ? L('Поиск', 'Search') : L('Чтение', 'Read'));
        ramPillCls = 'is-working-ram';
        ramPillText = 'RAM · ' + shortOp;
      } else if (ramWarm) {
        ramPillCls = 'is-standby';
        ramPillText = L('RAM · В фоне (', 'RAM · Standby (') + Math.round(ramCache.cacheUsedMb || 0) + L(' МБ)', ' MB)');
      }

      const topRamPill = document.getElementById('topRamLivePill');
      const topRamTxt = document.getElementById('topRamLiveText');
      if (topRamPill && topRamTxt) {
        topRamPill.className = 'hw-live-pill ' + ramPillCls;
        topRamPill.setAttribute('aria-pressed', ramEnabled ? 'true' : 'false');
        topRamTxt.textContent = ramPillText;
      }

      let gpuPillCls = 'is-off';
      let gpuPillText = oll.running ? L('GPU · Выгружена', 'GPU · Unloaded') : L('GPU · Сон', 'GPU · Sleep');
      if (!gpuEnabled) {
        gpuPillCls = 'is-off';
        gpuPillText = L('GPU · Выкл', 'GPU · Off');
      } else if (gpuWorking) {
        const activeModShort = String(gpuLive.currentModel || (s && s.gpuChatModel) || 'Ollama').split(':')[0];
        gpuPillCls = 'is-working-gpu';
        gpuPillText = 'GPU · ' + activeModShort;
      } else if (gpuWarmInVram) {
        gpuPillCls = 'is-standby';
        gpuPillText = L('GPU · В фоне (', 'GPU · Standby (') + (loadedVramMb / 1024).toFixed(1) + L(' ГБ)', ' GB)');
      }

      const topGpuPill = document.getElementById('topGpuLivePill');
      const topGpuTxt = document.getElementById('topGpuLiveText');
      if (topGpuPill && topGpuTxt) {
        topGpuPill.className = 'hw-live-pill ' + gpuPillCls;
        topGpuPill.setAttribute('aria-pressed', gpuEnabled ? 'true' : 'false');
        topGpuTxt.textContent = gpuPillText;
      }

      const liteMasterBtn = document.getElementById('liteRamGpuMasterBtn');
      if (liteMasterBtn) {
        const anyHwOn = ramEnabled || gpuEnabled;
        liteMasterBtn.classList.toggle('is-on', anyHwOn);
        liteMasterBtn.classList.toggle('is-off', !anyHwOn);
        liteMasterBtn.setAttribute('aria-pressed', anyHwOn ? 'true' : 'false');
        liteMasterBtn.textContent = anyHwOn ? L('Активно', 'Active') : L('Пауза', 'Paused');
      }

      const topCpuPill = document.getElementById('topCpuLivePill');
      const topCpuTxt = document.getElementById('topCpuLiveText');
      if (topCpuPill && topCpuTxt) {
        topCpuPill.setAttribute('aria-pressed', cpuPoolOn ? 'true' : 'false');
        if (!cpuPoolOn) {
          topCpuPill.className = 'hw-live-pill is-off';
          topCpuTxt.textContent = L('CPU · Выкл', 'CPU · Off');
        } else if (cpuWorking) {
          const opRaw = String(cpuLive.currentOp || '');
          const shortCpuOp = opRaw === 'cross_rerank'
            ? 'Rerank'
            : (opRaw === 'parallel_verify' || opRaw === 'ddmin_parallel' ? L('Проверка', 'Verify') : L('Воркеры', 'Workers'));
          topCpuPill.className = 'hw-live-pill is-working-cpu';
          topCpuTxt.textContent = 'CPU · ' + shortCpuOp;
        } else {
          topCpuPill.className = 'hw-live-pill is-standby';
          topCpuTxt.textContent = L('CPU · В фоне (', 'CPU · Standby (') + effThreads + L(' пот.)', ' thr.)');
        }
      }

      scheduleHwAfterglowDecay(ramWorking, ramLive, gpuWorking, gpuInFlight, cpuWorking, cpuInFlight);
      if (headerOnly) return;

      // 2. Оптические карточки внутри gpuRamCard (Liquid Silk: гидро-мениск и световоды)
      const ramCard = document.getElementById('ramLiveUnitCard');
      const ramBadge = document.getElementById('ramUnitStateBadge');
      const ramMetric = document.getElementById('ramUnitMetricVal');
      const ramOp = document.getElementById('ramUnitOpText');
      const ramFill = document.getElementById('ramUnitAfterglowFill');
      const ramCapPct = document.getElementById('ramUnitCapPct');
      if (ramCard && ramBadge && ramMetric && ramOp && ramFill) {
        const usedMb = ramCache && ramCache.active ? (ramCache.cacheUsedMb || 0) : 0;
        const capRam = Math.max(256, Number(ramBudgetMb || (ramCache && ramCache.budgetMb) || 4096));
        const rawRamFrac = Math.max(0, Math.min(1, usedMb / capRam));
        if (capRam >= 1024) {
          const capGbStr = (capRam % 1024 === 0) ? String(capRam / 1024) : (capRam / 1024).toFixed(1);
          const usedGbStr = usedMb === 0 ? '0' : (usedMb < 1024 ? (usedMb / 1024).toFixed(2).replace(/0$/, '') : (usedMb / 1024).toFixed(1));
          setHwMetricSplit(ramMetric, usedGbStr, '/ ' + capGbStr + L(' ГБ', ' GB'));
        } else {
          setHwMetricSplit(ramMetric, String(usedMb), '/ ' + capRam + L(' МБ', ' MB'));
        }
        if (ramCapPct) {
          setHwTextIfChanged(ramCapPct, !ramEnabled ? L('Выкл', 'Off') : formatHwCapPctLabel(usedMb, capRam));
        }
        if (!ramEnabled) {
          ramCard.className = 'hw-optical-unit ram-unit is-off';
          ramBadge.textContent = L('Выкл', 'Off');
          ramOp.textContent = L('In-RAM буфер отключён в настройках', 'In-RAM cache is disabled in settings');
          ramFill.style.setProperty('--hw-fill', '0');
          syncHwB4Unit('ram', 0, 'off');
        } else if (ramWorking) {
          const workFill = Math.min(1, Math.max(rawRamFrac, usedMb > 0 ? 0.08 : 0.04, 0.16 + 0.56 * ramRatio));
          ramCard.className = 'hw-optical-unit ram-unit is-working';
          ramBadge.textContent = L('В работе', 'Active');
          ramOp.textContent = formatRamLiveOpRu(ramLive);
          ramFill.style.setProperty('--hw-fill', workFill.toFixed(3));
          syncHwB4Unit('ram', workFill, 'working');
        } else if (ramWarm) {
          const wsArr = Array.isArray(ramCache.workspaces) ? ramCache.workspaces : [];
          const filesCount = wsArr.reduce((acc, w) => acc + (Number(w && w.files) || 0), 0);
          const sotaInfo = ramCache && ramCache.sota ? ramCache.sota : null;
          const sotaOpsCount = sotaInfo
            ? (Number(sotaInfo.memoHits || 0) + Number(sotaInfo.repairRecalls || 0))
            : 0;
          const sotaSuffix = sotaOpsCount > 0
            ? (L(' · Мемо/RepairKV: +', ' · Memo/RepairKV: +') + sotaOpsCount)
            : '';
          const standbyFill = usedMb > 0 ? Math.max(0.065, rawRamFrac) : 0.045;
          ramCard.className = 'hw-optical-unit ram-unit is-standby';
          ramBadge.textContent = L('В фоне', 'Standby');
          ramOp.textContent = (filesCount > 0
            ? (L('Прогрето в ОЗУ: ', 'Warmed in RAM: ') + filesCount + L(' файлов · ждёт запроса', ' files · awaiting query'))
            : (L('Демон активен · ждёт обращений (хитов: ', 'Daemon active · awaiting requests (hits: ') + (ramCache.hits || 0) + ')')) + sotaSuffix;
          ramFill.style.setProperty('--hw-fill', standbyFill.toFixed(3));
          syncHwB4Unit('ram', standbyFill, 'standby');
        } else {
          ramCard.className = 'hw-optical-unit ram-unit is-off';
          ramBadge.textContent = L('Спит', 'Sleep');
          ramOp.textContent = L('Автостарт при первом обращении ИИ', 'Auto-starts on first AI request');
          ramFill.style.setProperty('--hw-fill', '0.032');
          syncHwB4Unit('ram', 0.032, 'off');
        }
        setHwTooltipTitle(ramCard, ramBadge.textContent + ' · ' + ramOp.textContent);
      }

      const gpuCard = document.getElementById('gpuLiveUnitCard');
      const gpuBadge = document.getElementById('gpuUnitStateBadge');
      const gpuMetric = document.getElementById('gpuUnitMetricVal');
      const gpuGgufPill = document.getElementById('gpuUnitGgufPill');
      const gpuOp = document.getElementById('gpuUnitOpText');
      const gpuFill = document.getElementById('gpuUnitAfterglowFill');
      const gpuCapPct = document.getElementById('gpuUnitCapPct');
      const gpuTel = (gpu && gpu.telemetry) || {};
      const gpuHw = (gpu && gpu.hardware) || {};
      const gpuGuard = (gpu && gpu.thermalGuard) || {};
      if (gpuGgufPill) {
        const hostWarmedLbl = formatHostRamWarmedLabel(gpuTel.hostRamWarmedMb);
        const ddr5WarmOn = Boolean(gpuEnabled && hostWarmedLbl && (!s || s.gpuWarmHostRamCache !== false));
        if (ddr5WarmOn) {
          gpuGgufPill.style.display = 'inline-flex';
          setHwTextIfChanged(gpuGgufPill, 'GGUF: ' + hostWarmedLbl);
          setHwTooltipTitle(
            gpuGgufPill,
            L('Веса GGUF прогреты в системной DDR5 ОЗУ (', 'GGUF weights warmed in system DDR5 RAM (') +
            hostWarmedLbl +
            L(') для быстрого подъёма в VRAM', ') for fast VRAM load')
          );
        } else {
          gpuGgufPill.style.display = 'none';
        }
      }
      if (gpuCard && gpuBadge && gpuMetric && gpuOp && gpuFill) {
        const usedVramGb = (loadedVramMb / 1024).toFixed(1);
        const capVramMb = Math.max(256, Number(capGb || 4) * 1024);
        const rawGpuFrac = Math.max(0, Math.min(1, loadedVramMb / capVramMb));
        const liveUtilPct = Math.max(0, Math.min(100, Math.round(Number(gpuHw.utilPct || 0))));
        const liveTempC = Math.max(0, Math.round(Number(gpuHw.tempC || 0)));
        const hwSensorsSuffix = (gpuEnabled && gpuHw.available && (liveTempC > 0 || liveUtilPct > 0))
          ? ((isRu() ? ' · Ядро ' : ' · Core ') + liveUtilPct + '% · ' + (liveTempC > 0 ? (liveTempC + '°C') : '—'))
          : '';
        setHwMetricSplit(gpuMetric, usedVramGb, '/ ' + capGb + L(' ГБ', ' GB'));
        if (gpuCapPct) {
          setHwTextIfChanged(gpuCapPct, !gpuEnabled
            ? L('Выкл', 'Off')
            : ('VRAM ' + formatHwCapPctLabel(loadedVramMb, capVramMb) + hwSensorsSuffix));
        }
        setHwTooltipTitle(
          gpuMetric,
          gpuHw.available
            ? (
              isRu()
                ? (
                  gpuHw.name +
                  ' · Модели Ollama: ' + usedVramGb + ' ГБ' +
                  ' · Всего на GPU: ' + ((gpuHw.usedMb || 0) / 1024).toFixed(1) + ' / ' + ((gpuHw.totalMb || 0) / 1024).toFixed(1) + ' ГБ' +
                  ' (свободно ' + ((gpuHw.freeMb || 0) / 1024).toFixed(1) + ' ГБ) · Ядро: ' + liveUtilPct + '% · ' + liveTempC + '°C'
                )
                : (
                  gpuHw.name +
                  ' · Ollama models: ' + usedVramGb + ' GB' +
                  ' · Total GPU: ' + ((gpuHw.usedMb || 0) / 1024).toFixed(1) + ' / ' + ((gpuHw.totalMb || 0) / 1024).toFixed(1) + ' GB' +
                  ' (free ' + ((gpuHw.freeMb || 0) / 1024).toFixed(1) + ' GB) · Core: ' + liveUtilPct + '% · ' + liveTempC + '°C'
                )
            )
            : ''
        );
        let gpuOpTipText = '';
        if (!gpuEnabled) {
          gpuCard.className = 'hw-optical-unit gpu-unit is-off';
          gpuBadge.textContent = L('Выкл', 'Off');
          gpuOp.textContent = L('Локальный GPU-помощник выключен', 'Local GPU copilot is disabled');
          gpuOpTipText = '';
          gpuFill.style.setProperty('--hw-fill', '0');
          syncHwB4Unit('gpu', 0, 'off');
        } else if (gpuGuard.throttled && !gpuWorking) {
          const isThermal = gpuGuard.reason === 'thermal_throttle';
          const guardFill = Math.max(0.08, rawGpuFrac);
          gpuCard.className = 'hw-optical-unit gpu-unit is-standby is-over-cap';
          gpuBadge.textContent = isThermal ? (liveTempC + '°C') : ('GPU ' + liveUtilPct + '%');
          gpuOp.textContent = isThermal
            ? (L('Пауза по перегреву GPU (', 'GPU thermal pause (') + liveTempC + L('°C) · фоновые задачи приостановлены', '°C) · background tasks paused'))
            : (L('Внешняя нагрузка GPU (', 'External GPU load (') + liveUtilPct + L('%) · фоновый индекс отложен', '%) · background indexing deferred'));
          gpuOpTipText = pickText(gpuGuard, 'message', 'messageEn', gpuGuard.message || '');
          gpuFill.style.setProperty('--hw-fill', guardFill.toFixed(3));
          syncHwB4Unit('gpu', guardFill, 'over');
        } else if (gpuWorking) {
          const liveText = formatGpuLiveOpRu(gpuLive, (s && s.gpuChatModel) || 'gemma4:12b');
          const workVramFill = Math.min(1, Math.max(rawGpuFrac, loadedVramMb > 0 ? 0.08 : 0.18 + 0.58 * gpuRatio));
          gpuCard.className = 'hw-optical-unit gpu-unit is-working';
          gpuBadge.textContent = gpuInFlight ? L('В работе', 'Working') : L('Завершено', 'Done');
          gpuOp.textContent = liveText;
          gpuOpTipText = liveText;
          gpuFill.style.setProperty('--hw-fill', workVramFill.toFixed(3));
          syncHwB4Unit('gpu', workVramFill, 'working');
        } else if (gpuWarmInVram) {
          const names = Array.isArray(ollResolved && ollResolved.loadedModels)
            ? ollResolved.loadedModels.map((m) => m.name).join(' + ')
            : L('модель', 'model');
          const isOverCap = loadedVramMb > (capGb * 1024 + 128);
          const hostWarmedLbl = formatHostRamWarmedLabel(gpuTel.hostRamWarmedMb);
          const ddr5WarmOn = Boolean(hostWarmedLbl && (!s || s.gpuWarmHostRamCache !== false));
          const warmFill = isOverCap ? 1 : Math.max(0.065, rawGpuFrac);
          gpuCard.className = isOverCap ? 'hw-optical-unit gpu-unit is-standby is-over-cap' : 'hw-optical-unit gpu-unit is-standby';
          gpuBadge.textContent = isOverCap ? L('Сверх лимита', 'Over cap') : L('В фоне', 'Standby');
          if (isOverCap) {
            gpuOp.textContent = L('Превышен лимит ', 'Exceeded ') + capGb + L(' ГБ · требуется выгрузка или компактная модель', ' GB cap · unload or pick smaller model');
          } else {
            if (isRu()) {
              gpuOp.textContent = 'Дежурит в VRAM · расчётов сейчас нет';
            } else {
              gpuOp.textContent = 'Warm in VRAM · idle';
            }
            if (ddr5WarmOn) gpuOp.textContent = L('Дежурит в VRAM · DDR5 GGUF: ', 'Warm in VRAM · DDR5 GGUF: ') + hostWarmedLbl;
          }
          gpuOpTipText = L('В видеопамяти: ', 'In VRAM: ') + names + (ddr5WarmOn ? (L(' · Прогрето в DDR5 ОЗУ: ', ' · Warmed in DDR5 RAM: ') + hostWarmedLbl) : '');
          gpuFill.style.setProperty('--hw-fill', warmFill.toFixed(3));
          syncHwB4Unit('gpu', warmFill, isOverCap ? 'over' : 'standby');
        } else {
          const hostWarmedLbl = formatHostRamWarmedLabel(gpuTel.hostRamWarmedMb);
          const ddr5WarmOn = Boolean(hostWarmedLbl && (!s || s.gpuWarmHostRamCache !== false));
          gpuCard.className = 'hw-optical-unit gpu-unit is-off';
          gpuBadge.textContent = oll.running ? L('Выгружена', 'Unloaded') : L('Спит', 'Sleep');
          gpuOp.textContent = oll.running
            ? (ddr5WarmOn
                ? L('0 ГБ в VRAM · в DDR5 ОЗУ: ' + hostWarmedLbl, '0 GB in VRAM · in DDR5 RAM: ' + hostWarmedLbl)
                : L('0 ГБ в видеопамяти · ждёт задачи', '0 GB in VRAM · awaiting task'))
            : L('Сервер Ollama в режиме ожидания', 'Ollama server in standby');
          gpuOpTipText = (oll.running && ddr5WarmOn)
            ? (L('Веса GGUF прогреты в системной DDR5 ОЗУ (', 'GGUF weights warmed in system DDR5 RAM (') + hostWarmedLbl + L(') для быстрого подъёма в VRAM', ') for fast VRAM load'))
            : '';
          gpuFill.style.setProperty('--hw-fill', '0.032');
          syncHwB4Unit('gpu', 0.032, 'off');
        }
        setHwTooltipTitle(gpuOp, gpuOpTipText);
        setHwTooltipTitle(gpuCard, gpuBadge.textContent + ' · ' + gpuOp.textContent + (gpuOpTipText ? (' · ' + gpuOpTipText) : ''));
      }

      const cpuCard = document.getElementById('cpuLiveUnitCard');
      const cpuBadge = document.getElementById('cpuUnitStateBadge');
      const cpuMetric = document.getElementById('cpuUnitMetricVal');
      const cpuOp = document.getElementById('cpuUnitOpText');
      const cpuFill = document.getElementById('cpuUnitAfterglowFill');
      const cpuCapPct = document.getElementById('cpuUnitCapPct');
      const totalBatches = Number(cpuTel.workerBatches || 0);
      const lastRerankMs = Number(cpuTel.lastRerankMs || 0);
      if (cpuCard && cpuBadge && cpuMetric && cpuOp && cpuFill) {
        const rawActiveThreads = cpuInFlight
          ? Math.max(1, Number(cpuLive.activeThreads || cpuPool.busyWorkers || 1))
          : (cpuWorking ? Math.max(1, Number(cpuLive.recentThreads || 1)) : 0);
        const shownThreads = cpuEnabled ? Math.min(effThreads, rawActiveThreads) : 0;
        const threadFrac = Math.max(0, Math.min(1, shownThreads / Math.max(1, effThreads)));
        setHwMetricSplit(cpuMetric, String(shownThreads), '/ ' + effThreads + L(' пот.', ' thr.'));
        if (cpuCapPct) {
          setHwTextIfChanged(cpuCapPct, !cpuEnabled ? L('Выкл', 'Off') : (Math.round(threadFrac * 100) + '%'));
        }
        setHwTooltipTitle(
          cpuMetric,
          L('Лимит пула: ', 'Pool cap: ') + effThreads + L(' из ', ' of ') + logCores + L(' логических потоков', ' logical threads') +
          L(' · Активно в пуле: ', ' · Active in pool: ') + Number(cpuPool.activeWorkers || 0) +
          L(' · Пик нагрузки: ', ' · Peak load: ') + Math.max(Number(cpuTel.peakWorkersUsed || 0), shownThreads) + L(' пот.', ' thr.')
        );
        if (!cpuEnabled) {
          cpuCard.className = 'hw-optical-unit cpu-unit is-off';
          cpuBadge.textContent = L('Выкл', 'Off');
          cpuOp.textContent = L('Контур CPU-сопроцессора отключён в настройках', 'CPU coprocessor is disabled in settings');
          setHwTooltipTitle(cpuOp, '');
          cpuFill.style.setProperty('--hw-fill', '0');
          syncHwB4Unit('cpu', 0, 'off');
        } else if (cpuWorking) {
          const liveCpuText = formatCpuLiveOpRu(cpuLive);
          const workCpuFill = Math.min(1, Math.max(threadFrac, shownThreads > 0 ? 0.08 : 0.04, 0.16 + 0.56 * cpuRatio));
          cpuCard.className = 'hw-optical-unit cpu-unit is-working';
          cpuBadge.textContent = cpuInFlight ? L('В работе', 'Working') : L('Завершено', 'Done');
          cpuOp.textContent = liveCpuText;
          setHwTooltipTitle(cpuOp, liveCpuText);
          cpuFill.style.setProperty('--hw-fill', workCpuFill.toFixed(3));
          syncHwB4Unit('cpu', workCpuFill, 'working');
        } else {
          const batchStat = totalBatches > 0 ? (L(' · батчей: ', ' · batches: ') + totalBatches) : '';
          const rerankStat = lastRerankMs > 0 ? (' · rerank ' + lastRerankMs + L(' мс', ' ms')) : '';
          const standbyCpuFill = threadFrac > 0 ? Math.max(0.04, threadFrac) : 0;
          cpuCard.className = 'hw-optical-unit cpu-unit is-standby';
          cpuBadge.textContent = L('В фоне', 'Standby');
          cpuOp.textContent = (!cpuPoolOn
            ? L('Пул потоков выкл · активен быстрый индекс', 'Thread pool off · fast index active')
            : L('Дежурит в пуле · внутренних задач сейчас нет', 'Standing by in pool · no background tasks')) + batchStat + rerankStat;
          setHwTooltipTitle(cpuOp, cpuOp.textContent);
          cpuFill.style.setProperty('--hw-fill', standbyCpuFill > 0 ? standbyCpuFill.toFixed(3) : '0');
          syncHwB4Unit('cpu', standbyCpuFill > 0 ? standbyCpuFill : 0.02, 'standby');
        }
        setHwTooltipTitle(cpuCard, cpuBadge.textContent + ' · ' + cpuOp.textContent);
      }

      ensureHwB4Loop();
    }

    function scrollToGpuRamCard() {
      const card = document.getElementById('gpuRamCard');
      if (!card) return;
      if (document.body && document.body.getAttribute('data-panel-view') === 'full' && typeof setPanelFullTab === 'function') {
        const curTab = document.body.getAttribute('data-full-tab') || 'cockpit';
        if (curTab !== 'hardware') {
          setPanelFullTab('hardware', { silent: true, skipAutoExpand: true });
        }
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
        flashStatus(L('Лимит ' + capGb + ' ГБ: подходящая модель не скачана — нажмите «Каскад моделей»', capGb + ' GB cap: no fitting model downloaded — click "Model Cascade"'));
      } else {
        const pairTxt = currentState && currentState.gpuChatModel
          ? (' · ' + currentState.gpuChatModel + ' + ' + (currentState.gpuEmbedModel || 'qwen3-embedding:0.6b'))
          : '';
        flashStatus(L('Лимит VRAM: ', 'VRAM limit: ') + capGb + L(' ГБ', ' GB') + pairTxt + ' ✓');
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
        flashStatus(L('Ошибка: gpuEndpoint разрешён только для localhost/127.0.0.1!', 'Error: gpuEndpoint is only allowed for localhost/127.0.0.1!'));
        return;
      }
      const chatInput = document.getElementById('inp-gpuChatModel');
      const embedInput = document.getElementById('inp-gpuEmbedModel');
      const patch = {
        gpuChatModel: String((chatInput && chatInput.value) || (currentState && currentState.gpuChatModel) || 'gemma4:12b').trim(),
        gpuEmbedModel: String((embedInput && embedInput.value) || (currentState && currentState.gpuEmbedModel) || 'qwen3-embedding:0.6b').trim(),
        gpuKeepAlive: String((document.getElementById('inp-gpuKeepAlive') || {}).value || '15m').trim(),
        gpuEmbedKeepAlive: String((document.getElementById('inp-gpuEmbedKeepAlive') || {}).value || '90m').trim(),
        gpuContextTokens: Number((document.getElementById('inp-gpuContextTokens') || {}).value || 4096),
        gpuOllamaDir: String((document.getElementById('inp-gpuOllamaDir') || {}).value || '').trim(),
        gpuModelsDir: String((document.getElementById('inp-gpuModelsDir') || {}).value || '').trim(),
      };
      if (ep) patch.gpuEndpoint = ep;
      if (typeof clearExpertGpuInputsDirty === 'function') clearExpertGpuInputsDirty();
      const saved = await updateState(patch);
      if (saved) {
        flashStatus(L('Параметры Ollama и RAM сохранены ✓', 'Ollama & RAM settings saved ✓'));
      }
    }

    async function runGpuPanelAction(action) {
      const msgMap = {
        warm: L('Индексация проекта в векторный поиск на GPU...', 'Indexing workspace for GPU semantic search...'),
        unload: L('Выгрузка нейросетей из видеопамяти...', 'Unloading models from GPU VRAM...'),
        test_distill: L('Тестовое сжатие лога на локальной GPU...', 'Testing log distillation on local GPU...'),
      };
      try {
        flashStatus(msgMap[action] || L('Выполнение GPU-операции...', 'Running GPU operation...'));
        const res = await panelFetch('/api/gpu', {
          method: 'POST',
          body: JSON.stringify({ action: action }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok !== false && !data.error) {
          if (action === 'test_distill') {
            flashStatus(L('GPU-тест OK (', 'GPU test OK (') + (data.latencyMs || 0) + L(' мс) ✓', ' ms) ✓'));
          } else if (action === 'unload') {
            flashStatus(L('VRAM освобождена ✓', 'VRAM freed ✓'));
          } else {
            flashStatus(L('Проиндексировано: ', 'Indexed: ') + (data.totalFiles || 0) + L(' файлов ✓', ' files ✓'));
          }
          await refreshAll();
        } else {
          flashStatus('GPU: ' + (data && data.error ? data.error : L('ошибка', 'error')));
        }
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка обращения к локальной GPU!', 'Error contacting local GPU!'));
      }
    }

    async function backupProfile() {
      try {
        flashStatus(L('Сохранение слепка профиля...', 'Saving profile backup...'));
        const res = await panelFetch('/api/profile-backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'backup' })
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok && !result.error) {
          flashStatus(L('Слепок сохранён ✓ (', 'Backup saved ✓ (') + result.keysSaved + L(' настроек)', ' settings)'));
        } else {
          flashStatus(L('Ошибка: ', 'Error: ') + (result ? (result.error || L('сбой бэкапа', 'backup failed')) : L('сбой', 'failed')));
        }
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка сохранения слепка!', 'Error saving backup!'));
      }
    }

    async function restoreProfile() {
      try {
        flashStatus(L('Восстановление профиля...', 'Restoring profile...'));
        const res = await panelFetch('/api/profile-backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restore' })
        });
        const result = await res.json();
        if (res && res.ok && result && result.ok && !result.error) {
          flashStatus(L('Профиль восстановлен ✓ (', 'Profile restored ✓ (') + result.restoredKeys + L(' настроек)', ' settings)'));
          await refreshAll();
        } else {
          flashStatus(L('Ошибка: ', 'Error: ') + (result ? (result.error || L('слепок не найден', 'backup not found')) : L('сбой', 'failed')));
        }
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка восстановления профиля!', 'Error restoring profile!'));
      }
    }

    async function autoCalibrateHardware() {
      try {
        flashStatus(L('Сканирование железа ПК и авто-калибровка лимитов...', 'Scanning PC hardware and auto-calibrating limits...'));
        const res = await panelFetch('/api/hardware', {
          method: 'POST',
          body: JSON.stringify({ action: 'auto_apply', subscriptionTier: currentState.subscriptionTier || 'pro' }),
        });
        const data = await res.json();
        if (res && res.ok && data && data.ok && !data.error) {
          if (data.hardwareProfile) currentHardwareProfile = data.hardwareProfile;
          await refreshAll();
          flashStatus(L('Лимиты CPU / RAM / GPU адаптированы под ваш ПК ✓', 'CPU / RAM / GPU limits calibrated for your PC ✓'));
        } else {
          flashStatus(L('Ошибка калибровки: ', 'Calibration error: ') + (data && data.error ? data.error : L('сбой', 'failed')));
        }
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка обращения к сканеру железа!', 'Error accessing hardware profiler!'));
      }
    }

    let _openCustomSelectId = '';
    let _openCustomSelectFocusIdx = -1;

    function getCustomSelectTrigger(selId) {
      if (!selId || typeof selId !== 'string') return null;
      if (selId.indexOf('sel-') === 0) {
        return document.getElementById('btn-' + selId.slice(4));
      }
      return null;
    }

    function syncCustomSelectTrigger(selId) {
      const sel = document.getElementById(selId);
      const trigger = getCustomSelectTrigger(selId);
      if (!sel || !trigger) return;
      const valEl = trigger.querySelector('.lg-select-trigger-text');
      const selectedOpt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      const labelText = selectedOpt ? String(selectedOpt.textContent || selectedOpt.value || '') : String(sel.value || '');
      if (valEl) valEl.textContent = labelText || L('Выбрать модель', 'Select model');
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
        const rect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : null;
        if (rect && rect.height > 0 && typeof menu.animate === 'function' && !(typeof uiPrefersReducedMotion === 'function' && uiPrefersReducedMotion())) {
          const seq = (menu._lgSelSeq || 0) + 1;
          menu._lgSelSeq = seq;
          const placeTop = menu.getAttribute('data-placement') === 'top';
          try {
            const anim = menu.animate(
              [
                { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
                { opacity: 0, transform: 'translate3d(0,' + (placeTop ? 4 : -4) + 'px,0) scale(0.97)' }
              ],
              { duration: 130, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
            );
            anim.onfinish = function () {
              if (menu._lgSelSeq === seq && !menu.classList.contains('is-open')) {
                menu.hidden = true;
                menu.innerHTML = '';
              }
            };
          } catch {
            menu.hidden = true;
            menu.innerHTML = '';
          }
        } else {
          menu.hidden = true;
          menu.innerHTML = '';
        }
      }
      if (typeof releaseTooltipForClosedMenu === 'function') {
        releaseTooltipForClosedMenu();
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
        emptyEl.textContent = L('Нет доступных моделей', 'No available models');
        menu.appendChild(emptyEl);
      }

      menu._lgSelSeq = (menu._lgSelSeq || 0) + 1;
      menu.classList.remove('is-open');
      menu.hidden = false;
      menu.setAttribute('aria-hidden', 'false');

      const rect = trigger.getBoundingClientRect();
      const maxViewportW = Math.max(180, window.innerWidth - 16);
      const isCompactLimitSel = /vramcap|rambudget|cputhreads/i.test(selId);
      menu.classList.toggle('is-compact-limit', isCompactLimitSel);
      if (menu.style && typeof menu.style.setProperty === 'function') {
        if (isCompactLimitSel && typeof window.getComputedStyle === 'function') {
          const trigFont = window.getComputedStyle(trigger).fontSize;
          if (trigFont) menu.style.setProperty('--compact-sel-font', trigFont);
        } else if (typeof menu.style.removeProperty === 'function') {
          menu.style.removeProperty('--compact-sel-font');
        }
      }
      const desiredW = isCompactLimitSel
        ? Math.min(maxViewportW, Math.max(44, rect.width))
        : Math.min(maxViewportW, Math.max(rect.width, 238));
      const left = isCompactLimitSel
        ? Math.max(4, Math.min(rect.left, window.innerWidth - desiredW - 4))
        : Math.max(8, Math.min(rect.left, window.innerWidth - desiredW - 8));
      menu.style.width = (isCompactLimitSel ? Number(desiredW.toFixed(2)) : Math.round(desiredW)) + 'px';
      menu.style.left = (isCompactLimitSel ? Number(left.toFixed(2)) : Math.round(left)) + 'px';
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
      if (typeof suppressTooltipForOpenMenu === 'function') {
        suppressTooltipForOpenMenu(trigger);
      }
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
        ? (' (~' + (vramFit.selectedChatEstVramMb / 1024).toFixed(1) + L(' ГБ в VRAM)', ' GB in VRAM)'))
        : '';

      if (vramFit.needsModelDownload) {
        titleEl.textContent = L('Нет подходящей модели под лимит ', 'No compatible model for ') + vramFit.capGb + L(' ГБ VRAM', ' GB VRAM limit');
        descEl.textContent = L(
          'Выбранная модель ' + vramFit.selectedChatModel + estGbText +
          ' не помещается в лимит ' + vramFit.capGb + ' ГБ — её загрузка строго заблокирована, сжатие переведено на CPU. ' +
          'Скачайте компактную модель (например, ' + vramFit.recommendedPullModel + ').',
          'Selected model ' + vramFit.selectedChatModel + estGbText +
          ' exceeds the ' + vramFit.capGb + ' GB limit — loading is blocked and distillation switched to CPU. ' +
          'Download a compact model (e.g. ' + vramFit.recommendedPullModel + ').'
        );
        if (fallbackBtn) fallbackBtn.style.display = 'none';
        if (promptBtn) promptBtn.textContent = L('Подобрать в чате', 'Pick in chat');
      } else if (!vramFit.selectedChatFits && vramFit.bestFallbackChatModel) {
        titleEl.textContent = L('Модель ', 'Model ') + vramFit.selectedChatModel + L(' превышает лимит ', ' exceeds ') + vramFit.capGb + L(' ГБ VRAM', ' GB VRAM limit');
        descEl.textContent = L(
          'Модель требует' + (estGbText || (' > ' + vramFit.capGb + ' ГБ')) +
          '. Для работы в пределах лимита переключитесь на скачанную ' + vramFit.bestFallbackChatModel + '.',
          'Model requires' + (estGbText || (' > ' + vramFit.capGb + ' GB')) +
          '. To stay within budget, switch to downloaded ' + vramFit.bestFallbackChatModel + '.'
        );
        if (fallbackBtn) {
          fallbackBtn.style.display = 'inline-flex';
          fallbackBtn.setAttribute('data-arg', vramFit.bestFallbackChatModel);
          fallbackBtn.textContent = L('Включить ', 'Use ') + vramFit.bestFallbackChatModel;
        }
        if (promptBtn) promptBtn.textContent = L('Подобрать в чате', 'Pick in chat');
      } else if (vramFit.overBudgetLoaded) {
        titleEl.textContent = L('В VRAM занято ', 'VRAM usage is ') + (vramFit.loadedVramMb / 1024).toFixed(1) + L(' ГБ при лимите ', ' GB over ') + vramFit.capGb + L(' ГБ', ' GB cap');
        descEl.textContent = L(
          'В видеопамяти остаётся тяжёлая модель сверх установленного лимита — выгрузите её или подберите более лёгкую модель.',
          'A heavy model remains loaded above your VRAM limit — unload it or select a lighter model.'
        );
        if (fallbackBtn) fallbackBtn.style.display = 'none';
        if (promptBtn) promptBtn.textContent = L('Подобрать в чате', 'Pick in chat');
      }
    }

    let _gpuPullActiveUi = false;
    let _lastClientPullError = null;

    function formatGpuPullStatusText(pullStatus) {
      if (!pullStatus || typeof pullStatus !== 'object') {
        return L('Выполняется загрузка...', 'Downloading...');
      }
      const picked = pickText(pullStatus, 'statusTextRu', 'statusTextEn', '');
      if (picked) return picked;
      const raw = String(pullStatus.statusText || '');
      if (raw === 'All cascade models are already installed ✓') {
        return L('Все модели каскада уже установлены ✓', 'All cascade models are already installed ✓');
      }
      if (raw === 'Все модели каскада уже установлены ✓') {
        return L('Все модели каскада уже установлены ✓', 'All cascade models are already installed ✓');
      }
      return raw || L('Выполняется загрузка...', 'Downloading...');
    }

    function renderGpuCascadePullStatus(pullStatus, gpu, s) {
      const box = document.getElementById('gpuCascadePullBox');
      const titleEl = document.getElementById('gpuCascadePullTitle');
      const trackEl = document.getElementById('gpuCascadePullBarTrack');
      const fillEl = document.getElementById('gpuCascadePullFill');
      const subEl = document.getElementById('gpuCascadePullSub');
      const errItemsEl = document.getElementById('gpuCascadePullErrorItems');
      const actionsEl = document.getElementById('gpuCascadePullActions');
      const cancelBtn = document.getElementById('btnCancelGpuCascadePull');
      const retryHfBtn = document.getElementById('btnRetryGpuCascadeHf');
      const toolbarRow = document.getElementById('gpuCascadeToolbarRow');
      const toolbarBtn = document.getElementById('btnPullCascadeToolbar');
      const toolbarHfBtn = document.getElementById('btnPullCascadeHfToolbar');

      const effectiveStatus = (pullStatus && (pullStatus.active || pullStatus.error || (pullStatus.finishedAt && !pullStatus.dismissed)))
        ? pullStatus
        : (_lastClientPullError || pullStatus);

      const wasActive = _gpuPullActiveUi;
      const isActive = Boolean(effectiveStatus && effectiveStatus.active);
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
          toolbarBtn.textContent = L('⬇️ Докачать каскад (', '⬇️ Pull missing cascade (') + missingCount + (missingGb > 0 ? (' · ~' + missingGb.toFixed(1) + L(' ГБ', ' GB')) : '') + ')';
          setHwTooltipTitle(
            toolbarBtn,
            missingModels.length > 0
              ? (L('Не скачаны модели каскада: ', 'Missing cascade models: ') + missingModels.join(', ') + L(' — нажмите, чтобы скачать в фоне', ' — click to download in background'))
              : L('Скачать недостающие модели каскада под все лимиты вашей видеокарты (с автофоллбэком на Hugging Face)', 'Download missing cascade models for your VRAM limits (with Hugging Face fallback)')
          );
        }
      }
      if (toolbarHfBtn) {
        toolbarHfBtn.disabled = isActive;
      }
      if (!box) return;

      const failedItems = Array.isArray(effectiveStatus && effectiveStatus.items)
        ? effectiveStatus.items.filter(function (it) { return it && it.status === 'error'; })
        : [];
      const hasError = Boolean(effectiveStatus && !effectiveStatus.dismissed && (effectiveStatus.error || failedItems.length > 0));
      const recentlyFinished = Boolean(
        !isActive &&
        effectiveStatus &&
        !effectiveStatus.dismissed &&
        effectiveStatus.finishedAt &&
        (Date.now() - Number(effectiveStatus.finishedAt || 0)) < 12000 &&
        (effectiveStatus.statusText || effectiveStatus.statusTextEn)
      );
      if (!isActive && !hasError && !recentlyFinished) {
        box.style.display = 'none';
        box.classList.remove('is-error');
        return;
      }

      box.style.display = 'flex';
      box.classList.toggle('is-error', Boolean(!isActive && hasError));
      const total = Math.max(1, Number((effectiveStatus && effectiveStatus.totalCount) || 1));
      const done = Math.max(0, Number((effectiveStatus && effectiveStatus.completedCount) || 0));
      const curPct = Math.max(0, Math.min(100, Number((effectiveStatus && effectiveStatus.currentPercent) || 0)));
      const overallPct = isActive
        ? Math.min(99, Math.round(((done + curPct / 100) / total) * 100))
        : (hasError ? Math.round((done / total) * 100) : 100);

      if (titleEl) {
        titleEl.textContent = isActive
          ? (L('↓ Загрузка каскада моделей (', '↓ Downloading model cascade (') + Math.min(done + 1, total) + '/' + total + ')')
          : (hasError ? L('Ошибка скачивания моделей Ollama', 'Ollama model download error') : L('✓ Каскад моделей готов', '✓ Model cascade ready'));
      }
      if (cancelBtn) cancelBtn.style.display = isActive ? 'inline-flex' : 'none';
      if (trackEl) trackEl.style.display = (hasError && !isActive && done === 0) ? 'none' : '';
      if (fillEl) {
        fillEl.style.width = overallPct + '%';
        fillEl.style.setProperty('--fill-scale', (Math.max(0, Math.min(100, Number(overallPct) || 0)) / 100).toFixed(4));
      }
      if (subEl) {
        const srcBadge = effectiveStatus.source === 'huggingface' ? ' [Hugging Face]' : (effectiveStatus.source === 'ollama' ? ' [Ollama]' : '');
        const stText = formatGpuPullStatusText(effectiveStatus);
        subEl.textContent = stText + srcBadge + (effectiveStatus.error && !isActive && failedItems.length === 0 ? (' · ' + effectiveStatus.error) : '');
      }
      if (errItemsEl) {
        if (!isActive && hasError && failedItems.length > 0) {
          errItemsEl.style.display = 'flex';
          errItemsEl.innerHTML = failedItems.map(function (it) {
            const hfHint = it.hfAvailable === false
              ? L(' [нет GGUF-зеркала HF]', ' [no HF GGUF mirror]')
              : L(' [доступно HF-зеркало]', ' [HF mirror available]');
            return '<div>• <strong>' + escapeHtml(it.name) + '</strong>: ' + escapeHtml(it.error || L('сбой загрузки', 'download error')) + '<span style="opacity:0.78;">' + escapeHtml(hfHint) + '</span></div>';
          }).join('');
        } else if (!isActive && hasError && effectiveStatus.error) {
          errItemsEl.style.display = 'flex';
          errItemsEl.innerHTML = '<div>• ' + escapeHtml(effectiveStatus.error) + '</div>';
        } else {
          errItemsEl.style.display = 'none';
          errItemsEl.innerHTML = '';
        }
      }
      if (actionsEl) {
        actionsEl.style.display = (!isActive && hasError) ? 'flex' : 'none';
      }
      if (retryHfBtn) {
        const anyHf = failedItems.length === 0 || failedItems.some(function (it) { return it.hfAvailable !== false; });
        retryHfBtn.style.display = anyHf ? 'inline-flex' : 'none';
      }
    }

    async function startGpuCascadePull(mode, selectedCapMb, mirrorMode) {
      try {
        _lastClientPullError = null;
        const pullMode = mode === 'active_only' ? 'active_only' : 'cascade';
        const effectiveMirror = mirrorMode === 'huggingface' || mirrorMode === 'auto'
          ? mirrorMode
          : ((currentState && currentState.gpuPreferHfMirror) ? 'huggingface' : 'auto');
        flashStatus(effectiveMirror === 'huggingface'
          ? L('Запуск загрузки моделей через зеркало Hugging Face...', 'Starting model download via Hugging Face mirror...')
          : L('Запуск загрузки каскада моделей...', 'Starting model cascade download...'));
        const res = await panelFetch('/api/gpu', {
          method: 'POST',
          body: JSON.stringify({
            action: 'pull_cascade',
            mode: pullMode,
            mirrorMode: effectiveMirror,
            selectedCapMb: Number(selectedCapMb || (currentState && currentState.gpuMaxVramMb) || 4096),
          }),
        });
        const data = await res.json();
        if (data && data.ok) {
          renderGpuCascadePullStatus(data.pullStatus, data.gpu, currentState);
          if (data.pullStatus && data.pullStatus.active) {
            flashStatus(L('Каскад моделей качается в фоне...', 'Model cascade downloading in background...'));
            scheduleTelemetryPoll();
          } else if (data.pullStatus && (data.pullStatus.statusText || data.pullStatus.statusTextRu || data.pullStatus.statusTextEn)) {
            flashStatus(formatGpuPullStatusText(data.pullStatus));
          }
        } else {
          const errMsg = (data && data.error) ? data.error : L('неизвестная ошибка', 'unknown error');
          _lastClientPullError = {
            active: false,
            error: errMsg,
            dismissed: false,
            finishedAt: Date.now(),
            totalCount: 1,
            completedCount: 0,
            source: effectiveMirror === 'huggingface' ? 'huggingface' : 'ollama',
            statusTextRu: errMsg,
            statusTextEn: errMsg,
            items: [],
          };
          renderGpuCascadePullStatus(_lastClientPullError, data && data.gpu, currentState);
          if (data && data.code === 'OLLAMA_NOT_INSTALLED') {
            renderGpuOllamaInstallStatus(null, data.gpu, currentState);
          }
          flashStatus(L('Ошибка запуска загрузки: ', 'Download start failed: ') + errMsg);
        }
      } catch (e) {
        const connMsg = L('Ошибка связи с сервером панели при запуске загрузки', 'Panel server connection error starting model download');
        _lastClientPullError = {
          active: false,
          error: connMsg,
          dismissed: false,
          finishedAt: Date.now(),
          totalCount: 1,
          completedCount: 0,
          statusTextRu: connMsg,
          statusTextEn: connMsg,
          items: [],
        };
        renderGpuCascadePullStatus(_lastClientPullError);
        flashStatus(L('Ошибка связи с сервером панели', 'Panel server connection error'));
      }
    }

    function startGpuCascadePullHf() {
      return startGpuCascadePull('cascade', (currentState && currentState.gpuMaxVramMb) || 4096, 'huggingface');
    }

    async function dismissGpuPullError() {
      _lastClientPullError = null;
      try {
        const res = await panelFetch('/api/gpu', {
          method: 'POST',
          body: JSON.stringify({ action: 'pull_dismiss_error' }),
        });
        const data = await res.json();
        renderGpuCascadePullStatus(data && data.pullStatus ? data.pullStatus : { active: false, dismissed: true, items: [] });
      } catch {
        const box = document.getElementById('gpuCascadePullBox');
        if (box) {
          box.style.display = 'none';
          box.classList.remove('is-error');
        }
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
          flashStatus(L('Загрузка каскада отменена', 'Cascade download cancelled'));
        }
      } catch {}
    }

    let _gpuInstallActiveUi = false;

    function renderGpuOllamaInstallStatus(installStatus, gpu, s) {
      const box = document.getElementById('gpuOllamaInstallBox');
      if (!box) return;
      const titleEl = document.getElementById('gpuOllamaInstallTitle');
      const subEl = document.getElementById('gpuOllamaInstallSub');
      const dirEl = document.getElementById('gpuOllamaInstallDirHint');
      const trackEl = document.getElementById('gpuOllamaInstallBarTrack');
      const fillEl = document.getElementById('gpuOllamaInstallFill');
      const instBtn = document.getElementById('btnInstallOllamaPanel');
      const pickBtn = document.getElementById('btnPickOllamaFolderPanel');
      const dismissBtn = document.getElementById('btnDismissOllamaInstall');
      const actionsEl = document.getElementById('gpuOllamaInstallActions');

      const st = s || currentState || {};
      const gpuSnap = gpu || (lastPayloadCache && lastPayloadCache.gpu) || null;
      const oll = (gpuSnap && gpuSnap.ollama) || {};
      const inst = (installStatus && typeof installStatus === 'object') ? installStatus : null;

      const isActive = Boolean(inst && inst.active);
      const wasActive = _gpuInstallActiveUi;
      _gpuInstallActiveUi = isActive;
      if (wasActive && !isActive) {
        setTimeout(function () { refreshAll(); }, 300);
      }

      const hasErr = Boolean(!isActive && inst && inst.phase === 'error' && inst.error && !inst.dismissed);
      const recentlyDone = Boolean(
        !isActive &&
        inst &&
        inst.phase === 'done' &&
        !inst.dismissed &&
        inst.finishedAt &&
        (Date.now() - Number(inst.finishedAt || 0)) < 12000
      );
      const gpuOn = Boolean(st && st.gpuEnabled);
      const needsInstallPrompt = Boolean(gpuOn && !isActive && !hasErr && !recentlyDone && !oll.installed && !oll.running);

      if (!isActive && !hasErr && !recentlyDone && !needsInstallPrompt) {
        box.style.display = 'none';
        box.classList.remove('is-installing', 'is-error');
        return;
      }

      box.style.display = 'flex';
      box.classList.toggle('is-installing', isActive);
      box.classList.toggle('is-error', hasErr);

      const curInstallDir = String((inst && inst.installDir) || st.gpuOllamaDir || '').trim();
      const curModelsDir = String((inst && inst.modelsDir) || st.gpuModelsDir || '').trim();

      if (titleEl) {
        if (isActive) {
          titleEl.textContent = L('Установка Ollama...', 'Installing Ollama...');
        } else if (hasErr) {
          titleEl.textContent = L('Ошибка установки Ollama', 'Ollama setup error');
        } else if (recentlyDone) {
          titleEl.textContent = L('✓ Ollama готова к работе', '✓ Ollama ready');
        } else {
          titleEl.textContent = L('Ollama не найдена в системе', 'Ollama not detected');
        }
      }

      if (trackEl) trackEl.style.display = isActive ? 'block' : 'none';
      if (fillEl) {
        const instPct = inst ? Math.max(0, Math.min(100, Number(inst.percent || 0))) : 0;
        fillEl.style.width = instPct + '%';
        fillEl.style.setProperty('--fill-scale', (instPct / 100).toFixed(4));
      }

      if (subEl) {
        if (isActive || hasErr || recentlyDone) {
          subEl.textContent = pickText(inst, 'statusTextRu', 'statusTextEn', inst.statusText || inst.error || '');
        } else {
          subEl.textContent = L(
            'Нажмите «Установить Ollama», чтобы скачать и развернуть её в выбранную папку, либо выберите папку вручную.',
            'Click "Install Ollama" to download and install into your chosen folder, or pick a folder first.'
          );
        }
      }

      if (dirEl) {
        if (curInstallDir || curModelsDir) {
          dirEl.style.display = 'block';
          const parts = [];
          if (curInstallDir) parts.push(L('Программа: ', 'App: ') + curInstallDir);
          if (curModelsDir) parts.push(L('Модели: ', 'Models: ') + curModelsDir);
          dirEl.textContent = parts.join(' · ');
        } else {
          dirEl.style.display = 'none';
          dirEl.textContent = '';
        }
      }

      if (dismissBtn) dismissBtn.style.display = (!isActive && (hasErr || recentlyDone)) ? 'inline-flex' : 'none';
      if (actionsEl) actionsEl.style.display = recentlyDone ? 'none' : 'flex';
      if (instBtn) {
        instBtn.disabled = isActive;
        instBtn.textContent = hasErr ? L('↻ Повторить установку', '↻ Retry install') : L('⬇️ Установить Ollama', '⬇️ Install Ollama');
      }
      if (pickBtn) pickBtn.disabled = isActive;
    }

    async function startOllamaInstall(opts) {
      const o = (opts && typeof opts === 'object') ? opts : {};
      try {
        flashStatus(L('Запуск загрузки и установки Ollama...', 'Starting Ollama download and setup...'));
        const res = await panelFetch('/api/gpu', {
          method: 'POST',
          body: JSON.stringify({
            action: 'install_ollama',
            installDir: String(o.installDir !== undefined ? o.installDir : ((currentState && currentState.gpuOllamaDir) || '')).trim(),
            modelsDir: String(o.modelsDir !== undefined ? o.modelsDir : ((currentState && currentState.gpuModelsDir) || '')).trim(),
            pullModeAfter: o.pullModeAfter || '',
            selectedCapMb: Number(o.selectedCapMb || (currentState && currentState.gpuMaxVramMb) || 4096),
            mirrorMode: o.mirrorMode || ((currentState && currentState.gpuPreferHfMirror) ? 'huggingface' : 'auto'),
          }),
        });
        const data = await res.json();
        if (data && data.state) currentState = data.state;
        renderGpuOllamaInstallStatus(data && data.installStatus ? data.installStatus : null, data && data.gpu, currentState);
        if (data && data.ok) {
          scheduleTelemetryPoll();
        } else {
          flashStatus(L('Установка Ollama: ', 'Ollama install: ') + ((data && data.error) || L('ошибка', 'failed')));
        }
      } catch {
        flashStatus(L('Ошибка связи при запуске установки Ollama', 'Connection error starting Ollama install'));
      }
    }

    function installOllamaFromPanel() {
      return startOllamaInstall({
        installDir: (currentState && currentState.gpuOllamaDir) || '',
        modelsDir: (currentState && currentState.gpuModelsDir) || '',
        pullModeAfter: 'cascade',
        selectedCapMb: (currentState && currentState.gpuMaxVramMb) || 4096,
      });
    }

    async function dismissOllamaInstallStatus() {
      try {
        const res = await panelFetch('/api/gpu', {
          method: 'POST',
          body: JSON.stringify({ action: 'install_dismiss' }),
        });
        const data = await res.json();
        renderGpuOllamaInstallStatus(data && data.installStatus ? data.installStatus : { active: false, phase: 'idle', dismissed: true });
      } catch {
        const box = document.getElementById('gpuOllamaInstallBox');
        if (box) box.style.display = 'none';
      }
    }

    async function pickGpuFolder(mode) {
      const cleanMode = mode === 'models' ? 'models' : 'ollama';
      const inpId = cleanMode === 'models' ? 'inp-gpuModelsDir' : 'inp-gpuOllamaDir';
      const inpEl = document.getElementById(inpId);
      const initDir = (inpEl && inpEl.value ? inpEl.value.trim() : '') ||
        (cleanMode === 'models' ? (currentState && currentState.gpuModelsDir) : (currentState && currentState.gpuOllamaDir)) ||
        '';
      try {
        flashStatus(L('Открываем выбор папки…', 'Opening folder picker…'));
        const res = await panelFetch('/api/gpu/pick-folder', {
          method: 'POST',
          body: JSON.stringify({ mode: cleanMode, initialDir: initDir }),
        });
        const data = await res.json();
        if (!data || !data.ok) {
          flashStatus((data && data.error) || L('Не удалось выбрать папку', 'Failed to pick folder'));
          return;
        }
        const chosen = data.dir || data.workspaceRoot || '';
        if (data.cancelled || !chosen) return;
        const patch = {};
        if (cleanMode === 'models') {
          patch.gpuModelsDir = chosen;
          const mInp = document.getElementById('inp-gpuModelsDir');
          if (mInp) {
            mInp.value = chosen;
            mInp.removeAttribute('data-dirty');
          }
        } else {
          patch.gpuOllamaDir = chosen;
          const oInp = document.getElementById('inp-gpuOllamaDir');
          if (oInp) {
            oInp.value = chosen;
            oInp.removeAttribute('data-dirty');
          }
          const modelsInp = document.getElementById('inp-gpuModelsDir');
          const curModels = String((modelsInp && modelsInp.value) || (currentState && currentState.gpuModelsDir) || '').trim();
          const sep = chosen.indexOf('/') !== -1 && chosen.indexOf('\\') === -1 ? '/' : '\\';
          const derivedModels = chosen.replace(/[\\/]+$/, '') + sep + 'models';
          if (!curModels || curModels.toLowerCase().endsWith('\\models') || curModels.toLowerCase().endsWith('/models')) {
            patch.gpuModelsDir = derivedModels;
            if (modelsInp) {
              modelsInp.value = derivedModels;
              modelsInp.removeAttribute('data-dirty');
            }
          }
        }
        await updateState(patch);
        flashStatus(L('Папка сохранена ✓', 'Folder saved ✓'));
      } catch {
        flashStatus(L('Ошибка выбора папки', 'Folder picker error'));
      }
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
          const sizeText = Number(m.sizeGb) > 0 ? (Number(m.sizeGb).toFixed(1) + L(' ГБ', ' GB')) : '';
          const vramText = vramMb > 0 ? ('VRAM ' + (vramMb / 1024).toFixed(1) + L(' ГБ', ' GB')) : '';
          const parts = [];
          if (sizeText) parts.push(sizeText);
          if (vramMb > 0) parts.push(L('в VRAM ', 'in VRAM ') + (vramMb / 1024).toFixed(1) + L(' ГБ', ' GB'));
          if (checkBudget && chatBudgetMb > 0) {
            const estMb = estimateClientModelVramMb(name, downloaded, loadedMap);
            if (estMb > chatBudgetMb + 128) {
              parts.push('> ' + capGb + L(' ГБ', ' GB'));
            }
          }
          const label = parts.length > 0 ? (name + ' (' + parts.join(' · ') + ')') : name;
          opts.push({ value: name, label: label, sizeText: sizeText, vramText: vramText, missingText: '' });
        });
        if (currentVal && !seen.has(currentVal)) {
          const vramMb = loadedMap.get(currentVal) || 0;
          const vramText = vramMb > 0 ? ('VRAM ' + (vramMb / 1024).toFixed(1) + L(' ГБ', ' GB')) : '';
          const missingText = vramMb <= 0 && oll && oll.running ? L('не скачана', 'not downloaded') : '';
          const estMb = checkBudget && chatBudgetMb > 0 ? estimateClientModelVramMb(currentVal, downloaded, loadedMap) : 0;
          const overTag = estMb > chatBudgetMb + 128 ? (' · > ' + capGb + L(' ГБ', ' GB')) : '';
          const suffix = vramMb > 0
            ? (L(' (в VRAM ', ' (in VRAM ') + (vramMb / 1024).toFixed(1) + L(' ГБ', ' GB') + overTag + ')')
            : (missingText ? (' (' + missingText + overTag + ')') : (overTag ? (' (' + overTag.replace(/^ · /, '') + ')') : ''));
          opts.unshift({ value: currentVal, label: currentVal + suffix, sizeText: '', vramText: vramText, missingText: missingText });
        }
        const sig = getUiLanguage() + '|' + currentVal + '|' + opts.map(function (o) { return o.value + ':' + o.label; }).join(';');
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
        flashStatus(L('Модель GPU выбрана: ', 'GPU model selected: ') + clean + ' ✓');
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

    async function dispatchPromptToChatDetailed(promptText, sentStatus, copiedStatus, newChatStatus, options) {
      const opts = (options && typeof options === 'object') ? options : {};
      const forceNew = Boolean(opts.forceNewConversation);
      const shouldFocusNew = opts.focusNewConversation !== false;
      const customTitle = typeof opts.title === 'string' ? opts.title.trim() : '';
      const explicitRootDir = typeof opts.rootDir === 'string' ? opts.rootDir.trim() : '';
      const directConvId = forceNew
        ? ''
        : ((window.sidecar && window.sidecar.conversationId) || _activeFallbackSidecarConvId || '');
      const wsUris = await getSidecarWorkspaceUrisFast();
      const pinnedWs = (_selectedWorkspaceMode !== '__auto__' && _selectedWorkspaceMode !== '__all__')
        ? _selectedWorkspaceMode
        : '';
      const rootDir = explicitRootDir || pinnedWs || (detectedProjectInfo && detectedProjectInfo.workspaceRoot) || _activeWorkspaceResolved || '';
      let lastErr = '';

      try {
        const apiRes = await panelFetch('/api/chat-send', {
          method: 'POST',
          body: JSON.stringify({
            message: promptText,
            conversationId: directConvId,
            workspaceUris: wsUris,
            rootDir: rootDir,
            title: customTitle,
            allowNewConversation: true,
          }),
        });
        if (apiRes && apiRes.ok) {
          const data = await apiRes.json();
          if (data && data.ok) {
            const targetCid = data.conversationId || directConvId || '';
            if (data.mode === 'new_conversation') {
              if (targetCid && shouldFocusNew) {
                _activeFallbackSidecarConvId = targetCid;
                focusSidecarConversationIfPossible(targetCid);
              }
              const msgNew = newChatStatus || L('Открыт новый чат и отправлен запрос ✓', 'Opened a new chat and sent prompt ✓');
              flashStatus(msgNew);
              return { sent: true, copied: false, mode: 'new_conversation', conversationId: targetCid, statusText: msgNew, queue: data.queue || null };
            }
            const msgSent = sentStatus || L('Запрос отправлен в активный чат ✓', 'Prompt sent to active chat ✓');
            flashStatus(msgSent);
            return { sent: true, copied: false, mode: 'existing_conversation', conversationId: targetCid, statusText: msgSent, queue: data.queue || null };
          }
          if (data && data.error) lastErr = String(data.error);
          if (data && data.dropped) {
            return { sent: false, copied: false, dropped: true, mode: 'dropped', conversationId: '', statusText: lastErr || L('Старая задача сброшена очередью', 'Old queued task dropped'), error: lastErr, queue: data.queue || null };
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
            const msgDirect = sentStatus || L('Запрос отправлен в активный чат ✓', 'Prompt sent to active chat ✓');
            flashStatus(msgDirect);
            return { sent: true, copied: false, mode: 'existing_conversation', conversationId: directConvId, statusText: msgDirect };
          }
          if (typeof window.sidecar.agent.startConversation === 'function') {
            const startRes = await window.sidecar.agent.startConversation(promptText);
            const startedCid = extractSidecarConvIdFromClientPayload(startRes, 0);
            if (startedCid && shouldFocusNew) {
              _activeFallbackSidecarConvId = startedCid;
              focusSidecarConversationIfPossible(startedCid);
            }
            const msgStarted = newChatStatus || L('Открыт новый чат и отправлен запрос ✓', 'Opened a new chat and sent prompt ✓');
            flashStatus(msgStarted);
            return { sent: true, copied: false, mode: 'new_conversation', conversationId: startedCid, statusText: msgStarted };
          }
        } catch (err) {
          console.error(err);
          if (err && err.message) lastErr = String(err.message);
        }
      }

      const copied = await copyTextToClipboardSafe(promptText);
      const errDetail = lastErr ? (' (' + lastErr.slice(0, 120) + ')') : '';
      const fallbackMsg = copied
        ? ((copiedStatus || L('Текст скопирован в буфер — вставьте в чат (Ctrl+V) ✓', 'Copied to clipboard — paste in chat (Ctrl+V) ✓')) + errDetail)
        : (L('Не удалось отправить в чат', 'Failed to send to chat') + (lastErr ? (': ' + lastErr) : L(' — откройте активный чат и повторите', ' — open an active chat and retry')));
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
        flashStatus(L('Подготовка запроса на подбор модели под ', 'Preparing model fit request for ') + capGb + L(' ГБ VRAM...', ' GB VRAM...'));
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
            : L('не обнаружены', 'none detected');
          const curChat = String((currentState && currentState.gpuChatModel) || 'gemma4:12b');
          const curEmbed = String((currentState && currentState.gpuEmbedModel) || 'qwen3-embedding:0.6b');
          const recModel = capMb < 11264 ? 'qwen3:4b' : 'gemma4:12b';
          promptText = isRu()
            ? [
                'Я ограничил лимит видеопамяти до **' + capGb + ' ГБ (' + capMb + ' МБ)**, но среди установленных моделей Ollama (' + installed + ') нет чат-модели, которая помещается в этот лимит вместе с `' + curEmbed + '` (текущая `' + curChat + '` заблокирована).',
                '1. Подбери 2–3 компактные модели Ollama для роли `gpuChatModel` (сжатие логов и кода), которые гарантированно влезут в **' + capGb + ' ГБ VRAM** вместе с `' + curEmbed + '` (например, `' + recModel + '` или аналоги), укажи команды `ollama pull ...`.',
                '2. После моего подтверждения скачай выбранную модель и обнови `gpuChatModel` в `~/.gemini/config/plugins/antigravity-model-router/router-state.json`, не изменяя исходный код плагина.'
              ].join('\n')
            : [
                'I set my GPU VRAM cap to **' + capGb + ' GB (' + capMb + ' MB)**, but none of the installed Ollama models (' + installed + ') fit within this cap alongside `' + curEmbed + '` (current `' + curChat + '` is blocked).',
                '1. Recommend 2–3 compact Ollama models for `gpuChatModel` (log distillation and code analysis) that fit safely into **' + capGb + ' GB VRAM** together with `' + curEmbed + '` (e.g. `' + recModel + '` or equivalents), and provide `ollama pull ...` commands.',
                '2. After my confirmation, pull the chosen model and update `gpuChatModel` in `~/.gemini/config/plugins/antigravity-model-router/router-state.json` without modifying plugin source code.'
              ].join('\n');
        }
        if (data && data.hardwareProfile) {
          currentHardwareProfile = data.hardwareProfile;
        }
        await dispatchPromptToChatOrClipboard(
          promptText,
          L('Запрос на подбор модели под ' + capGb + ' ГБ отправлен в активный чат ✓', 'Model fit request for ' + capGb + ' GB sent to active chat ✓'),
          L('Активный чат недоступен — запрос подбора модели скопирован в буфер ✓', 'Active chat unavailable — model fit prompt copied to clipboard ✓')
        );
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка подготовки запроса подбора модели', 'Error preparing model fit prompt'));
      }
    }

    async function prepareModelSearchPrompt() {
      try {
        flashStatus(L('Сбор списка моделей Ollama и параметров GPU...', 'Collecting Ollama models and GPU specs...'));
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
          flashStatus(L('Не удалось сформировать задание поиска моделей', 'Failed to prepare model search prompt'));
          return;
        }
        if (data.hardwareProfile) {
          currentHardwareProfile = data.hardwareProfile;
        }
        await dispatchPromptToChatOrClipboard(
          data.promptText,
          L('Запрос на поиск актуальных моделей отправлен в активный чат ✓', 'Model search request sent to active chat ✓'),
          L('Активный чат недоступен — запрос скопирован в буфер, вставьте его в чат ✓', 'Active chat unavailable — prompt copied to clipboard ✓')
        );
      } catch (err) {
        console.error(err);
        flashStatus(L('Ошибка подготовки поиска моделей', 'Error preparing model search'));
      }
    }

    async function sendHardwareTunePrompt() {
      try {
        flashStatus(L('Сборка паспорта системы для ИИ-оптимизации...', 'Building hardware passport for AI tuning...'));
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
          flashStatus(L('Не удалось сформировать промпт диагностики', 'Failed to generate diagnostic prompt'));
          return;
        }
        if (data.hardwareProfile) {
          currentHardwareProfile = data.hardwareProfile;
        }
        const modal = document.getElementById('onboardingWizardModal');
        const insideWizard = Boolean(modal && modal.classList.contains('visible'));
        await dispatchPromptToChatOrClipboard(
          data.promptText,
          insideWizard
            ? L('Паспорт ПК отправлен в чат ✓ — можно продолжить настройку', 'PC hardware passport sent to chat ✓ — continue setup below')
            : L('Паспорт ПК отправлен в активный чат для ИИ-оптимизации ✓', 'PC hardware passport sent to active chat ✓'),
          L('Промпт скопирован в буфер! Откройте новый чат и нажмите Вставить ✓', 'Prompt copied to clipboard! Open a new chat and paste ✓')
        );
      } catch (err) {
        console.error(err);
        flashStatus(L('Сбой отправки промпта диагностики', 'Failed to send diagnostic prompt'));
      }
    }

