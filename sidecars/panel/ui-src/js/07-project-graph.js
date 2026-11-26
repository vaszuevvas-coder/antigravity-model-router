    // =========================================================================
    // 07. INTERACTIVE PROJECT GRAPH (OBSIDIAN GRAPH + SPLIT INSPECTOR)
    // =========================================================================
    const PG_CLUSTER_PALETTE_DARK = [
      '#f04848', '#3fb950', '#e09f3e', '#d4a373',
      '#e07a5f', '#9ca3af', '#84a98c', '#c98a5b',
      '#7c8696', '#b56576'
    ];

    const pgState = {
      open: false,
      loading: false,
      mode: 'global', // 'global' | 'local'
      viewLevel: 'folders', // 'folders' | 'files'
      layoutMode: 'layered', // 'layered' | 'force'
      showHulls: true,
      drillFolder: '',
      focusFile: '',
      depth: 2,
      includeTests: false,
      includeDocs: true,
      showLabels: true,
      searchQuery: '',
      activeClusterId: '',
      inspectorTab: 'blast', // 'blast' | 'imports' | 'overview' | 'files'
      selectedNodeId: '',
      hoveredNodeId: '',
      rawGraphData: null,
      graphData: null,
      nodes: [],
      nodeById: new Map(),
      edges: [],
      inNeighbors: new Map(),
      outNeighbors: new Map(),
      clusterColors: new Map(),
      layeredColumns: [],
      activeLayerTier: null,
      hoveredLayerTier: null,
      layerHeaderRects: [],
      dragLayerTier: null,
      dragLayerOrigin: null,
      alpha: 0,
      rafId: 0,
      width: 0,
      height: 0,
      dpr: 1,
      camX: 0,
      camY: 0,
      camScale: 1,
      dragMode: '', // '' | 'pan' | 'node'
      dragNode: null,
      dragMoved: false,
      lastClientX: 0,
      lastClientY: 0,
      resizeObserver: null,
      bound: false,
      fetchSeq: 0,
      lens: 'arch', // 'arch' | 'blast' | 'cycles' | 'path'
      blastUseGitDiff: false,
      blastWaveMap: new Map(),
      blastFileWaveMap: new Map(),
      blastByHop: { 0: [], 1: [], 2: [], 3: [] },
      blastAffectedTests: [],
      blastEstTokens: 0,
      gitDiffFiles: [],
      gitDiffSet: new Set(),
      gitDiffAvailable: true,
      gitDiffLoaded: false,
      gitDiffLoading: false,
      cycles: [],
      cycleNodeSet: new Set(),
      cycleEdgeSet: new Set(),
      macroCycleNodeSet: new Set(),
      macroCycleEdgeSet: new Set(),
      activeCycleIdx: -1,
      activeCycleNodeSet: new Set(),
      activeCycleEdgeSet: new Set(),
      orphanSet: new Set(),
      pathFrom: '',
      pathTo: '',
      pathResult: null,
      pathLoading: false,
      pathFileSequence: [],
      pathNodeSet: new Set(),
      pathEdgeSet: new Set(),
      contextCart: new Set(),
      edgeBundling: true,
      showMinimap: true,
      minimapRect: null,
      symbolFile: '',
      symbolGraphData: null,
      symbolLoading: false,
      symbolReturnLevel: 'files',
      churnDays: 90,
      churnLoaded: false,
      churnLoading: false,
      churnSeq: 0,
      churnAvailable: true,
      churnMax: 0,
      churnByFile: {},
      hotspotScoreMap: new Map(),
      hotspotRankList: [],
      semanticSearchEnabled: false,
      semanticLoading: false,
      semanticMode: '',
      semanticQuery: '',
      semanticScores: new Map(),
      semanticTimer: 0,
      semanticSeq: 0,
      maxNodes: 220,
      renderMode: 'auto', // 'auto' | 'webgl2' | '2d'
      webglActive: false,
      spatialTree: null,
      workspaceRoot: '',
      knownWorkspaces: [],
      autoWorkspace: '',
      workspacesLoaded: false,
      workspacesSeq: 0,
      activePointerId: null,
      dragOriginPos: null,
      undoStack: [],
      redoStack: [],
      aiMenuOpen: false,
      aiBoxOpen: false,
      aiBusy: false,
      aiReqSeq: 0,
      aiNodeId: '',
      aiHistory: [],
      aiLastPrompt: '',
      aiAbortCtrl: null,
      aiRequestId: '',
      aiStartedAt: 0,
      aiElapsedTimer: 0,
      aiSpotlightMap: new Map(),
      aiCalloutOpen: false,
      aiCalloutNodeId: '',
      aiCalloutData: null
    };

    const PG_RECENT_WORKSPACES_STORAGE_KEY = 'ag_tunnel_pg_recent_workspaces_v1';

    function pgNormWsKey(p) {
      if (typeof normalizeWsClientKey === 'function') return normalizeWsClientKey(p);
      return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    function pgWsBasename(p) {
      if (typeof getWorkspaceBasename === 'function') return getWorkspaceBasename(p);
      const clean = String(p || '').trim().replace(/[\\/]+$/, '');
      if (!clean) return '';
      const parts = clean.split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : clean;
    }

    function pgLoadRecentWorkspaces() {
      try {
        if (typeof localStorage === 'undefined' || !localStorage || typeof localStorage.getItem !== 'function') return [];
        const raw = localStorage.getItem(PG_RECENT_WORKSPACES_STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter(function (s) { return typeof s === 'string' && s.trim(); }).slice(0, 12);
      } catch {
        return [];
      }
    }

    function pgSaveRecentWorkspace(wsPath) {
      const clean = String(wsPath || '').trim();
      if (!clean) return;
      try {
        if (typeof localStorage === 'undefined' || !localStorage || typeof localStorage.setItem !== 'function') return;
        const key = pgNormWsKey(clean);
        const prev = pgLoadRecentWorkspaces();
        const next = [clean];
        for (let i = 0; i < prev.length && next.length < 12; i++) {
          if (pgNormWsKey(prev[i]) !== key) next.push(prev[i]);
        }
        localStorage.setItem(PG_RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(next));
      } catch {}
    }

    function pgGetEffectiveWorkspaceRoot() {
      return String(pgState.workspaceRoot || '').trim();
    }

    function pgAppendWorkspaceParam(params) {
      if (!params || typeof params.set !== 'function') return params;
      const ws = pgGetEffectiveWorkspaceRoot();
      if (ws) {
        params.set('rootDir', ws);
      }
      return params;
    }

    function pgSyncStandaloneUrlParam(wsRoot) {
      if (!pgIsStandaloneView()) return;
      try {
        if (typeof window === 'undefined' || !window.location || !window.history || typeof window.history.replaceState !== 'function') return;
        const qs = new URLSearchParams(window.location.search || '');
        if (wsRoot) {
          qs.set('rootDir', wsRoot);
        } else {
          qs.delete('rootDir');
        }
        const qStr = qs.toString();
        const pathname = typeof window.location.pathname === 'string' && window.location.pathname ? window.location.pathname : '/';
        const hash = typeof window.location.hash === 'string' ? window.location.hash : '';
        window.history.replaceState(null, '', pathname + (qStr ? '?' + qStr : '') + hash);
      } catch {}
    }

    function pgPrefersReducedMotion() {
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch {
        return false;
      }
    }

    function pgGetClusterPalette() {
      return PG_CLUSTER_PALETTE_DARK;
    }

    function pgGetClusterColor(clusterId) {
      if (!clusterId) return pgGetClusterPalette()[0];
      let idx = pgState.clusterColors.get(clusterId);
      if (idx === undefined) {
        idx = pgState.clusterColors.size;
        pgState.clusterColors.set(clusterId, idx);
      }
      const pal = pgGetClusterPalette();
      return pal[idx % pal.length];
    }

    function pgSyncCanvasSize() {
      const stage = document.getElementById('pgCanvasStage');
      const canvas = document.getElementById('projectGraphCanvas');
      if (!stage || !canvas) return false;
      const rect = stage.getBoundingClientRect();
      const w = Math.max(220, Math.floor(rect.width));
      const h = Math.max(180, Math.floor(rect.height));
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      if (pgState.width === w && pgState.height === h && pgState.dpr === dpr) return false;
      pgState.width = w;
      pgState.height = h;
      pgState.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      const glCanvas = document.getElementById('projectGraphWebglCanvas');
      if (glCanvas) {
        glCanvas.width = Math.round(w * dpr);
        glCanvas.height = Math.round(h * dpr);
        glCanvas.style.width = w + 'px';
        glCanvas.style.height = h + 'px';
      }
      return true;
    }

    function pgStopLoop() {
      if (pgState.rafId) {
        cancelAnimationFrame(pgState.rafId);
        pgState.rafId = 0;
      }
    }

    function pgHasActivePulses() {
      const hasHoveredOrSelected = Boolean(pgState.hoveredNodeId || pgState.selectedNodeId);
      const hasLensPulse = Boolean(
        (pgState.lens === 'cycles' && Array.isArray(pgState.cycles) && pgState.cycles.length > 0) ||
        (pgState.lens === 'path' && pgState.pathEdgeSet && pgState.pathEdgeSet.size > 0) ||
        (pgState.lens === 'blast' && pgState.blastWaveMap && pgState.blastWaveMap.size > 1) ||
        (pgState.lens === 'hotspots' && Array.isArray(pgState.hotspotRankList) && pgState.hotspotRankList.length > 0) ||
        (pgState.semanticSearchEnabled && pgState.semanticScores && pgState.semanticScores.size > 0)
      );
      return Boolean(
        pgState.open &&
        !pgPrefersReducedMotion() &&
        (typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
        (hasHoveredOrSelected || hasLensPulse) &&
        pgState.edges.length > 0
      );
    }

    function pgStartLoop(alphaBoost) {
      if (!pgState.open) return;
      if (pgState.layoutMode === 'layered') {
        pgState.alpha = 0;
        pgDrawGraph();
        if (pgHasActivePulses() && !pgState.rafId) {
          pgState.rafId = requestAnimationFrame(pgTickFrame);
        } else if (!pgHasActivePulses()) {
          pgStopLoop();
        }
        return;
      }
      if (typeof alphaBoost === 'number') {
        pgState.alpha = Math.max(pgState.alpha, alphaBoost);
      }
      if (pgPrefersReducedMotion()) {
        if (pgState.alpha > 0.02) {
          for (let i = 0; i < 65; i++) pgStepPhysics(0.06);
          pgState.alpha = 0;
        }
        pgDrawGraph();
        return;
      }
      if (!pgState.rafId && (pgState.alpha >= 0.008 || pgState.dragMode === 'node' || pgHasActivePulses())) {
        pgState.rafId = requestAnimationFrame(pgTickFrame);
      }
    }

    function pgWorldToScreen(wx, wy) {
      return {
        x: (wx - pgState.camX) * pgState.camScale + pgState.width * 0.5,
        y: (wy - pgState.camY) * pgState.camScale + pgState.height * 0.5
      };
    }

    function pgScreenToWorld(sx, sy) {
      return {
        x: (sx - pgState.width * 0.5) / pgState.camScale + pgState.camX,
        y: (sy - pgState.height * 0.5) / pgState.camScale + pgState.camY
      };
    }

    function pgGetUiScale() {
      let factor = 1;
      try {
        const mode = typeof normalizePanelUiScale === 'function'
          ? normalizePanelUiScale((typeof currentState === 'object' && currentState && currentState.panelUiScale) || (typeof _activePanelUiScaleMode !== 'undefined' ? _activePanelUiScaleMode : 'auto'))
          : 'auto';
        if (mode === 'auto') {
          factor = typeof computeAutoUiScale === 'function' ? computeAutoUiScale() : 1;
        } else {
          factor = (Number(mode) || 100) / 100;
        }
      } catch {}
      if (!Number.isFinite(factor) || factor <= 0) factor = 1;
      return Math.max(0.85, Math.min(1.45, factor));
    }

    function pgGetLayerRolePalette(role, colIndex) {
      if (role === 'entry') {
        return { accentRgb: '224, 159, 62', accentHex: '#e09f3e', laneEvenAlpha: 0.05, laneOddAlpha: 0.05 };
      }
      if (role === 'core') {
        return { accentRgb: '240, 72, 72', accentHex: '#f04848', laneEvenAlpha: 0.055, laneOddAlpha: 0.055 };
      }
      if (role === 'single') {
        return { accentRgb: '156, 163, 175', accentHex: '#9ca3af', laneEvenAlpha: 0.045, laneOddAlpha: 0.045 };
      }
      const even = (Number(colIndex) || 0) % 2 === 0;
      return even
        ? { accentRgb: '148, 163, 184', accentHex: '#94a3b8', laneEvenAlpha: 0.035, laneOddAlpha: 0.016 }
        : { accentRgb: '113, 113, 122', accentHex: '#71717a', laneEvenAlpha: 0.035, laneOddAlpha: 0.016 };
    }

    function pgFindLayerHeaderAtScreen(sx, sy) {
      const rects = Array.isArray(pgState.layerHeaderRects) ? pgState.layerHeaderRects : [];
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i];
        if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
          return r;
        }
      }
      return null;
    }

    function pgToggleLayerFilter(tier) {
      if (tier === null || tier === undefined || tier === '') {
        if (pgState.activeLayerTier === null) return;
        pgState.activeLayerTier = null;
        pgRenderClusterPills();
        pgDrawGraph();
        if (typeof flashStatus === 'function') {
          flashStatus(L('Фильтр по слою сброшен', 'Layer filter cleared'));
        }
        return;
      }
      const numTier = Number(tier);
      if (!Number.isFinite(numTier)) return;
      const next = pgState.activeLayerTier === numTier ? null : numTier;
      pgState.activeLayerTier = next;
      pgRenderClusterPills();
      pgDrawGraph();
      if (typeof flashStatus === 'function') {
        if (next === null) {
          flashStatus(L('Фильтр по слою сброшен', 'Layer filter cleared'));
        } else {
          const col = (pgState.layeredColumns || []).find(function (c) { return c.tier === next; });
          const lbl = col ? (isRu() ? col.labelRu : col.labelEn) : (L('Слой ', 'Layer ') + (next + 1));
          flashStatus(L('Слой: ', 'Layer: ') + lbl + (col ? (' · ' + col.count) : ''));
        }
      }
    }

    function pgSyncNodeLayerDetachment(node) {
      if (!node || pgState.layoutMode !== 'layered' || typeof node._tier !== 'number') {
        if (node) node._detachedFromLayer = false;
        return false;
      }
      const cols = Array.isArray(pgState.layeredColumns) ? pgState.layeredColumns : [];
      const col = cols.find(function (c) { return c.tier === node._tier; });
      if (!col) {
        node._detachedFromLayer = false;
        return false;
      }
      const gap = Number(col.colGap) || 210;
      const detachDist = Math.max(gap * 0.62, 130);
      const reattachDist = Math.max(gap * 0.48, 96);
      const dx = Math.abs(Number(node.x || 0) - Number(col.x || 0));
      if (node._detachedFromLayer) {
        if (dx <= reattachDist) node._detachedFromLayer = false;
      } else if (dx > detachDist) {
        node._detachedFromLayer = true;
      }
      return Boolean(node._detachedFromLayer);
    }

    function pgResetLayeredPositions() {
      if (pgState.layoutMode !== 'layered' || !Array.isArray(pgState.layeredColumns) || !pgState.layeredColumns.length || !Array.isArray(pgState.nodes) || !pgState.nodes.length) {
        return false;
      }
      const colChanges = [];
      for (let c = 0; c < pgState.layeredColumns.length; c++) {
        const col = pgState.layeredColumns[c];
        const origX = Number.isFinite(col.origX) ? col.origX : col.x;
        if (Math.abs(col.x - origX) > 0.5) {
          colChanges.push({ tier: col.tier, prevX: col.x, nextX: origX });
        }
      }
      const nodeChanges = [];
      for (let i = 0; i < pgState.nodes.length; i++) {
        const n = pgState.nodes[i];
        const ox = Number.isFinite(n._origX) ? n._origX : n.x;
        const oy = Number.isFinite(n._origY) ? n._origY : n.y;
        if (Math.abs(n.x - ox) > 0.5 || Math.abs(n.y - oy) > 0.5 || n._detachedFromLayer) {
          nodeChanges.push({ id: n.id, prevX: n.x, prevY: n.y, nextX: ox, nextY: oy });
        }
      }
      if (colChanges.length === 0 && nodeChanges.length === 0) {
        pgFitView();
        return false;
      }
      if (!Array.isArray(pgState.undoStack)) pgState.undoStack = [];
      pgState.undoStack.push({ kind: 'batch', cols: colChanges, nodes: nodeChanges });
      if (pgState.undoStack.length > 80) pgState.undoStack.shift();
      pgState.redoStack = [];

      for (let c = 0; c < pgState.layeredColumns.length; c++) {
        const col = pgState.layeredColumns[c];
        if (Number.isFinite(col.origX)) col.x = col.origX;
      }
      for (let i = 0; i < pgState.nodes.length; i++) {
        const n = pgState.nodes[i];
        if (Number.isFinite(n._origX)) n.x = n._origX;
        if (Number.isFinite(n._origY)) n.y = n._origY;
        n.vx = 0;
        n.vy = 0;
        n.fx = null;
        n.fy = null;
        n._detachedFromLayer = false;
      }
      pgState.spatialTree = null;
      pgFitView();
      if (typeof flashStatus === 'function') {
        flashStatus(L('Слои выровнены ↺', 'Layers realigned ↺'));
      }
      return true;
    }

    function pgFitView() {
      const nodes = pgState.nodes;
      if (!nodes.length) {
        pgState.camX = 0;
        pgState.camY = 0;
        pgState.camScale = 1;
        return;
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      const uiScale = pgGetUiScale();
      const headerPad = pgState.layoutMode === 'layered' ? Math.round(42 * uiScale) : 0;
      const spanX = Math.max(140, (maxX - minX) + 90);
      const spanY = Math.max(120, (maxY - minY) + 90);
      const w = Math.max(240, pgState.width || 600);
      const h = Math.max(180, (pgState.height || 420) - headerPad);
      const minScale = pgState.layoutMode === 'layered' ? 0.16 : 0.28;
      const scale = Math.max(minScale, Math.min(2.1, Math.min(w / spanX, h / spanY) * 0.88));
      pgState.camX = (minX + maxX) * 0.5;
      pgState.camY = (minY + maxY) * 0.5 - (headerPad * 0.5) / scale;
      pgState.camScale = scale;
      pgDrawGraph();
    }

    function pgHashUnit(str) {
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return ((h >>> 0) % 10000) / 10000;
    }

    function pgBuildSubsystemMap(rawNodes) {
      const resolveRelPath = function (n) {
        const rawId = String((n && n.id) || '');
        if (n && n.file) return String(n.file);
        if (rawId.indexOf('sym:') === 0) return rawId.slice(4).split('#')[0];
        return rawId;
      };
      const subdirsBySeg0 = new Map();
      for (let i = 0; i < rawNodes.length; i++) {
        const rel = resolveRelPath(rawNodes[i]);
        const parts = rel.split('/');
        if (parts.length >= 3) {
          const seg0 = parts[0];
          const seg1 = parts[1];
          let set = subdirsBySeg0.get(seg0);
          if (!set) {
            set = new Set();
            subdirsBySeg0.set(seg0, set);
          }
          set.add(seg1);
        }
      }

      const fileToSubsystem = new Map();
      for (let i = 0; i < rawNodes.length; i++) {
        const rawId = String(rawNodes[i].id || '');
        const rel = resolveRelPath(rawNodes[i]);
        const parts = rel.split('/');
        let key = 'root';
        if (parts.length === 2) {
          key = parts[0];
        } else if (parts.length >= 3) {
          const seg0 = parts[0];
          const subSet = subdirsBySeg0.get(seg0);
          key = (subSet && subSet.size >= 1 && subSet.size <= 5) ? (seg0 + '/' + parts[1]) : seg0;
        }
        fileToSubsystem.set(rawId, key);
      }
      return fileToSubsystem;
    }

    function pgBuildMacroGraph(rawData) {
      const rawNodes = Array.isArray(rawData?.nodes) ? rawData.nodes : [];
      const rawEdges = Array.isArray(rawData?.edges) ? rawData.edges : [];
      const fileToSubsystem = pgBuildSubsystemMap(rawNodes);

      const folderAcc = new Map();
      for (let i = 0; i < rawNodes.length; i++) {
        const n = rawNodes[i];
        const fKey = fileToSubsystem.get(n.id) || 'root';
        let acc = folderAcc.get(fKey);
        if (!acc) {
          acc = {
            id: 'folder:' + fKey,
            isFolder: true,
            folderKey: fKey,
            label: fKey,
            dir: fKey,
            ext: '',
            lines: 0,
            symbolsCount: 0,
            filesCount: 0,
            godCount: 0,
            fragileCount: 0,
            reliabilitySum: 0,
            internalEdges: 0,
            clusterId: fKey,
            clusterLabel: fKey,
            inDeg: 0,
            outDeg: 0,
            inFiles: new Set(),
            outFiles: new Set(),
            fileIds: [],
            topHubFile: '',
            topHubScore: -1,
            isGod: false,
            isTest: false,
            isFragile: false,
            reliabilityPercent: 100,
            hop: -1
          };
          folderAcc.set(fKey, acc);
        }
        acc.filesCount += 1;
        acc.lines += Number(n.lines || 0);
        acc.symbolsCount += Number(n.symbolsCount || 0);
        acc.reliabilitySum += Number(n.reliabilityPercent ?? 100);
        if (n.isGod) acc.godCount += 1;
        if (n.isFragile) acc.fragileCount += 1;
        acc.fileIds.push(n.id);
        const hubScore = Number(n.inDeg || 0) * 3 + Number(n.outDeg || 0) + (n.isGod ? 20 : 0);
        if (hubScore > acc.topHubScore) {
          acc.topHubScore = hubScore;
          acc.topHubFile = n.id;
        }
      }

      const edgeMap = new Map();
      for (let i = 0; i < rawEdges.length; i++) {
        const e = rawEdges[i];
        const sKey = fileToSubsystem.get(e.source);
        const tKey = fileToSubsystem.get(e.target);
        if (!sKey || !tKey) continue;
        if (sKey === tKey) {
          const sameAcc = folderAcc.get(sKey);
          if (sameAcc) sameAcc.internalEdges += 1;
          continue;
        }
        const sFolderId = 'folder:' + sKey;
        const tFolderId = 'folder:' + tKey;
        const sAcc = folderAcc.get(sKey);
        const tAcc = folderAcc.get(tKey);
        if (sAcc) sAcc.outFiles.add(tKey);
        if (tAcc) tAcc.inFiles.add(sKey);
        const pairKey = sFolderId + '->' + tFolderId;
        let rec = edgeMap.get(pairKey);
        if (!rec) {
          rec = { source: sFolderId, target: tFolderId, kind: e.kind === 'doc' ? 'doc' : 'import', weight: 0 };
          edgeMap.set(pairKey, rec);
        }
        rec.weight += 1;
        if (e.kind !== 'doc') rec.kind = 'import';
      }

      const macroNodes = [];
      const clusters = [];
      for (const acc of folderAcc.values()) {
        acc.inDeg = acc.inFiles.size;
        acc.outDeg = acc.outFiles.size;
        acc.isGod = acc.godCount > 0 || acc.inDeg >= 4;
        acc.isFragile = acc.fragileCount > 0;
        acc.reliabilityPercent = acc.filesCount > 0 ? Math.round(acc.reliabilitySum / acc.filesCount) : 100;
        delete acc.inFiles;
        delete acc.outFiles;
        delete acc.reliabilitySum;
        delete acc.topHubScore;
        macroNodes.push(acc);
        clusters.push({
          id: acc.folderKey,
          label: acc.folderKey,
          size: acc.filesCount,
          shownSize: acc.filesCount,
          hubFile: acc.topHubFile
        });
      }
      clusters.sort(function (a, b) {
        return b.size - a.size || a.label.localeCompare(b.label);
      });

      return {
        ...rawData,
        isMacro: true,
        shownNodes: macroNodes.length,
        shownEdges: edgeMap.size,
        clusters,
        nodes: macroNodes,
        edges: Array.from(edgeMap.values())
      };
    }

    function pgComputeLayeredLayout(simNodes, simEdges, isMacro, isSymbolsView) {
      const len = simNodes.length;
      if (len === 0) {
        pgState.layeredColumns = [];
        return;
      }
      const isSymbols = typeof isSymbolsView === 'boolean'
        ? isSymbolsView
        : simNodes.some(function (n) { return Boolean(n && n.isSymbol); });

      const adjOut = new Map();
      const adjIn = new Map();
      const adjOutW = new Map();
      const adjInW = new Map();
      const inDegCount = new Map();
      for (let i = 0; i < len; i++) {
        const id = simNodes[i].id;
        adjOut.set(id, []);
        adjIn.set(id, []);
        adjOutW.set(id, []);
        adjInW.set(id, []);
        inDegCount.set(id, 0);
      }
      for (let i = 0; i < simEdges.length; i++) {
        const e = simEdges[i];
        const sId = e.source.id;
        const tId = e.target.id;
        if (sId === tId) continue;
        const ew = Math.max(1, Number(e.weight || 1));
        adjOut.get(sId).push(tId);
        adjIn.get(tId).push(sId);
        adjOutW.get(sId).push({ id: tId, w: ew });
        adjInW.get(tId).push({ id: sId, w: ew });
        inDegCount.set(tId, (inDegCount.get(tId) || 0) + 1);
      }

      // Cycle-safe topological ranking: entries on the left (tier 0), core hubs on the right
      const rank = new Map();
      const queue = [];
      for (let i = 0; i < len; i++) {
        const n = simNodes[i];
        rank.set(n.id, 0);
        if ((inDegCount.get(n.id) || 0) === 0) {
          queue.push(n.id);
        }
      }

      let head = 0;
      const visitedKahn = new Set();
      while (head < queue.length) {
        const u = queue[head++];
        visitedKahn.add(u);
        const uRank = rank.get(u) || 0;
        const outs = adjOut.get(u) || [];
        for (let i = 0; i < outs.length; i++) {
          const v = outs[i];
          if ((rank.get(v) || 0) <= uRank) {
            rank.set(v, Math.min(6, uRank + 1));
          }
          const rem = (inDegCount.get(v) || 0) - 1;
          inDegCount.set(v, rem);
          if (rem === 0) queue.push(v);
        }
      }

      // Relax remaining nodes involved in cycles (capped iterations)
      if (visitedKahn.size < len) {
        for (let iter = 0; iter < 12; iter++) {
          let changed = false;
          for (let i = 0; i < simEdges.length; i++) {
            const sId = simEdges[i].source.id;
            const tId = simEdges[i].target.id;
            if (sId === tId) continue;
            const sr = rank.get(sId) || 0;
            const tr = rank.get(tId) || 0;
            if (tr <= sr && sr < 6) {
              rank.set(tId, sr + 1);
              changed = true;
            }
          }
          if (!changed) break;
        }
      }

      // Push pure dependency sinks toward the rightmost foundation layer
      let maxTier = 0;
      for (const r of rank.values()) {
        if (r > maxTier) maxTier = r;
      }
      if (maxTier > 0) {
        for (let i = 0; i < len; i++) {
          const n = simNodes[i];
          if ((adjOut.get(n.id) || []).length === 0 && (adjIn.get(n.id) || []).length > 0) {
            rank.set(n.id, maxTier);
          }
        }
      }

      const tiers = new Map();
      for (let i = 0; i < len; i++) {
        const n = simNodes[i];
        const t = rank.get(n.id) || 0;
        n._tier = t;
        let arr = tiers.get(t);
        if (!arr) {
          arr = [];
          tiers.set(t, arr);
        }
        arr.push(n);
      }

      const tierKeys = Array.from(tiers.keys()).sort(function (a, b) { return a - b; });
      const colCount = tierKeys.length;

      // Initial deterministic order inside each column
      for (let k = 0; k < colCount; k++) {
        const colNodes = tiers.get(tierKeys[k]);
        colNodes.sort(function (a, b) {
          return String(a.subsystemKey || a.clusterId || '').localeCompare(String(b.subsystemKey || b.clusterId || '')) ||
            (Number(b.inDeg || 0) - Number(a.inDeg || 0)) ||
            a.id.localeCompare(b.id);
        });
        for (let r = 0; r < colNodes.length; r++) colNodes[r]._rowIdx = r;
      }

      // 5-pass weighted Sugiyama barycenter sweep + adjacent transpose to minimize edge crossings
      for (let pass = 0; pass < 5; pass++) {
        for (let k = 1; k < colCount; k++) {
          const colNodes = tiers.get(tierKeys[k]);
          for (let r = 0; r < colNodes.length; r++) {
            const ins = adjInW.get(colNodes[r].id) || [];
            if (ins.length === 0) {
              colNodes[r]._bary = r;
              continue;
            }
            let sum = 0;
            let wSum = 0;
            for (let j = 0; j < ins.length; j++) {
              const item = ins[j];
              const pNode = pgState.nodeById.get(item.id);
              if (pNode && pNode._tier < colNodes[r]._tier) {
                sum += (pNode._rowIdx || 0) * item.w;
                wSum += item.w;
              }
            }
            colNodes[r]._bary = wSum > 0 ? (sum / wSum) : r;
          }
          colNodes.sort(function (a, b) {
            return (a._bary - b._bary) ||
              String(a.subsystemKey || a.clusterId || '').localeCompare(String(b.subsystemKey || b.clusterId || '')) ||
              a.id.localeCompare(b.id);
          });
          for (let r = 0; r < colNodes.length; r++) colNodes[r]._rowIdx = r;
        }
        for (let k = colCount - 2; k >= 0; k--) {
          const colNodes = tiers.get(tierKeys[k]);
          for (let r = 0; r < colNodes.length; r++) {
            const outs = adjOutW.get(colNodes[r].id) || [];
            if (outs.length === 0) {
              colNodes[r]._bary = r;
              continue;
            }
            let sum = 0;
            let wSum = 0;
            for (let j = 0; j < outs.length; j++) {
              const item = outs[j];
              const cNode = pgState.nodeById.get(item.id);
              if (cNode && cNode._tier > colNodes[r]._tier) {
                sum += (cNode._rowIdx || 0) * item.w;
                wSum += item.w;
              }
            }
            colNodes[r]._bary = wSum > 0 ? (sum / wSum) : r;
          }
          colNodes.sort(function (a, b) {
            return (a._bary - b._bary) ||
              String(a.subsystemKey || a.clusterId || '').localeCompare(String(b.subsystemKey || b.clusterId || '')) ||
              a.id.localeCompare(b.id);
          });
          for (let r = 0; r < colNodes.length; r++) colNodes[r]._rowIdx = r;
        }
      }

      // Lightweight adjacent-pair transpose pass per column to eliminate local X-crossings
      function pgPairCrossings(aNode, bNode) {
        const aRow = aNode._rowIdx || 0;
        const bRow = bNode._rowIdx || 0;
        const aIns = adjInW.get(aNode.id) || [];
        const bIns = adjInW.get(bNode.id) || [];
        const aOuts = adjOutW.get(aNode.id) || [];
        const bOuts = adjOutW.get(bNode.id) || [];
        let cur = 0;
        let swapped = 0;
        for (let i = 0; i < aIns.length; i++) {
          const pa = pgState.nodeById.get(aIns[i].id);
          if (!pa || pa._tier >= aNode._tier) continue;
          for (let j = 0; j < bIns.length; j++) {
            const pb = pgState.nodeById.get(bIns[j].id);
            if (!pb || pb._tier >= bNode._tier) continue;
            const prDiff = (pa._rowIdx || 0) - (pb._rowIdx || 0);
            if ((prDiff < 0 && aRow > bRow) || (prDiff > 0 && aRow < bRow)) cur += 1;
            else if ((prDiff < 0 && bRow > aRow) || (prDiff > 0 && bRow < aRow)) swapped += 1;
          }
        }
        for (let i = 0; i < aOuts.length; i++) {
          const ca = pgState.nodeById.get(aOuts[i].id);
          if (!ca || ca._tier <= aNode._tier) continue;
          for (let j = 0; j < bOuts.length; j++) {
            const cb = pgState.nodeById.get(bOuts[j].id);
            if (!cb || cb._tier <= bNode._tier) continue;
            const crDiff = (ca._rowIdx || 0) - (cb._rowIdx || 0);
            if ((crDiff < 0 && aRow > bRow) || (crDiff > 0 && aRow < bRow)) cur += 1;
            else if ((crDiff < 0 && bRow > aRow) || (crDiff > 0 && bRow < aRow)) swapped += 1;
          }
        }
        return cur - swapped;
      }

      for (let k = 0; k < colCount; k++) {
        const colNodes = tiers.get(tierKeys[k]);
        if (colNodes.length < 2 || colNodes.length > 60) continue;
        for (let iter = 0; iter < 3; iter++) {
          let swappedAny = false;
          for (let r = 0; r < colNodes.length - 1; r++) {
            if (pgPairCrossings(colNodes[r], colNodes[r + 1]) > 0) {
              const tmp = colNodes[r];
              colNodes[r] = colNodes[r + 1];
              colNodes[r + 1] = tmp;
              colNodes[r]._rowIdx = r;
              colNodes[r + 1]._rowIdx = r + 1;
              swappedAny = true;
            }
          }
          if (!swappedAny) break;
        }
      }

      const colGap = isMacro ? 235 : 205;
      const rowGap = isMacro ? 74 : (len > 80 ? 23 : 34);
      const startX = -((colCount - 1) * colGap) * 0.5;
      const columns = [];

      for (let k = 0; k < colCount; k++) {
        const tierId = tierKeys[k];
        const colNodes = tiers.get(tierId);
        const colX = startX + k * colGap;
        const startY = -((colNodes.length - 1) * rowGap) * 0.5;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let r = 0; r < colNodes.length; r++) {
          const ny = startY + r * rowGap;
          colNodes[r].x = colX;
          colNodes[r].y = ny;
          colNodes[r]._origX = colX;
          colNodes[r]._origY = ny;
          colNodes[r]._detachedFromLayer = false;
          colNodes[r].vx = 0;
          colNodes[r].vy = 0;
          if (ny < minY) minY = ny;
          if (ny > maxY) maxY = ny;
        }
        if (!Number.isFinite(minY)) minY = 0;
        if (!Number.isFinite(maxY)) maxY = 0;

        let role = 'mid';
        let labelRu = 'Слой ' + (k + 1);
        let labelEn = 'Layer ' + (k + 1);
        let shortRu = 'С' + (k + 1);
        let shortEn = 'L' + (k + 1);

        if (colCount === 1) {
          role = 'single';
          labelRu = isSymbols ? 'Символы' : 'Модули';
          labelEn = isSymbols ? 'Symbols' : 'Modules';
          shortRu = labelRu;
          shortEn = labelEn;
        } else if (k === 0) {
          role = 'entry';
          labelRu = isSymbols ? 'Точки входа' : 'Входы / UI';
          labelEn = isSymbols ? 'Entry Points' : 'Entries / UI';
          shortRu = 'Входы';
          shortEn = isSymbols ? 'Entry' : 'Entries';
        } else if (k === colCount - 1) {
          role = 'core';
          labelRu = isSymbols ? 'База / Утилиты' : 'Ядро / Хабы';
          labelEn = isSymbols ? 'Core / Utils' : 'Core / Hubs';
          shortRu = isSymbols ? 'База' : 'Ядро';
          shortEn = 'Core';
        } else if (isSymbols) {
          labelRu = 'Логика · Слой ' + (k + 1);
          labelEn = 'Logic · Layer ' + (k + 1);
        }

        columns.push({
          tier: tierId,
          index: k,
          role,
          x: colX,
          origX: colX,
          colGap,
          minY,
          maxY,
          count: colNodes.length,
          labelRu,
          labelEn,
          shortRu,
          shortEn
        });
      }
      pgState.layeredColumns = columns;

      // Compute long-span bypass arcs for edges skipping intermediate tiers
      let longArcIdx = 0;
      for (let i = 0; i < simEdges.length; i++) {
        const e = simEdges[i];
        const sTier = e.source._tier || 0;
        const tTier = e.target._tier || 0;
        const span = Math.abs(tTier - sTier);
        e._span = span;
        if (span >= 2) {
          const avgY = (e.source.y + e.target.y) * 0.5;
          const dirSign = avgY < 0 ? -1 : 1;
          const mag = (isMacro ? 54 : 38) + (span - 2) * 18 + (longArcIdx % 4) * 7;
          e._bypassArc = dirSign * Math.min(140, mag);
          longArcIdx += 1;
        } else {
          e._bypassArc = 0;
        }
      }
    }

    function pgComputeConvexHull(points) {
      if (!points || points.length < 3) return points || [];
      const pts = points.slice().sort(function (a, b) {
        return a.x - b.x || a.y - b.y;
      });
      const cross = function (o, a, b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      };
      const lower = [];
      for (let i = 0; i < pts.length; i++) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) {
          lower.pop();
        }
        lower.push(pts[i]);
      }
      const upper = [];
      for (let i = pts.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) {
          upper.pop();
        }
        upper.push(pts[i]);
      }
      lower.pop();
      upper.pop();
      return lower.concat(upper);
    }

    function pgBuildViewDataFromRaw(rawData) {
      if (rawData && rawData.isSymbolsView) {
        const symNodes = Array.isArray(rawData.nodes) ? rawData.nodes.map(function (n) {
          return { ...n, subsystemKey: n.clusterId || (n.isExternal ? 'external' : 'internal') };
        }) : [];
        return {
          ...rawData,
          isMacro: false,
          isSymbolsView: true,
          nodes: symNodes,
          edges: Array.isArray(rawData.edges) ? rawData.edges : []
        };
      }
      const baseNodes = Array.isArray(rawData?.nodes) ? rawData.nodes : [];
      const baseEdges = Array.isArray(rawData?.edges) ? rawData.edges : [];
      const fileToSubsystem = pgBuildSubsystemMap(baseNodes);

      if (pgState.viewLevel === 'folders' && pgState.mode === 'global' && !pgState.drillFolder) {
        return pgBuildMacroGraph(rawData);
      }

      if (pgState.drillFolder) {
        const inFolder = new Set();
        for (let i = 0; i < baseNodes.length; i++) {
          const sub = fileToSubsystem.get(baseNodes[i].id) || 'root';
          if (sub === pgState.drillFolder) inFolder.add(baseNodes[i].id);
        }
        const keepIds = new Set(inFolder);
        for (let i = 0; i < baseEdges.length; i++) {
          const e = baseEdges[i];
          if (inFolder.has(e.source)) keepIds.add(e.target);
          if (inFolder.has(e.target)) keepIds.add(e.source);
        }
        const filteredNodes = [];
        const subMap = new Map();
        for (let i = 0; i < baseNodes.length; i++) {
          const n = baseNodes[i];
          if (!keepIds.has(n.id)) continue;
          const sub = fileToSubsystem.get(n.id) || 'root';
          filteredNodes.push({ ...n, subsystemKey: sub, clusterId: sub, clusterLabel: sub });
          if (!subMap.has(sub)) subMap.set(sub, { id: sub, label: sub, size: 0, shownSize: 0 });
          subMap.get(sub).size += 1;
          subMap.get(sub).shownSize += 1;
        }
        const filteredEdges = baseEdges.filter(function (e) {
          return keepIds.has(e.source) && keepIds.has(e.target);
        });
        return {
          ...rawData,
          isMacro: false,
          drillFolder: pgState.drillFolder,
          shownNodes: filteredNodes.length,
          shownEdges: filteredEdges.length,
          clusters: Array.from(subMap.values()).sort(function (a, b) { return b.size - a.size; }),
          nodes: filteredNodes,
          edges: filteredEdges
        };
      }

      const enrichedNodes = [];
      const subClusters = new Map();
      for (let i = 0; i < baseNodes.length; i++) {
        const n = baseNodes[i];
        const sub = fileToSubsystem.get(n.id) || 'root';
        enrichedNodes.push({ ...n, subsystemKey: sub, clusterId: sub, clusterLabel: sub });
        if (!subClusters.has(sub)) subClusters.set(sub, { id: sub, label: sub, size: 0, shownSize: 0 });
        subClusters.get(sub).size += 1;
        subClusters.get(sub).shownSize += 1;
      }
      return {
        ...rawData,
        isMacro: false,
        clusters: Array.from(subClusters.values()).sort(function (a, b) { return b.size - a.size; }),
        nodes: enrichedNodes,
        edges: baseEdges
      };
    }

    function pgHydrateSimulation(rawOrViewData) {
      const data = pgBuildViewDataFromRaw(rawOrViewData);
      pgState.graphData = data;
      pgState.clusterColors.clear();
      pgState.layeredColumns = [];
      const rawNodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const rawEdges = Array.isArray(data?.edges) ? data.edges : [];
      const clusters = Array.isArray(data?.clusters) ? data.clusters : [];

      const clusterCenter = new Map();
      const cCount = Math.max(1, clusters.length);
      for (let i = 0; i < clusters.length; i++) {
        const ang = (i / cCount) * Math.PI * 2 - Math.PI * 0.5;
        const rad = cCount > 1 ? 220 : 0;
        clusterCenter.set(clusters[i].id, {
          x: Math.cos(ang) * rad,
          y: Math.sin(ang) * rad
        });
        pgGetClusterColor(clusters[i].id);
      }

      const simNodes = [];
      const nodeById = new Map();
      for (let i = 0; i < rawNodes.length; i++) {
        const rn = rawNodes[i];
        const cc = clusterCenter.get(rn.clusterId) || { x: 0, y: 0 };
        const angle = pgHashUnit(rn.id + '#a') * Math.PI * 2;
        const dist = rn.hop === 0
          ? 0
          : (rn.hop > 0 ? rn.hop * 110 : (30 + pgHashUnit(rn.id + '#d') * 110));
        const radius = rn.isFolder
          ? Math.max(12, Math.min(20, 12 + Math.sqrt(Number(rn.filesCount || 1)) * 1.4))
          : Math.max(3.0, Math.min(9.0, 3.0 + Math.sqrt(Number(rn.inDeg || 0)) * 1.1 + (rn.isGod ? 1.4 : 0)));
        const node = {
          ...rn,
          radius,
          x: rn.hop === 0 ? 0 : (cc.x + Math.cos(angle) * dist),
          y: rn.hop === 0 ? 0 : (cc.y + Math.sin(angle) * dist),
          vx: 0,
          vy: 0,
          anchorX: cc.x,
          anchorY: cc.y,
          fx: null,
          fy: null
        };
        simNodes.push(node);
        nodeById.set(node.id, node);
      }

      const simEdges = [];
      const inNeighbors = new Map();
      const outNeighbors = new Map();
      const edgePairSet = new Set();
      for (let i = 0; i < rawEdges.length; i++) {
        const re = rawEdges[i];
        if (re?.source && re?.target && re.source !== re.target) {
          edgePairSet.add(re.source + '->' + re.target);
        }
      }
      for (let i = 0; i < rawEdges.length; i++) {
        const re = rawEdges[i];
        const sNode = nodeById.get(re.source);
        const tNode = nodeById.get(re.target);
        if (!sNode || !tNode) continue;
        const kind = re.kind === 'doc' ? 'doc' : 'import';
        const weight = Math.max(1, Number(re.weight || 1));
        const isBidir = edgePairSet.has(tNode.id + '->' + sNode.id);
        const phase = pgHashUnit(sNode.id + '->' + tNode.id);
        simEdges.push({ source: sNode, target: tNode, kind, weight, _isBidir: isBidir, _phase: phase });
        if (!outNeighbors.has(sNode.id)) outNeighbors.set(sNode.id, []);
        outNeighbors.get(sNode.id).push({ id: tNode.id, kind, weight });
        if (!inNeighbors.has(tNode.id)) inNeighbors.set(tNode.id, []);
        inNeighbors.get(tNode.id).push({ id: sNode.id, kind, weight });
      }

      pgState.nodes = simNodes;
      pgState.nodeById = nodeById;
      pgState.edges = simEdges;
      pgState.inNeighbors = inNeighbors;
      pgState.outNeighbors = outNeighbors;
      pgState.hoveredNodeId = '';
      pgState.dragOriginPos = null;
      pgState.undoStack = [];
      pgState.redoStack = [];

      if (pgState.activeClusterId && !clusters.some(function (c) { return c.id === pgState.activeClusterId; })) {
        pgState.activeClusterId = '';
      }

      if (data?.focus && nodeById.has(data.focus)) {
        pgState.selectedNodeId = data.focus;
      } else if (pgState.selectedNodeId && nodeById.has(pgState.selectedNodeId)) {
        // Keep current selection when still in graph
      } else if (simNodes.length > 0) {
        const godFirst = simNodes.find(function (n) { return n.isGod; }) || simNodes[0];
        pgState.selectedNodeId = godFirst.id;
      } else {
        pgState.selectedNodeId = '';
      }

      if (pgState.layoutMode === 'layered') {
        pgComputeLayeredLayout(simNodes, simEdges, Boolean(data?.isMacro), Boolean(data?.isSymbolsView));
        if (pgState.activeLayerTier !== null && !pgState.layeredColumns.some(function (c) { return c.tier === pgState.activeLayerTier; })) {
          pgState.activeLayerTier = null;
        }
        pgState.alpha = 0;
        pgStopLoop();
      } else {
        pgState.activeLayerTier = null;
        pgState.hoveredLayerTier = null;
        pgState.layerHeaderRects = [];
        const preSteps = simNodes.length >= 1000
          ? Math.min(80, Math.max(24, Math.round(92 - simNodes.length * 0.012)))
          : Math.min(110, Math.max(45, Math.round(130 - simNodes.length * 0.2)));
        for (let s = 0; s < preSteps; s++) {
          pgStepPhysics(0.085 * (1 - s / (preSteps + 12)));
        }
        pgState.alpha = pgPrefersReducedMotion() ? 0 : 0.32;
      }

      pgState.spatialTree = typeof pgBuildQuadtree === 'function' ? pgBuildQuadtree(simNodes) : null;
      pgFitView();
      if (typeof pgRefreshLensState === 'function') {
        pgRefreshLensState();
      }
      pgRenderToolbarAndStats();
      pgRenderClusterPills();
      pgRenderInspector();
      pgStartLoop(pgState.alpha);
    }

    function pgStepPhysics(alpha) {
      const nodes = pgState.nodes;
      const edges = pgState.edges;
      const len = nodes.length;
      if (len === 0) return;

      const repulseK = len > 1000 ? 1200 : (len > 140 ? 1500 : 1850);
      if (len >= 60 && typeof pgBuildQuadtree === 'function' && typeof pgApplyBarnesHutRepulsion === 'function') {
        const tree = pgBuildQuadtree(nodes);
        pgState.spatialTree = tree;
        const theta = len > 1800 ? 0.85 : 0.72;
        for (let i = 0; i < len; i++) {
          const a = nodes[i];
          const pullCenter = a.hop === 0 ? 0.08 : 0.012;
          a.vx += (a.anchorX * 0.25 - a.x) * pullCenter * alpha;
          a.vy += (a.anchorY * 0.25 - a.y) * pullCenter * alpha;
          pgApplyBarnesHutRepulsion(tree, a, theta, repulseK, alpha);
        }
      } else {
        for (let i = 0; i < len; i++) {
          const a = nodes[i];
          // Center & cluster gravity
          const pullCenter = a.hop === 0 ? 0.08 : 0.012;
          a.vx += (a.anchorX * 0.25 - a.x) * pullCenter * alpha;
          a.vy += (a.anchorY * 0.25 - a.y) * pullCenter * alpha;

          for (let j = i + 1; j < len; j++) {
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 1) {
              dx = 0.7;
              dy = 0.7;
              distSq = 1;
            }
            if (distSq > 95000) continue;
            const dist = Math.sqrt(distSq);
            const minSep = a.radius + b.radius + 22;
            const overlapBoost = dist < minSep ? (minSep - dist) * 0.22 : 0;
            const force = ((repulseK / distSq) * alpha) + overlapBoost * alpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }
      }

      for (let e = 0; e < edges.length; e++) {
        const edge = edges[e];
        const a = edge.source;
        const b = edge.target;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetDist = edge.kind === 'doc' ? 150 : 112;
        const strength = edge.kind === 'doc' ? 0.045 : 0.095;
        const f = ((dist - targetDist) / dist) * strength * alpha;
        const fx = dx * f;
        const fy = dy * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      const damping = 0.82;
      for (let i = 0; i < len; i++) {
        const n = nodes[i];
        if (n.fx !== null && n.fy !== null) {
          n.x = n.fx;
          n.y = n.fy;
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx *= damping;
        n.vy *= damping;
        const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (speed > 18) {
          n.vx = (n.vx / speed) * 18;
          n.vy = (n.vy / speed) * 18;
        }
        n.x += n.vx;
        n.y += n.vy;
      }
    }

    function pgTickFrame() {
      pgState.rafId = 0;
      if (!pgState.open) return;
      const hasPhysics = pgState.layoutMode !== 'layered' && (pgState.alpha >= 0.008 || pgState.dragMode === 'node');
      if (hasPhysics) {
        const stepAlpha = pgState.dragMode === 'node' ? Math.max(0.08, pgState.alpha) : pgState.alpha;
        pgStepPhysics(stepAlpha);
        pgState.alpha *= 0.965;
        if (pgState.alpha < 0.008 && pgState.dragMode !== 'node') {
          pgState.alpha = 0;
        }
      }
      pgDrawGraph();
      if (
        (pgState.layoutMode !== 'layered' && (pgState.alpha > 0 || pgState.dragMode === 'node')) ||
        pgHasActivePulses()
      ) {
        pgState.rafId = requestAnimationFrame(pgTickFrame);
      }
    }

    function pgEvalEdgePoint(geom, t) {
      const clamped = t < 0 ? 0 : (t > 1 ? 1 : t);
      if (geom.isCubic) {
        const u = 1 - clamped;
        const u2 = u * u;
        const t2 = clamped * clamped;
        return {
          x: u2 * u * geom.sx + 3 * u2 * clamped * geom.cp1x + 3 * u * t2 * geom.cp2x + t2 * clamped * geom.tx,
          y: u2 * u * geom.sy + 3 * u2 * clamped * geom.cp1y + 3 * u * t2 * geom.cp2y + t2 * clamped * geom.ty
        };
      }
      if (geom.isQuad) {
        const u = 1 - clamped;
        return {
          x: u * u * geom.sx + 2 * u * clamped * geom.cx + clamped * clamped * geom.tx,
          y: u * u * geom.sy + 2 * u * clamped * geom.cy + clamped * clamped * geom.ty
        };
      }
      return {
        x: geom.sx + (geom.tx - geom.sx) * clamped,
        y: geom.sy + (geom.ty - geom.sy) * clamped
      };
    }

    function pgNodeMatchesFilters(node) {
      if (pgState.layoutMode === 'layered' && pgState.activeLayerTier !== null && node._tier !== pgState.activeLayerTier) {
        return false;
      }
      if (pgState.activeClusterId && node.clusterId !== pgState.activeClusterId) {
        return false;
      }
      const q = pgState.searchQuery.trim().toLowerCase();
      if (q) {
        const directTextMatch = node.id.toLowerCase().indexOf(q) !== -1 || node.label.toLowerCase().indexOf(q) !== -1;
        if (directTextMatch) return true;
        if (pgState.semanticSearchEnabled && pgState.semanticScores && pgState.semanticScores.size > 0) {
          if (pgState.semanticScores.has(node.id)) return true;
          if (node.isSymbol && node.file && pgState.semanticScores.has(node.file)) return true;
          if (node.isFolder && Array.isArray(node.fileIds) && node.fileIds.some(function (fid) { return pgState.semanticScores.has(fid); })) {
            return true;
          }
        }
        return false;
      }
      return true;
    }

    function pgGetNodeScreenRadius(node, scale) {
      const base = (node && Number(node.radius)) ? Number(node.radius) : 4.2;
      const s = Number(scale) || 1;
      if (s <= 1) {
        return Math.max(2.0, base * Math.pow(Math.max(0.1, s), 0.25));
      }
      // Shrink screen-space dot radius gently as zoom increases so zoomed views stay crisp & airy
      const minR = (node && node.isGod) ? 3.8 : 2.2;
      return Math.max(minR, base / (1 + (s - 1) * 0.30));
    }

    function pgDrawRoundedRectPath(ctx, x, y, width, height, radius) {
      const r = Math.min(radius, width * 0.5, height * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function pgDrawGraph() {
      const canvas = document.getElementById('projectGraphCanvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = pgState.width || 600;
      const h = pgState.height || 420;
      const dpr = pgState.dpr || 1;
      const scale = pgState.camScale || 1;
      const uiScale = pgGetUiScale();
      const isLayered = pgState.layoutMode === 'layered';
      const isMacro = Boolean(pgState.graphData?.isMacro);

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const nodes = pgState.nodes;
      const edges = pgState.edges;
      if (!nodes.length) {
        ctx.restore();
        return;
      }

      const activeId = pgState.hoveredNodeId || pgState.selectedNodeId || '';
      const activeNeighbors = new Set();
      if (activeId) {
        activeNeighbors.add(activeId);
        const ins = pgState.inNeighbors.get(activeId) || [];
        const outs = pgState.outNeighbors.get(activeId) || [];
        for (let i = 0; i < ins.length; i++) activeNeighbors.add(ins[i].id);
        for (let i = 0; i < outs.length; i++) activeNeighbors.add(outs[i].id);
      }

      const rawQuery = pgState.searchQuery.trim();
      const hasSearch = Boolean(rawQuery);
      const hasQueryOrCluster = Boolean(rawQuery || pgState.activeClusterId || (isLayered && pgState.activeLayerTier !== null));
      const lens = pgState.lens || 'arch';
      const hasBlastWave = lens === 'blast' && pgState.blastWaveMap && pgState.blastWaveMap.size > 0;
      const hasCycleLens = lens === 'cycles';
      const hasAiSpotlight = Boolean(pgState.aiSpotlightMap && pgState.aiSpotlightMap.size > 0);
      const activeCycleNodes = hasCycleLens
        ? (pgState.activeCycleIdx >= 0 && pgState.activeCycleNodeSet && pgState.activeCycleNodeSet.size > 0
            ? pgState.activeCycleNodeSet
            : (isMacro ? pgState.macroCycleNodeSet : pgState.cycleNodeSet))
        : null;
      const activeCycleEdges = hasCycleLens
        ? (pgState.activeCycleIdx >= 0 && pgState.activeCycleEdgeSet && pgState.activeCycleEdgeSet.size > 0
            ? pgState.activeCycleEdgeSet
            : (isMacro ? pgState.macroCycleEdgeSet : pgState.cycleEdgeSet))
        : null;
      const hasActiveCycleHighlight = Boolean(hasCycleLens && activeCycleEdges && activeCycleEdges.size > 0);
      const hasPathLens = lens === 'path' && Boolean(
        (pgState.pathNodeSet && pgState.pathNodeSet.size > 0) || pgState.pathFrom
      );
      const hasPathHighlight = Boolean(lens === 'path' && pgState.pathEdgeSet && pgState.pathEdgeSet.size > 0);
      const hasHotspotsLens = lens === 'hotspots' && pgState.hotspotScoreMap && pgState.hotspotScoreMap.size > 0;
      const hasSemanticHeat = Boolean(pgState.semanticSearchEnabled && pgState.semanticScores && pgState.semanticScores.size > 0);
      const isSymbolsView = Boolean(pgState.graphData?.isSymbolsView || pgState.viewLevel === 'symbols');
      const lodTier = scale < 0.55 ? 0 : (scale < 1.35 ? 1 : 2);
      const bundleCentroids = (pgState.edgeBundling && typeof pgComputeBundleCentroids === 'function')
        ? pgComputeBundleCentroids(nodes, isLayered)
        : null;
      const halfW = w * 0.5;
      const halfH = h * 0.5;

      // Project nodes into screen space once per frame
      const baseCardScale = scale < 0.7 ? Math.max(0.58, scale / 0.7) : (scale > 2.0 ? Math.max(0.76, 1 / (1 + (scale - 2) * 0.12)) : 1);
      const cardScale = baseCardScale * uiScale;
      const folderTitleFontPx = Math.max(9, Math.round(10.5 * cardScale));
      const tierBounds = isLayered ? new Map() : null;
      const detachedNodesByTier = isLayered ? new Map() : null;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n._sx = (n.x - pgState.camX) * scale + halfW;
        n._sy = (n.y - pgState.camY) * scale + halfH;
        if (n.isFolder) {
          const textW = Math.min(138, Math.max(82, String(n.label || '').length * 6.3 + 28));
          const minTitleW = Math.min(18, String(n.label || '').length) * (folderTitleFontPx * 0.62) + 20 * uiScale;
          n._bw = Math.round(Math.max(textW * cardScale, minTitleW));
          n._bh = Math.round(36 * cardScale);
          n._sr = n._bw * 0.5;
          n._inView = n._sx >= -120 && n._sx <= w + 120 && n._sy >= -90 && n._sy <= h + 90;
        } else {
          n._bw = 0;
          n._bh = 0;
          n._sr = pgGetNodeScreenRadius(n, scale) * Math.min(1.25, Math.max(0.92, uiScale));
          n._inView = n._sx >= -90 && n._sx <= w + 90 && n._sy >= -90 && n._sy <= h + 90;
        }
        if (isLayered && typeof n._tier === 'number') {
          if (n._detachedFromLayer) {
            let dArr = detachedNodesByTier.get(n._tier);
            if (!dArr) {
              dArr = [];
              detachedNodesByTier.set(n._tier, dArr);
            }
            dArr.push(n);
          } else if (tierBounds) {
            const hw = n.isFolder ? (n._bw * 0.5) : n._sr;
            const hh = n.isFolder ? (n._bh * 0.5) : n._sr;
            let tb = tierBounds.get(n._tier);
            if (!tb) {
              tb = { minSx: n._sx - hw, maxSx: n._sx + hw, minSy: n._sy - hh, maxSy: n._sy + hh, count: 1 };
              tierBounds.set(n._tier, tb);
            } else {
              if (n._sx - hw < tb.minSx) tb.minSx = n._sx - hw;
              if (n._sx + hw > tb.maxSx) tb.maxSx = n._sx + hw;
              if (n._sy - hh < tb.minSy) tb.minSy = n._sy - hh;
              if (n._sy + hh > tb.maxSy) tb.maxSy = n._sy + hh;
              tb.count += 1;
            }
          }
        }
      }

      // Draw Combo Swimlanes (1) + Focus Lane Highlight (2) + Node-Bounding Layer Frames (3); sticky headers draw after nodes
      pgState.layerHeaderRects = [];
      let deferredLayeredHeaders = null;
      if (isLayered && pgState.layeredColumns.length > 0) {
        const cols = pgState.layeredColumns;
        ctx.save();
        const headerH = Math.round(24 * uiScale);
        const headerY = 6;
        const laneTop = headerY + headerH + 6;
        const laneBottom = Math.max(laneTop + 40, h - 10);
        const laneHeight = laneBottom - laneTop;

        const activeNodeObj = activeId ? pgState.nodeById.get(activeId) : null;
        const hasLockedLayer = pgState.activeLayerTier !== null;
        const focusTier = hasLockedLayer
          ? pgState.activeLayerTier
          : (pgState.hoveredLayerTier !== null
              ? pgState.hoveredLayerTier
              : (activeNodeObj && typeof activeNodeObj._tier === 'number' ? activeNodeObj._tier : null));

        const colScreenXs = [];
        for (let c = 0; c < cols.length; c++) {
          colScreenXs.push((cols[c].x - pgState.camX) * scale + halfW);
        }
        const sortedOrder = [];
        for (let c = 0; c < cols.length; c++) sortedOrder.push(c);
        sortedOrder.sort(function (a, b) {
          return (colScreenXs[a] - colScreenXs[b]) || (a - b);
        });

        let minPositiveGap = Infinity;
        for (let pos = 1; pos < sortedOrder.length; pos++) {
          const g = Math.abs(colScreenXs[sortedOrder[pos]] - colScreenXs[sortedOrder[pos - 1]]);
          if (g > 1 && g < minPositiveGap) minPositiveGap = g;
        }
        const fallbackStep = Math.min(w * 0.72, 260 * Math.max(0.7, scale) * uiScale);
        const colStepScreen = sortedOrder.length > 1
          ? (Number.isFinite(minPositiveGap) ? minPositiveGap : 0)
          : fallbackStep;
        const outerHalfStep = Math.max(
          (sortedOrder.length > 1 ? Math.max(colStepScreen, 110 * Math.max(0.65, scale) * uiScale) * 0.5 : Math.min(w * 0.42, 140 * Math.max(0.7, scale) * uiScale)),
          68 * uiScale
        );

        const laneBounds = new Array(cols.length);
        for (let pos = 0; pos < sortedOrder.length; pos++) {
          const c = sortedOrder[pos];
          const cx = colScreenXs[c];
          const left = pos === 0 ? (cx - outerHalfStep) : ((colScreenXs[sortedOrder[pos - 1]] + cx) * 0.5);
          const right = pos === sortedOrder.length - 1 ? (cx + outerHalfStep) : ((cx + colScreenXs[sortedOrder[pos + 1]]) * 0.5);
          laneBounds[c] = { left, right, width: Math.max(12, right - left) };
        }

        // Pass 1: Vertical swimlane stripes + separators + focus wash
        for (let pos = 0; pos < sortedOrder.length; pos++) {
          const c = sortedOrder[pos];
          const col = cols[c];
          const lb = laneBounds[c];
          if (lb.right < -80 || lb.left > w + 80) continue;
          const pal = pgGetLayerRolePalette(col.role, c);
          const tb = tierBounds ? tierBounds.get(col.tier) : null;
          const hasAttached = Boolean(tb && tb.count > 0);
          const isFocused = focusTier === col.tier;
          const isDimmed = hasLockedLayer && pgState.activeLayerTier !== col.tier;

          if (isFocused) {
            ctx.fillStyle = 'rgba(' + pal.accentRgb + ', 0.11)';
          } else if (isDimmed) {
            ctx.fillStyle = 'rgba(10, 11, 13, 0.28)';
          } else {
            const baseAlpha = (c % 2 === 0) ? pal.laneEvenAlpha : pal.laneOddAlpha;
            const bgAlpha = hasAttached ? baseAlpha : (baseAlpha * 0.45);
            ctx.fillStyle = 'rgba(' + pal.accentRgb + ', ' + bgAlpha + ')';
          }
          pgDrawRoundedRectPath(ctx, lb.left + 2, laneTop, Math.max(8, lb.width - 4), laneHeight, Math.round(5 * uiScale));
          ctx.fill();

          if (pos > 0 && lb.left >= -20 && lb.left <= w + 20) {
            const prevFocus = focusTier === cols[sortedOrder[pos - 1]].tier;
            ctx.strokeStyle = (isFocused || prevFocus)
              ? ('rgba(' + pal.accentRgb + ', 0.28)')
              : 'rgba(255, 255, 255, 0.07)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(lb.left, laneTop + 4);
            ctx.lineTo(lb.left, laneBottom - 4);
            ctx.stroke();
          }

          if (isFocused && colScreenXs[c] >= -40 && colScreenXs[c] <= w + 40) {
            ctx.save();
            ctx.strokeStyle = 'rgba(' + pal.accentRgb + ', 0.22)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 5]);
            ctx.beginPath();
            ctx.moveTo(colScreenXs[c], laneTop + 4);
            ctx.lineTo(colScreenXs[c], laneBottom - 4);
            ctx.stroke();
            ctx.restore();
          }
        }

        // Pass 2: Compact rounded frames wrapping attached nodes only (zero ghost boxes when empty)
        const padX = Math.round((isMacro ? 18 : 22) * uiScale);
        const padTop = Math.round(16 * uiScale);
        const padBot = Math.round(22 * uiScale);
        const cornerFontPx = Math.max(8.5, Math.round(9.2 * uiScale));
        for (let c = 0; c < cols.length; c++) {
          const col = cols[c];
          const lb = laneBounds[c];
          const tb = tierBounds ? tierBounds.get(col.tier) : null;
          if (!tb || tb.count === 0) continue;
          const pal = pgGetLayerRolePalette(col.role, c);
          const isFocused = focusTier === col.tier;
          const isDimmed = hasLockedLayer && pgState.activeLayerTier !== col.tier;

          const rawLeft = Math.min(colScreenXs[c] - 28 * uiScale, tb.minSx - padX);
          const rawRight = Math.max(colScreenXs[c] + 28 * uiScale, tb.maxSx + padX);
          const fLeft = lb.width > 34 ? Math.max(lb.left + 4, rawLeft) : rawLeft;
          const fRight = lb.width > 34 ? Math.min(lb.right - 4, rawRight) : rawRight;
          const fW = Math.max(22, fRight - fLeft);
          const fTop = Math.max(laneTop + 2, tb.minSy - padTop);
          const fBot = Math.min(laneBottom - 2, tb.maxSy + padBot);
          const fH = fBot - fTop;
          if (fH <= 14 || fRight < -60 || fLeft > w + 60) continue;

          pgDrawRoundedRectPath(ctx, fLeft, fTop, fW, fH, Math.round(6 * uiScale));
          if (isFocused) {
            ctx.fillStyle = 'rgba(' + pal.accentRgb + ', 0.095)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(' + pal.accentRgb + ', 0.68)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else {
            ctx.fillStyle = isDimmed
              ? 'rgba(18, 19, 22, 0.24)'
              : 'rgba(18, 19, 22, 0.56)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(' + pal.accentRgb + ', ' + (isDimmed ? '0.09' : '0.28') + ')';
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          if (fTop > laneTop + 18 * uiScale && fW >= 68 * uiScale) {
            const cornerTxt = (isRu() ? col.shortRu : col.shortEn) + ' · ' + tb.count;
            ctx.save();
            ctx.font = '700 ' + cornerFontPx + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
            const badgeW = Math.min(fW - 12, ctx.measureText(cornerTxt).width + 12 * uiScale);
            const badgeH = Math.round(15 * uiScale);
            const bx = fLeft + 8;
            const by = fTop - badgeH * 0.5;
            pgDrawRoundedRectPath(ctx, bx, by, badgeW, badgeH, 4);
            ctx.fillStyle = '#121316';
            ctx.fill();
            ctx.strokeStyle = 'rgba(' + pal.accentRgb + ', ' + (isFocused ? '0.65' : '0.35') + ')';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = isFocused ? pal.accentHex : '#e4e6eb';
            ctx.fillText(cornerTxt, bx + badgeW * 0.5, by + badgeH * 0.5 + 0.5);
            ctx.restore();
          }
        }

        // Subtle focus tether from hovered/filtered layer header to detached nodes of that layer
        if (focusTier !== null && detachedNodesByTier && detachedNodesByTier.has(focusTier)) {
          const focusColIdx = cols.findIndex(function (c) { return c.tier === focusTier; });
          if (focusColIdx >= 0) {
            const fCol = cols[focusColIdx];
            const fPal = pgGetLayerRolePalette(fCol.role, focusColIdx);
            const fHdrX = Math.max(12, Math.min(w - 12, colScreenXs[focusColIdx]));
            const fHdrY = headerY + headerH;
            const dNodes = detachedNodesByTier.get(focusTier) || [];
            ctx.save();
            ctx.strokeStyle = 'rgba(' + fPal.accentRgb + ', 0.42)';
            ctx.lineWidth = 1.1;
            ctx.setLineDash([4, 4]);
            for (let di = 0; di < dNodes.length; di++) {
              const dn = dNodes[di];
              ctx.beginPath();
              ctx.moveTo(fHdrX, fHdrY);
              ctx.quadraticCurveTo(fHdrX, (fHdrY + dn._sy) * 0.5, dn._sx, dn._sy);
              ctx.stroke();
            }
            ctx.restore();
          }
        }

        // Defer sticky clickable/draggable header rail until after nodes & labels so nodes never obscure headers
        deferredLayeredHeaders = {
          cols,
          sortedOrder,
          colScreenXs,
          laneBounds,
          colStepScreen,
          headerY,
          headerH,
          focusTier,
        };
        ctx.restore();
      }

      // Draw soft subsystem islands (Convex Hulls) in Files + Cloud mode
      if (!isMacro && !isLayered && pgState.showHulls) {
        const groups = new Map();
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const gk = n.subsystemKey || n.clusterId;
          if (!gk) continue;
          let arr = groups.get(gk);
          if (!arr) {
            arr = [];
            groups.set(gk, arr);
          }
          arr.push({ x: n._sx, y: n._sy, node: n });
        }
        ctx.save();
        ctx.font = '700 10px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const hullLabelQueue = [];
        for (const [gk, pts] of groups.entries()) {
          if (pts.length < 3) continue;
          let cx = 0, cy = 0;
          for (let i = 0; i < pts.length; i++) {
            cx += pts[i].x;
            cy += pts[i].y;
          }
          cx /= pts.length;
          cy /= pts.length;
          const hull = pgComputeConvexHull(pts);
          if (hull.length < 3) continue;
          const padded = hull.map(function (p) {
            const dx = p.x - cx;
            const dy = p.y - cy;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            return { x: p.x + (dx / d) * 18, y: p.y + (dy / d) * 18 };
          });
          const col = pgGetClusterColor(gk);
          ctx.beginPath();
          const last = padded[padded.length - 1];
          const first = padded[0];
          ctx.moveTo((last.x + first.x) * 0.5, (last.y + first.y) * 0.5);
          for (let k = 0; k < padded.length; k++) {
            const cur = padded[k];
            const nxt = padded[(k + 1) % padded.length];
            ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + nxt.x) * 0.5, (cur.y + nxt.y) * 0.5);
          }
          ctx.closePath();
          ctx.globalAlpha = 0.08;
          ctx.fillStyle = col;
          ctx.fill();
          ctx.globalAlpha = 0.32;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          let topY = Infinity;
          for (let k = 0; k < padded.length; k++) {
            if (padded[k].y < topY) topY = padded[k].y;
          }
          hullLabelQueue.push({
            text: gk + ' · ' + pts.length,
            count: pts.length,
            col,
            cx,
            baseY: Math.max(12, topY + 10)
          });
        }
        hullLabelQueue.sort(function (a, b) {
          return b.count - a.count;
        });
        const placedHullLabels = [];
        for (let hi = 0; hi < hullLabelQueue.length; hi++) {
          const hl = hullLabelQueue[hi];
          const tw = (typeof ctx.measureText === 'function' ? ctx.measureText(hl.text).width : hl.text.length * 6) + 10;
          const x1 = Math.max(6, Math.min(w - tw - 6, hl.cx - tw * 0.5));
          const x2 = x1 + tw;
          const drawX = (x1 + x2) * 0.5;
          const yOffsets = [0, 14, -14, 28];
          let chosenY = null;
          for (let oi = 0; oi < yOffsets.length; oi++) {
            const candY = Math.max(12, Math.min(h - 18, hl.baseY + yOffsets[oi]));
            const y1 = candY - 7;
            const y2 = candY + 7;
            let hit = false;
            for (let pi = 0; pi < placedHullLabels.length; pi++) {
              const b = placedHullLabels[pi];
              if (x1 < b.x2 && x2 > b.x1 && y1 < b.y2 && y2 > b.y1) {
                hit = true;
                break;
              }
            }
            if (!hit) {
              chosenY = candY;
              placedHullLabels.push({ x1, y1, x2, y2 });
              break;
            }
          }
          if (chosenY !== null) {
            ctx.globalAlpha = 0.78;
            ctx.fillStyle = hl.col;
            ctx.fillText(hl.text, drawX, chosenY);
          }
        }
        ctx.restore();
      }

      // Optional Zero-Deps WebGL2 Instanced layer for large graphs (5k-50k+ nodes)
      const wantWebgl = typeof pgShouldUseWebglRenderer === 'function' && pgShouldUseWebglRenderer(nodes.length);
      const renderedWebgl = Boolean(wantWebgl && typeof pgRenderWebgl2Scene === 'function' && pgRenderWebgl2Scene({
        nodes,
        edges,
        w,
        h,
        dpr,
        scale,
        isLayered,
        isMacro,
        activeId,
        activeNeighbors,
        hasQueryOrCluster,
        hasBlastWave,
        hasCycleLens,
        activeCycleNodes,
        activeCycleEdges,
        hasActiveCycleHighlight,
        hasPathLens,
        hasPathHighlight,
        hasHotspotsLens,
        hasSemanticHeat
      }));
      pgState.webglActive = renderedWebgl;
      if (!renderedWebgl && typeof pgHideWebglCanvas === 'function') {
        pgHideWebglCanvas();
      }

      // Draw edges in screen space (skip background bulk in WebGL2 mode, keeping active/lens glow beams)
      const edgeMidBadges = [];
      const activePulseGeoms = [];
      const edgeLoopLimit = (renderedWebgl && !activeId && !hasBlastWave && !hasActiveCycleHighlight && !hasPathHighlight) ? 0 : edges.length;
      for (let i = 0; i < edgeLoopLimit; i++) {
        const e = edges[i];
        if (!e.source._inView && !e.target._inView) continue;
        const sMatch = pgNodeMatchesFilters(e.source);
        const tMatch = pgNodeMatchesFilters(e.target);
        let isActiveEdge = Boolean(activeId && (e.source.id === activeId || e.target.id === activeId));
        const edgePairKey = e.source.id + '->' + e.target.id;
        let isLensEdge = false;
        let lensEdgeColor = '';

        if (hasBlastWave) {
          const sHop = pgState.blastWaveMap.get(e.source.id);
          const tHop = pgState.blastWaveMap.get(e.target.id);
          if (sHop !== undefined && tHop !== undefined && sHop !== tHop) {
            isLensEdge = true;
            lensEdgeColor = typeof pgGetHopColor === 'function'
              ? pgGetHopColor(Math.max(sHop, tHop))
              : '#ff9f0a';
          }
        } else if (hasActiveCycleHighlight) {
          if (activeCycleEdges.has(edgePairKey)) {
            isLensEdge = true;
            lensEdgeColor = '#f04848';
          }
        } else if (hasPathHighlight) {
          if (pgState.pathEdgeSet.has(edgePairKey)) {
            isLensEdge = true;
            lensEdgeColor = '#f04848';
          }
        }
        if (renderedWebgl && !isActiveEdge && !isLensEdge) continue;

        let alpha = 1;
        if (hasBlastWave || hasActiveCycleHighlight || hasPathHighlight) {
          if (isLensEdge) {
            alpha = 0.96;
            isActiveEdge = true;
          } else if (isActiveEdge) {
            alpha *= 0.28;
          } else {
            alpha *= 0.11;
          }
        } else if (activeId && !isActiveEdge) {
          alpha *= 0.14;
        }
        if (hasQueryOrCluster && (!sMatch || !tMatch)) alpha *= 0.15;

        const sx = e.source.isFolder ? (e.source._sx + (e.target._sx >= e.source._sx ? e.source._bw * 0.45 : -e.source._bw * 0.45)) : e.source._sx;
        const sy = e.source._sy;
        const tx = e.target.isFolder ? (e.target._sx + (e.target._sx >= e.source._sx ? -e.target._bw * 0.48 : e.target._bw * 0.48)) : e.target._sx;
        const ty = e.target._sy;

        ctx.save();
        ctx.globalAlpha = alpha;
        if (e.kind === 'doc') {
          ctx.setLineDash([4, 4]);
        }
        const weightWidth = isMacro ? (1.05 + Math.min(2.4, Math.log1p(e.weight || 1) * 0.75)) : 0.9;
        let edgeStrokeColor;
        if (isLensEdge && lensEdgeColor) {
          edgeStrokeColor = lensEdgeColor;
          ctx.strokeStyle = edgeStrokeColor;
          ctx.lineWidth = Math.max(2.1, weightWidth + 0.85);
        } else if (isActiveEdge) {
          const isIncoming = e.target.id === activeId;
          edgeStrokeColor = isIncoming
            ? 'rgba(240, 72, 72, 0.92)'
            : 'rgba(34, 197, 94, 0.86)';
          ctx.strokeStyle = edgeStrokeColor;
          ctx.lineWidth = Math.max(1.7, weightWidth + 0.45);
        } else {
          edgeStrokeColor = 'rgba(228, 230, 235, 0.16)';
          ctx.strokeStyle = edgeStrokeColor;
          ctx.lineWidth = weightWidth;
        }

        let ux = 1, uy = 0, tipX = tx, tipY = ty;
        let midX = (sx + tx) * 0.5;
        let midY = (sy + ty) * 0.5;
        let pulseGeom = null;
        const bundledGeom = (typeof pgComputeBundledEdgeGeom === 'function')
          ? pgComputeBundledEdgeGeom(e, sx, sy, tx, ty, isLayered, isMacro, bundleCentroids, isActiveEdge)
          : null;

        if (bundledGeom) {
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          if (bundledGeom.isCubic) {
            ctx.bezierCurveTo(bundledGeom.cp1x, bundledGeom.cp1y, bundledGeom.cp2x, bundledGeom.cp2y, tx, ty);
          } else if (bundledGeom.isQuad) {
            ctx.quadraticCurveTo(bundledGeom.cx, bundledGeom.cy, tx, ty);
          } else {
            ctx.lineTo(tx, ty);
          }
          ctx.stroke();
          midX = bundledGeom.midX;
          midY = bundledGeom.midY;
          ux = bundledGeom.ux;
          uy = bundledGeom.uy;
          tipX = bundledGeom.tipX;
          tipY = bundledGeom.tipY;
          pulseGeom = {
            ...bundledGeom,
            color: edgeStrokeColor,
            weight: e.weight || 1,
            phase: e._phase || 0,
            alpha
          };
        } else if (isLayered) {
          const dxSpan = Math.max(42, Math.abs(tx - sx) * 0.48);
          const dir = tx >= sx ? 1 : -1;
          const bidirSign = e._isBidir ? (e.source.id < e.target.id ? -1 : 1) : 0;
          const bidirShift = bidirSign * 16;
          const cp1x = sx + dxSpan * dir;
          const cp1y = sy + bidirShift;
          const cp2x = tx - dxSpan * dir;
          const cp2y = ty + bidirShift;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, tx, ty);
          ctx.stroke();

          midX = 0.125 * sx + 0.375 * cp1x + 0.375 * cp2x + 0.125 * tx;
          midY = 0.125 * sy + 0.375 * cp1y + 0.375 * cp2y + 0.125 * ty;
          const tanX = tx - cp2x;
          const tanY = ty - cp2y;
          const tanLen = Math.sqrt(tanX * tanX + tanY * tanY) || 1;
          ux = tanX / tanLen;
          uy = tanY / tanLen;
          const endOffset = e.target.isFolder ? 2 : (e.target._sr + 2.5);
          tipX = tx - ux * endOffset;
          tipY = ty - uy * endOffset;
          pulseGeom = {
            isCubic: true,
            sx, sy, cp1x, cp1y, cp2x, cp2y, tx, ty,
            color: edgeStrokeColor,
            weight: e.weight || 1,
            phase: e._phase || 0,
            alpha
          };
        } else if (e._isBidir) {
          const dx = tx - sx;
          const dy = ty - sy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = -dy / dist;
          const ny = dx / dist;
          const cx = (sx + tx) * 0.5 + nx * 14;
          const cy = (sy + ty) * 0.5 + ny * 14;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.quadraticCurveTo(cx, cy, tx, ty);
          ctx.stroke();

          midX = 0.25 * sx + 0.5 * cx + 0.25 * tx;
          midY = 0.25 * sy + 0.5 * cy + 0.25 * ty;
          const tanX = tx - cx;
          const tanY = ty - cy;
          const tanLen = Math.sqrt(tanX * tanX + tanY * tanY) || 1;
          ux = tanX / tanLen;
          uy = tanY / tanLen;
          const endOffset = e.target.isFolder ? 2 : (e.target._sr + 2.5);
          tipX = tx - ux * endOffset;
          tipY = ty - uy * endOffset;
          pulseGeom = {
            isQuad: true,
            sx, sy, cx, cy, tx, ty,
            color: edgeStrokeColor,
            weight: e.weight || 1,
            phase: e._phase || 0,
            alpha
          };
        } else {
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(tx, ty);
          ctx.stroke();

          const dx = tx - sx;
          const dy = ty - sy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          ux = dx / dist;
          uy = dy / dist;
          const endOffset = e.target.isFolder ? 2 : (e.target._sr + 2.5);
          tipX = tx - ux * endOffset;
          tipY = ty - uy * endOffset;
          pulseGeom = {
            sx, sy, tx, ty,
            color: edgeStrokeColor,
            weight: e.weight || 1,
            phase: e._phase || 0,
            alpha
          };
        }

        if (isActiveEdge || (lodTier > 0 && scale > 0.72) || isMacro) {
          const arrowLen = isActiveEdge ? 6.5 : 4.5;
          ctx.setLineDash([]);
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - ux * arrowLen - uy * arrowLen * 0.45, tipY - uy * arrowLen + ux * arrowLen * 0.45);
          ctx.lineTo(tipX - ux * arrowLen + uy * arrowLen * 0.45, tipY - uy * arrowLen - ux * arrowLen * 0.45);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();

        if (isActiveEdge && alpha > 0.18 && pulseGeom) {
          activePulseGeoms.push(pulseGeom);
        }
        if (isMacro && isActiveEdge && e.weight > 1) {
          edgeMidBadges.push({ x: midX, y: midY, text: String(e.weight), color: edgeStrokeColor });
        }
      }

      // Draw smooth "fiber-optic" directional signal pulses along active edges
      if (activePulseGeoms.length > 0 && !pgPrefersReducedMotion()) {
        const nowSec = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) * 0.001;
        const speedPerSec = 0.42;
        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 0; i < activePulseGeoms.length; i++) {
          const g = activePulseGeoms[i];
          const packetCount = g.weight >= 10 ? 2 : 1;
          for (let p = 0; p < packetCount; p++) {
            const tHead = (nowSec * speedPerSec + g.phase + p * 0.5) % 1;
            const headPt = pgEvalEdgePoint(g, tHead);
            const segs = 5;
            const tailSpan = 0.14;
            for (let s = 0; s < segs; s++) {
              const t0 = Math.max(0, tHead - tailSpan * ((segs - s) / segs));
              const t1 = Math.max(0, tHead - tailSpan * ((segs - s - 1) / segs));
              if (t1 <= t0) continue;
              const p0 = pgEvalEdgePoint(g, t0);
              const p1 = pgEvalEdgePoint(g, t1);
              const frac = (s + 1) / segs;
              ctx.globalAlpha = g.alpha * frac * 0.72;
              ctx.strokeStyle = g.color;
              ctx.lineWidth = 1.2 + frac * 1.4;
              ctx.beginPath();
              ctx.moveTo(p0.x, p0.y);
              ctx.lineTo(p1.x, p1.y);
              ctx.stroke();
            }

            // Soft outer halo + crisp bright core dot
            ctx.globalAlpha = g.alpha * 0.28;
            ctx.fillStyle = g.color;
            ctx.beginPath();
            ctx.arc(headPt.x, headPt.y, 4.4, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = g.alpha * 0.96;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(headPt.x, headPt.y, 2.0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // Draw edge weight pills for active macro folder links
      if (edgeMidBadges.length > 0) {
        ctx.save();
        ctx.font = '700 ' + Math.max(8.5, Math.round(9 * uiScale)) + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < edgeMidBadges.length; i++) {
          const b = edgeMidBadges[i];
          const bw = Math.max(16, ctx.measureText(b.text).width + 8);
          pgDrawRoundedRectPath(ctx, b.x - bw * 0.5, b.y - 7.5, bw, 15, 4);
          ctx.fillStyle = '#121316';
          ctx.fill();
          ctx.strokeStyle = b.color;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = '#e4e6eb';
          ctx.fillText(b.text, b.x, b.y + 0.5);
        }
        ctx.restore();
      }

      // Draw nodes (folder cards vs file dots) and collect ultra-compact label candidates
      const showLabels = pgState.showLabels;
      const labelCandidates = [];

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n._inView) continue;
        const color = pgGetClusterColor(n.clusterId);
        const isSelected = n.id === pgState.selectedNodeId;
        const isHovered = n.id === pgState.hoveredNodeId;
        const isNeighbor = activeId ? activeNeighbors.has(n.id) : true;
        const matchesFilter = pgNodeMatchesFilters(n);
        const waveHop = hasBlastWave ? pgState.blastWaveMap.get(n.id) : undefined;
        const isWaveNode = waveHop !== undefined;
        const isCycleNode = Boolean(hasCycleLens && activeCycleNodes && activeCycleNodes.has(n.id));
        const isOrphanNode = Boolean(!n.isFolder && pgState.orphanSet && pgState.orphanSet.has(n.id));
        const isPathNode = Boolean(hasPathLens && ((pgState.pathNodeSet && pgState.pathNodeSet.has(n.id)) || n.id === pgState.pathFrom || n.id === pgState.pathTo));
        const isPathEndpoint = Boolean(hasPathLens && (n.id === pgState.pathFrom || n.id === pgState.pathTo));
        const isCartNode = Boolean(
          pgState.contextCart && (
            pgState.contextCart.has(n.id) ||
            (n.isFolder && Array.isArray(n.fileIds) && n.fileIds.some(function (fid) { return pgState.contextCart.has(fid); }))
          )
        );
        const isDiffNode = Boolean(
          pgState.gitDiffSet && (
            pgState.gitDiffSet.has(n.id) ||
            (n.isFolder && Array.isArray(n.fileIds) && n.fileIds.some(function (fid) { return pgState.gitDiffSet.has(fid); }))
          )
        );
        let hotspotScore = 0;
        if (hasHotspotsLens) {
          if (n.isFolder && Array.isArray(n.fileIds)) {
            for (let k = 0; k < n.fileIds.length; k++) {
              const hs = pgState.hotspotScoreMap.get(n.fileIds[k]) || 0;
              if (hs > hotspotScore) hotspotScore = hs;
            }
          } else {
            hotspotScore = pgState.hotspotScoreMap.get(n.isSymbol && n.file ? n.file : n.id) || 0;
          }
        }
        let semanticScore = 0;
        if (hasSemanticHeat) {
          if (n.isFolder && Array.isArray(n.fileIds)) {
            for (let k = 0; k < n.fileIds.length; k++) {
              const ss = pgState.semanticScores.get(n.fileIds[k]) || 0;
              if (ss > semanticScore) semanticScore = ss;
            }
          } else {
            semanticScore = pgState.semanticScores.get(n.isSymbol && n.file ? n.file : n.id) || 0;
          }
        }

        const aiRank = hasAiSpotlight ? (pgState.aiSpotlightMap.get(n.id) || 0) : 0;

        let alpha = 1;
        if (hasBlastWave) {
          if (!isWaveNode) alpha *= 0.16;
        } else if (hasCycleLens && activeCycleNodes && activeCycleNodes.size > 0) {
          if (!isCycleNode) alpha *= (isOrphanNode ? 0.55 : 0.15);
        } else if (hasHotspotsLens) {
          if (hotspotScore <= 0 && !isSelected && !isHovered) alpha *= 0.24;
        } else if (hasPathLens && pgState.pathNodeSet && pgState.pathNodeSet.size > 0) {
          if (!isPathNode) alpha *= 0.15;
        } else if (hasAiSpotlight) {
          if (!aiRank && !isSelected && !isHovered) alpha *= 0.24;
        } else if (activeId && !isNeighbor) {
          alpha *= 0.22;
        }
        if (hasQueryOrCluster && !matchesFilter) alpha *= 0.18;

        if (!renderedWebgl) {
          ctx.save();
          ctx.globalAlpha = alpha;

          if (n.isFolder) {
            const x0 = n._sx - n._bw * 0.5;
            const y0 = n._sy - n._bh * 0.5;
            pgDrawRoundedRectPath(ctx, x0, y0, n._bw, n._bh, 5 * cardScale);
            ctx.fillStyle = '#14161a';
            ctx.fill();
            let cardBorderColor = '#2a2d35';
            let cardBorderWidth = 1.1;
            if (isWaveNode && typeof pgGetHopColor === 'function') {
              cardBorderColor = pgGetHopColor(waveHop);
              cardBorderWidth = waveHop === 0 ? 2.4 : 1.7;
            } else if (isCycleNode) {
              cardBorderColor = '#f04848';
              cardBorderWidth = 2.1;
            } else if (hotspotScore > 0.15 && typeof pgGetHotspotColor === 'function') {
              cardBorderColor = pgGetHotspotColor(hotspotScore);
              cardBorderWidth = hotspotScore >= 0.65 ? 2.3 : 1.7;
            } else if (semanticScore > 0.15) {
              cardBorderColor = '#22c55e';
              cardBorderWidth = 2.1;
            } else if (isPathNode) {
              cardBorderColor = '#f04848';
              cardBorderWidth = isPathEndpoint ? 2.4 : 1.8;
            } else if (isSelected || isHovered) {
              cardBorderColor = '#f04848';
              cardBorderWidth = 2;
            } else if (n.isFragile) {
              cardBorderColor = '#f04848';
            }
            ctx.lineWidth = cardBorderWidth;
            ctx.strokeStyle = cardBorderColor;
            ctx.stroke();

            if (isCartNode) {
              pgDrawRoundedRectPath(ctx, x0 - 2.5, y0 - 2.5, n._bw + 5, n._bh + 5, 6 * cardScale);
              ctx.strokeStyle = '#22c55e';
              ctx.lineWidth = 1.6;
              ctx.stroke();
            }

            if (aiRank > 0) {
              pgDrawRoundedRectPath(ctx, x0 - 3, y0 - 3, n._bw + 6, n._bh + 6, 6 * cardScale);
              ctx.strokeStyle = '#f04848';
              ctx.lineWidth = 2.1;
              ctx.stroke();
            }

            // Left subsystem color stripe
            if (typeof ctx.clip === 'function') {
              ctx.save();
              pgDrawRoundedRectPath(ctx, x0, y0, n._bw, n._bh, 5 * cardScale);
              ctx.clip();
              ctx.fillStyle = color;
              ctx.fillRect(x0, y0, 3.5 * cardScale, n._bh);
              ctx.restore();
            }

            if (isDiffNode) {
              ctx.beginPath();
              ctx.arc(x0 + n._bw - 6 * cardScale, y0 + 6 * cardScale, 3.2, 0, Math.PI * 2);
              ctx.fillStyle = '#f59e0b';
              ctx.fill();
            }

            if (cardScale >= 0.56) {
              const titleFont = Math.max(9, Math.round(10.5 * cardScale));
              const subFont = Math.max(8, Math.round(9 * cardScale));
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.font = '700 ' + titleFont + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
              ctx.fillStyle = '#eef0f3';
              let titleTxt = String(n.label || '');
              const maxTextW = Math.max(24, n._bw - 15 * cardScale);
              if (ctx.measureText(titleTxt).width > maxTextW) {
                while (titleTxt.length > 3 && ctx.measureText(titleTxt + '…').width > maxTextW) {
                  titleTxt = titleTxt.slice(0, -1);
                }
                titleTxt += '…';
              }
              ctx.fillText(titleTxt, x0 + 9 * cardScale, n._sy - 5.5 * cardScale);

              ctx.font = '500 ' + subFont + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
              ctx.fillStyle = '#8a8f98';
              const metaTxt = L(n.filesCount + ' ф.', n.filesCount + ' f.') +
                (n.godCount > 0 ? ' · HUB' : '') +
                (n.fragileCount > 0 ? ' · !' : '');
              ctx.fillText(metaTxt, x0 + 9 * cardScale, n._sy + 7 * cardScale);
            }
            if (isLayered && n._detachedFromLayer && typeof n._tier === 'number') {
              const dCol = (pgState.layeredColumns || []).find(function (c) { return c.tier === n._tier; });
              if (dCol) {
                const dPal = pgGetLayerRolePalette(dCol.role, dCol.index);
                const dTxt = isRu() ? dCol.shortRu : dCol.shortEn;
                const dFont = Math.max(8, Math.round(8.5 * uiScale));
                ctx.save();
                ctx.font = '700 ' + dFont + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
                const dW = Math.max(22, ctx.measureText(dTxt).width + 10 * uiScale);
                const dH = Math.round(13 * uiScale);
                const dX = x0 + n._bw - dW + 4;
                const dY = y0 - dH * 0.65;
                pgDrawRoundedRectPath(ctx, dX, dY, dW, dH, dH * 0.5);
                ctx.fillStyle = 'rgba(13, 19, 34, 0.95)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(' + dPal.accentRgb + ', 0.72)';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = dPal.accentHex;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(dTxt, dX + dW * 0.5, dY + dH * 0.5 + 0.4);
                ctx.restore();
              }
            }
            ctx.restore();
            continue;
          }

          if (isWaveNode && typeof pgGetHopColor === 'function') {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + (waveHop === 0 ? 4.4 : 3.2), 0, Math.PI * 2);
            ctx.strokeStyle = pgGetHopColor(waveHop);
            ctx.lineWidth = waveHop === 0 ? 2.4 : 1.7;
            ctx.stroke();
          } else if (isCycleNode) {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + 3.6, 0, Math.PI * 2);
            ctx.strokeStyle = '#f04848';
            ctx.lineWidth = 2.0;
            ctx.stroke();
          } else if (hasCycleLens && isOrphanNode) {
            ctx.save();
            ctx.setLineDash([2.5, 2.5]);
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + 3.2, 0, Math.PI * 2);
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1.4;
            ctx.stroke();
            ctx.restore();
          } else if (isPathNode) {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + (isPathEndpoint ? 4.5 : 3.2), 0, Math.PI * 2);
            ctx.strokeStyle = '#f04848';
            ctx.lineWidth = isPathEndpoint ? 2.4 : 1.7;
            ctx.stroke();
          } else if (hotspotScore > 0.12 && typeof pgGetHotspotColor === 'function') {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + 2.4 + hotspotScore * 3.2, 0, Math.PI * 2);
            ctx.strokeStyle = pgGetHotspotColor(hotspotScore);
            ctx.lineWidth = hotspotScore >= 0.65 ? 2.3 : 1.5;
            ctx.stroke();
          }

          if (semanticScore > 0.12) {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + 3.5 + semanticScore * 2.5, 0, Math.PI * 2);
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2.0;
            ctx.stroke();
          }

          if (n.isFragile) {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + 2.5, 0, Math.PI * 2);
            ctx.strokeStyle = '#ff453a';
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }

          if (isCartNode) {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + 5.2, 0, Math.PI * 2);
            ctx.strokeStyle = '#30d158';
            ctx.lineWidth = 1.8;
            ctx.stroke();
          }

          if (isSelected || isHovered || n.hop === 0) {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + (isSelected ? 3.8 : 2.8), 0, Math.PI * 2);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = isSelected ? 1.9 : 1.4;
            ctx.stroke();
          }

          const fillNodeColor = (hotspotScore >= 0.45 && typeof pgGetHotspotColor === 'function')
            ? pgGetHotspotColor(hotspotScore)
            : color;
              if (n.isSymbol && n.kind === 'class') {
              const rs = n._sr * 1.12;
              ctx.beginPath();
              ctx.moveTo(n._sx, n._sy - rs);
              ctx.lineTo(n._sx + rs, n._sy);
              ctx.lineTo(n._sx, n._sy + rs);
              ctx.lineTo(n._sx - rs, n._sy);
              ctx.closePath();
              ctx.fillStyle = fillNodeColor;
              ctx.fill();
            } else {
              ctx.beginPath();
              ctx.arc(n._sx, n._sy, n._sr, 0, Math.PI * 2);
              ctx.fillStyle = fillNodeColor;
              ctx.fill();
            }

            if (aiRank > 0) {
              ctx.beginPath();
              ctx.arc(n._sx, n._sy, n._sr + 4.8, 0, Math.PI * 2);
              ctx.strokeStyle = '#f04848';
              ctx.lineWidth = 2.1;
              ctx.stroke();
            }

          if (n.isSymbol && n.isExternal) {
            ctx.save();
            ctx.setLineDash([2.2, 2.2]);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 1.1;
            ctx.stroke();
            ctx.restore();
          } else if (n.isGod) {
            ctx.strokeStyle = 'rgba(255,255,255,0.78)';
            ctx.lineWidth = 1.1;
            ctx.stroke();
          }

          if (isDiffNode) {
            ctx.beginPath();
            ctx.arc(n._sx + n._sr * 0.78, n._sy - n._sr * 0.78, 2.7, 0, Math.PI * 2);
            ctx.fillStyle = '#ff9f0a';
            ctx.fill();
          }
          if (isLayered && n._detachedFromLayer && typeof n._tier === 'number') {
            const dCol = (pgState.layeredColumns || []).find(function (c) { return c.tier === n._tier; });
            if (dCol) {
              const dPal = pgGetLayerRolePalette(dCol.role, dCol.index);
              const dTxt = isRu() ? dCol.shortRu : dCol.shortEn;
              const dFont = Math.max(7.5, Math.round(8 * uiScale));
              ctx.font = '700 ' + dFont + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
              const dW = Math.max(18, ctx.measureText(dTxt).width + 8 * uiScale);
              const dH = Math.round(12 * uiScale);
              const dX = n._sx - dW * 0.5;
              const dY = n._sy - n._sr - dH - 3;
              pgDrawRoundedRectPath(ctx, dX, dY, dW, dH, Math.round(3 * uiScale));
              ctx.fillStyle = 'rgba(18, 19, 22, 0.96)';
              ctx.fill();
              ctx.strokeStyle = 'rgba(' + dPal.accentRgb + ', 0.70)';
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.fillStyle = dPal.accentHex;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(dTxt, n._sx, dY + dH * 0.5 + 0.4);
            }
          }
          ctx.restore();
        } else if (n.isFolder) {
          continue;
        }

        if (aiRank > 0) {
          ctx.save();
          if (renderedWebgl) {
            ctx.beginPath();
            ctx.arc(n._sx, n._sy, n._sr + 4.8, 0, Math.PI * 2);
            ctx.strokeStyle = '#f04848';
            ctx.lineWidth = 2.1;
            ctx.stroke();
          }
          const bx = n._sx + n._sr * 0.85;
          const by = n._sy - n._sr * 0.85;
          ctx.beginPath();
          ctx.arc(bx, by, 6.2, 0, Math.PI * 2);
          ctx.fillStyle = '#f04848';
          ctx.fill();
          ctx.strokeStyle = '#121316';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(aiRank), bx, by + 0.4);
          ctx.restore();
        }

        const isLensForceLabel = Boolean(
          aiRank > 0 ||
          (hasBlastWave && waveHop === 0) ||
          isPathEndpoint ||
          (hasCycleLens && isCycleNode) ||
          (hasHotspotsLens && hotspotScore >= 0.65) ||
          (hasSemanticHeat && semanticScore >= 0.72)
        );
        const isAlwaysLabel = isHovered || isSelected || n.hop === 0 || isLensForceLabel;
        const isToggleLabel = showLabels && (
          lodTier >= 1
            ? (n.isGod || isSymbolsView || (hasSearch && matchesFilter) || isPathNode || (hasBlastWave && waveHop === 1) || semanticScore > 0.25 || hotspotScore > 0.35 || lodTier === 2)
            : (n.isGod || (hasSearch && matchesFilter) || semanticScore >= 0.5)
        );
        if ((isAlwaysLabel || isToggleLabel) && alpha > 0.25) {
          const priority = isHovered ? 5000
            : isSelected ? 4000
            : isPathEndpoint ? 3600
            : (semanticScore >= 0.7) ? (3450 + Math.round(semanticScore * 100))
            : (hasBlastWave && waveHop === 0) ? 3400
            : (hotspotScore >= 0.55) ? (3100 + Math.round(hotspotScore * 100))
            : n.hop === 0 ? 3000
            : isCycleNode ? 2500
            : (hasSearch && matchesFilter) ? (2000 + Number(n.inDeg || 0))
            : (1000 + Number(n.inDeg || 0));
          let subCaption = '';
          if (lodTier === 2) {
            if (semanticScore > 0.2) subCaption = Math.round(semanticScore * 100) + '% GPU';
            else if (hotspotScore > 0.2) subCaption = (pgState.churnByFile[n.id] || 0) + 'c';
            else if (n.isSymbol && n.startLine) subCaption = ':L' + n.startLine;
            else if (n.lines > 0) subCaption = n.lines + 'L';
          }
          labelCandidates.push({
            node: n,
            priority,
            subCaption,
            force: isHovered || isSelected || n.hop === 0 || isPathEndpoint || (hasBlastWave && waveHop === 0)
          });
        }
      }

      // Draw non-overlapping labels above all dots in crisp scaled screen font
      if (labelCandidates.length > 0) {
        labelCandidates.sort(function (a, b) {
          return b.priority - a.priority;
        });
        const lblFontPx = Math.max(9.5, Math.round(10.5 * uiScale));
        const subFontPx = Math.max(8, Math.round(8.8 * uiScale));
        const lblLineH = Math.round(13 * uiScale);
        ctx.save();
        ctx.font = '600 ' + lblFontPx + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3;
        const outlineColor = 'rgba(8, 12, 22, 0.92)';
        const fillColor = 'rgba(245, 245, 247, 0.94)';
        const placedBoxes = [];
        const maxLabelsDraw = renderedWebgl ? 160 : labelCandidates.length;

        for (let i = 0; i < labelCandidates.length && placedBoxes.length < maxLabelsDraw; i++) {
          const item = labelCandidates[i];
          const n = item.node;
          const tw = Math.min(200 * uiScale, ctx.measureText(n.label).width);
          const lx = n._sx;
          const ly = n._sy + n._sr + 5;
          const box = {
            x1: lx - tw * 0.5 - 4,
            y1: ly - 2,
            x2: lx + tw * 0.5 + 4,
            y2: ly + lblLineH
          };

          let overlaps = false;
          if (!item.force) {
            for (let b = 0; b < placedBoxes.length; b++) {
              const p = placedBoxes[b];
              if (box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1) {
                overlaps = true;
                break;
              }
            }
          }
          if (overlaps) continue;

          placedBoxes.push(box);
          if (typeof ctx.strokeText === 'function') {
            ctx.strokeStyle = outlineColor;
            ctx.strokeText(n.label, lx, ly);
          }
          ctx.fillStyle = fillColor;
          ctx.fillText(n.label, lx, ly);
          if (item.subCaption) {
            ctx.save();
            ctx.font = '500 ' + subFontPx + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
            ctx.fillStyle = 'rgba(185, 200, 224, 0.78)';
            ctx.fillText(item.subCaption, lx, ly + Math.round(11.5 * uiScale));
            ctx.restore();
          }
        }
        ctx.restore();
      }

      if (deferredLayeredHeaders) {
        const {
          cols,
          sortedOrder,
          colScreenXs,
          laneBounds,
          colStepScreen,
          headerY,
          headerH,
          focusTier,
        } = deferredLayeredHeaders;
        ctx.save();
        ctx.fillStyle = 'rgba(10, 11, 13, 0.88)';
        ctx.fillRect(0, 0, w, headerY + headerH + 4);
        const hdrFontPx = Math.max(9.5, Math.round(10 * uiScale));
        ctx.font = '700 ' + hdrFontPx + 'px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (cols.length > 1 && colStepScreen < 28) {
          const firstCx = colScreenXs[sortedOrder[0]];
          const lastCx = colScreenXs[sortedOrder[sortedOrder.length - 1]];
          const midX = (firstCx + lastCx) * 0.5;
          const summaryTxt = isRu() ? 'Входы / UI  →  Ядро / Хабы' : 'Entries / UI  →  Core / Hubs';
          const chipW = Math.min(220 * uiScale, ctx.measureText(summaryTxt).width + 20 * uiScale);
          pgDrawRoundedRectPath(ctx, midX - chipW * 0.5, headerY, chipW, headerH, Math.round(4 * uiScale));
          ctx.fillStyle = 'rgba(18, 19, 22, 0.96)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = '#e4e6eb';
          ctx.fillText(summaryTxt, midX, headerY + headerH * 0.5 + 0.5);
        } else {
          for (let pos = 0; pos < sortedOrder.length; pos++) {
            const c = sortedOrder[pos];
            const col = cols[c];
            const lb = laneBounds[c];
            if (lb.right < -20 || lb.left > w + 20) continue;
            const pal = pgGetLayerRolePalette(col.role, c);
            const isActiveFilter = pgState.activeLayerTier === col.tier;
            const isFocused = focusTier === col.tier;
            const maxPillW = Math.max(26, lb.width - 8);
            const dotExtra = Math.round(12 * uiScale);
            const clearExtra = isActiveFilter ? Math.round(12 * uiScale) : 0;

            const fullLbl = (isRu() ? col.labelRu : col.labelEn) + ' · ' + col.count;
            const shortLbl = (isRu() ? col.shortRu : col.shortEn) + ' · ' + col.count;
            const microLbl = (col.role === 'mid') ? String(c + 1) : (isRu() ? col.shortRu : col.shortEn);
            const padText = Math.round(16 * uiScale) + dotExtra + clearExtra;

            let lblText = fullLbl;
            if (ctx.measureText(fullLbl).width + padText > maxPillW) {
              lblText = shortLbl;
              if (ctx.measureText(shortLbl).width + padText > maxPillW) {
                lblText = microLbl;
              }
            }

            const measuredW = ctx.measureText(lblText).width + padText;
            const pillW = Math.min(maxPillW, Math.max(28, measuredW));
            const minX = Math.max(4, lb.left + 4);
            const maxX = Math.min(w - pillW - 4, lb.right - pillW - 4);
            const pillX = minX <= maxX
              ? Math.max(minX, Math.min(maxX, colScreenXs[c] - pillW * 0.5))
              : Math.max(4, Math.min(w - pillW - 4, colScreenXs[c] - pillW * 0.5));

            pgDrawRoundedRectPath(ctx, pillX, headerY, pillW, headerH, Math.round(4 * uiScale));
            if (isActiveFilter) {
              ctx.fillStyle = 'rgba(26, 28, 34, 0.98)';
            } else if (isFocused) {
              ctx.fillStyle = 'rgba(27, 30, 36, 0.98)';
            } else {
              ctx.fillStyle = 'rgba(18, 19, 22, 0.96)';
            }
            ctx.fill();
            if (isActiveFilter) {
              ctx.fillStyle = 'rgba(' + pal.accentRgb + ', 0.22)';
              ctx.fill();
            }
            ctx.strokeStyle = (isActiveFilter || isFocused)
              ? ('rgba(' + pal.accentRgb + ', 0.78)')
              : ('rgba(' + pal.accentRgb + ', 0.28)');
            ctx.lineWidth = isActiveFilter ? 1.5 : 1;
            ctx.stroke();

            const cy = headerY + headerH * 0.5;
            if (pillW >= 40) {
              ctx.beginPath();
              ctx.arc(pillX + Math.round(9 * uiScale), cy, Math.max(2.6, 3 * uiScale), 0, Math.PI * 2);
              ctx.fillStyle = pal.accentHex;
              ctx.fill();
            }
            const textCenterX = pillX + (pillW >= 40 ? (dotExtra * 0.45) : 0) + (pillW - clearExtra) * 0.5;
            ctx.fillStyle = isActiveFilter
              ? '#ffffff'
              : (isFocused ? '#f4f5f7' : '#d1d5db');
            ctx.fillText(lblText + (isActiveFilter ? ' ×' : ''), textCenterX, cy + 0.5);

            pgState.layerHeaderRects.push({
              tier: col.tier,
              index: col.index,
              x: pillX,
              y: headerY,
              w: pillW,
              h: headerH,
              labelRu: col.labelRu,
              labelEn: col.labelEn,
              count: col.count,
              role: col.role
            });
          }
        }
        ctx.restore();
      }

      if (pgState.showMinimap && typeof pgDrawMinimap === 'function') {
        pgDrawMinimap(ctx, w, h);
      } else {
        pgState.minimapRect = null;
      }

      if (typeof pgPositionAiMapCallout === 'function') {
        pgPositionAiMapCallout();
      }

      ctx.restore();
    }

    function pgFindNodeAtScreen(sx, sy) {
      const scale = pgState.camScale || 1;
      if (pgState.nodes.length >= 100 && typeof pgFindNodeQuadtree === 'function') {
        if (!pgState.spatialTree && typeof pgBuildQuadtree === 'function') {
          pgState.spatialTree = pgBuildQuadtree(pgState.nodes);
        }
        if (pgState.spatialTree) {
          const wPos = pgScreenToWorld(sx, sy);
          return pgFindNodeQuadtree(pgState.spatialTree, wPos.x, wPos.y, sx, sy, scale);
        }
      }
      let best = null;
      let bestDist = Infinity;
      for (let i = pgState.nodes.length - 1; i >= 0; i--) {
        const n = pgState.nodes[i];
        const pt = pgWorldToScreen(n.x, n.y);
        if (n.isFolder && n._bw > 0 && n._bh > 0) {
          const hw = n._bw * 0.5 + 4;
          const hh = n._bh * 0.5 + 4;
          const dx = sx - pt.x;
          const dy = sy - pt.y;
          if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) {
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestDist) {
              best = n;
              bestDist = d;
            }
          }
          continue;
        }
        const hitRadius = Math.max(7, pgGetNodeScreenRadius(n, scale) + 5);
        const dx = sx - pt.x;
        const dy = sy - pt.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= hitRadius && d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
      return best;
    }

    function pgUpdateHoverTooltip(node, sx, sy) {
      const tip = document.getElementById('pgHoverTooltip');
      if (!tip) return;
      if (!node) {
        tip.style.display = 'none';
        return;
      }
      const inCount = Number(node.inDeg || 0);
      const outCount = Number(node.outDeg || 0);
      if (node.isFolder) {
        tip.textContent = node.label + '  · ' + L(node.filesCount + ' файлов', node.filesCount + ' files') + '  (← ' + inCount + ' · → ' + outCount + ')';
      } else if (node.isSymbol) {
        tip.textContent = 'ƒ ' + node.label + ' [' + (node.kind || 'fn') + '] · ' + (node.file || '') + ':' + (node.startLine || 1) + '  (← ' + inCount + ' · → ' + outCount + ')';
      } else {
        const churnCnt = pgState.churnByFile && pgState.churnByFile[node.id] ? pgState.churnByFile[node.id] : 0;
        const relStr = node.isFragile ? (' · ! ' + node.reliabilityPercent + '%') : '';
        const churnStr = (pgState.lens === 'hotspots' && churnCnt > 0) ? (' · ' + churnCnt + 'c') : '';
        tip.textContent = node.id + '  (← ' + inCount + ' · → ' + outCount + relStr + churnStr + ')';
      }
      tip.style.left = '0px';
      tip.style.top = '0px';
      tip.style.display = 'block';
      const stageW = Math.max(200, pgState.width || 400);
      const stageH = Math.max(160, pgState.height || 300);
      const tipW = Math.min(stageW - 20, Math.max(80, Number(tip.offsetWidth) || 260));
      const tipH = Math.max(24, Number(tip.offsetHeight) || 28);
      let left = sx + 12;
      if (left + tipW > stageW - 10) {
        left = sx - tipW - 12;
      }
      const maxLeft = Math.max(10, stageW - tipW - 10);
      const maxTop = Math.max(10, stageH - tipH - 10);
      let top = sy - tipH - 8;
      if (top < 10) top = sy + 14;
      tip.style.left = Math.min(maxLeft, Math.max(10, left)) + 'px';
      tip.style.top = Math.min(maxTop, Math.max(10, top)) + 'px';
    }

    function pgRenderToolbarAndStats() {
      const data = pgState.graphData;
      const statsEl = document.getElementById('pgStatsPill');
      const wsBadge = document.getElementById('pgProjectBadge');
      const foldersBtn = document.getElementById('pgLevelFoldersBtn');
      const filesBtn = document.getElementById('pgLevelFilesBtn');
      const symbolsBtn = document.getElementById('pgLevelSymbolsBtn');
      const layeredBtn = document.getElementById('pgLayoutLayeredBtn');
      const forceBtn = document.getElementById('pgLayoutForceBtn');
      const globalBtn = document.getElementById('pgModeGlobalBtn');
      const localBtn = document.getElementById('pgModeLocalBtn');
      const testsBtn = document.getElementById('pgToggleTestsBtn');
      const docsBtn = document.getElementById('pgToggleDocsBtn');
      const labelsBtn = document.getElementById('pgToggleLabelsBtn');
      const hullsBtn = document.getElementById('pgToggleHullsBtn');
      const bundlingBtn = document.getElementById('pgToggleBundlingBtn');
      const minimapBtn = document.getElementById('pgToggleMinimapBtn');
      const webglBtn = document.getElementById('pgToggleWebglBtn');
      const semBtn = document.getElementById('pgSemanticSearchBtn');
      const limitSel = document.getElementById('pgLimitSelect');
      const depthSel = document.getElementById('pgDepthSelect');

      if (wsBadge) {
        wsBadge.textContent = (data && data.workspaceName)
          ? data.workspaceName
          : (pgState.workspaceRoot ? (pgWsBasename(pgState.workspaceRoot) || pgState.workspaceRoot) : getSelectedWorkspaceDisplayName());
      }
      pgRenderWorkspaceSelect();
      if (statsEl) {
        if (data && data.ok) {
          const nCount = Number(data.shownNodes || 0);
          const eCount = Number(data.shownEdges || 0);
          if (data.isSymbolsView) {
            statsEl.textContent = L(nCount + ' символов · ' + eCount + ' вызовов', nCount + ' symbols · ' + eCount + ' calls');
          } else if (data.isMacro) {
            statsEl.textContent = L(nCount + ' папок · ' + eCount + ' связей', nCount + ' folders · ' + eCount + ' links');
          } else {
            statsEl.textContent = L(nCount + ' узлов · ' + eCount + ' связей', nCount + ' nodes · ' + eCount + ' edges');
          }
        } else {
          statsEl.textContent = L('0 узлов · 0 связей', '0 nodes · 0 edges');
        }
      }
      const isSymbolsView = Boolean(pgState.viewLevel === 'symbols' || data?.isSymbolsView);
      const isFilesEffective = !isSymbolsView && (pgState.viewLevel === 'files' || pgState.mode === 'local' || Boolean(pgState.drillFolder));
      if (foldersBtn) {
        foldersBtn.classList.toggle('active', !isFilesEffective && !isSymbolsView);
        foldersBtn.disabled = false;
      }
      if (filesBtn) filesBtn.classList.toggle('active', isFilesEffective);
      if (symbolsBtn) {
        symbolsBtn.classList.toggle('active', isSymbolsView);
      }
      if (layeredBtn) layeredBtn.classList.toggle('active', pgState.layoutMode === 'layered');
      if (forceBtn) forceBtn.classList.toggle('active', pgState.layoutMode === 'force');
      if (globalBtn) globalBtn.classList.toggle('active', pgState.mode === 'global');
      if (localBtn) localBtn.classList.toggle('active', pgState.mode === 'local');
      if (testsBtn) testsBtn.classList.toggle('active', pgState.includeTests);
      if (docsBtn) docsBtn.classList.toggle('active', pgState.includeDocs);
      if (labelsBtn) {
        labelsBtn.classList.toggle('active', pgState.showLabels);
        labelsBtn.disabled = !isFilesEffective && !isSymbolsView;
      }
      if (hullsBtn) {
        hullsBtn.classList.toggle('active', pgState.showHulls);
        hullsBtn.disabled = (!isFilesEffective && !isSymbolsView) || pgState.layoutMode !== 'force';
      }
      if (bundlingBtn) {
        bundlingBtn.classList.toggle('active', pgState.edgeBundling);
      }
      if (minimapBtn) {
        minimapBtn.classList.toggle('active', pgState.showMinimap);
      }
      if (webglBtn) {
        const isGlOn = Boolean(pgState.webglActive || pgState.renderMode === 'webgl2');
        webglBtn.classList.toggle('active', isGlOn);
      }
      if (semBtn) {
        semBtn.classList.toggle('active', pgState.semanticSearchEnabled);
      }
      if (limitSel) {
        limitSel.value = String(pgState.maxNodes || 220);
        limitSel.disabled = pgState.mode === 'local' || isSymbolsView;
        limitSel.style.display = isSymbolsView ? 'none' : '';
      }
      if (depthSel) {
        depthSel.value = String(pgState.depth);
        depthSel.disabled = pgState.mode !== 'local';
      }
      const alignBtn = document.getElementById('pgAlignLayersBtn');
      if (alignBtn) {
        alignBtn.disabled = pgState.layoutMode !== 'layered';
      }
      if (typeof pgRenderLensToolbarBadges === 'function') {
        pgRenderLensToolbarBadges();
      }
    }

    function pgRenderClusterPills() {
      const bar = document.getElementById('pgClusterPills');
      if (!bar) return;
      const clusters = Array.isArray(pgState.graphData?.clusters) ? pgState.graphData.clusters : [];
      const isSymbolsView = Boolean(pgState.viewLevel === 'symbols' || pgState.graphData?.isSymbolsView);
      const hasLayerFilter = pgState.layoutMode === 'layered' && pgState.activeLayerTier !== null;
      if (!clusters.length && !pgState.drillFolder && pgState.mode !== 'local' && !isSymbolsView && !hasLayerFilter) {
        bar.innerHTML = '';
        bar.style.display = 'none';
        return;
      }
      bar.style.display = 'flex';
      let html = '';
      if (isSymbolsView) {
        html += '<button type="button" class="pg-breadcrumb-chip" data-action="pgExitSymbolsLevel" data-arg="folders" title="' + L('Вернуться к уровню папок', 'Back to folders level') + '">' +
          '← ' + L('Папки', 'Folders') + '</button>';
        html += '<button type="button" class="pg-breadcrumb-chip" data-action="pgExitSymbolsLevel" data-arg="files" title="' + L('Вернуться к уровню файлов', 'Back to files level') + '">' +
          '← ' + L('Файлы', 'Files') + '</button>';
        if (pgState.symbolFile) {
          html += '<span class="pg-breadcrumb-chip" style="opacity:0.9;cursor:default;">ƒ <strong>' + escapeHtml(pgState.symbolFile) + '</strong></span>';
        }
      } else if (pgState.mode === 'local') {
        html += '<button type="button" class="pg-breadcrumb-chip" data-action="pgExitToMainView" title="' + L('Вернуться к главному слою папок', 'Return to main folders layer') + '">' +
          '← ' + L('Главный слой (Папки)', 'Main Layer (Folders)') + '</button>';
        html += '<button type="button" class="pg-cluster-chip" data-action="pgSetGraphMode" data-arg="global" title="' + L('Показать все файлы проекта', 'Show all project files') + '">' +
          L('Все файлы', 'All files') + '</button>';
      } else if (pgState.drillFolder) {
        html += '<button type="button" class="pg-breadcrumb-chip" data-action="pgExitFolderDrill" title="' + L('Вернуться к обзору папок', 'Back to folders overview') + '">' +
          '← ' + L('Все папки', 'All folders') + ' / <strong>' + escapeHtml(pgState.drillFolder) + '</strong></button>';
      }
      if (hasLayerFilter) {
        const activeCol = (pgState.layeredColumns || []).find(function (c) { return c.tier === pgState.activeLayerTier; });
        const layerTitle = activeCol ? (isRu() ? activeCol.labelRu : activeCol.labelEn) : (L('Слой ', 'Layer ') + (pgState.activeLayerTier + 1));
        const layerCnt = activeCol ? (' · ' + activeCol.count) : '';
        html += '<button type="button" class="pg-breadcrumb-chip pg-layer-filter-chip" data-action="pgClearLayerFilter" title="' + escapeHtml(L('Сбросить фильтр по слою', 'Clear layer filter')) + '">' +
          escapeHtml(L('Слой: ', 'Layer: ') + layerTitle + layerCnt) + ' ×</button>';
      }
      html += '<button type="button" class="pg-cluster-chip' + (!pgState.activeClusterId ? ' active' : '') + '" data-action="pgFilterCluster" data-arg="">' +
        L('Все подсистемы', 'All subsystems') + ' (' + pgState.nodes.length + ')</button>';
      for (let i = 0; i < clusters.length && i < 12; i++) {
        const cl = clusters[i];
        const color = pgGetClusterColor(cl.id);
        const isActive = pgState.activeClusterId === cl.id;
        html += '<button type="button" class="pg-cluster-chip' + (isActive ? ' active' : '') + '" data-action="pgFilterCluster" data-arg="' + escapeHtml(cl.id) + '" title="' + escapeHtml(cl.label) + '">' +
          '<span class="pg-cluster-dot" style="background:' + escapeHtml(color) + ';"></span>' +
          '<span>' + escapeHtml(cl.label) + '</span>' +
          '<span class="pg-cluster-cnt">' + Number(cl.shownSize || cl.size || 0) + '</span>' +
        '</button>';
      }
      bar.innerHTML = html;
    }

    function pgRenderInspector() {
      const fnEl = document.getElementById('pgInspFilename');
      const pathEl = document.getElementById('pgInspPath');
      const badgesEl = document.getElementById('pgInspBadges');
      const metricsEl = document.getElementById('pgInspMetrics');
      const tabsEl = document.getElementById('pgInspTabs');
      const listEl = document.getElementById('pgInspList');
      const actionsEl = document.getElementById('pgInspActions');
      const focusBtn = document.getElementById('pgActionFocusBtn');
      const symbolsBtn = document.getElementById('pgActionSymbolsBtn');
      const pathBtn = document.getElementById('pgActionPathBtn');
      const copyBtn = document.getElementById('pgActionCopyBtn');
      const cartToggleBtn = document.getElementById('pgActionCartToggleBtn');
      const composerBtn = document.getElementById('pgActionComposerBtn');

      if (typeof pgRenderLensInspectorSection === 'function') {
        pgRenderLensInspectorSection();
      }
      if (typeof pgRenderContextCart === 'function') {
        pgRenderContextCart();
      }

      const node = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      const askAiBtn = document.getElementById('pgActionAskAiBtn');
      const askAiMenu = document.getElementById('pgAskAiMenu');
      const aiChatBox = document.getElementById('pgAiChatBox');
      if (!node || pgState.aiNodeId !== node.id) {
        pgAbortActiveAiRequest({ clearHistory: true });
        pgClearAiMapOverlay();
        pgState.aiMenuOpen = false;
        pgState.aiBoxOpen = false;
        pgState.aiNodeId = node ? node.id : '';
        if (askAiMenu) askAiMenu.hidden = true;
        if (askAiBtn) askAiBtn.setAttribute('aria-expanded', 'false');
        if (aiChatBox) aiChatBox.style.display = 'none';
      }
      if (askAiBtn && node) {
        askAiBtn.textContent = node.isFolder
          ? L('Спросить ИИ о папке ▾', 'Ask AI about folder ▾')
          : (node.isSymbol ? L('Спросить ИИ о символе ▾', 'Ask AI about symbol ▾') : L('Спросить ИИ о файле ▾', 'Ask AI about file ▾'));
      }
      if (!node) {
        if (fnEl) fnEl.textContent = L('Выберите узел на карте', 'Select a node on the graph');
        if (pathEl) pathEl.textContent = L('Кликните по папке или файлу, чтобы увидеть зависимости', 'Click a folder or file to inspect dependencies');
        if (badgesEl) badgesEl.innerHTML = '';
        if (metricsEl) metricsEl.style.display = 'none';
        if (tabsEl) tabsEl.style.display = 'none';
        if (actionsEl) actionsEl.style.display = 'none';
        if (listEl) {
          const renderedWave = pgState.lens === 'blast' && typeof pgRenderBlastWaveList === 'function' && pgRenderBlastWaveList(listEl);
          if (!renderedWave) {
            listEl.innerHTML = '<div class="pg-insp-placeholder">' + escapeHtml(L(
              'Наведите курсор для подсветки связей. Двойной клик по папке откроет её файлы, по файлу — локальный граф (1–2 хопа).',
              'Hover to highlight links. Double-click a folder to drill into its files, or a file for its 1–2 hop neighborhood.'
            )) + '</div>';
          }
        }
        return;
      }

      if (fnEl) {
        fnEl.textContent = node.isFolder ? node.label : (node.isSymbol ? ('ƒ ' + node.label) : node.label);
      }
      if (pathEl) {
        pathEl.textContent = node.isFolder
          ? L('Подсистема · ' + node.filesCount + ' файлов · ' + (node.internalEdges || 0) + ' внутр. связей', 'Subsystem · ' + node.filesCount + ' files · ' + (node.internalEdges || 0) + ' internal links')
          : (node.isSymbol
              ? ((node.file || 'external') + ':' + Number(node.startLine || 1) + (node.endLine > node.startLine ? ('–' + node.endLine) : ''))
              : node.id);
      }

      const targetCartId = node.isSymbol && node.file ? node.file : node.id;
      const nodeInCart = Boolean(
        pgState.contextCart && (
          pgState.contextCart.has(targetCartId) ||
          (node.isFolder && Array.isArray(node.fileIds) && node.fileIds.some(function (fid) { return pgState.contextCart.has(fid); }))
        )
      );

      if (badgesEl) {
        const bList = [];
        const cColor = pgGetClusterColor(node.clusterId);
        bList.push('<span class="pg-badge-pill"><span class="pg-cluster-dot" style="background:' + escapeHtml(cColor) + ';"></span>' + escapeHtml(node.clusterLabel) + '</span>');
        if (node.isFolder) {
          if (node.godCount > 0) bList.push('<span class="pg-badge-pill is-god">God ×' + Number(node.godCount) + '</span>');
          if (node.fragileCount > 0) bList.push('<span class="pg-badge-pill is-fragile">! ' + L('Хрупких: ', 'Fragile: ') + Number(node.fragileCount) + '</span>');
        } else if (node.isSymbol) {
          bList.push('<span class="pg-symbol-kind-pill">' + escapeHtml(node.kind || 'function') + '</span>');
          if (node.isExternal) bList.push('<span class="pg-badge-pill">' + L('Внешний файл', 'External file') + '</span>');
          if (node.isGod) bList.push('<span class="pg-badge-pill is-god">God Symbol</span>');
          if (nodeInCart) bList.push('<span class="pg-badge-pill is-cart">✓ ' + L('В пакете', 'In Cart') + '</span>');
        } else {
          if (node.isGod) bList.push('<span class="pg-badge-pill is-god">God Node</span>');
          if (node.isFragile) bList.push('<span class="pg-badge-pill is-fragile">! ' + L('Хрупкий', 'Fragile') + '</span>');
          if (node.isTest) bList.push('<span class="pg-badge-pill">' + L('Тест', 'Test') + '</span>');
          const churnCnt = pgState.churnByFile && pgState.churnByFile[node.id] ? Number(pgState.churnByFile[node.id]) : 0;
          if (churnCnt > 0) bList.push('<span class="pg-badge-pill is-diff">' + churnCnt + ' ' + L('правок', 'commits') + '</span>');
          const semPct = pgState.semanticScores && pgState.semanticScores.get(node.id);
          if (semPct > 0) bList.push('<span class="pg-sem-pill">GPU ' + Math.round(semPct * 100) + '%</span>');
          if (pgState.cycleNodeSet && pgState.cycleNodeSet.has(node.id)) bList.push('<span class="pg-badge-pill is-cycle">⟳ ' + L('Цикл', 'Cycle') + '</span>');
          if (pgState.orphanSet && pgState.orphanSet.has(node.id)) bList.push('<span class="pg-badge-pill is-orphan">○ ' + L('Сирота', 'Orphan') + '</span>');
          if (pgState.gitDiffSet && pgState.gitDiffSet.has(node.id)) bList.push('<span class="pg-badge-pill is-diff">Diff</span>');
          if (nodeInCart) bList.push('<span class="pg-badge-pill is-cart">✓ ' + L('В пакете', 'In Cart') + '</span>');
        }
        badgesEl.innerHTML = bList.join('');
      }

      const incoming = pgState.inNeighbors.get(node.id) || [];
      const outgoing = pgState.outNeighbors.get(node.id) || [];

      if (metricsEl) {
        metricsEl.style.display = 'grid';
        const mIn = document.getElementById('pgMetricIn');
        const mOut = document.getElementById('pgMetricOut');
        const mLines = document.getElementById('pgMetricLines');
        const mRel = document.getElementById('pgMetricRel');
        if (mIn) mIn.textContent = String(Math.max(incoming.length, Number(node.inDeg || 0)));
        if (mOut) mOut.textContent = String(Math.max(outgoing.length, Number(node.outDeg || 0)));
        if (mLines) mLines.textContent = String(Number(node.lines || 0));
        if (mRel) {
          mRel.textContent = Number(node.reliabilityPercent ?? 100) + '%';
          mRel.style.color = node.isFragile ? 'var(--status-err)' : '';
        }
      }

      if (!node.isFolder && pgState.inspectorTab === 'files') {
        pgState.inspectorTab = 'blast';
      }

      if (tabsEl) {
        tabsEl.style.display = 'flex';
        const tBlast = document.getElementById('pgTabBlast');
        const tImp = document.getElementById('pgTabImports');
        const tOv = document.getElementById('pgTabOverview');
        if (tBlast) {
          tBlast.textContent = node.isFolder
            ? (L('Файлы', 'Files') + ' (' + (node.fileIds ? node.fileIds.length : 0) + ')')
            : (node.isSymbol ? (L('Кто вызывает', 'Callers') + ' (' + incoming.length + ')') : ('Blast Radius (' + incoming.length + ')'));
          tBlast.classList.toggle('active', pgState.inspectorTab === 'blast' || (node.isFolder && pgState.inspectorTab === 'files'));
        }
        if (tImp) {
          tImp.textContent = (node.isSymbol ? L('Вызывает', 'Callees') : L('Импорты', 'Imports')) + ' (' + outgoing.length + ')';
          tImp.classList.toggle('active', pgState.inspectorTab === 'imports');
        }
        if (tOv) {
          tOv.textContent = node.isFolder ? (L('Зависят', 'Dependents') + ' (' + incoming.length + ')') : L('Обзор', 'Overview');
          tOv.classList.toggle('active', pgState.inspectorTab === 'overview');
        }
      }

      if (actionsEl) {
        actionsEl.style.display = 'flex';
        if (focusBtn) {
          if (node.isFolder) {
            focusBtn.textContent = L('Раскрыть', 'Drill in');
            focusBtn.setAttribute('data-action', 'pgDrillIntoFolder');
            focusBtn.setAttribute('data-arg', node.folderKey || '');
            focusBtn.title = L('Открыть файлы этой папки на карте', 'Open files inside this folder');
          } else if (pgState.mode === 'local' && pgState.focusFile === node.id) {
            focusBtn.textContent = L('← Главный слой', '← Main layer');
            focusBtn.setAttribute('data-action', 'pgExitToMainView');
            focusBtn.removeAttribute('data-arg');
            focusBtn.title = L('Вернуться на главный слой всех папок', 'Return to main folders layer');
          } else if (node.isSymbol) {
            focusBtn.textContent = L('← К файлам', '← Back to files');
            focusBtn.setAttribute('data-action', 'pgExitSymbolsLevel');
            focusBtn.setAttribute('data-arg', 'files');
            focusBtn.title = L('Вернуться к графу файлов', 'Return to files dependency map');
          } else {
            focusBtn.textContent = L('Фокус', 'Focus');
            focusBtn.setAttribute('data-action', 'pgFocusSelectedNode');
            focusBtn.removeAttribute('data-arg');
            focusBtn.title = L('Показать 1–2 хопа вокруг этого файла', 'Focus 1–2 hops around this file');
          }
        }
        if (symbolsBtn) {
          const canOpenSyms = !node.isFolder && (!node.isSymbol || (node.isExternal && Boolean(node.file)));
          symbolsBtn.style.display = canOpenSyms ? '' : 'none';
          symbolsBtn.textContent = node.isSymbol ? L('ƒ Файл', 'ƒ File') : L('ƒ Символы', 'ƒ Symbols');
        }
        if (pathBtn) {
          const isPathStart = pgState.pathFrom && (pgState.pathFrom === node.id || (node.isFolder && pgState.pathFrom === node.topHubFile));
          pathBtn.textContent = isPathStart ? L('⇄ Старт (A)', '⇄ Start (A)') : L('⇄ Путь', '⇄ Path');
        }
        if (copyBtn) copyBtn.style.display = node.isFolder ? 'none' : '';
        if (cartToggleBtn) {
          cartToggleBtn.textContent = nodeInCart ? L('✓ В пакете', '✓ In Cart') : L('＋ В пакет', '＋ To Cart');
        }
        if (composerBtn) {
          composerBtn.textContent = node.isFolder
            ? L('Хаб в Композер', 'Hub to Composer')
            : L('В Композер', 'To Composer');
        }
      }

      if (listEl) {
        if (pgState.lens === 'blast' && pgState.inspectorTab === 'blast' && typeof pgRenderBlastWaveList === 'function' && pgRenderBlastWaveList(listEl)) {
          return;
        }
        if (node.isFolder && (pgState.inspectorTab === 'blast' || pgState.inspectorTab === 'files')) {
          const fList = Array.isArray(node.fileIds) ? node.fileIds : [];
          if (!fList.length) {
            listEl.innerHTML = '<div class="pg-insp-placeholder">' + L('Папка пуста.', 'Folder is empty.') + '</div>';
          } else {
            listEl.innerHTML = fList.slice(0, 60).map(function (fId) {
              const isHub = fId === node.topHubFile;
              return '<button type="button" class="pg-dep-row" data-action="pgOpenFileFromFolder" data-arg="' + escapeHtml(fId) + '" title="' + escapeHtml(fId) + '">' +
                '<span class="pg-dep-name">' + escapeHtml(fId) + (isHub ? ' [HUB]' : '') + '</span>' +
                '<span class="pg-dep-kind">' + L('откр.', 'open') + '</span>' +
              '</button>';
            }).join('');
          }
          return;
        }

        if (!node.isFolder && pgState.inspectorTab === 'overview') {
          if (node.isSymbol) {
            listEl.innerHTML =
              '<div class="pg-ov-row"><span>' + L('Файл', 'File') + '</span><code>' + escapeHtml(node.file || '—') + '</code></div>' +
              '<div class="pg-ov-row"><span>' + L('Строки', 'Lines') + '</span><strong>L' + Number(node.startLine || 1) + '–' + Number(node.endLine || node.startLine || 1) + '</strong></div>' +
              '<div class="pg-ov-row"><span>' + L('Сигнатура', 'Signature') + '</span><code>' + escapeHtml(node.signature || node.label) + '</code></div>' +
              '<div class="pg-ov-row"><span>' + L('Подсистема', 'Subsystem') + '</span><strong>' + escapeHtml(node.clusterLabel) + '</strong></div>';
          } else {
            listEl.innerHTML =
              '<div class="pg-ov-row"><span>' + L('Папка', 'Directory') + '</span><code>' + escapeHtml(node.dir || '.') + '</code></div>' +
              '<div class="pg-ov-row"><span>' + L('Подсистема', 'Subsystem') + '</span><strong>' + escapeHtml(node.clusterLabel) + '</strong></div>' +
              '<div class="pg-ov-row"><span>' + L('Символов AST', 'AST Symbols') + '</span><strong>' + Number(node.symbolsCount || 0) + '</strong></div>' +
              '<div class="pg-ov-row"><span>' + L('Строк кода', 'Lines') + '</span><strong>' + Number(node.lines || 0) + '</strong></div>' +
              '<div class="pg-ov-row"><span>' + L('Модульность проекта Q', 'Project Modularity Q') + '</span><strong>' + Number(pgState.graphData?.modularityQ || 0) + '</strong></div>';
          }
        } else {
          const items = pgState.inspectorTab === 'imports' ? outgoing : incoming;
          if (!items.length) {
            listEl.innerHTML = '<div class="pg-insp-placeholder">' + (
              pgState.inspectorTab === 'imports'
                ? L('Нет видимых исходящих связей среди текущих узлов графа.', 'No visible outgoing dependencies among shown nodes.')
                : L('Ни один из показанных узлов напрямую не зависит от этого элемента.', 'No shown nodes directly depend on this item.')
            ) + '</div>';
          } else {
            listEl.innerHTML = items.map(function (edgeItem) {
              const targetNode = pgState.nodeById.get(edgeItem.id);
              const displayLabel = targetNode && targetNode.isFolder ? targetNode.label : edgeItem.id;
              const kindBadge = node.isFolder && edgeItem.weight
                ? (edgeItem.weight + ' ' + (edgeItem.kind === 'doc' ? L('док', 'doc') : L('св.', 'lnk')))
                : (edgeItem.kind === 'doc' ? L('док', 'doc') : L('имп.', 'imp'));
              const extraBadge = targetNode && targetNode.isFragile ? ' [!]' : (targetNode && targetNode.isGod ? ' [HUB]' : '');
              return '<button type="button" class="pg-dep-row" data-action="pgSelectNodeById" data-arg="' + escapeHtml(edgeItem.id) + '" title="' + escapeHtml(edgeItem.id) + '">' +
                '<span class="pg-dep-name">' + escapeHtml(displayLabel) + escapeHtml(extraBadge) + '</span>' +
                '<span class="pg-dep-kind">' + escapeHtml(kindBadge) + '</span>' +
              '</button>';
            }).join('');
          }
        }
      }
    }

    async function pgLoadGraph(opts) {
      const seq = ++pgState.fetchSeq;
      const emptyEl = document.getElementById('pgEmptyState');
      const emptyTitle = document.getElementById('pgEmptyTitle');
      const emptySub = document.getElementById('pgEmptySub');
      pgState.loading = true;
      if (emptyEl) {
        emptyEl.style.display = 'flex';
        if (emptyTitle) emptyTitle.textContent = L('Строим карту проекта…', 'Building project graph…');
        if (emptySub) emptySub.textContent = L('Читаем связи AST и кластеры из RAM', 'Reading AST edges and clusters from RAM');
      }

      try {
        const params = new URLSearchParams();
        pgAppendWorkspaceParam(params);
        if (pgState.mode === 'local' && pgState.focusFile) {
          params.set('focus', pgState.focusFile);
          params.set('depth', String(pgState.depth));
        }
        params.set('maxNodes', pgState.mode === 'local' ? '140' : String(pgState.maxNodes || 220));
        params.set('includeTests', pgState.includeTests ? '1' : '0');
        params.set('includeDocs', pgState.includeDocs ? '1' : '0');
        if (opts && opts.refresh) params.set('refresh', '1');

        const res = await panelFetch('/api/project-graph?' + params.toString());
        const data = await res.json();
        if (seq !== pgState.fetchSeq || !pgState.open) return;

        if (!data || !data.ok) {
          if (emptyEl) {
            emptyEl.style.display = 'flex';
            if (emptyTitle) emptyTitle.textContent = L('Не удалось загрузить карту', 'Failed to load graph');
            if (emptySub) emptySub.textContent = (data && data.error) ? data.error : L('Ошибка сервера панели', 'Panel server error');
          }
          return;
        }

        if (!pgState.workspaceRoot && data.workspaceRoot && !pgState.autoWorkspace) {
          pgState.autoWorkspace = data.workspaceRoot;
        }

        if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
          pgState.nodes = [];
          pgState.edges = [];
          pgState.graphData = data;
          pgRenderToolbarAndStats();
          pgRenderClusterPills();
          pgRenderInspector();
          pgDrawGraph();
          if (emptyEl) {
            emptyEl.style.display = 'flex';
            if (emptyTitle) emptyTitle.textContent = L('Нет файлов для отображения', 'No files to display');
            if (emptySub) emptySub.textContent = L('Проверьте выбранный проект или включите отображение тестов', 'Check active project or enable test files');
          }
          return;
        }

        if (emptyEl) emptyEl.style.display = 'none';
        if (pgState.viewLevel === 'symbols') {
          pgState.viewLevel = pgState.symbolReturnLevel === 'folders' ? 'folders' : 'files';
          pgState.symbolFile = '';
          pgState.symbolGraphData = null;
        }
        pgState.rawGraphData = data;
        pgHydrateSimulation(data);
        if (pgState.mode === 'local' && pgState.focusFile) {
          const focusTarget = pgState.nodeById.get(pgState.focusFile) || (data.focus ? pgState.nodeById.get(data.focus) : null);
          if (focusTarget) {
            pgState.selectedNodeId = focusTarget.id;
            pgState.camX = focusTarget.x;
            pgState.camY = focusTarget.y;
            if (typeof pgRefreshLensState === 'function') pgRefreshLensState();
            pgRenderInspector();
            pgDrawGraph();
          }
        }
        if (pgState.lens === 'blast' && typeof pgLoadGitDiff === 'function' && (!pgState.gitDiffLoaded || (opts && opts.refresh))) {
          void pgLoadGitDiff(Boolean(opts && opts.refresh));
        }
        if (pgState.lens === 'hotspots' && typeof pgLoadGitChurn === 'function' && (!pgState.churnLoaded || (opts && opts.refresh))) {
          void pgLoadGitChurn(Boolean(opts && opts.refresh));
        }
        if (opts && opts.silent !== true) {
          flashStatus(L('Карта проекта обновлена ✓', 'Project graph updated ✓'));
        }
      } catch (err) {
        if (seq !== pgState.fetchSeq || !pgState.open) return;
        if (emptyEl) {
          emptyEl.style.display = 'flex';
          if (emptyTitle) emptyTitle.textContent = L('Ошибка соединения', 'Connection error');
          if (emptySub) emptySub.textContent = err && err.message ? err.message : L('Повторите попытку позже', 'Please retry');
        }
      } finally {
        if (seq === pgState.fetchSeq) pgState.loading = false;
      }
    }

    function pgApplyNodeMoveSnapshot(entry, direction) {
      if (!entry) return false;
      if (entry.kind === 'batch') {
        if (Array.isArray(entry.cols) && Array.isArray(pgState.layeredColumns)) {
          for (let i = 0; i < entry.cols.length; i++) {
            const cSnap = entry.cols[i];
            const col = pgState.layeredColumns.find(function (c) { return c.tier === cSnap.tier; });
            if (col) {
              const tx = direction === 'redo' ? cSnap.nextX : cSnap.prevX;
              if (Number.isFinite(tx)) col.x = tx;
            }
          }
        }
        if (Array.isArray(entry.nodes)) {
          for (let i = 0; i < entry.nodes.length; i++) {
            const nSnap = entry.nodes[i];
            const node = pgState.nodeById && typeof pgState.nodeById.get === 'function'
              ? pgState.nodeById.get(nSnap.id)
              : (Array.isArray(pgState.nodes) ? pgState.nodes.find(function (n) { return n && n.id === nSnap.id; }) : null);
            if (!node) continue;
            const targetX = direction === 'redo' ? nSnap.nextX : nSnap.prevX;
            const targetY = direction === 'redo' ? nSnap.nextY : nSnap.prevY;
            if (Number.isFinite(targetX)) node.x = targetX;
            if (Number.isFinite(targetY)) node.y = targetY;
            node.vx = 0;
            node.vy = 0;
            node.fx = null;
            node.fy = null;
            pgSyncNodeLayerDetachment(node);
          }
        }
        pgState.alpha = 0;
        pgStopLoop();
        if (typeof pgBuildQuadtree === 'function' && Array.isArray(pgState.nodes)) {
          pgState.spatialTree = pgBuildQuadtree(pgState.nodes);
        }
        pgDrawGraph();
        return true;
      }
      if (!entry.id) return false;
      const node = pgState.nodeById && typeof pgState.nodeById.get === 'function'
        ? pgState.nodeById.get(entry.id)
        : (Array.isArray(pgState.nodes) ? pgState.nodes.find(function (n) { return n && n.id === entry.id; }) : null);
      if (!node) return false;
      const targetX = direction === 'redo' ? entry.nextX : entry.prevX;
      const targetY = direction === 'redo' ? entry.nextY : entry.prevY;
      if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return false;
      node.x = targetX;
      node.y = targetY;
      node.vx = 0;
      node.vy = 0;
      node.fx = null;
      node.fy = null;
      pgSyncNodeLayerDetachment(node);
      pgState.alpha = 0;
      pgStopLoop();
      if (typeof pgBuildQuadtree === 'function' && Array.isArray(pgState.nodes)) {
        pgState.spatialTree = pgBuildQuadtree(pgState.nodes);
      }
      pgDrawGraph();
      return true;
    }

    function pgUndoNodeMove() {
      if (!Array.isArray(pgState.undoStack) || pgState.undoStack.length === 0) return false;
      while (pgState.undoStack.length > 0) {
        const entry = pgState.undoStack.pop();
        if (pgApplyNodeMoveSnapshot(entry, 'undo')) {
          if (!Array.isArray(pgState.redoStack)) pgState.redoStack = [];
          pgState.redoStack.push(entry);
          if (pgState.redoStack.length > 80) pgState.redoStack.shift();
          if (typeof flashStatus === 'function') {
            flashStatus(L('Отмена переноса узла ↺', 'Undid node move ↺'));
          }
          return true;
        }
      }
      return false;
    }

    function pgRedoNodeMove() {
      if (!Array.isArray(pgState.redoStack) || pgState.redoStack.length === 0) return false;
      while (pgState.redoStack.length > 0) {
        const entry = pgState.redoStack.pop();
        if (pgApplyNodeMoveSnapshot(entry, 'redo')) {
          if (!Array.isArray(pgState.undoStack)) pgState.undoStack = [];
          pgState.undoStack.push(entry);
          if (pgState.undoStack.length > 80) pgState.undoStack.shift();
          if (typeof flashStatus === 'function') {
            flashStatus(L('Возврат переноса узла ↻', 'Redid node move ↻'));
          }
          return true;
        }
      }
      return false;
    }

    function pgBindCanvasEvents() {
      if (pgState.bound) return;
      pgState.bound = true;
      const canvas = document.getElementById('projectGraphCanvas');
      const stage = document.getElementById('pgCanvasStage');
      if (!canvas || !stage) return;

      if (typeof ResizeObserver === 'function') {
        pgState.resizeObserver = new ResizeObserver(function () {
          if (pgState.open && pgSyncCanvasSize()) {
            pgDrawGraph();
          }
        });
        pgState.resizeObserver.observe(stage);
      }

      canvas.addEventListener('pointerdown', function (ev) {
        if (pgState.ctxMenuOpen) pgCloseNodeContextMenu();
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        const rect = canvas.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        pgState.dragMoved = false;
        pgState.lastClientX = ev.clientX;
        pgState.lastClientY = ev.clientY;
        pgState.activePointerId = ev.pointerId !== undefined ? ev.pointerId : null;
        pgState.dragOriginPos = null;
        if (pgState.showMinimap && typeof pgHitTestMinimap === 'function' && pgHitTestMinimap(sx, sy)) {
          pgState.dragMode = 'minimap';
          pgState.dragNode = null;
          if (typeof pgPanCameraFromMinimap === 'function') {
            pgPanCameraFromMinimap(sx, sy);
          }
          pgDrawGraph();
          try {
            if (canvas.setPointerCapture && ev.pointerId !== undefined) canvas.setPointerCapture(ev.pointerId);
          } catch {}
          return;
        }
        const hdrHit = pgFindLayerHeaderAtScreen(sx, sy);
        if (hdrHit) {
          pgState.dragMode = 'layer-header';
          pgState.dragNode = null;
          pgState.dragLayerTier = hdrHit.tier;
          const colObj = (pgState.layeredColumns || []).find(function (c) { return c.tier === hdrHit.tier; });
          pgState.dragLayerOrigin = colObj ? {
            tier: hdrHit.tier,
            colOrigX: colObj.x,
            startClientX: ev.clientX,
            nodes: pgState.nodes
              .filter(function (n) { return n._tier === hdrHit.tier && !n._detachedFromLayer; })
              .map(function (n) { return { id: n.id, x: n.x, y: n.y }; })
          } : null;
          try {
            if (canvas.setPointerCapture && ev.pointerId !== undefined) canvas.setPointerCapture(ev.pointerId);
          } catch {}
          return;
        }
        const hit = pgFindNodeAtScreen(sx, sy);
        if (hit) {
          pgState.dragMode = 'node';
          pgState.dragNode = hit;
          pgState.dragOriginPos = { id: hit.id, x: hit.x, y: hit.y };
          hit.fx = hit.x;
          hit.fy = hit.y;
          pgStartLoop(0.18);
        } else {
          pgState.dragMode = 'pan';
          pgState.dragNode = null;
          stage.classList.add('is-grabbing');
        }
        try {
          if (canvas.setPointerCapture && ev.pointerId !== undefined) canvas.setPointerCapture(ev.pointerId);
        } catch {}
      });

      canvas.addEventListener('pointermove', function (ev) {
        if (pgState.dragMode && ev.pointerType === 'mouse' && typeof ev.buttons === 'number' && ev.buttons === 0) {
          endPointerDrag(ev);
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;

        if (pgState.dragMode === 'minimap') {
          pgState.dragMoved = true;
          if (typeof pgPanCameraFromMinimap === 'function') {
            pgPanCameraFromMinimap(sx, sy);
          }
          pgDrawGraph();
          return;
        }

        if (pgState.dragMode === 'layer-header' && pgState.dragLayerOrigin) {
          const dx = ev.clientX - pgState.lastClientX;
          const totalDx = Math.abs(ev.clientX - pgState.dragLayerOrigin.startClientX);
          if (totalDx > 4) pgState.dragMoved = true;
          if (pgState.dragMoved) {
            const dWorldX = dx / (pgState.camScale || 1);
            const colObj = (pgState.layeredColumns || []).find(function (c) { return c.tier === pgState.dragLayerOrigin.tier; });
            if (colObj) colObj.x += dWorldX;
            const movedRefs = pgState.dragLayerOrigin.nodes || [];
            for (let i = 0; i < movedRefs.length; i++) {
              const mn = pgState.nodeById.get(movedRefs[i].id);
              if (mn) mn.x += dWorldX;
            }
            pgState.lastClientX = ev.clientX;
            pgState.spatialTree = null;
            canvas.style.cursor = 'ew-resize';
            pgDrawGraph();
          }
          return;
        }

        if (pgState.dragMode === 'node' && pgState.dragNode) {
          const dx = ev.clientX - pgState.lastClientX;
          const dy = ev.clientY - pgState.lastClientY;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) pgState.dragMoved = true;
          const world = pgScreenToWorld(sx, sy);
          pgState.dragNode.fx = world.x;
          pgState.dragNode.fy = world.y;
          pgState.dragNode.x = world.x;
          pgState.dragNode.y = world.y;
          pgSyncNodeLayerDetachment(pgState.dragNode);
          pgState.spatialTree = null;
          pgUpdateHoverTooltip(pgState.dragNode, sx, sy);
          pgDrawGraph();
          return;
        }

        if (pgState.dragMode === 'pan') {
          const dx = ev.clientX - pgState.lastClientX;
          const dy = ev.clientY - pgState.lastClientY;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) pgState.dragMoved = true;
          pgState.lastClientX = ev.clientX;
          pgState.lastClientY = ev.clientY;
          pgState.camX -= dx / pgState.camScale;
          pgState.camY -= dy / pgState.camScale;
          pgDrawGraph();
          return;
        }

        const hdrHit = pgFindLayerHeaderAtScreen(sx, sy);
        if (hdrHit) {
          const prevLayerHover = pgState.hoveredLayerTier;
          const prevNodeHover = pgState.hoveredNodeId;
          pgState.hoveredLayerTier = hdrHit.tier;
          pgState.hoveredNodeId = '';
          canvas.style.cursor = 'pointer';
          pgUpdateHoverTooltip(null, 0, 0);
          if (prevLayerHover !== hdrHit.tier || prevNodeHover) {
            pgDrawGraph();
          }
          return;
        }
        if (pgState.hoveredLayerTier !== null) {
          pgState.hoveredLayerTier = null;
          pgDrawGraph();
        }

        const hit = pgFindNodeAtScreen(sx, sy);
        const nextHoverId = hit ? hit.id : '';
        if (nextHoverId !== pgState.hoveredNodeId) {
          pgState.hoveredNodeId = nextHoverId;
          canvas.style.cursor = hit ? 'pointer' : 'grab';
          pgStartLoop();
        }
        pgUpdateHoverTooltip(hit, sx, sy);
      });

      function endPointerDrag(ev) {
        if (!pgState.dragMode) return;
        const pid = (ev && ev.pointerId !== undefined) ? ev.pointerId : pgState.activePointerId;
        try {
          if (pid !== null && pid !== undefined && canvas.releasePointerCapture) {
            canvas.releasePointerCapture(pid);
          }
        } catch {}

        const hasCoords = Boolean(ev && typeof ev.clientX === 'number' && typeof ev.clientY === 'number');
        const rect = hasCoords ? canvas.getBoundingClientRect() : null;
        const sx = hasCoords && rect ? (ev.clientX - rect.left) : 0;
        const sy = hasCoords && rect ? (ev.clientY - rect.top) : 0;

        if (pgState.dragMode === 'minimap') {
          pgState.dragMoved = true;
          if (hasCoords && typeof pgPanCameraFromMinimap === 'function') {
            pgPanCameraFromMinimap(sx, sy);
          }
          pgDrawGraph();
        } else if (pgState.dragMode === 'layer-header') {
          if (!pgState.dragMoved && pgState.dragLayerTier !== null) {
            pgToggleLayerFilter(pgState.dragLayerTier);
          } else if (pgState.dragMoved && pgState.dragLayerOrigin) {
            const origin = pgState.dragLayerOrigin;
            const colObj = (pgState.layeredColumns || []).find(function (c) { return c.tier === origin.tier; });
            if (colObj && Math.abs(colObj.x - origin.colOrigX) > 1) {
              const nodeSnapshots = [];
              const refs = origin.nodes || [];
              for (let i = 0; i < refs.length; i++) {
                const mn = pgState.nodeById.get(refs[i].id);
                if (mn) {
                  nodeSnapshots.push({ id: mn.id, prevX: refs[i].x, prevY: refs[i].y, nextX: mn.x, nextY: mn.y });
                }
              }
              if (!Array.isArray(pgState.undoStack)) pgState.undoStack = [];
              pgState.undoStack.push({
                kind: 'batch',
                cols: [{ tier: colObj.tier, prevX: origin.colOrigX, nextX: colObj.x }],
                nodes: nodeSnapshots
              });
              if (pgState.undoStack.length > 80) pgState.undoStack.shift();
              pgState.redoStack = [];
            }
            canvas.style.cursor = 'pointer';
          }
        } else if (pgState.dragMode === 'node' && pgState.dragNode) {
          const clickedNode = pgState.dragNode;
          clickedNode.fx = null;
          clickedNode.fy = null;
          if (pgState.dragMoved) {
            pgSyncNodeLayerDetachment(clickedNode);
            pgState.spatialTree = null;
            const orig = pgState.dragOriginPos;
            if (orig && orig.id === clickedNode.id && Math.hypot(clickedNode.x - orig.x, clickedNode.y - orig.y) > 1) {
              if (!Array.isArray(pgState.undoStack)) pgState.undoStack = [];
              pgState.undoStack.push({
                id: clickedNode.id,
                prevX: orig.x,
                prevY: orig.y,
                nextX: clickedNode.x,
                nextY: clickedNode.y,
              });
              if (pgState.undoStack.length > 80) {
                pgState.undoStack.shift();
              }
              pgState.redoStack = [];
            }
          } else if (hasCoords) {
            if ((ev.ctrlKey || ev.metaKey) && typeof pgToggleNodeInCart === 'function') {
              pgToggleNodeInCart(clickedNode.id);
            } else if (ev.shiftKey && typeof pgQueryGraphPath === 'function') {
              const fromCand = pgState.pathFrom || pgState.selectedNodeId || clickedNode.id;
              void pgQueryGraphPath(fromCand, clickedNode.id);
            } else if (pgState.lens === 'path' && pgState.pathFrom && !pgState.pathTo && typeof pgQueryGraphPath === 'function') {
              const targetCand = typeof pgResolveFileTargetFromNode === 'function' ? pgResolveFileTargetFromNode(clickedNode.id) : clickedNode.id;
              if (targetCand && targetCand !== pgState.pathFrom) {
                void pgQueryGraphPath(pgState.pathFrom, clickedNode.id);
              } else {
                pgState.selectedNodeId = clickedNode.id;
                pgRenderInspector();
                pgStartLoop();
              }
            } else {
              pgState.selectedNodeId = clickedNode.id;
              if (pgState.lens === 'blast') pgState.blastUseGitDiff = false;
              if (pgState.lens === 'path' && !pgState.pathFrom && typeof pgResolveFileTargetFromNode === 'function') {
                pgState.pathFrom = pgResolveFileTargetFromNode(clickedNode.id) || '';
              }
              if (typeof pgRefreshLensState === 'function') pgRefreshLensState();
              pgRenderInspector();
              pgStartLoop();
            }
          }
        } else if (pgState.dragMode === 'pan' && !pgState.dragMoved && hasCoords) {
          const hit = pgFindNodeAtScreen(sx, sy);
          if (!hit) {
            pgState.selectedNodeId = '';
            pgRenderInspector();
            pgStartLoop();
          }
        }
        pgState.dragMode = '';
        pgState.dragNode = null;
        pgState.dragLayerTier = null;
        pgState.dragLayerOrigin = null;
        pgState.activePointerId = null;
        pgState.dragOriginPos = null;
        stage.classList.remove('is-grabbing');
      }

      canvas.addEventListener('pointerup', endPointerDrag);
      canvas.addEventListener('pointercancel', endPointerDrag);
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pointerup', endPointerDrag);
        window.addEventListener('pointercancel', endPointerDrag);
        window.addEventListener('blur', function () {
          endPointerDrag(null);
        });
      }
      canvas.addEventListener('pointerleave', function () {
        const hadLayerHover = pgState.hoveredLayerTier !== null;
        pgState.hoveredLayerTier = null;
        if (!pgState.dragMode && (pgState.hoveredNodeId || hadLayerHover)) {
          pgState.hoveredNodeId = '';
          pgUpdateHoverTooltip(null, 0, 0);
          pgStartLoop();
        }
      });

      canvas.addEventListener('dblclick', function (ev) {
        const rect = canvas.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const hit = pgFindNodeAtScreen(sx, sy);
        if (hit) {
          pgState.selectedNodeId = hit.id;
          if (hit.isFolder) {
            pgDrillIntoFolder(hit.folderKey);
          } else if (hit.isSymbol && hit.isExternal && hit.file && typeof pgOpenFileSymbols === 'function') {
            void pgOpenFileSymbols(hit.file);
          } else if (!hit.isSymbol && typeof pgOpenFileSymbols === 'function') {
            void pgOpenFileSymbols(hit.id);
          } else {
            pgFocusSelectedNode();
          }
        }
      });

      canvas.addEventListener('contextmenu', function (ev) {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const hit = pgFindNodeAtScreen(sx, sy);
        if (hit) {
          pgOpenNodeContextMenu(hit, sx, sy);
        } else {
          pgCloseNodeContextMenu();
        }
      });

      canvas.addEventListener('wheel', function (ev) {
        if (pgState.ctxMenuOpen) pgCloseNodeContextMenu();
        ev.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const before = pgScreenToWorld(sx, sy);
        const factor = ev.deltaY < 0 ? 1.14 : 0.88;
        const nextScale = Math.max(0.18, Math.min(8.0, pgState.camScale * factor));
        pgState.camScale = nextScale;
        const after = pgScreenToWorld(sx, sy);
        pgState.camX += before.x - after.x;
        pgState.camY += before.y - after.y;
        pgDrawGraph();
      }, { passive: false });

      document.addEventListener('keydown', function (ev) {
        if (!pgState.open) return;
        if (ev.key === 'Escape') {
          if (ev.defaultPrevented) return;
          ev.preventDefault();
          if (pgState.ctxMenuOpen) {
            pgCloseNodeContextMenu();
            return;
          }
          if (pgState.aiMenuOpen) {
            pgToggleAskAiMenu(false);
            return;
          }
          closeProjectGraphModal();
          return;
        }
        if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
          const activeEl = document.activeElement;
          const activeTag = activeEl && activeEl.tagName ? String(activeEl.tagName).toUpperCase() : '';
          const isEditable = Boolean(
            activeTag === 'INPUT' ||
            activeTag === 'TEXTAREA' ||
            activeTag === 'SELECT' ||
            (activeEl && activeEl.isContentEditable)
          );
          if (isEditable) return;
          const keyLow = ev.key ? String(ev.key).toLowerCase() : '';
          if (ev.code === 'KeyZ' || keyLow === 'z') {
            ev.preventDefault();
            if (ev.shiftKey) {
              pgRedoNodeMove();
            } else {
              pgUndoNodeMove();
            }
          } else if (ev.code === 'KeyY' || keyLow === 'y') {
            ev.preventDefault();
            pgRedoNodeMove();
          }
        }
      });

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && pgState.open) {
          pgStartLoop();
        } else if (document.visibilityState !== 'visible') {
          pgStopLoop();
        }
      });
    }

    function pgIsStandaloneView() {
      try {
        return new URLSearchParams(window.location.search).get('view') === 'graph';
      } catch {
        return false;
      }
    }

    async function pgSyncStandaloneThemeAndLang() {
      try {
        const res = await panelFetch('/api/state', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const data = await res.json();
        const st = data?.state || data || {};
        if (st && typeof st === 'object') {
          if (typeof currentState !== 'undefined' && currentState) {
            Object.assign(currentState, st);
          }
          if (document.body) document.body.setAttribute('data-panel-theme', 'glass_teal');
          const lang = typeof normalizeUiLanguage === 'function' ? normalizeUiLanguage(st.uiLanguage) : (st.uiLanguage || 'ru');
          if (typeof applyUiLanguageDom === 'function') applyUiLanguageDom(lang);
          if (typeof applyPanelUiScaleDom === 'function') applyPanelUiScaleDom(st.panelUiScale || 'auto', false);
          document.title = lang === 'ru' ? 'Карта проекта · The Tunnel' : 'Project Map · The Tunnel';
          if (pgState.open) {
            pgRenderToolbarAndStats();
            pgRenderClusterPills();
            pgRenderInspector();
            pgDrawGraph();
          }
        }
      } catch {}
    }

    function pgBuildMergedWorkspacesList() {
      const merged = [];
      const seen = new Set();
      const pushItem = function (raw) {
        if (!raw) return;
        const wsPath = typeof raw === 'string' ? raw.trim() : String(raw.workspaceRoot || '').trim();
        if (!wsPath || wsPath === '__all__' || wsPath === '__auto__') return;
        const key = pgNormWsKey(wsPath);
        if (!key || seen.has(key)) return;
        seen.add(key);
        const base = pgWsBasename(wsPath) || wsPath;
        if (typeof raw === 'string') {
          merged.push({
            workspaceRoot: wsPath,
            projectName: base,
            displayLabel: base,
            status: 'idle',
            source: 'recent',
          });
        } else {
          merged.push({
            workspaceRoot: wsPath,
            projectName: raw.projectName || base,
            displayLabel: raw.displayLabel || raw.projectName || base,
            status: raw.status || 'idle',
            source: raw.source || 'known',
            isOpenInIde: Boolean(raw.isOpenInIde || raw.source === 'open_ide'),
          });
        }
      };

      if (pgState.workspaceRoot) pushItem(pgState.workspaceRoot);
      const known = Array.isArray(pgState.knownWorkspaces) ? pgState.knownWorkspaces : [];
      for (let i = 0; i < known.length; i++) pushItem(known[i]);
      const recent = pgLoadRecentWorkspaces();
      for (let i = 0; i < recent.length; i++) pushItem(recent[i]);
      if (typeof _knownWorkspacesList !== 'undefined' && Array.isArray(_knownWorkspacesList)) {
        for (let i = 0; i < _knownWorkspacesList.length; i++) pushItem(_knownWorkspacesList[i]);
      }
      if (pgState.graphData && pgState.graphData.workspaceRoot) {
        pushItem({
          workspaceRoot: pgState.graphData.workspaceRoot,
          projectName: pgState.graphData.workspaceName || pgWsBasename(pgState.graphData.workspaceRoot),
          displayLabel: pgState.graphData.workspaceName || pgWsBasename(pgState.graphData.workspaceRoot),
          status: 'idle',
          source: 'known',
        });
      }
      return merged;
    }

    function pgRenderWorkspaceSelect() {
      const sel = document.getElementById('pgWorkspaceSelect');
      if (!sel) return;
      const list = pgBuildMergedWorkspacesList();
      const autoCandidate = pgState.autoWorkspace ||
        (typeof _autoWorkspaceResolved === 'string' ? _autoWorkspaceResolved : '') ||
        (typeof _activeWorkspaceResolved === 'string' ? _activeWorkspaceResolved : '') ||
        (!pgState.workspaceRoot && pgState.graphData && pgState.graphData.workspaceRoot ? pgState.graphData.workspaceRoot : '');
      const autoLabel = autoCandidate ? pgWsBasename(autoCandidate) : '';
      const targetKey = pgNormWsKey(pgState.workspaceRoot);

      const sigParts = [getUiLanguage(), autoLabel, pgState.workspaceRoot || ''];
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        sigParts.push([w.workspaceRoot, w.displayLabel || w.projectName, w.status || ''].join(':'));
      }
      const nextSig = sigParts.join('|');
      let matchedVal = '';
      for (let i = 0; i < list.length; i++) {
        if (targetKey && pgNormWsKey(list[i].workspaceRoot) === targetKey) {
          matchedVal = list[i].workspaceRoot;
          break;
        }
      }

      if (!sel.dataset || sel.dataset.pgWsSig !== nextSig) {
        if (sel.dataset) sel.dataset.pgWsSig = nextSig;
        sel.innerHTML = '';

        const autoOpt = document.createElement('option');
        autoOpt.value = '';
        autoOpt.textContent = autoLabel
          ? L('Авто (' + autoLabel + ')', 'Auto (' + autoLabel + ')')
          : L('Авто (активный чат)', 'Auto (active chat)');
        autoOpt.title = autoCandidate || L('Автоопределение проекта по активному чату', 'Auto-detect project from active chat');
        sel.appendChild(autoOpt);

        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          const opt = document.createElement('option');
          opt.value = item.workspaceRoot;
          const lbl = item.displayLabel || item.projectName || pgWsBasename(item.workspaceRoot);
          const isLive = item.status === 'running' || item.status === 'waiting_user';
          const isOpenIde = Boolean(item.isOpenInIde || item.source === 'open_ide');
          opt.textContent = (isLive ? '● ' : (isOpenIde ? '○ ' : '')) + lbl;
          opt.title = item.workspaceRoot + (isOpenIde ? L(' (открыт в Antigravity)', ' (open in Antigravity)') : '');
          sel.appendChild(opt);
        }
      }

      sel.value = matchedVal;
      sel.title = matchedVal
        ? (L('Проект карты: ', 'Map project: ') + matchedVal)
        : (autoCandidate
          ? (L('Авторежим: ', 'Auto mode: ') + autoCandidate)
          : L('Выбрать проект для карты', 'Select project for map'));
    }

    async function pgLoadWorkspaces() {
      const seq = ++pgState.workspacesSeq;
      try {
        const params = new URLSearchParams();
        pgAppendWorkspaceParam(params);
        const recent = pgLoadRecentWorkspaces();
        if (recent.length > 0) {
          params.set('extraRoots', recent.join('|'));
        }
        if (typeof refreshSidecarOpenWorkspacesFast === 'function') {
          const openUris = await refreshSidecarOpenWorkspacesFast(true);
          if (Array.isArray(openUris) && openUris.length > 0) {
            params.set('openWorkspaces', openUris.join('|'));
          }
        }
        const q = params.toString();
        const res = await panelFetch('/api/project-graph/workspaces' + (q ? '?' + q : ''));
        const data = await res.json();
        if (seq !== pgState.workspacesSeq) return;
        if (data && data.ok) {
          if (typeof data.autoWorkspace === 'string' && data.autoWorkspace) {
            pgState.autoWorkspace = data.autoWorkspace;
          }
          if (Array.isArray(data.workspaces)) {
            pgState.knownWorkspaces = data.workspaces;
          }
          pgState.workspacesLoaded = true;
          pgRenderWorkspaceSelect();
        }
      } catch {
        if (seq === pgState.workspacesSeq) {
          pgRenderWorkspaceSelect();
        }
      }
    }

    function pgResetProjectTransientState() {
      pgStopLoop();
      pgCloseNodeContextMenu();
      pgUpdateHoverTooltip(null, 0, 0);
      if (typeof pgHideWebglCanvas === 'function') pgHideWebglCanvas();
      pgState.mode = 'global';
      pgState.viewLevel = 'folders';
      pgState.drillFolder = '';
      pgState.focusFile = '';
      pgState.selectedNodeId = '';
      pgState.hoveredNodeId = '';
      pgState.activeClusterId = '';
      pgState.searchQuery = '';
      const searchInp = document.getElementById('pgSearchInput');
      if (searchInp) searchInp.value = '';
      const searchClear = document.getElementById('pgSearchClearBtn');
      if (searchClear) searchClear.style.display = 'none';
      pgState.rawGraphData = null;
      pgState.graphData = null;
      pgState.nodes = [];
      pgState.edges = [];
      pgState.nodeById = new Map();
      pgState.inNeighbors = new Map();
      pgState.outNeighbors = new Map();
      pgState.clusterColors = new Map();
      pgState.layeredColumns = [];
      pgState.activeLayerTier = null;
      pgState.hoveredLayerTier = null;
      pgState.layerHeaderRects = [];
      pgState.dragLayerTier = null;
      pgState.dragLayerOrigin = null;
      pgState.spatialTree = null;
      pgState.symbolFile = '';
      pgState.symbolGraphData = null;
      pgState.symbolLoading = false;
      pgState.gitDiffLoaded = false;
      pgState.gitDiffLoading = false;
      pgState.gitDiffFiles = [];
      pgState.gitDiffSet = new Set();
      pgState.blastUseGitDiff = false;
      pgState.blastWaveMap = new Map();
      pgState.blastFileWaveMap = new Map();
      pgState.blastByHop = { 0: [], 1: [], 2: [], 3: [] };
      pgState.blastAffectedTests = [];
      pgState.blastEstTokens = 0;
      pgState.churnLoaded = false;
      pgState.churnLoading = false;
      pgState.churnByFile = {};
      pgState.churnMax = 0;
      pgState.hotspotScoreMap = new Map();
      pgState.hotspotRankList = [];
      pgState.churnSeq = (pgState.churnSeq || 0) + 1;
      pgState.pathFrom = '';
      pgState.pathTo = '';
      pgState.pathResult = null;
      pgState.pathLoading = false;
      pgState.pathFileSequence = [];
      pgState.pathNodeSet = new Set();
      pgState.pathEdgeSet = new Set();
      pgState.cycles = [];
      pgState.activeCycleIdx = -1;
      pgState.cycleNodeSet = new Set();
      pgState.cycleEdgeSet = new Set();
      pgState.macroCycleNodeSet = new Set();
      pgState.macroCycleEdgeSet = new Set();
      pgState.activeCycleNodeSet = new Set();
      pgState.activeCycleEdgeSet = new Set();
      pgState.orphanSet = new Set();
      pgState.semanticScores = new Map();
      pgState.semanticQuery = '';
      pgState.semanticMode = '';
      pgState.semanticLoading = false;
      pgState.semanticSeq = (pgState.semanticSeq || 0) + 1;
      pgState.contextCart = new Set();
    }

    async function pgSelectWorkspace(nextRoot) {
      const clean = String(nextRoot || '').trim();
      const prevKey = pgNormWsKey(pgState.workspaceRoot);
      const nextKey = pgNormWsKey(clean);
      pgState.workspaceRoot = clean;
      if (clean) {
        pgSaveRecentWorkspace(clean);
        if (!Array.isArray(pgState.knownWorkspaces)) pgState.knownWorkspaces = [];
        const exists = pgState.knownWorkspaces.some(function (w) {
          return w && pgNormWsKey(w.workspaceRoot) === nextKey;
        });
        if (!exists) {
          const base = pgWsBasename(clean) || clean;
          pgState.knownWorkspaces.unshift({
            workspaceRoot: clean,
            projectName: base,
            displayLabel: base,
            status: 'idle',
            source: 'recent',
          });
        }
      }
      pgResetProjectTransientState();
      pgSyncStandaloneUrlParam(clean);
      pgRenderWorkspaceSelect();
      pgRenderToolbarAndStats();
      pgRenderClusterPills();
      if (typeof pgRenderContextCart === 'function') pgRenderContextCart();
      pgRenderInspector();
      pgDrawGraph();

      if (prevKey !== nextKey || !pgState.workspacesLoaded) {
        void pgLoadWorkspaces();
      }
      const label = clean ? (pgWsBasename(clean) || clean) : L('Авто (активный проект)', 'Auto (active project)');
      if (typeof flashStatus === 'function') {
        flashStatus(L('Загружаем карту проекта «' + label + '»…', 'Loading project map "' + label + '"…'));
      }
      await pgLoadGraph({ silent: false });
    }

    async function pgBrowseWorkspaceFolder() {
      const browseBtn = document.getElementById('pgBrowseWorkspaceBtn');
      if (browseBtn) browseBtn.disabled = true;
      try {
        if (typeof flashStatus === 'function') {
          flashStatus(L('Открываем выбор папки проекта…', 'Opening project folder picker…'));
        }
        const initDir = pgGetEffectiveWorkspaceRoot() ||
          pgState.autoWorkspace ||
          (typeof _activeWorkspaceResolved === 'string' ? _activeWorkspaceResolved : '') ||
          '';
        const res = await panelFetch('/api/project-graph/pick-folder', {
          method: 'POST',
          body: JSON.stringify({ initialDir: initDir }),
        });
        const data = await res.json();
        if (!data || !data.ok) {
          if (typeof flashStatus === 'function') {
            flashStatus((data && data.error) || L('Не удалось выбрать папку проекта', 'Failed to pick project folder'));
          }
          return;
        }
        if (data.cancelled || !data.workspaceRoot) {
          return;
        }
        await pgSelectWorkspace(data.workspaceRoot);
      } catch (err) {
        if (typeof flashStatus === 'function') {
          flashStatus((err && err.message) || L('Ошибка диалога выбора папки', 'Folder picker error'));
        }
      } finally {
        if (browseBtn) browseBtn.disabled = false;
      }
    }

    function pgNormalizeFocusFilePath(rawPath) {
      const s = typeof rawPath === 'string' ? rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
      if (!s || s.length > 512 || /[\r\n\0]/.test(s) || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
        return '';
      }
      if (s.split('/').some(function (seg) { return seg === '..'; })) return '';
      return s;
    }

    function pgIsTestFilePath(relPath) {
      const p = String(relPath || '').replace(/\\/g, '/');
      if (!p) return false;
      return /(^|\/)(tests?|__tests__|specs?)(\/|$)/i.test(p) || /\.(test|spec)\.[^./]+$/i.test(p);
    }

    function pgPrepareFocusState(focusFile) {
      const cleanFocus = pgNormalizeFocusFilePath(focusFile);
      if (!cleanFocus) return false;
      pgState.focusFile = cleanFocus;
      pgState.mode = 'local';
      pgState.viewLevel = 'files';
      pgState.drillFolder = '';
      pgState.activeClusterId = '';
      pgState.activeLayerTier = null;
      pgState.hoveredLayerTier = null;
      pgState.layerHeaderRects = [];
      pgState.selectedNodeId = cleanFocus;
      if (pgIsTestFilePath(cleanFocus)) {
        pgState.includeTests = true;
      }
      return true;
    }

    function pgInitStandaloneIfNeeded() {
      if (!pgIsStandaloneView()) return false;
      let focusParam = '';
      try {
        const qs = new URLSearchParams(window.location.search);
        const wsParam = String(qs.get('rootDir') || '').trim();
        focusParam = pgNormalizeFocusFilePath(qs.get('focus') || '');
        pgState.workspaceRoot = wsParam;
        if (wsParam) pgSaveRecentWorkspace(wsParam);
        if (typeof _selectedWorkspaceMode !== 'undefined') {
          _selectedWorkspaceMode = '__auto__';
        }
      } catch {}
      if (document.body) {
        document.body.classList.add('pg-standalone');
      }
      const openOpts = focusParam ? { inlineOnly: true, focusFile: focusParam } : { inlineOnly: true };
      void openProjectGraphModal(openOpts).catch(function () {});
      void pgSyncStandaloneThemeAndLang();
      return true;
    }

    async function openProjectGraphModal(opts) {
      const requestedFocus = pgNormalizeFocusFilePath((opts && (opts.focusFile || opts.focus)) || '');
      if (!pgIsStandaloneView() && !(opts && opts.inlineOnly)) {
        try {
          if (typeof flashStatus === 'function') {
            flashStatus(L('Открытие карты проекта в отдельном окне…', 'Opening project map in standalone window…'));
          }
          const tok = (window.sidecar && window.sidecar.token) ||
            new URLSearchParams(window.location.search).get('token') ||
            '';
          const curGraphWs = pgGetEffectiveWorkspaceRoot();
          const openBody = { token: tok };
          const openParams = new URLSearchParams();
          if (curGraphWs) {
            openBody.rootDir = curGraphWs;
            openParams.set('rootDir', curGraphWs);
          }
          if (requestedFocus) {
            openBody.focus = requestedFocus;
            openParams.set('focus', requestedFocus);
          }
          const openQs = openParams.toString();
          const openUrl = openQs
            ? '/api/project-graph/open-window?' + openQs
            : '/api/project-graph/open-window';
          const res = await panelFetch(openUrl, {
            method: 'POST',
            body: JSON.stringify(openBody),
          });
          const data = await res.json();
          if (data && data.ok) {
            if (typeof flashStatus === 'function') {
              flashStatus(L('Карта проекта открыта в отдельном окне ✓', 'Project map opened in standalone window ✓'));
            }
            return;
          }
        } catch {}
      }

      const modal = document.getElementById('projectGraphModal');
      if (!modal) return;
      if (requestedFocus) {
        pgPrepareFocusState(requestedFocus);
      }
      pgState.open = true;
      modal.classList.add('visible');
      pgBindCanvasEvents();
      pgSyncCanvasSize();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          if (!pgState.open) return;
          pgSyncCanvasSize();
          pgDrawGraph();
        });
      }
      pgRenderWorkspaceSelect();
      pgRenderToolbarAndStats();
      pgRenderInspector();
      if (typeof applyUiLanguageDom === 'function') {
        applyUiLanguageDom(getUiLanguage());
      }
      if (typeof applyPanelUiScaleDom === 'function') {
        applyPanelUiScaleDom((typeof currentState === 'object' && currentState && currentState.panelUiScale) || (typeof _activePanelUiScaleMode !== 'undefined' ? _activePanelUiScaleMode : 'auto'), false);
      }
      void pgLoadWorkspaces();
      void pgLoadGraph({ silent: true });
    }

    function closeProjectGraphModal() {
      pgAbortActiveAiRequest();
      pgClearAiMapOverlay();
      if (pgIsStandaloneView()) {
        try {
          window.close();
        } catch {}
        return;
      }
      const modal = document.getElementById('projectGraphModal');
      if (modal) modal.classList.remove('visible');
      pgState.open = false;
      pgStopLoop();
      pgCloseNodeContextMenu();
      pgUpdateHoverTooltip(null, 0, 0);
    }

    function pgSetGraphMode(mode) {
      const next = mode === 'local' ? 'local' : 'global';
      if (next === 'local') {
        const selNode = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
        const candidate = (selNode && selNode.isFolder)
          ? (selNode.topHubFile || (selNode.fileIds && selNode.fileIds[0]) || '')
          : (pgState.selectedNodeId || pgState.focusFile || (pgState.rawGraphData?.nodes?.[0]?.id || ''));
        if (!candidate) {
          flashStatus(L('Сначала выберите файл для локального режима', 'Select a file first for local mode'));
          return;
        }
        pgState.focusFile = candidate;
        pgState.viewLevel = 'files';
        pgState.drillFolder = '';
      } else {
        pgState.focusFile = '';
      }
      pgState.mode = next;
      pgRenderToolbarAndStats();
      void pgLoadGraph({ silent: true });
    }

    function pgSetViewLevel(level) {
      if (level === 'symbols') {
        if (typeof pgOpenSymbolsForSelected === 'function') {
          pgOpenSymbolsForSelected();
        }
        return;
      }
      const next = level === 'files' ? 'files' : 'folders';
      if (pgState.viewLevel === 'symbols') {
        pgState.symbolFile = '';
        pgState.symbolGraphData = null;
      }
      if (pgState.mode === 'local' && next === 'folders') {
        pgState.mode = 'global';
        pgState.focusFile = '';
        pgState.viewLevel = 'folders';
        pgState.drillFolder = '';
        pgState.selectedNodeId = '';
        pgRenderToolbarAndStats();
        void pgLoadGraph({ silent: true });
        return;
      }
      pgState.viewLevel = next;
      pgState.drillFolder = '';
      pgState.activeClusterId = '';
      pgState.activeLayerTier = null;
      pgState.hoveredLayerTier = null;
      pgState.layerHeaderRects = [];
      pgState.selectedNodeId = '';
      if (pgState.rawGraphData) {
        pgHydrateSimulation(pgState.rawGraphData);
      } else {
        void pgLoadGraph({ silent: true });
      }
    }

    function pgSetLayoutMode(layout) {
      const next = layout === 'force' ? 'force' : 'layered';
      if (pgState.layoutMode === next) return;
      pgState.layoutMode = next;
      pgState.activeLayerTier = null;
      pgState.hoveredLayerTier = null;
      pgState.layerHeaderRects = [];
      if (pgState.rawGraphData) {
        pgHydrateSimulation(pgState.rawGraphData);
      } else {
        pgRenderToolbarAndStats();
      }
    }

    function pgDrillIntoFolder(folderKey) {
      const key = String(folderKey || '').trim();
      if (!key) return;
      pgState.drillFolder = key;
      pgState.viewLevel = 'files';
      pgState.activeClusterId = '';
      pgState.activeLayerTier = null;
      pgState.hoveredLayerTier = null;
      pgState.layerHeaderRects = [];
      pgState.selectedNodeId = '';
      if (pgState.rawGraphData) {
        pgHydrateSimulation(pgState.rawGraphData);
      }
    }

    function pgExitFolderDrill() {
      pgState.drillFolder = '';
      pgState.viewLevel = 'folders';
      pgState.activeClusterId = '';
      pgState.activeLayerTier = null;
      pgState.hoveredLayerTier = null;
      pgState.layerHeaderRects = [];
      pgState.selectedNodeId = '';
      if (pgState.rawGraphData) {
        pgHydrateSimulation(pgState.rawGraphData);
      }
    }

    function pgOpenFileFromFolder(fileId) {
      const targetId = String(fileId || '').trim();
      if (!targetId) return;
      pgState.drillFolder = '';
      pgState.viewLevel = 'files';
      pgState.activeClusterId = '';
      pgState.activeLayerTier = null;
      pgState.hoveredLayerTier = null;
      pgState.layerHeaderRects = [];
      pgState.selectedNodeId = targetId;
      if (pgState.rawGraphData) {
        pgHydrateSimulation(pgState.rawGraphData);
        const node = pgState.nodeById.get(targetId);
        if (node) {
          pgState.camX = node.x;
          pgState.camY = node.y;
          pgDrawGraph();
        }
      }
    }

    function pgExitToMainView() {
      pgState.mode = 'global';
      pgState.focusFile = '';
      pgState.drillFolder = '';
      pgState.viewLevel = 'folders';
      pgState.activeClusterId = '';
      pgState.activeLayerTier = null;
      pgState.hoveredLayerTier = null;
      pgState.layerHeaderRects = [];
      pgState.selectedNodeId = '';
      pgRenderToolbarAndStats();
      void pgLoadGraph({ silent: true });
    }

    function pgFocusSelectedNode() {
      if (!pgState.selectedNodeId) return;
      const selNode = pgState.nodeById.get(pgState.selectedNodeId);
      if (selNode && selNode.isFolder) {
        pgDrillIntoFolder(selNode.folderKey);
        return;
      }
      pgState.focusFile = pgState.selectedNodeId;
      pgState.mode = 'local';
      pgState.viewLevel = 'files';
      pgState.drillFolder = '';
      pgRenderToolbarAndStats();
      void pgLoadGraph({ silent: true });
    }

    function pgRefreshGraph() {
      void pgLoadGraph({ silent: false, refresh: true });
    }

    function pgToggleFilter(kind) {
      if (kind === 'tests') {
        pgState.includeTests = !pgState.includeTests;
        pgRenderToolbarAndStats();
        void pgLoadGraph({ silent: true });
      } else if (kind === 'docs') {
        pgState.includeDocs = !pgState.includeDocs;
        pgRenderToolbarAndStats();
        void pgLoadGraph({ silent: true });
      } else if (kind === 'labels') {
        pgState.showLabels = !pgState.showLabels;
        pgRenderToolbarAndStats();
        pgDrawGraph();
      } else if (kind === 'hulls') {
        pgState.showHulls = !pgState.showHulls;
        pgRenderToolbarAndStats();
        pgDrawGraph();
      } else if (kind === 'bundling') {
        pgState.edgeBundling = !pgState.edgeBundling;
        pgRenderToolbarAndStats();
        pgDrawGraph();
      } else if (kind === 'minimap') {
        pgState.showMinimap = !pgState.showMinimap;
        pgRenderToolbarAndStats();
        pgDrawGraph();
      } else if (kind === 'webgl') {
        if (pgState.renderMode === 'webgl2' || pgState.webglActive) {
          pgState.renderMode = '2d';
        } else {
          pgState.renderMode = 'webgl2';
        }
        pgDrawGraph();
        pgRenderToolbarAndStats();
      }
    }

    function pgChangeNodeLimit(val) {
      const cap = Math.max(50, Math.min(25000, Math.floor(Number(val) || 220)));
      pgState.maxNodes = cap;
      pgRenderToolbarAndStats();
      if (pgState.mode === 'global' && pgState.viewLevel !== 'symbols') {
        void pgLoadGraph({ silent: true });
      }
    }

    function pgChangeDepth(val) {
      const n = Math.max(1, Math.min(3, Math.floor(Number(val) || 2)));
      pgState.depth = n;
      if (pgState.mode === 'local' && pgState.focusFile) {
        void pgLoadGraph({ silent: true });
      }
    }

    function pgFilterCluster(clusterId) {
      const cid = String(clusterId || '');
      pgState.activeClusterId = pgState.activeClusterId === cid ? '' : cid;
      pgRenderClusterPills();
      pgDrawGraph();
    }

    function onProjectGraphSearch(val) {
      pgState.searchQuery = String(val || '');
      const clearBtn = document.getElementById('pgSearchClearBtn');
      if (clearBtn) clearBtn.style.display = pgState.searchQuery.trim() ? 'inline-flex' : 'none';
      const q = pgState.searchQuery.trim().toLowerCase();
      if (q) {
        const exact = pgState.nodes.find(function (n) { return n.label.toLowerCase() === q || n.id.toLowerCase() === q; });
        const firstHit = exact || pgState.nodes.find(function (n) { return n.id.toLowerCase().indexOf(q) !== -1; });
        if (firstHit) {
          pgState.selectedNodeId = firstHit.id;
          pgState.camX = firstHit.x;
          pgState.camY = firstHit.y;
          pgState.camScale = Math.max(pgState.camScale, 1.05);
          pgRenderInspector();
        }
      }
      if (pgState.semanticSearchEnabled && typeof pgScheduleSemanticSearch === 'function') {
        pgScheduleSemanticSearch(pgState.searchQuery);
      }
      pgStartLoop();
    }

    function pgClearSearch() {
      const inp = document.getElementById('pgSearchInput');
      if (inp) inp.value = '';
      onProjectGraphSearch('');
    }

    function pgZoomStep(mode) {
      if (mode === 'fit') {
        pgFitView();
        return;
      }
      const factor = mode === 'in' ? 1.24 : 0.8;
      pgState.camScale = Math.max(0.18, Math.min(8.0, pgState.camScale * factor));
      pgDrawGraph();
    }

    function pgSetInspectorTab(tab) {
      pgState.inspectorTab = (tab === 'imports' || tab === 'overview') ? tab : 'blast';
      pgRenderInspector();
    }

    function pgSelectNodeById(nodeId) {
      let node = nodeId ? pgState.nodeById.get(nodeId) : null;
      if (!node && nodeId && pgState.graphData && pgState.graphData.isMacro && pgState.rawGraphData) {
        const rawNodes = Array.isArray(pgState.rawGraphData.nodes) ? pgState.rawGraphData.nodes : [];
        if (rawNodes.some(function (rn) { return rn.id === nodeId; })) {
          pgState.viewLevel = 'files';
          pgState.selectedNodeId = nodeId;
          pgState.blastUseGitDiff = false;
          pgHydrateSimulation(pgState.rawGraphData);
          node = pgState.nodeById.get(nodeId);
          if (node) {
            pgState.camX = node.x;
            pgState.camY = node.y;
            pgDrawGraph();
          }
          return;
        }
      }
      if (!node) return;
      pgState.selectedNodeId = node.id;
      if (pgState.lens === 'blast') pgState.blastUseGitDiff = false;
      pgState.camX = node.x;
      pgState.camY = node.y;
      if (typeof pgRefreshLensState === 'function') pgRefreshLensState();
      pgRenderInspector();
      pgStartLoop();
    }

    async function pgCopySelectedPath() {
      const node = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      if (!node) return;
      const copyText = node.isSymbol
        ? ((node.file || '') + (node.startLine ? (':' + node.startLine) : ''))
        : node.id;
      if (!copyText) return;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(copyText);
        }
        flashStatus(L('Путь скопирован: ', 'Path copied: ') + copyText);
      } catch {
        flashStatus(copyText);
      }
    }

    function pgSendToComposer() {
      const node = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      if (!node) return;
      const targetFile = node.isFolder
        ? (node.topHubFile || (node.fileIds && node.fileIds[0]) || '')
        : (node.isSymbol ? (node.file || '') : node.id);
      if (!targetFile) return;
      if (typeof pgInsertFilesIntoComposer === 'function') {
        pgInsertFilesIntoComposer([targetFile]);
        return;
      }
      const token = '@file:' + targetFile;
      if (pgIsStandaloneView()) {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            void navigator.clipboard.writeText(token + ' ');
          }
        } catch {}
        flashStatus(L('Скопировано для вставки в чат: ', 'Copied to paste in chat: ') + token);
        return;
      }
      const inputEl = document.getElementById('smartComposerInput');
      if (inputEl) {
        const cur = inputEl.value || '';
        if (cur.indexOf(token) === -1) {
          const sep = cur && !/\s$/.test(cur) ? ' ' : '';
          inputEl.value = cur + sep + token + ' ';
        }
        if (typeof _smartLastDraft !== 'undefined') {
          _smartLastDraft = inputEl.value;
        }
        if (typeof renderSmartComposerMirror === 'function') {
          renderSmartComposerMirror();
        }
      }
      closeProjectGraphModal();
      if (inputEl) {
        inputEl.focus();
      }
      flashStatus(L('Добавлено в Композер: ', 'Added to Composer: ') + token);
    }

    let _pgAiListenersAttached = false;

    function pgEnsureAiListeners() {
      if (_pgAiListenersAttached || typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return;
      }
      _pgAiListenersAttached = true;
      document.addEventListener('click', function (ev) {
        const target = ev.target;
        if (pgState.ctxMenuOpen) {
          if (!(target && target.closest && target.closest('#pgNodeContextMenu'))) {
            pgCloseNodeContextMenu();
          }
        }
        if (!pgState.aiMenuOpen) return;
        if (target && target.closest && (target.closest('#pgAskAiMenu') || target.closest('#pgActionAskAiBtn'))) {
          return;
        }
        pgToggleAskAiMenu(false);
      });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && pgState.ctxMenuOpen) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          pgCloseNodeContextMenu();
          return;
        }
        if (ev.key === 'Escape' && pgState.aiMenuOpen) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          pgToggleAskAiMenu(false);
          return;
        }
        if (ev.key === 'Enter' && !ev.shiftKey && ev.target && ev.target.id === 'pgAiQuestionInput') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          void pgSubmitCustomAiQuestion();
        }
      });
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', function () {
          pgAbortActiveAiRequest();
        });
      }
    }

    function pgCloseNodeContextMenu() {
      pgState.ctxMenuOpen = false;
      pgState.ctxMenuNodeId = '';
      const menuEl = document.getElementById('pgNodeContextMenu');
      if (menuEl) menuEl.hidden = true;
    }

    function pgOpenNodeContextMenu(node, sx, sy) {
      if (!node) return;
      pgEnsureAiListeners();
      pgToggleAskAiMenu(false);
      pgUpdateHoverTooltip(null, 0, 0);

      pgState.selectedNodeId = node.id;
      if (pgState.lens === 'blast') pgState.blastUseGitDiff = false;
      if (typeof pgRefreshLensState === 'function') pgRefreshLensState();
      pgRenderInspector();
      pgStartLoop();

      const menuEl = document.getElementById('pgNodeContextMenu');
      const stageEl = document.getElementById('pgCanvasStage');
      if (!menuEl) return;

      const icon = node.isSymbol ? 'ƒ ' : '';
      const title = node.label || node.id;
      const targetCartId = node.isSymbol && node.file ? node.file : node.id;
      const inCart = Boolean(pgState.contextCart && pgState.contextCart.has(targetCartId));

      const nodeItems = [];
      if (node.isFolder) {
        nodeItems.push({ arg: 'drill', label: L('Раскрыть папку', 'Open folder') });
        nodeItems.push({ arg: 'focus', label: L('Фокус (1–2 хопа)', 'Focus (1–2 hops)') });
      } else if (node.isSymbol) {
        nodeItems.push({ arg: 'focus', label: L('Фокус', 'Focus') });
      } else {
        nodeItems.push({ arg: 'focus', label: L('Фокус (1–2 хопа)', 'Focus (1–2 hops)') });
        nodeItems.push({ arg: 'symbols', label: L('ƒ Символы файла', 'ƒ File symbols') });
      }
      nodeItems.push({ arg: 'path', label: L('⇄ Найти путь A→B', '⇄ Find path A→B') });
      nodeItems.push({
        arg: 'cart',
        label: inCart
          ? L('✓ Убрать из пакета', '✓ Remove from bundle')
          : L('＋ Добавить в пакет', '＋ Add to bundle'),
      });
      nodeItems.push({ arg: 'composer', label: L('Добавить @file в Композер', 'Add @file to Composer') });
      nodeItems.push({ arg: 'copy', label: L('Копировать путь', 'Copy path') });

      const explainLbl = node.isFolder
        ? L('Объяснить, за что отвечает папка', 'Explain what this folder does')
        : (node.isSymbol
            ? L('Объяснить, за что отвечает символ', 'Explain what this symbol does')
            : L('Объяснить, за что отвечает файл', 'Explain what this file does'));

      const aiItems = [
        { arg: 'ai:explain', label: explainLbl },
        { arg: 'ai:risks', label: L('Зависимости и риски (Blast Radius)', 'Dependencies & risks (Blast Radius)') },
        { arg: 'ai:bugs', label: L('Найти баги и слабые места', 'Find bugs & weak spots') },
        { arg: 'ai:tests', label: L('Что проверить тестами', 'What to cover with tests') },
        { arg: 'ai:custom', label: L('Задать свой вопрос…', 'Ask a custom question…') },
        { arg: 'ai:composer', label: L('Открыть вопрос в Умном Композере', 'Open question in Smart Composer') },
      ];

      const renderBtn = function (item) {
        return '<button type="button" class="pg-ai-menu-item" role="menuitem" data-action="pgCtxAction" data-arg="' +
          escapeHtml(item.arg) + '">' + escapeHtml(item.label) + '</button>';
      };

      menuEl.innerHTML =
        '<div class="pg-ctx-header" title="' + escapeHtml(node.id) + '">' + icon + escapeHtml(title) + '</div>' +
        nodeItems.map(renderBtn).join('') +
        '<div class="pg-ctx-sep" role="separator"></div>' +
        '<div class="pg-ctx-section-lbl">' + escapeHtml(L('Спросить ИИ', 'Ask AI')) + '</div>' +
        aiItems.map(renderBtn).join('');

      menuEl.hidden = false;
      pgState.ctxMenuOpen = true;
      pgState.ctxMenuNodeId = node.id;

      const stageW = (stageEl && stageEl.clientWidth) ? stageEl.clientWidth : (pgState.width || 900);
      const stageH = (stageEl && stageEl.clientHeight) ? stageEl.clientHeight : (pgState.height || 600);
      const menuW = menuEl.offsetWidth || 256;
      const menuH = menuEl.offsetHeight || 340;
      const pad = 8;
      const left = Math.max(pad, Math.min(Math.round(sx), Math.max(pad, stageW - menuW - pad)));
      const top = Math.max(pad, Math.min(Math.round(sy), Math.max(pad, stageH - menuH - pad)));
      menuEl.style.left = left + 'px';
      menuEl.style.top = top + 'px';
    }

    function pgRunNodeContextAction(actionKey) {
      const targetId = pgState.ctxMenuNodeId || pgState.selectedNodeId;
      const node = targetId ? pgState.nodeById.get(targetId) : null;
      pgCloseNodeContextMenu();
      if (!node) return;
      pgState.selectedNodeId = node.id;

      const key = String(actionKey || '');
      if (key === 'drill') {
        if (node.isFolder) pgDrillIntoFolder(node.folderKey);
        return;
      }
      if (key === 'focus') {
        pgFocusSelectedNode();
        return;
      }
      if (key === 'symbols') {
        pgOpenSymbolsForSelected();
        return;
      }
      if (key === 'path') {
        pgStartPathFromSelected();
        return;
      }
      if (key === 'cart') {
        pgToggleNodeInCart(node.id);
        return;
      }
      if (key === 'composer') {
        pgSendToComposer();
        return;
      }
      if (key === 'copy') {
        void pgCopySelectedPath();
        return;
      }
      if (key.indexOf('ai:') === 0) {
        void pgRunAiPreset(key.slice(3));
      }
    }

    function pgToggleAskAiMenu(forceState) {
      pgEnsureAiListeners();
      const menuEl = document.getElementById('pgAskAiMenu');
      const btnEl = document.getElementById('pgActionAskAiBtn');
      const node = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      const nextOpen = typeof forceState === 'boolean' ? forceState : !pgState.aiMenuOpen;
      if (nextOpen && !node) {
        flashStatus(L('Сначала выберите файл или папку на карте', 'Select a file or folder on the graph first'));
        return;
      }
      pgState.aiMenuOpen = nextOpen;
      if (menuEl) menuEl.hidden = !nextOpen;
      if (btnEl) btnEl.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    }

    function pgBuildNodeAiContext(node) {
      if (!node) return null;
      const incoming = (pgState.inNeighbors && pgState.inNeighbors.get(node.id)) || [];
      const outgoing = (pgState.outNeighbors && pgState.outNeighbors.get(node.id)) || [];
      const targetFile = node.isFolder
        ? (node.topHubFile || (node.fileIds && node.fileIds[0]) || node.id)
        : (node.isSymbol ? (node.file || node.id) : node.id);
      const topIncoming = incoming.slice(0, 5).map(function (e) { return e.id; }).filter(Boolean);
      const topOutgoing = outgoing.slice(0, 5).map(function (e) { return e.id; }).filter(Boolean);
      return {
        nodeId: node.id,
        targetFile: targetFile,
        nodeLabel: node.label || node.id,
        isFolder: Boolean(node.isFolder),
        isSymbol: Boolean(node.isSymbol),
        symbolName: node.isSymbol ? (node.label || '') : '',
        lines: Number(node.lines || 0),
        inCount: Math.max(incoming.length, Number(node.inDeg || 0)),
        outCount: Math.max(outgoing.length, Number(node.outDeg || 0)),
        topIncoming: topIncoming,
        topOutgoing: topOutgoing,
        isGod: Boolean(node.isGod || (node.godCount || 0) > 0),
        isFragile: Boolean(node.isFragile || (node.fragileCount || 0) > 0),
        reliabilityPct: Number(node.reliabilityPercent !== undefined ? node.reliabilityPercent : 100),
        clusterLabel: node.clusterLabel || '',
      };
    }

    function pgBuildAiPresetPrompt(preset, ctx) {
      if (!ctx) return '';
      const subject = ctx.isSymbol
        ? (ctx.symbolName + ' (' + ctx.targetFile + ')')
        : (ctx.isFolder ? (ctx.nodeLabel + ' (хаб: ' + ctx.targetFile + ')') : ctx.targetFile);
      if (preset === 'explain') {
        return L(
          'Кратко объясни, за что отвечает ' + subject + ', какие ключевые функции/экспорты он предоставляет и как встроен в проект.',
          'Briefly explain the responsibility of ' + subject + ', its key exports/functions, and how it fits into the project.'
        );
      }
      if (preset === 'risks') {
        return L(
          'Оцени зависимости и риски изменений (Blast Radius) для ' + subject + '. Кто от него зависит и что может сломаться при правке?',
          'Analyze dependencies and change risks (Blast Radius) for ' + subject + '. What depends on it and what can break on edit?'
        );
      }
      if (preset === 'bugs') {
        return L(
          'Найди потенциальные баги, гонки, утечки или слабые места обработки ошибок в ' + subject + '.',
          'Find potential bugs, race conditions, leaks, or weak error handling in ' + subject + '.'
        );
      }
      if (preset === 'tests') {
        return L(
          'Какие сценарии и краевые случаи стоит проверить тестами при изменении ' + subject + '?',
          'What scenarios and edge cases should be covered by tests when changing ' + subject + '?'
        );
      }
      return L(
        'Проанализируй ' + subject + ' и предложи ключевые улучшения.',
        'Analyze ' + subject + ' and suggest key improvements.'
      );
    }

    function pgFormatNodeRef(rawId) {
      const raw = String(rawId || '').trim();
      const symMatch = /^sym:([^#]+)#([^:]+)(?::(\d+))?$/.exec(raw);
      if (symMatch) {
        const filePath = symMatch[1];
        const symName = symMatch[2];
        const line = symMatch[3] || '';
        const slashIdx = filePath.lastIndexOf('/');
        const baseFile = slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
        return {
          raw: raw,
          primary: symName,
          secondary: baseFile + (line ? (':' + line) : ''),
          file: filePath,
          line: line,
          isSymbol: true,
        };
      }
      const clean = raw.replace(/\\/g, '/');
      const slashIdx = clean.lastIndexOf('/');
      const base = slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean;
      return {
        raw: raw,
        primary: base,
        secondary: slashIdx >= 0 ? clean : '',
        file: clean,
        line: '',
        isSymbol: false,
      };
    }

    function pgBuildStaticSummaryCard(ctx, warningText) {
      if (!ctx) return null;
      const refInfo = pgFormatNodeRef(ctx.targetFile || ctx.nodeId);
      const title = ctx.isSymbol
        ? (ctx.symbolName || refInfo.primary)
        : (ctx.isFolder ? ctx.nodeLabel : (refInfo.primary || ctx.targetFile));
      const subtitle = ctx.isSymbol
        ? (ctx.targetFile || '')
        : (ctx.isFolder ? (ctx.targetFile || '') : (refInfo.secondary || ctx.targetFile || ''));
      return {
        title: title,
        subtitle: subtitle,
        clusterLabel: ctx.clusterLabel || '',
        isSymbol: Boolean(ctx.isSymbol),
        isFolder: Boolean(ctx.isFolder),
        isGod: Boolean(ctx.isGod),
        isFragile: Boolean(ctx.isFragile),
        reliabilityPct: Number(ctx.reliabilityPct !== undefined ? ctx.reliabilityPct : 100),
        inCount: Number(ctx.inCount || 0),
        outCount: Number(ctx.outCount || 0),
        lines: Number(ctx.lines || 0),
        incoming: (Array.isArray(ctx.topIncoming) ? ctx.topIncoming : []).map(pgFormatNodeRef),
        outgoing: (Array.isArray(ctx.topOutgoing) ? ctx.topOutgoing : []).map(pgFormatNodeRef),
        warningText: String(warningText || '').trim(),
      };
    }

    function pgExtractAiTldr(msg, ctx) {
      if (msg && msg.summaryCard) {
        const card = msg.summaryCard;
        const incNames = card.incoming.slice(0, 3).map(function (r) { return r.primary; }).join(', ');
        const outNames = card.outgoing.slice(0, 2).map(function (r) { return r.primary; }).join(', ');
        const parts = [];
        if (incNames) parts.push(L('Зависимые: ', 'Dependents: ') + incNames);
        if (outNames) parts.push(L('Импорты: ', 'Imports: ') + outNames);
        if (parts.length > 0) return parts.join(' · ');
        return card.warningText || (L('Метрики: ↙ ', 'Metrics: ↙ ') + card.inCount + ' · ↗ ' + card.outCount);
      }
      let clean = String((msg && msg.content) || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^#{1,4}\s+/gm, '')
        .replace(/^\s*[-*•]\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) {
        return ctx
          ? (L('Узел: ', 'Node: ') + (ctx.nodeLabel || ctx.targetFile))
          : '';
      }
      if (clean.length > 175) {
        clean = clean.slice(0, 172).replace(/\s+\S*$/, '') + '…';
      }
      return clean;
    }

    function pgResolveGraphNodeForRef(refStr) {
      const raw = String(refStr || '').trim();
      if (!raw || !pgState.nodeById) return null;
      if (pgState.nodeById.has(raw)) return pgState.nodeById.get(raw);
      const symMatch = /^sym:([^#]+)#([^:]+)(?::\d+)?$/.exec(raw);
      if (symMatch) {
        const symFile = symMatch[1];
        const symName = symMatch[2];
        if (pgState.nodeById.has(symFile)) return pgState.nodeById.get(symFile);
        if (Array.isArray(pgState.nodes)) {
          for (let i = 0; i < pgState.nodes.length; i++) {
            const n = pgState.nodes[i];
            if (n.isSymbol && n.file === symFile && n.label === symName) return n;
          }
        }
      }
      const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/:L?\d+(?:-L?\d+)?$/i, '');
      if (pgState.nodeById.has(norm)) return pgState.nodeById.get(norm);
      if (Array.isArray(pgState.nodes)) {
        for (let i = 0; i < pgState.nodes.length; i++) {
          const n = pgState.nodes[i];
          if (n.id === norm || n.file === norm || n.label === norm) return n;
          if (typeof n.id === 'string' && norm.indexOf('/') === -1 && n.id.endsWith('/' + norm)) return n;
        }
      }
      return null;
    }

    function pgClearAiMapOverlay() {
      if (pgState.aiSpotlightMap && typeof pgState.aiSpotlightMap.clear === 'function') {
        pgState.aiSpotlightMap.clear();
      } else {
        pgState.aiSpotlightMap = new Map();
      }
      pgState.aiCalloutOpen = false;
      pgState.aiCalloutNodeId = '';
      pgState.aiCalloutData = null;
      const el = document.getElementById('pgAiMapCallout');
      if (el) el.hidden = true;
      if (typeof pgStartLoop === 'function') pgStartLoop();
    }

    function pgRenderAiMapCallout() {
      const el = document.getElementById('pgAiMapCallout');
      if (!el) return;
      const d = pgState.aiCalloutData;
      if (!pgState.aiCalloutOpen || !d) {
        el.hidden = true;
        return;
      }
      const pills = [
        '<span class="pg-ai-metric-pill">↙ ' + Number(d.inCount || 0) + '</span>',
        '<span class="pg-ai-metric-pill">↗ ' + Number(d.outCount || 0) + '</span>',
      ];
      if (d.lines > 0) {
        pills.push('<span class="pg-ai-metric-pill">' + Number(d.lines) + ' ' + escapeHtml(L('стр.', 'L')) + '</span>');
      }
      if (d.spotlightCount > 1) {
        pills.push('<span class="pg-ai-metric-pill is-god">' + d.spotlightCount + ' ' + escapeHtml(L('на карте', 'on map')) + '</span>');
      }
      el.innerHTML =
        '<div class="pg-ai-callout-head">' +
          '<span class="pg-ai-callout-title">' + escapeHtml(d.title || '') + '</span>' +
          '<button type="button" class="pg-mini-btn" style="width:20px;height:20px;font-size:11px;" data-action="pgDismissAiMapCallout" title="' + escapeHtml(L('Скрыть выноску с карты', 'Hide map callout')) + '">×</button>' +
        '</div>' +
        '<div class="pg-ai-callout-tldr">' + escapeHtml(d.tldr || '') + '</div>' +
        '<div class="pg-ai-callout-meta">' + pills.join('') + '</div>' +
        '<div class="pg-ai-callout-actions">' +
          '<button type="button" class="win-btn" style="padding:2px 7px;font-size:9.5px;" data-action="pgExpandAiFromCallout">' + escapeHtml(L('Полный ответ', 'Full reply')) + '</button>' +
          '<button type="button" class="win-btn active" style="padding:2px 7px;font-size:9.5px;" data-action="pgSendAiToComposer">' + escapeHtml(L('В Композер', 'To Composer')) + '</button>' +
        '</div>';
      el.hidden = false;
    }

    function pgPositionAiMapCallout() {
      const el = document.getElementById('pgAiMapCallout');
      if (!el) return;
      if (!pgState.aiCalloutOpen || !pgState.aiCalloutNodeId || !pgState.open) {
        el.hidden = true;
        return;
      }
      const node = pgState.nodeById ? pgState.nodeById.get(pgState.aiCalloutNodeId) : null;
      if (!node) {
        el.hidden = true;
        return;
      }
      const pt = pgWorldToScreen(node.x, node.y);
      const w = pgState.width || 600;
      const h = pgState.height || 420;
      const boxW = Math.min(264, Math.max(180, w - 24));
      const boxH = el.offsetHeight || 116;
      const sr = Number(node._sr || (node.isFolder ? (node._bh || 26) * 0.5 : 10));
      const left = Math.max(12, Math.min(w - boxW - 12, Math.round(pt.x - boxW * 0.5)));
      let top = Math.round(pt.y - sr - boxH - 14);
      if (top < 12) {
        top = Math.round(pt.y + sr + 14);
      }
      top = Math.max(12, Math.min(Math.max(12, h - boxH - 42), top));
      el.hidden = false;
      if (el.style) {
        el.style.left = left + 'px';
        el.style.top = top + 'px';
      }
    }

    function pgSyncAiMapOverlay(msg, ctx) {
      if (!pgState.aiSpotlightMap || typeof pgState.aiSpotlightMap.clear !== 'function') {
        pgState.aiSpotlightMap = new Map();
      } else {
        pgState.aiSpotlightMap.clear();
      }
      const addSpot = function (refOrNode) {
        if (pgState.aiSpotlightMap.size >= 8) return;
        const n = (refOrNode && typeof refOrNode === 'object' && refOrNode.id)
          ? refOrNode
          : pgResolveGraphNodeForRef(refOrNode);
        if (n && !pgState.aiSpotlightMap.has(n.id)) {
          pgState.aiSpotlightMap.set(n.id, pgState.aiSpotlightMap.size + 1);
        }
      };
      if (ctx && ctx.nodeId) addSpot(ctx.nodeId);
      if (msg && msg.summaryCard) {
        const card = msg.summaryCard;
        for (let i = 0; i < card.incoming.length; i++) addSpot(card.incoming[i].raw);
        for (let i = 0; i < card.outgoing.length; i++) addSpot(card.outgoing[i].raw);
      }
      if (msg && Array.isArray(msg.sources)) {
        for (let i = 0; i < msg.sources.length; i++) {
          if (msg.sources[i] && msg.sources[i].file) addSpot(msg.sources[i].file);
        }
      }
      if (msg && msg.content && Array.isArray(pgState.nodes) && pgState.aiSpotlightMap.size < 8) {
        const textLower = String(msg.content).toLowerCase();
        for (let i = 0; i < pgState.nodes.length && pgState.aiSpotlightMap.size < 8; i++) {
          const n = pgState.nodes[i];
          if (!n || !n.id || pgState.aiSpotlightMap.has(n.id)) continue;
          const idLow = String(n.id).toLowerCase();
          const lblLow = String(n.label || '').toLowerCase();
          if ((idLow.length >= 5 && textLower.indexOf(idLow) !== -1) ||
              (lblLow.length >= 5 && textLower.indexOf(lblLow) !== -1)) {
            addSpot(n);
          }
        }
      }

      const anchorId = (ctx && ctx.nodeId) || '';
      const anchorNode = anchorId && pgState.nodeById ? pgState.nodeById.get(anchorId) : null;
      if (anchorNode && ctx) {
        pgState.aiCalloutNodeId = anchorNode.id;
        pgState.aiCalloutOpen = true;
        pgState.aiCalloutData = {
          title: (ctx.isSymbol ? ctx.symbolName : ctx.nodeLabel) || ctx.targetFile || anchorNode.label,
          tldr: pgExtractAiTldr(msg, ctx),
          inCount: ctx.inCount || 0,
          outCount: ctx.outCount || 0,
          lines: ctx.lines || 0,
          spotlightCount: pgState.aiSpotlightMap.size,
        };
        pgRenderAiMapCallout();
        pgPositionAiMapCallout();
      }
      if (typeof pgStartLoop === 'function') pgStartLoop();
    }

    function pgFocusAiMention(refStr) {
      const n = pgResolveGraphNodeForRef(refStr);
      if (!n) {
        flashStatus(L('Узел не отображается на текущем уровне карты', 'Node is not visible at current graph level'));
        return;
      }
      pgState.camX = n.x;
      pgState.camY = n.y;
      pgState.hoveredNodeId = n.id;
      if (typeof pgStartLoop === 'function') pgStartLoop();
    }

    function pgDismissAiMapCallout() {
      pgClearAiMapOverlay();
    }

    function pgExpandAiFromCallout() {
      pgState.aiBoxOpen = true;
      pgRenderAiChatBox();
      const boxEl = document.getElementById('pgAiChatBox');
      if (boxEl && typeof boxEl.scrollIntoView === 'function') {
        try { boxEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
      }
    }

    function pgBuildStaticGraphSummary(ctx) {
      if (!ctx) return '';
      const header = ctx.isSymbol
        ? L('Символ: ', 'Symbol: ') + ctx.symbolName + ' (' + ctx.targetFile + ')'
        : (ctx.isFolder ? L('Подсистема: ', 'Subsystem: ') + ctx.nodeLabel : L('Файл: ', 'File: ') + ctx.targetFile);
      const flags = [];
      if (ctx.isGod) flags.push('God Node');
      if (ctx.isFragile) flags.push(L('! Хрупкий (', '! Fragile (') + ctx.reliabilityPct + '%)');
      const lines = [
        header + (ctx.clusterLabel ? (' · [' + ctx.clusterLabel + ']') : ''),
        L('Метрики: ', 'Metrics: ') +
          L('входящих ', 'incoming ') + ctx.inCount +
          ' · ' + L('импортов ', 'imports ') + ctx.outCount +
          (ctx.lines > 0 ? (' · ' + ctx.lines + L(' строк', ' lines')) : '') +
          (flags.length > 0 ? (' · ' + flags.join(', ')) : ''),
      ];
      if (ctx.topIncoming.length > 0) {
        lines.push(L('Зависимые (Blast Radius): ', 'Dependents (Blast Radius): ') + ctx.topIncoming.join(', '));
      }
      if (ctx.topOutgoing.length > 0) {
        lines.push(L('Импортирует: ', 'Imports: ') + ctx.topOutgoing.join(', '));
      }
      return lines.join('\n');
    }

    function pgGetAiElapsedSec() {
      if (!pgState.aiBusy || !pgState.aiStartedAt) return 0;
      return Math.max(0, Math.floor((Date.now() - pgState.aiStartedAt) / 1000));
    }

    function pgUpdateAiElapsedIndicators() {
      if (!pgState.aiBusy) return;
      const sec = pgGetAiElapsedSec();
      const unit = L('с', 's');
      const badgeEl = document.getElementById('pgAiEngineBadge');
      if (badgeEl) {
        badgeEl.textContent = L('GPU RAG · анализ…', 'GPU RAG · thinking…') + (sec > 0 ? (' ' + sec + unit) : '');
      }
      const secEl = document.getElementById('pgAiThinkingSec');
      if (secEl) {
        secEl.textContent = sec + unit;
      }
    }

    function pgAbortActiveAiRequest(opts) {
      const o = opts && typeof opts === 'object' ? opts : {};
      if (pgState.aiElapsedTimer) {
        try { clearInterval(pgState.aiElapsedTimer); } catch {}
        pgState.aiElapsedTimer = 0;
      }
      pgState.aiStartedAt = 0;
      pgState.aiReqSeq += 1;
      const reqId = pgState.aiRequestId;
      pgState.aiRequestId = '';
      if (pgState.aiAbortCtrl && typeof pgState.aiAbortCtrl.abort === 'function') {
        try { pgState.aiAbortCtrl.abort(); } catch {}
      }
      pgState.aiAbortCtrl = null;
      pgState.aiBusy = false;
      if (o.clearHistory) {
        pgState.aiHistory = [];
        pgState.aiLastPrompt = '';
      }
      if (reqId && o.notifyServer !== false && typeof panelFetch === 'function') {
        try {
          Promise.resolve(
            panelFetch('/api/local-chat/abort', {
              method: 'POST',
              body: JSON.stringify({ requestId: reqId }),
              keepalive: true,
            })
          ).catch(function () {});
        } catch {}
      }
    }

    function pgStopAiRequest() {
      if (!pgState.aiBusy) return;
      pgAbortActiveAiRequest();
      pgState.aiHistory.push({
        role: 'assistant',
        error: true,
        content: L('Генерация остановлена пользователем.', 'Generation stopped by user.'),
      });
      pgRenderAiChatBox();
    }

    function pgRenderAiChatBox() {
      const boxEl = document.getElementById('pgAiChatBox');
      const msgEl = document.getElementById('pgAiChatMessages');
      const badgeEl = document.getElementById('pgAiEngineBadge');
      const titleEl = document.getElementById('pgAiChatTitle');
      const submitBtn = document.getElementById('pgAiAskSubmitBtn');
      const node = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      const ctx = pgBuildNodeAiContext(node);
      const gpuOn = Boolean(typeof currentState !== 'undefined' && currentState && currentState.gpuEnabled);
      const elapsedSec = pgGetAiElapsedSec();
      const secSuffix = elapsedSec > 0 ? (' ' + elapsedSec + L('с', 's')) : '';

      if (boxEl) boxEl.style.display = pgState.aiBoxOpen && node ? 'flex' : 'none';
      if (titleEl && ctx) {
        titleEl.textContent = ctx.nodeLabel || ctx.targetFile;
      }
      if (badgeEl) {
        if (badgeEl.classList && typeof badgeEl.classList.toggle === 'function') {
          badgeEl.classList.toggle('is-busy', Boolean(pgState.aiBusy));
        }
        if (pgState.aiBusy) {
          badgeEl.textContent = L('GPU RAG · анализ…', 'GPU RAG · thinking…') + secSuffix;
        } else if (gpuOn) {
          badgeEl.textContent = L('GPU RAG · 0 тк', 'GPU RAG · 0 tok');
        } else {
          badgeEl.textContent = L('Граф + Композер', 'Graph + Composer');
        }
      }
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = pgState.aiBusy ? '■' : '↑';
        submitBtn.setAttribute('data-action', pgState.aiBusy ? 'pgStopAiRequest' : 'pgSubmitCustomAiQuestion');
        submitBtn.title = pgState.aiBusy
          ? L('Остановить генерацию на GPU', 'Stop GPU generation')
          : L('Задать вопрос по выбранному файлу', 'Ask a question about selected file');
        if (submitBtn.classList && typeof submitBtn.classList.toggle === 'function') {
          submitBtn.classList.toggle('is-stop', Boolean(pgState.aiBusy));
        }
      }
      if (!msgEl) return;

      if ((!Array.isArray(pgState.aiHistory) || pgState.aiHistory.length === 0) && !pgState.aiBusy) {
        msgEl.innerHTML = '<div class="pg-insp-placeholder">' + escapeHtml(
          gpuOn
            ? L('Задайте вопрос по файлу — локальный GPU ответит прямо здесь (0% квоты).', 'Ask a question about this file — local GPU answers right here (0% quota).')
            : L('GPU выключен: доступен мгновенный разбор связей и перенос вопроса с @file в Умный Композер.', 'GPU is off: instant dependency summary & @file handoff to Smart Composer available.')
        ) + '</div>';
        return;
      }

      const renderRefChips = function (refs, groupLabel) {
        if (!Array.isArray(refs) || refs.length === 0) return '';
        return '<div class="pg-ai-chip-group">' +
          '<div class="pg-ai-chip-label">' + escapeHtml(groupLabel) + '</div>' +
          '<div class="pg-ai-chips-wrap">' + refs.map(function (r) {
            const targetNode = pgResolveGraphNodeForRef(r.raw);
            const rank = (targetNode && pgState.aiSpotlightMap) ? (pgState.aiSpotlightMap.get(targetNode.id) || 0) : 0;
            const rankHtml = rank > 0 ? ('<span class="pg-ai-rank-badge">' + rank + '</span>') : '';
            const tip = r.file + (r.line ? (':' + r.line) : '');
            return '<button type="button" class="pg-ai-ref-chip" data-action="pgFocusAiMention" data-arg="' + escapeHtml(r.raw) + '" title="' + escapeHtml(tip) + '">' +
              rankHtml +
              '<span class="pg-ai-ref-primary">' + escapeHtml(r.primary) + '</span>' +
              (r.secondary ? '<span class="pg-ai-ref-sub">' + escapeHtml(r.secondary) + '</span>' : '') +
            '</button>';
          }).join('') + '</div>' +
        '</div>';
      };

      const messagesHtml = (Array.isArray(pgState.aiHistory) ? pgState.aiHistory : []).map(function (m) {
        const cls = 'pg-ai-msg ' + (m.role === 'user' ? 'is-user' : 'is-assistant') + (m.error ? ' is-error' : '');
        let bodyHtml = '';
        if (m.role === 'assistant' && m.summaryCard) {
          const card = m.summaryCard;
          const pills = [
            '<span class="pg-ai-metric-pill">↙ ' + card.inCount + '</span>',
            '<span class="pg-ai-metric-pill">↗ ' + card.outCount + '</span>',
          ];
          if (card.lines > 0) {
            pills.push('<span class="pg-ai-metric-pill">' + card.lines + ' ' + escapeHtml(L('стр.', 'L')) + '</span>');
          }
          if (card.isGod) pills.push('<span class="pg-ai-metric-pill is-god">God</span>');
          if (card.isFragile) pills.push('<span class="pg-ai-metric-pill is-fragile">! ' + card.reliabilityPct + '%</span>');
          bodyHtml =
            '<div class="pg-ai-card">' +
              '<div class="pg-ai-card-head">' +
                '<span class="pg-ai-card-title">' + escapeHtml(card.title) + '</span>' +
                (card.clusterLabel ? '<span class="pg-ai-metric-pill">' + escapeHtml(card.clusterLabel) + '</span>' : '') +
              '</div>' +
              (card.subtitle ? '<div class="pg-ai-card-sub">' + escapeHtml(card.subtitle) + '</div>' : '') +
              '<div class="pg-ai-card-metrics">' + pills.join('') + '</div>' +
              renderRefChips(card.incoming, L('Зависимые (Blast Radius):', 'Dependents (Blast Radius):')) +
              renderRefChips(card.outgoing, L('Импортирует:', 'Imports:')) +
              (card.warningText ? '<div class="pg-ai-warn-callout">! ' + escapeHtml(card.warningText) + '</div>' : '') +
            '</div>';
        } else if (m.role === 'assistant') {
          const mdHtml = typeof formatSafeLocalRagMarkdown === 'function'
            ? formatSafeLocalRagMarkdown(m.content || '')
            : '<div class="pg-ai-msg-plain">' + escapeHtml(m.content || '') + '</div>';
          bodyHtml = '<div class="pg-ai-md-body">' + mdHtml + '</div>';
        } else {
          bodyHtml = escapeHtml(m.content || '');
        }
        const srcs = Array.isArray(m.sources) && m.sources.length > 0
          ? '<div class="pg-ai-sources-row">' + m.sources.slice(0, 4).map(function (s) {
              const lbl = s.file + (s.startLine ? (':L' + s.startLine) : '');
              const sNode = pgResolveGraphNodeForRef(s.file);
              const sRank = (sNode && pgState.aiSpotlightMap) ? (pgState.aiSpotlightMap.get(sNode.id) || 0) : 0;
              const sRankHtml = sRank > 0 ? ('<span class="pg-ai-rank-badge">' + sRank + '</span>') : '';
              return '<button type="button" class="pg-ai-source-chip" data-action="pgFocusAiMention" data-arg="' + escapeHtml(s.file) + '" title="' + escapeHtml(lbl) + '">' + sRankHtml + escapeHtml(lbl) + '</button>';
            }).join('') + '</div>'
          : '';
        return '<div class="' + cls + '">' + bodyHtml + srcs + '</div>';
      }).join('');
      const thinkingHtml = pgState.aiBusy
        ? '<div class="pg-ai-msg is-assistant is-thinking" id="pgAiThinkingBubble">' +
            '<span class="pg-ai-thinking-dot" aria-hidden="true"></span>' +
            '<span class="pg-ai-thinking-text">' +
              escapeHtml(L('GPU генерирует ответ… ', 'GPU is generating answer… ')) +
              '<strong id="pgAiThinkingSec">' + elapsedSec + escapeHtml(L('с', 's')) + '</strong>' +
            '</span>' +
            '<button type="button" class="pg-mini-btn pg-ai-stop-inline" data-action="pgStopAiRequest" title="' +
              escapeHtml(L('Остановить генерацию на GPU', 'Stop GPU generation')) + '">' +
              escapeHtml(L('■ Стоп', '■ Stop')) +
            '</button>' +
          '</div>'
        : '';
      const combinedAiHtml = [messagesHtml, thinkingHtml].join('');
      msgEl.innerHTML = combinedAiHtml;
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    async function pgExecuteFileAiQuestion(promptText, displayLabel) {
      pgEnsureAiListeners();
      const node = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      const ctx = pgBuildNodeAiContext(node);
      if (!node || !ctx) return;

      const cleanPrompt = String(promptText || '').trim();
      if (!cleanPrompt) return;
      pgAbortActiveAiRequest();
      pgState.aiNodeId = node.id;
      pgState.aiBoxOpen = true;
      pgState.aiLastPrompt = cleanPrompt;

      const gpuOn = Boolean(typeof currentState !== 'undefined' && currentState && currentState.gpuEnabled);
      const userVisible = String(displayLabel || cleanPrompt).trim();
      pgState.aiHistory.push({ role: 'user', content: userVisible });

      if (!gpuOn) {
        const staticSummary = pgBuildStaticGraphSummary(ctx);
        const hintLine = L(
          'Локальный GPU сейчас выключен — нажмите «В Композер», чтобы отправить готовый вопрос с @file:' + ctx.targetFile + ' агенту.',
          'Local GPU is currently disabled — click "To Composer" to send this question with @file:' + ctx.targetFile + ' to the agent.'
        );
        const offMsg = {
          role: 'assistant',
          content: staticSummary + '\n\n' + hintLine,
          summaryCard: pgBuildStaticSummaryCard(ctx, hintLine),
          sources: ctx.targetFile ? [{ file: ctx.targetFile, startLine: 1 }] : [],
        };
        pgState.aiHistory.push(offMsg);
        pgState.aiBusy = false;
        pgSyncAiMapOverlay(offMsg, ctx);
        pgRenderAiChatBox();
        return;
      }

      const seq = ++pgState.aiReqSeq;
      const requestId = 'pg-' + Date.now() + '-' + seq;
      const priorTurns = pgState.aiHistory
        .slice(0, -1)
        .filter(function (m) { return !m.error && (m.role === 'user' || m.role === 'assistant'); })
        .slice(-6)
        .map(function (m) { return { role: m.role, content: m.content }; });
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      pgState.aiAbortCtrl = ctrl;
      pgState.aiRequestId = requestId;
      pgState.aiBusy = true;
      pgState.aiStartedAt = Date.now();
      if (typeof setInterval === 'function') {
        pgState.aiElapsedTimer = setInterval(pgUpdateAiElapsedIndicators, 1000);
      }
      pgRenderAiChatBox();

      try {
        const wsRoot = pgGetEffectiveWorkspaceRoot() ||
          pgState.autoWorkspace ||
          (typeof _activeWorkspaceResolved === 'string' ? _activeWorkspaceResolved : '') ||
          '';
        const res = await panelFetch('/api/local-chat', {
          method: 'POST',
          body: JSON.stringify({
            requestId: requestId,
            message: cleanPrompt,
            messages: priorTurns,
            rootDir: wsRoot,
            focusFile: ctx.targetFile,
          }),
          signal: ctrl ? ctrl.signal : undefined,
        });
        const data = await res.json();
        if (seq !== pgState.aiReqSeq || pgState.aiNodeId !== node.id) return;

        if (data && data.ok && data.answer) {
          const okMsg = {
            role: 'assistant',
            content: String(data.answer).trim(),
            sources: Array.isArray(data.sources) ? data.sources : [],
            model: data.model || '',
            grounding: data.grounding || null,
          };
          pgState.aiHistory.push(okMsg);
          pgSyncAiMapOverlay(okMsg, ctx);
        } else if (data && data.aborted) {
          return;
        } else {
          const fallbackErr = (data && data.error) || L('Локальный GPU недоступен', 'Local GPU unavailable');
          const warnMsg = fallbackErr + ' — ' +
            L('нажмите «В Композер» для отправки в чат.', 'click "To Composer" to send to agent chat.');
          const errMsg = {
            role: 'assistant',
            error: true,
            content: pgBuildStaticGraphSummary(ctx) + '\n\n! ' + warnMsg,
            summaryCard: pgBuildStaticSummaryCard(ctx, warnMsg),
            sources: ctx.targetFile ? [{ file: ctx.targetFile, startLine: 1 }] : [],
          };
          pgState.aiHistory.push(errMsg);
          pgSyncAiMapOverlay(errMsg, ctx);
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        if (seq !== pgState.aiReqSeq || pgState.aiNodeId !== node.id) return;
        const netWarn = (err && err.message) || L('Ошибка связи с сервером панели', 'Panel server connection error');
        const catchMsg = {
          role: 'assistant',
          error: true,
          content: pgBuildStaticGraphSummary(ctx) + '\n\n! ' + netWarn,
          summaryCard: pgBuildStaticSummaryCard(ctx, netWarn),
        };
        pgState.aiHistory.push(catchMsg);
        pgSyncAiMapOverlay(catchMsg, ctx);
      } finally {
        if (seq === pgState.aiReqSeq) {
          if (pgState.aiElapsedTimer) {
            try { clearInterval(pgState.aiElapsedTimer); } catch {}
            pgState.aiElapsedTimer = 0;
          }
          pgState.aiStartedAt = 0;
          pgState.aiRequestId = '';
          pgState.aiBusy = false;
          pgState.aiAbortCtrl = null;
          pgRenderAiChatBox();
        }
      }
    }

    async function pgRunAiPreset(preset) {
      pgToggleAskAiMenu(false);
      const node = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      const ctx = pgBuildNodeAiContext(node);
      if (!node || !ctx) {
        flashStatus(L('Сначала выберите файл на карте', 'Select a file on the graph first'));
        return;
      }
      pgState.aiNodeId = node.id;
      if (preset === 'custom') {
        pgState.aiBoxOpen = true;
        pgRenderAiChatBox();
        const inp = document.getElementById('pgAiQuestionInput');
        if (inp) inp.focus();
        return;
      }
      const prompt = pgBuildAiPresetPrompt(preset, ctx);
      if (preset === 'composer') {
        pgState.aiLastPrompt = prompt;
        pgSendAiToComposer(prompt);
        return;
      }
      await pgExecuteFileAiQuestion(prompt, prompt);
    }

    async function pgSubmitCustomAiQuestion() {
      const inp = document.getElementById('pgAiQuestionInput');
      const q = inp ? String(inp.value || '').trim() : '';
      if (!q) {
        if (inp) inp.focus();
        return;
      }
      if (inp) inp.value = '';
      await pgExecuteFileAiQuestion(q, q);
    }

    function pgClearAiChat() {
      pgState.aiHistory = [];
      pgState.aiLastPrompt = '';
      pgClearAiMapOverlay();
      pgRenderAiChatBox();
    }

    function pgCloseAiChat() {
      pgAbortActiveAiRequest();
      pgClearAiMapOverlay();
      pgState.aiBoxOpen = false;
      const boxEl = document.getElementById('pgAiChatBox');
      if (boxEl) boxEl.style.display = 'none';
    }

    function pgSendAiToComposer(explicitPrompt) {
      const node = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      const ctx = pgBuildNodeAiContext(node);
      if (!ctx || !ctx.targetFile) return;
      const token = '@file:' + ctx.targetFile;
      const inpEl = document.getElementById('pgAiQuestionInput');
      const draftQ = String(explicitPrompt || (inpEl && inpEl.value) || pgState.aiLastPrompt || '').trim();
      const fullText = draftQ ? (token + ' ' + draftQ) : (token + ' ');

      if (pgIsStandaloneView()) {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            void navigator.clipboard.writeText(fullText);
          }
        } catch {}
        flashStatus(L('Скопировано для вставки в чат: ', 'Copied for chat: ') + token);
        return;
      }

      const compInput = document.getElementById('smartComposerInput');
      if (compInput) {
        const cur = compInput.value || '';
        const sep = cur && !/\s$/.test(cur) ? '\n' : '';
        compInput.value = cur.indexOf(token) !== -1
          ? (draftQ && cur.indexOf(draftQ) === -1 ? (cur + sep + draftQ) : cur)
          : (cur + sep + fullText);
        if (typeof _smartLastDraft !== 'undefined') {
          _smartLastDraft = compInput.value;
        }
        if (typeof renderSmartComposerMirror === 'function') {
          renderSmartComposerMirror();
        }
      }
      closeProjectGraphModal();
      if (compInput) compInput.focus();
      flashStatus(L('Вопрос и @file добавлены в Композер ✓', 'Question & @file sent to Composer ✓'));
    }

    pgEnsureAiListeners();
