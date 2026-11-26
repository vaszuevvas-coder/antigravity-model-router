    // =========================================================================
    // 07c. PROJECT GRAPH VISUALS (BUNDLING, MINIMAP, AST SYMBOLS, GPU SEARCH, EXPORT)
    // =========================================================================

    function pgComputeBundleCentroids(nodes, isLayered) {
      if (!Array.isArray(nodes) || nodes.length === 0) return null;
      const groups = new Map();
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const gk = n.subsystemKey || n.clusterId || 'root';
        let g = groups.get(gk);
        if (!g) {
          g = { sx: 0, sy: 0, count: 0 };
          groups.set(gk, g);
        }
        g.sx += n._sx;
        g.sy += n._sy;
        g.count += 1;
      }
      const scale = pgState.camScale || 1;
      const centerSx = (pgState.width || 600) * 0.5 - pgState.camX * scale;
      const centerSy = (pgState.height || 420) * 0.5 - pgState.camY * scale;
      const centroids = new Map();
      groups.forEach(function (g, gk) {
        if (g.count > 0) {
          centroids.set(gk, {
            x: g.sx / g.count,
            y: g.sy / g.count,
            count: g.count,
            isLayered: Boolean(isLayered)
          });
        }
      });
      centroids.set('__global__', { x: centerSx, y: centerSy, count: nodes.length });
      return centroids;
    }

    function pgComputeBundledEdgeGeom(e, sx, sy, tx, ty, isLayered, isMacro, centroids, isActiveEdge) {
      const scale = pgState.camScale || 1;
      const endOffset = e.target.isFolder ? 2 : (e.target._sr + 2.5);
      const sGroup = e.source.subsystemKey || e.source.clusterId || 'root';
      const tGroup = e.target.subsystemKey || e.target.clusterId || 'root';

      if (isLayered) {
        const dxSpan = Math.max(42, Math.abs(tx - sx) * 0.48);
        const dir = tx >= sx ? 1 : -1;
        const bidirSign = e._isBidir ? (e.source.id < e.target.id ? -1 : 1) : 0;
        const bidirShift = bidirSign * 16;
        const bypassScreen = (e._span >= 2 && e._bypassArc) ? (e._bypassArc * scale) : 0;

        let cp1y = sy + bidirShift + bypassScreen * 0.72;
        let cp2y = ty + bidirShift + bypassScreen * 0.72;
        let cp1x = sx + dxSpan * dir;
        let cp2x = tx - dxSpan * dir;

        if (!bypassScreen && centroids && sGroup !== tGroup) {
          const sC = centroids.get(sGroup);
          const tC = centroids.get(tGroup);
          const strength = isActiveEdge ? 0.22 : (isMacro ? 0.35 : 0.52);
          if (sC && tC) {
            cp1y = cp1y * (1 - strength) + sC.y * strength;
            cp2y = cp2y * (1 - strength) + tC.y * strength;
          }
        }

        const midX = 0.125 * sx + 0.375 * cp1x + 0.375 * cp2x + 0.125 * tx;
        const midY = 0.125 * sy + 0.375 * cp1y + 0.375 * cp2y + 0.125 * ty;
        const tanX = tx - cp2x;
        const tanY = ty - cp2y;
        const tanLen = Math.sqrt(tanX * tanX + tanY * tanY) || 1;
        const ux = tanX / tanLen;
        const uy = tanY / tanLen;
        return {
          isCubic: true,
          sx, sy, cp1x, cp1y, cp2x, cp2y, tx, ty,
          midX, midY, ux, uy,
          tipX: tx - ux * endOffset,
          tipY: ty - uy * endOffset
        };
      }

      if (centroids && (sGroup !== tGroup || e._isBidir)) {
        const sC = centroids.get(sGroup);
        const tC = centroids.get(tGroup);
        const gC = centroids.get('__global__');
        const mx = (sx + tx) * 0.5;
        const my = (sy + ty) * 0.5;
        const dx = tx - sx;
        const dy = ty - sy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / dist;
        const ny = dx / dist;
        const bidirPush = e._isBidir ? (e.source.id < e.target.id ? 14 : -14) : 0;

        let cx = mx + nx * bidirPush;
        let cy = my + ny * bidirPush;
        if (sGroup !== tGroup && sC && tC) {
          const hubMidX = (sC.x + tC.x) * 0.5;
          const hubMidY = (sC.y + tC.y) * 0.5;
          const gPull = gC ? 0.14 : 0;
          const targetX = hubMidX * (1 - gPull) + (gC ? gC.x * gPull : 0);
          const targetY = hubMidY * (1 - gPull) + (gC ? gC.y * gPull : 0);
          const bundleStr = isActiveEdge ? 0.25 : 0.62;
          cx = cx * (1 - bundleStr) + targetX * bundleStr;
          cy = cy * (1 - bundleStr) + targetY * bundleStr;
        }

        const midX = 0.25 * sx + 0.5 * cx + 0.25 * tx;
        const midY = 0.25 * sy + 0.5 * cy + 0.25 * ty;
        const tanX = tx - cx;
        const tanY = ty - cy;
        const tanLen = Math.sqrt(tanX * tanX + tanY * tanY) || 1;
        const ux = tanX / tanLen;
        const uy = tanY / tanLen;
        return {
          isQuad: true,
          sx, sy, cx, cy, tx, ty,
          midX, midY, ux, uy,
          tipX: tx - ux * endOffset,
          tipY: ty - uy * endOffset
        };
      }

      if (e._isBidir) {
        const dx = tx - sx;
        const dy = ty - sy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / dist;
        const ny = dx / dist;
        const cx = (sx + tx) * 0.5 + nx * 14;
        const cy = (sy + ty) * 0.5 + ny * 14;
        const tanX = tx - cx;
        const tanY = ty - cy;
        const tanLen = Math.sqrt(tanX * tanX + tanY * tanY) || 1;
        const ux = tanX / tanLen;
        const uy = tanY / tanLen;
        return {
          isQuad: true,
          sx, sy, cx, cy, tx, ty,
          midX: 0.25 * sx + 0.5 * cx + 0.25 * tx,
          midY: 0.25 * sy + 0.5 * cy + 0.25 * ty,
          ux, uy,
          tipX: tx - ux * endOffset,
          tipY: ty - uy * endOffset
        };
      }

      const dx = tx - sx;
      const dy = ty - sy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      return {
        isQuad: false,
        isCubic: false,
        sx, sy, tx, ty,
        midX: (sx + tx) * 0.5,
        midY: (sy + ty) * 0.5,
        ux, uy,
        tipX: tx - ux * endOffset,
        tipY: ty - uy * endOffset
      };
    }

    function pgDrawMinimap(ctx, w, h) {
      const nodes = pgState.nodes;
      if (!ctx || !Array.isArray(nodes) || nodes.length === 0 || w < 340 || h < 220) {
        pgState.minimapRect = null;
        return;
      }
      const mw = Math.min(156, Math.round(w * 0.24));
      const mh = Math.min(104, Math.round(h * 0.24));
      const mx = w - mw - 12;
      const my = h - mh - 12;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      const pad = 80;
      minX -= pad; maxX += pad;
      minY -= pad; maxY += pad;
      const spanX = Math.max(200, maxX - minX);
      const spanY = Math.max(200, maxY - minY);
      const mScale = Math.min((mw - 12) / spanX, (mh - 12) / spanY);
      const offX = mx + (mw - spanX * mScale) * 0.5;
      const offY = my + (mh - spanY * mScale) * 0.5;

      pgState.minimapRect = { mx, my, mw, mh, minX, minY, spanX, spanY, mScale, offX, offY };

      ctx.save();
      pgDrawRoundedRectPath(ctx, mx, my, mw, mh, 5);
      ctx.fillStyle = 'rgba(18, 19, 22, 0.92)';
      ctx.fill();
      ctx.strokeStyle = '#2a2d35';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.save();
      pgDrawRoundedRectPath(ctx, mx + 2, my + 2, mw - 4, mh - 4, 4);
      ctx.clip();

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const px = offX + (n.x - minX) * mScale;
        const py = offY + (n.y - minY) * mScale;
        const sem = pgState.semanticSearchEnabled && pgState.semanticScores ? (pgState.semanticScores.get(n.id) || 0) : 0;
        const hs = pgState.lens === 'hotspots' && pgState.hotspotScoreMap ? (pgState.hotspotScoreMap.get(n.id) || 0) : 0;
        let dotCol = pgGetClusterColor(n.clusterId);
        let r = n.isFolder ? 2.6 : 1.7;
        if (sem > 0.2) {
          dotCol = '#22c55e';
          r = 2.8;
        } else if (hs > 0.45 && typeof pgGetHotspotColor === 'function') {
          dotCol = pgGetHotspotColor(hs);
          r = 2.6;
        } else if (n.id === pgState.selectedNodeId) {
          dotCol = '#f04848';
          r = 3.0;
        }
        ctx.fillStyle = dotCol;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw current camera viewport frame inside minimap
      const scale = pgState.camScale || 1;
      const viewLeft = pgState.camX - (w * 0.5) / scale;
      const viewTop = pgState.camY - (h * 0.5) / scale;
      const viewW = w / scale;
      const viewH = h / scale;
      const vx = offX + (viewLeft - minX) * mScale;
      const vy = offY + (viewTop - minY) * mScale;
      const vw = Math.max(8, viewW * mScale);
      const vh = Math.max(8, viewH * mScale);
      ctx.strokeStyle = '#f04848';
      ctx.fillStyle = 'rgba(240, 72, 72, 0.14)';
      ctx.lineWidth = 1.1;
      ctx.fillRect(vx, vy, vw, vh);
      ctx.strokeRect(vx, vy, vw, vh);

      ctx.restore();
      ctx.restore();
    }

    function pgHitTestMinimap(sx, sy) {
      const mr = pgState.minimapRect;
      if (!mr) return false;
      return sx >= mr.mx && sx <= mr.mx + mr.mw && sy >= mr.my && sy <= mr.my + mr.mh;
    }

    function pgPanCameraFromMinimap(sx, sy) {
      const mr = pgState.minimapRect;
      if (!mr || mr.mScale <= 0) return;
      const wx = mr.minX + (sx - mr.offX) / mr.mScale;
      const wy = mr.minY + (sy - mr.offY) / mr.mScale;
      pgState.camX = wx;
      pgState.camY = wy;
    }

    async function pgOpenFileSymbols(fileId) {
      const target = typeof pgResolveFileTargetFromNode === 'function'
        ? pgResolveFileTargetFromNode(fileId)
        : String(fileId || '').trim();
      if (!target || pgState.symbolLoading) return;

      if (pgState.viewLevel !== 'symbols') {
        pgState.symbolReturnLevel = (pgState.viewLevel === 'folders' && !pgState.drillFolder) ? 'folders' : 'files';
      }
      pgState.symbolLoading = true;
      pgState.symbolFile = target;
      const emptyEl = document.getElementById('pgEmptyState');
      const emptyTitle = document.getElementById('pgEmptyTitle');
      const emptySub = document.getElementById('pgEmptySub');
      if (emptyEl) {
        emptyEl.style.display = 'flex';
        if (emptyTitle) emptyTitle.textContent = L('Строим граф AST-символов…', 'Building AST symbol graph…');
        if (emptySub) emptySub.textContent = target;
      }

      try {
        const params = new URLSearchParams();
        params.set('file', target);
        if (typeof pgAppendWorkspaceParam === 'function') pgAppendWorkspaceParam(params);
        const res = await panelFetch('/api/project-graph/symbols?' + params.toString());
        const data = await res.json();
        if (!data || !data.ok) {
          if (emptyEl) emptyEl.style.display = 'none';
          flashStatus((data && data.error) || L('Не удалось построить граф символов', 'Failed to build symbol graph'));
          return;
        }
        pgState.viewLevel = 'symbols';
        pgState.activeClusterId = '';
        pgState.selectedNodeId = '';
        pgState.symbolGraphData = data;
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
            if (emptyTitle) emptyTitle.textContent = L('Символы AST не найдены', 'No AST symbols found');
            if (emptySub) emptySub.textContent = L('В этом файле нет объявленных функций или классов', 'This file defines no functions or classes');
          }
          return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        pgHydrateSimulation(data);
      } catch {
        if (emptyEl) emptyEl.style.display = 'none';
        flashStatus(L('Ошибка загрузки AST-символов', 'Failed to load AST symbols'));
      } finally {
        pgState.symbolLoading = false;
      }
    }

    function pgOpenSymbolsForSelected() {
      const selNode = pgState.selectedNodeId ? pgState.nodeById.get(pgState.selectedNodeId) : null;
      let target = '';
      if (selNode) {
        target = selNode.isSymbol
          ? (selNode.file || '')
          : (typeof pgResolveFileTargetFromNode === 'function' ? pgResolveFileTargetFromNode(selNode) : selNode.id);
      }
      if (!target && pgState.symbolFile) {
        target = pgState.symbolFile;
      }
      if (!target && pgState.rawGraphData && Array.isArray(pgState.rawGraphData.nodes) && pgState.rawGraphData.nodes.length > 0) {
        const hub = pgState.rawGraphData.nodes.find(function (n) { return n.isGod; }) || pgState.rawGraphData.nodes[0];
        target = hub ? hub.id : '';
      }
      if (!target) {
        flashStatus(L('Выберите файл для просмотра AST-символов', 'Select a file to inspect AST symbols'));
        return;
      }
      void pgOpenFileSymbols(target);
    }

    function pgExitSymbolsLevel(targetLevel) {
      const prevFile = pgState.symbolFile || '';
      const dest = targetLevel === 'folders' ? 'folders' : 'files';
      pgState.viewLevel = dest;
      pgState.symbolFile = '';
      pgState.symbolGraphData = null;
      pgState.activeClusterId = '';
      pgState.selectedNodeId = (dest === 'files' && prevFile) ? prevFile : '';
      const emptyEl = document.getElementById('pgEmptyState');
      if (emptyEl) emptyEl.style.display = 'none';
      if (pgState.rawGraphData) {
        pgHydrateSimulation(pgState.rawGraphData);
      } else {
        void pgLoadGraph({ silent: true });
      }
    }

    function pgToggleSemanticSearch() {
      pgState.semanticSearchEnabled = !pgState.semanticSearchEnabled;
      pgRenderToolbarAndStats();
      if (!pgState.semanticSearchEnabled) {
        pgState.semanticScores = new Map();
        pgState.semanticQuery = '';
        pgState.semanticMode = '';
        if (typeof pgRenderLegendExtra === 'function') pgRenderLegendExtra();
        pgRenderInspector();
        pgStartLoop();
        return;
      }
      const q = pgState.searchQuery.trim();
      if (q.length >= 2) {
        void pgRunSemanticSearch(q);
      } else {
        flashStatus(L('GPU-поиск включён: введите запрос в строку поиска', 'GPU search enabled: enter query in search box'));
      }
    }

    function pgScheduleSemanticSearch(q) {
      if (pgState.semanticTimer) {
        clearTimeout(pgState.semanticTimer);
        pgState.semanticTimer = 0;
      }
      const clean = String(q || '').trim();
      if (!pgState.semanticSearchEnabled || clean.length < 2) {
        pgState.semanticScores = new Map();
        pgState.semanticQuery = '';
        if (typeof pgRenderLegendExtra === 'function') pgRenderLegendExtra();
        return;
      }
      pgState.semanticTimer = setTimeout(function () {
        pgState.semanticTimer = 0;
        void pgRunSemanticSearch(clean);
      }, 240);
    }

    async function pgRunSemanticSearch(q) {
      const clean = String(q || '').trim();
      if (!pgState.semanticSearchEnabled || clean.length < 2) {
        pgState.semanticScores = new Map();
        return;
      }
      const seq = ++pgState.semanticSeq;
      pgState.semanticLoading = true;
      pgState.semanticQuery = clean;
      try {
        const params = new URLSearchParams();
        params.set('q', clean);
        if (typeof pgAppendWorkspaceParam === 'function') pgAppendWorkspaceParam(params);
        const res = await panelFetch('/api/project-graph/semantic-search?' + params.toString());
        const data = await res.json();
        if (seq !== pgState.semanticSeq || !pgState.semanticSearchEnabled) return;
        const map = new Map();
        if (data && data.ok && data.scoresByFile && typeof data.scoresByFile === 'object') {
          Object.keys(data.scoresByFile).forEach(function (file) {
            const val = Number(data.scoresByFile[file]);
            if (val > 0) map.set(file, val);
          });
          pgState.semanticMode = data.mode || '';
        }
        pgState.semanticScores = map;
        if (map.size > 0 && data.matches && data.matches[0]) {
          const topFile = data.matches[0].file;
          if (pgState.nodeById.has(topFile)) {
            const hitNode = pgState.nodeById.get(topFile);
            pgState.selectedNodeId = hitNode.id;
            pgState.camX = hitNode.x;
            pgState.camY = hitNode.y;
          }
        }
        if (typeof pgRenderLegendExtra === 'function') pgRenderLegendExtra();
        pgRenderInspector();
        pgStartLoop();
      } catch {
        if (seq === pgState.semanticSeq) pgState.semanticScores = new Map();
      } finally {
        if (seq === pgState.semanticSeq) pgState.semanticLoading = false;
      }
    }

    function pgBuildMermaidDiagram() {
      const nodes = Array.isArray(pgState.nodes) ? pgState.nodes : [];
      const edges = Array.isArray(pgState.edges) ? pgState.edges : [];
      if (nodes.length === 0) return 'flowchart LR\n';

      const idMap = new Map();
      const sanitizeId = function (raw, idx) {
        const clean = String(raw || '').replace(/[^A-Za-z0-9_]/g, '_');
        return 'N_' + idx + '_' + clean.slice(-24);
      };
      const lines = ['flowchart LR'];
      for (let i = 0; i < nodes.length && i < 120; i++) {
        const n = nodes[i];
        const mid = sanitizeId(n.id, i);
        idMap.set(n.id, mid);
        const safeLabel = String(n.label || n.id).replace(/"/g, "'");
        lines.push('  ' + mid + '["' + safeLabel + '"]');
      }
      for (let i = 0; i < edges.length && i < 250; i++) {
        const e = edges[i];
        const sMid = idMap.get(e.source.id);
        const tMid = idMap.get(e.target.id);
        if (!sMid || !tMid) continue;
        const arrow = (e.kind === 'doc') ? ' -.-> ' : ' --> ';
        lines.push('  ' + sMid + arrow + tMid);
      }
      return lines.join('\n') + '\n';
    }

    async function pgExportMermaid() {
      const mmd = pgBuildMermaidDiagram();
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(mmd);
        }
        flashStatus(L('Mermaid-диаграмма скопирована ✓', 'Mermaid diagram copied ✓'));
      } catch {
        flashStatus(L('Mermaid сформирован (' + mmd.split('\n').length + ' строк)', 'Mermaid built (' + mmd.split('\n').length + ' lines)'));
      }
      return mmd;
    }

    function pgExportPng() {
      const canvas = document.getElementById('projectGraphCanvas');
      if (!canvas || typeof canvas.toDataURL !== 'function') return '';
      try {
        let dataUrl = '';
        const glCanvas = document.getElementById('projectGraphWebglCanvas');
        if (pgState.webglActive && glCanvas) {
          const comp = document.createElement('canvas');
          if (comp && typeof comp.getContext === 'function' && typeof comp.toDataURL === 'function') {
            comp.width = canvas.width || 1200;
            comp.height = canvas.height || 800;
            const c2 = comp.getContext('2d');
            if (c2 && typeof c2.drawImage === 'function') {
              c2.drawImage(glCanvas, 0, 0);
              c2.drawImage(canvas, 0, 0);
              dataUrl = comp.toDataURL('image/png');
            }
          }
        }
        if (!dataUrl) {
          dataUrl = canvas.toDataURL('image/png');
        }
        const a = document.createElement('a');
        if (a && typeof a.click === 'function') {
          const baseName = (pgState.graphData && pgState.graphData.workspaceName) ? pgState.graphData.workspaceName : 'project-graph';
          a.href = dataUrl;
          a.download = baseName.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + (pgState.viewLevel || 'map') + '.png';
          a.click();
        }
        flashStatus(L('PNG-снимок карты сохранён ✓', 'Graph PNG snapshot saved ✓'));
        return dataUrl;
      } catch {
        flashStatus(L('Не удалось экспортировать PNG', 'Failed to export PNG'));
        return '';
      }
    }
