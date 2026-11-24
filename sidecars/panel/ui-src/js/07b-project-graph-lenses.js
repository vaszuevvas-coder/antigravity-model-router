    // =========================================================================
    // 07b. PROJECT GRAPH LENSES (BLAST+DIFF, TARJAN CYCLES, PATH A->B, CART)
    // =========================================================================

    function pgGetHopColor(hop, isLight) {
      if (hop <= 0) return isLight ? '#dc2626' : '#ff375f';
      if (hop === 1) return isLight ? '#ea580c' : '#ff9f0a';
      if (hop === 2) return isLight ? '#d97706' : '#ffd60a';
      return isLight ? '#0284c7' : '#64d2ff';
    }

    function pgGetNodeEstTokens(nodeId) {
      if (!nodeId) return 0;
      const rawNodes = Array.isArray(pgState.rawGraphData?.nodes) ? pgState.rawGraphData.nodes : [];
      for (let i = 0; i < rawNodes.length; i++) {
        const rn = rawNodes[i];
        if (rn.id === nodeId) {
          if (Number(rn.estTokens) > 0) return Number(rn.estTokens);
          return Math.max(10, Math.round(Number(rn.lines || 20) * 11));
        }
      }
      const n = pgState.nodeById.get(nodeId);
      if (n) {
        if (Number(n.estTokens) > 0) return Number(n.estTokens);
        return Math.max(10, Math.round(Number(n.lines || 20) * 11));
      }
      return 120;
    }

    function pgFormatTokenEstimate(tok) {
      const val = Math.max(0, Math.round(Number(tok || 0)));
      if (val >= 1000) return '~' + (val / 1000).toFixed(1) + 'k';
      return '~' + val;
    }

    function pgResolveFileTargetFromNode(nodeOrId) {
      const id = typeof nodeOrId === 'string' ? nodeOrId : (nodeOrId && nodeOrId.id ? nodeOrId.id : '');
      if (!id) return '';
      const node = typeof nodeOrId === 'object' && nodeOrId ? nodeOrId : pgState.nodeById.get(id);
      if (node && node.isSymbol && node.file) {
        return node.file;
      }
      if (node && node.isFolder) {
        return node.topHubFile || (Array.isArray(node.fileIds) && node.fileIds[0]) || '';
      }
      if (id.indexOf('folder:') === 0) {
        const subKey = id.slice(7);
        const rawNodes = Array.isArray(pgState.rawGraphData?.nodes) ? pgState.rawGraphData.nodes : [];
        for (let i = 0; i < rawNodes.length; i++) {
          if (String(rawNodes[i].id || '').indexOf(subKey + '/') === 0) return rawNodes[i].id;
        }
        return '';
      }
      return id;
    }

    function pgResolveMacroProjectionMap() {
      const rawNodes = Array.isArray(pgState.rawGraphData?.nodes) ? pgState.rawGraphData.nodes : [];
      return typeof pgBuildSubsystemMap === 'function' ? pgBuildSubsystemMap(rawNodes) : new Map();
    }

    function pgSyncCycleSetsFromRaw(rawData) {
      const cycles = Array.isArray(rawData?.cycles) ? rawData.cycles : [];
      pgState.cycles = cycles;
      pgState.cycleNodeSet = new Set(Array.isArray(rawData?.cycleNodeIds) ? rawData.cycleNodeIds : []);
      pgState.cycleEdgeSet = new Set(Array.isArray(rawData?.cycleEdgeKeys) ? rawData.cycleEdgeKeys : []);
      pgState.orphanSet = new Set(Array.isArray(rawData?.orphanIds) ? rawData.orphanIds : []);

      // Fallback compute from edges if rawData has cycles without precomputed sets
      if (cycles.length > 0 && pgState.cycleNodeSet.size === 0) {
        for (let c = 0; c < cycles.length; c++) {
          const chain = cycles[c];
          for (let i = 0; i < chain.length; i++) {
            pgState.cycleNodeSet.add(chain[i]);
            if (i + 1 < chain.length) {
              pgState.cycleEdgeSet.add(chain[i] + '->' + chain[i + 1]);
            }
          }
        }
      }

      // Project onto folder macro nodes when in macro view
      const subMap = pgResolveMacroProjectionMap();
      const macroNodes = new Set();
      const macroEdges = new Set();
      pgState.cycleNodeSet.forEach(function (fid) {
        const sk = subMap.get(fid);
        if (sk) macroNodes.add('folder:' + sk);
      });
      pgState.cycleEdgeSet.forEach(function (ek) {
        const arrowIdx = ek.indexOf('->');
        if (arrowIdx <= 0) return;
        const sKey = subMap.get(ek.slice(0, arrowIdx));
        const tKey = subMap.get(ek.slice(arrowIdx + 2));
        if (sKey && tKey && sKey !== tKey) {
          macroEdges.add('folder:' + sKey + '->folder:' + tKey);
        }
      });
      pgState.macroCycleNodeSet = macroNodes;
      pgState.macroCycleEdgeSet = macroEdges;

      if (pgState.activeCycleIdx >= cycles.length) {
        pgState.activeCycleIdx = -1;
      }
      pgRebuildActiveCycleSubsets();
    }

    function pgRebuildActiveCycleSubsets() {
      const nodeSet = new Set();
      const edgeSet = new Set();
      const idx = pgState.activeCycleIdx;
      const chain = idx >= 0 && Array.isArray(pgState.cycles) ? pgState.cycles[idx] : null;
      if (Array.isArray(chain) && chain.length >= 2) {
        for (let i = 0; i < chain.length; i++) {
          nodeSet.add(chain[i]);
          if (i + 1 < chain.length) {
            edgeSet.add(chain[i] + '->' + chain[i + 1]);
          }
        }
      }
      pgState.activeCycleNodeSet = nodeSet;
      pgState.activeCycleEdgeSet = edgeSet;
    }

    function pgComputeTransitiveBlast(seedIds, maxHops) {
      const limitHops = Math.max(1, Math.min(3, Number(maxHops) || 3));
      const rawNodes = Array.isArray(pgState.rawGraphData?.nodes) ? pgState.rawGraphData.nodes : [];
      const rawEdges = Array.isArray(pgState.rawGraphData?.edges) ? pgState.rawGraphData.edges : [];
      const testFilesByTarget = (pgState.rawGraphData && typeof pgState.rawGraphData.testFilesByTarget === 'object' && pgState.rawGraphData.testFilesByTarget) || {};

      const rawNodeSet = new Set();
      const rawNodeMap = new Map();
      for (let i = 0; i < rawNodes.length; i++) {
        rawNodeSet.add(rawNodes[i].id);
        rawNodeMap.set(rawNodes[i].id, rawNodes[i]);
      }

      // Reverse adjacency: if `source` imports `target`, changing `target` impacts `source`.
      const revAdj = new Map();
      for (let i = 0; i < rawEdges.length; i++) {
        const e = rawEdges[i];
        if (!e || !e.source || !e.target) continue;
        let list = revAdj.get(e.target);
        if (!list) {
          list = [];
          revAdj.set(e.target, list);
        }
        list.push(e.source);
      }

      const expandedSeeds = [];
      const seenSeed = new Set();
      const inputSeeds = Array.isArray(seedIds) ? seedIds : [seedIds];
      for (let i = 0; i < inputSeeds.length; i++) {
        const s = String(inputSeeds[i] || '').trim();
        if (!s) continue;
        const folderNode = pgState.nodeById.get(s);
        if (folderNode && folderNode.isFolder && Array.isArray(folderNode.fileIds)) {
          for (let j = 0; j < folderNode.fileIds.length; j++) {
            const fid = folderNode.fileIds[j];
            if (rawNodeSet.has(fid) && !seenSeed.has(fid)) {
              seenSeed.add(fid);
              expandedSeeds.push(fid);
            }
          }
        } else if (rawNodeSet.has(s) && !seenSeed.has(s)) {
          seenSeed.add(s);
          expandedSeeds.push(s);
        }
      }

      const fileWaveMap = new Map();
      const byHop = { 0: [], 1: [], 2: [], 3: [] };
      const queue = [];

      for (let i = 0; i < expandedSeeds.length; i++) {
        const fid = expandedSeeds[i];
        fileWaveMap.set(fid, 0);
        byHop[0].push(fid);
        queue.push({ id: fid, hop: 0 });
      }

      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        if (cur.hop >= limitHops) continue;
        const dependents = revAdj.get(cur.id) || [];
        for (let i = 0; i < dependents.length; i++) {
          const depId = dependents[i];
          if (fileWaveMap.has(depId)) continue;
          const nextHop = cur.hop + 1;
          fileWaveMap.set(depId, nextHop);
          if (!byHop[nextHop]) byHop[nextHop] = [];
          byHop[nextHop].push(depId);
          queue.push({ id: depId, hop: nextHop });
        }
      }

      for (const hKey of Object.keys(byHop)) {
        byHop[hKey].sort();
      }

      const affectedTestsSet = new Set();
      let estTokens = 0;
      fileWaveMap.forEach(function (_hop, fid) {
        estTokens += pgGetNodeEstTokens(fid);
        const nodeObj = rawNodeMap.get(fid);
        if (nodeObj && nodeObj.isTest) {
          affectedTestsSet.add(fid);
        }
        const linkedTests = testFilesByTarget[fid];
        if (Array.isArray(linkedTests)) {
          for (let t = 0; t < linkedTests.length; t++) {
            affectedTestsSet.add(linkedTests[t]);
          }
        }
      });

      // Merge projected folder min-hop entries so macro folder canvas view can render the wave too
      const combinedWaveMap = new Map(fileWaveMap);
      if (pgState.graphData && pgState.graphData.isMacro) {
        const subMap = pgResolveMacroProjectionMap();
        fileWaveMap.forEach(function (hop, fid) {
          const sk = subMap.get(fid);
          if (!sk) return;
          const folderKey = 'folder:' + sk;
          const prev = combinedWaveMap.get(folderKey);
          if (prev === undefined || hop < prev) {
            combinedWaveMap.set(folderKey, hop);
          }
        });
      }

      return {
        waveMap: combinedWaveMap,
        fileWaveMap,
        byHop,
        fileCount: fileWaveMap.size,
        affectedTests: Array.from(affectedTestsSet).sort(),
        estTokens,
      };
    }

    function pgGetHotspotColor(score, isLight) {
      const s = Math.max(0, Math.min(1, Number(score || 0)));
      if (s >= 0.72) return isLight ? '#dc2626' : '#ff375f';
      if (s >= 0.42) return isLight ? '#ea580c' : '#ff9f0a';
      return isLight ? '#d97706' : '#ffd60a';
    }

    function pgComputeHotspotScores() {
      const scoreMap = new Map();
      const rankList = [];
      const rawNodes = Array.isArray(pgState.rawGraphData?.nodes) ? pgState.rawGraphData.nodes : [];
      const churnMap = pgState.churnByFile && typeof pgState.churnByFile === 'object' ? pgState.churnByFile : {};
      if (rawNodes.length === 0) {
        pgState.hotspotScoreMap = scoreMap;
        pgState.hotspotRankList = rankList;
        return { scoreMap, rankList };
      }

      const rawMetrics = [];
      let maxRaw = 0;
      for (let i = 0; i < rawNodes.length; i++) {
        const rn = rawNodes[i];
        const commits = Number(churnMap[rn.id] || 0);
        if (commits <= 0) continue;
        const coupling = Number(rn.inDeg || 0) + Number(rn.outDeg || 0) + (rn.isGod ? 3 : 0) + (rn.isFragile ? 3 : 0);
        const rawScore = commits * (1 + Math.log1p(Math.max(0, coupling)));
        if (rawScore > maxRaw) maxRaw = rawScore;
        rawMetrics.push({
          id: rn.id,
          label: rn.label || rn.id,
          commits,
          inDeg: Number(rn.inDeg || 0),
          outDeg: Number(rn.outDeg || 0),
          rawScore
        });
      }

      const byBase = new Map();
      for (let i = 0; i < rawMetrics.length; i++) {
        const lbl = rawMetrics[i].label;
        if (!byBase.has(lbl)) byBase.set(lbl, []);
        byBase.get(lbl).push(rawMetrics[i]);
      }
      byBase.forEach(function (group, baseLbl) {
        if (group.length <= 1) {
          group[0].displayLabel = baseLbl;
          return;
        }
        for (let segs = 2; segs <= 5; segs++) {
          const seen = new Set();
          let dup = false;
          for (let j = 0; j < group.length; j++) {
            const parts = String(group[j].id || baseLbl).split('/');
            const cand = parts.slice(-segs).join('/');
            group[j].displayLabel = cand;
            if (seen.has(cand)) dup = true;
            seen.add(cand);
          }
          if (!dup) break;
        }
      });

      const denom = maxRaw > 0 ? maxRaw : 1;
      for (let i = 0; i < rawMetrics.length; i++) {
        const m = rawMetrics[i];
        const norm = Math.max(0.08, Math.min(1, Number((m.rawScore / denom).toFixed(3))));
        scoreMap.set(m.id, norm);
        rankList.push({ ...m, score: norm });
      }
      rankList.sort(function (a, b) {
        return b.score - a.score || b.commits - a.commits || a.id.localeCompare(b.id);
      });

      pgState.hotspotScoreMap = scoreMap;
      pgState.hotspotRankList = rankList;
      return { scoreMap, rankList };
    }

    async function pgLoadGitChurn(forceRefresh) {
      if (pgState.churnLoading && !forceRefresh) return;
      const seq = (pgState.churnSeq || 0) + 1;
      pgState.churnSeq = seq;
      pgState.churnLoading = true;
      const reqDays = pgState.churnDays || 90;
      try {
        const params = new URLSearchParams();
        params.set('days', String(reqDays));
        if (forceRefresh) params.set('refresh', '1');
        const res = await panelFetch('/api/project-graph/git-churn?' + params.toString());
        const data = await res.json();
        if (seq !== pgState.churnSeq) return;
        if (data && data.ok) {
          pgState.churnAvailable = Boolean(data.available);
          pgState.churnMax = Number(data.maxChurn || 0);
          pgState.churnByFile = data.churnByFile && typeof data.churnByFile === 'object' ? data.churnByFile : {};
          pgState.churnLoaded = true;
          pgState.churnLoading = false;
          pgComputeHotspotScores();
          pgRefreshLensState();
          pgRenderInspector();
          pgStartLoop();
        }
      } catch {
        if (seq === pgState.churnSeq) pgState.churnAvailable = false;
      } finally {
        if (seq === pgState.churnSeq) pgState.churnLoading = false;
      }
    }

    function pgChangeChurnDays(daysArg) {
      const next = Number(daysArg) === 30 ? 30 : 90;
      if (pgState.churnDays === next && pgState.churnLoaded) return;
      pgState.churnDays = next;
      pgState.churnLoaded = false;
      pgRenderInspector();
      void pgLoadGitChurn(true);
    }

    function pgAddTopHotspotsToCart() {
      const list = Array.isArray(pgState.hotspotRankList) ? pgState.hotspotRankList : [];
      if (list.length === 0) return;
      const cap = Math.min(5, list.length);
      let added = 0;
      for (let i = 0; i < cap; i++) {
        const fid = list[i].id;
        if (fid && !pgState.contextCart.has(fid)) added += 1;
        if (fid) pgState.contextCart.add(fid);
      }
      pgRenderContextCart();
      pgRenderInspector();
      pgDrawGraph();
      flashStatus(L('Топ-' + cap + ' горячих файлов в пакете (+', 'Top-' + cap + ' hotspots in cart (+') + added + ')');
    }

    function pgRefreshLensState() {
      pgState.gitDiffSet = new Set(Array.isArray(pgState.gitDiffFiles) ? pgState.gitDiffFiles : []);
      if (pgState.rawGraphData) {
        pgSyncCycleSetsFromRaw(pgState.rawGraphData);
      }

      if (pgState.lens === 'blast') {
        let seeds = [];
        if (pgState.blastUseGitDiff && pgState.gitDiffFiles.length > 0) {
          seeds = pgState.gitDiffFiles.slice();
        } else if (pgState.selectedNodeId) {
          seeds = [pgState.selectedNodeId];
        } else if (pgState.gitDiffFiles.length > 0) {
          seeds = pgState.gitDiffFiles.slice();
        }
        const blastRes = pgComputeTransitiveBlast(seeds, 3);
        pgState.blastWaveMap = blastRes.waveMap;
        pgState.blastFileWaveMap = blastRes.fileWaveMap;
        pgState.blastByHop = blastRes.byHop;
        pgState.blastAffectedTests = blastRes.affectedTests;
        pgState.blastEstTokens = blastRes.estTokens;
      } else {
        pgState.blastWaveMap = new Map();
        pgState.blastFileWaveMap = new Map();
        pgState.blastByHop = { 0: [], 1: [], 2: [], 3: [] };
        pgState.blastAffectedTests = [];
        pgState.blastEstTokens = 0;
      }

      if (pgState.lens === 'hotspots') {
        pgComputeHotspotScores();
      } else {
        pgState.hotspotScoreMap = new Map();
      }

      // Refresh path folder projection if pathResult exists
      pgRebuildPathSets();
      pgRenderLensToolbarBadges();
      pgRenderLegendExtra();
    }

    function pgRebuildPathSets() {
      const nodeSet = new Set();
      const edgeSet = new Set();
      const res = pgState.pathResult;
      const pathArr = Array.isArray(res?.path) ? res.path : [];
      const fileSeq = [];
      for (let i = 0; i < pathArr.length; i++) {
        const f = pathArr[i]?.file ? String(pathArr[i].file) : '';
        if (f) {
          nodeSet.add(f);
          if (fileSeq.length === 0 || fileSeq[fileSeq.length - 1] !== f) {
            fileSeq.push(f);
          }
        }
      }
      if (pgState.pathFrom && res && res.found) nodeSet.add(pgState.pathFrom);
      if (pgState.pathTo && res && res.found) nodeSet.add(pgState.pathTo);

      for (let i = 0; i + 1 < fileSeq.length; i++) {
        const a = fileSeq[i];
        const b = fileSeq[i + 1];
        edgeSet.add(a + '->' + b);
        edgeSet.add(b + '->' + a);
      }
      const resEdges = Array.isArray(res?.edges) ? res.edges : [];
      for (let i = 0; i < resEdges.length; i++) {
        const re = resEdges[i];
        const rawA = String(re?.from || '');
        const rawB = String(re?.to || '');
        const fA = rawA.indexOf('file:') === 0 ? rawA.slice(5) : '';
        const fB = rawB.indexOf('file:') === 0 ? rawB.slice(5) : '';
        if (fA && fB && fA !== fB) {
          nodeSet.add(fA);
          nodeSet.add(fB);
          edgeSet.add(fA + '->' + fB);
          edgeSet.add(fB + '->' + fA);
        }
      }

      if (pgState.graphData && pgState.graphData.isMacro && nodeSet.size > 0) {
        const subMap = pgResolveMacroProjectionMap();
        const macroFileSeq = [];
        nodeSet.forEach(function (fid) {
          const sk = subMap.get(fid);
          if (sk) nodeSet.add('folder:' + sk);
        });
        for (let i = 0; i < fileSeq.length; i++) {
          const sk = subMap.get(fileSeq[i]);
          if (sk) {
            const fk = 'folder:' + sk;
            if (macroFileSeq.length === 0 || macroFileSeq[macroFileSeq.length - 1] !== fk) {
              macroFileSeq.push(fk);
            }
          }
        }
        for (let i = 0; i + 1 < macroFileSeq.length; i++) {
          edgeSet.add(macroFileSeq[i] + '->' + macroFileSeq[i + 1]);
          edgeSet.add(macroFileSeq[i + 1] + '->' + macroFileSeq[i]);
        }
      }

      pgState.pathFileSequence = fileSeq;
      pgState.pathNodeSet = nodeSet;
      pgState.pathEdgeSet = edgeSet;
    }

    async function pgLoadGitDiff(forceRefresh) {
      if (pgState.gitDiffLoading) return;
      pgState.gitDiffLoading = true;
      try {
        const params = new URLSearchParams();
        if (forceRefresh) params.set('refresh', '1');
        const q = params.toString();
        const res = await panelFetch('/api/project-graph/git-diff' + (q ? '?' + q : ''));
        const data = await res.json();
        if (data && data.ok) {
          pgState.gitDiffAvailable = Boolean(data.available);
          pgState.gitDiffFiles = Array.isArray(data.changedFiles) ? data.changedFiles : [];
          pgState.gitDiffLoaded = true;
          if (!pgState.selectedNodeId && pgState.gitDiffFiles.length > 0 && pgState.lens === 'blast') {
            pgState.blastUseGitDiff = true;
          }
          pgRefreshLensState();
          pgRenderInspector();
          pgStartLoop();
        }
      } catch {
        pgState.gitDiffAvailable = false;
      } finally {
        pgState.gitDiffLoading = false;
      }
    }

    function pgSetLens(lens) {
      const valid = (lens === 'blast' || lens === 'cycles' || lens === 'path' || lens === 'hotspots') ? lens : 'arch';
      pgState.lens = valid;

      if (valid === 'blast') {
        if (!pgState.gitDiffLoaded) {
          void pgLoadGitDiff(false);
        }
        if (pgState.gitDiffFiles.length > 0 && !pgState.selectedNodeId) {
          pgState.blastUseGitDiff = true;
        }
      } else if (valid === 'hotspots') {
        if (!pgState.churnLoaded) {
          void pgLoadGitChurn(false);
        }
        pgComputeHotspotScores();
      } else if (valid === 'cycles') {
        if (pgState.viewLevel === 'folders' && pgState.mode === 'global' && !pgState.drillFolder && pgState.cycles.length > 0 && pgState.rawGraphData) {
          pgState.viewLevel = 'files';
          pgHydrateSimulation(pgState.rawGraphData);
          return;
        }
      } else if (valid === 'path') {
        if (pgState.viewLevel === 'folders' && pgState.mode === 'global' && !pgState.drillFolder && pgState.rawGraphData) {
          pgState.viewLevel = 'files';
          pgHydrateSimulation(pgState.rawGraphData);
          if (pgState.selectedNodeId && !pgState.pathFrom) {
            const resolved = pgResolveFileTargetFromNode(pgState.selectedNodeId);
            if (resolved) pgState.pathFrom = resolved;
          }
          pgRefreshLensState();
          pgRenderInspector();
          pgStartLoop();
          return;
        }
        if (!pgState.pathFrom && pgState.selectedNodeId) {
          const resolved = pgResolveFileTargetFromNode(pgState.selectedNodeId);
          if (resolved) pgState.pathFrom = resolved;
        }
      }

      pgRefreshLensState();
      pgRenderToolbarAndStats();
      pgRenderInspector();
      pgStartLoop();
    }

    function pgToggleGitDiffWave() {
      if (!pgState.gitDiffLoaded) {
        pgState.blastUseGitDiff = true;
        void pgLoadGitDiff(true);
        return;
      }
      pgState.blastUseGitDiff = !pgState.blastUseGitDiff;
      pgRefreshLensState();
      pgRenderInspector();
      pgStartLoop();
    }

    function pgSelectCycleIdx(idxArg) {
      const parsed = Number(idxArg);
      const nextIdx = Number.isFinite(parsed) && parsed >= 0 && parsed < pgState.cycles.length ? parsed : -1;
      pgState.activeCycleIdx = (pgState.activeCycleIdx === nextIdx) ? -1 : nextIdx;
      pgRebuildActiveCycleSubsets();
      if (pgState.activeCycleIdx >= 0) {
        const chain = pgState.cycles[pgState.activeCycleIdx];
        if (Array.isArray(chain) && chain.length > 0) {
          const firstNode = pgState.nodeById.get(chain[0]);
          if (firstNode) {
            pgState.selectedNodeId = firstNode.id;
            pgState.camX = firstNode.x;
            pgState.camY = firstNode.y;
          }
        }
      }
      pgRenderInspector();
      pgStartLoop();
    }

    async function pgQueryGraphPath(fromId, toId) {
      const fromFile = pgResolveFileTargetFromNode(fromId);
      const toFile = pgResolveFileTargetFromNode(toId);
      if (!fromFile || !toFile) return;

      pgState.pathFrom = fromFile;
      pgState.pathTo = toFile;
      pgState.lens = 'path';

      if (pgState.viewLevel === 'folders' && pgState.mode === 'global' && !pgState.drillFolder && pgState.rawGraphData) {
        pgState.viewLevel = 'files';
        pgHydrateSimulation(pgState.rawGraphData);
      }

      if (fromFile === toFile) {
        pgState.pathResult = {
          ok: true,
          found: true,
          from: fromFile,
          to: toFile,
          hops: 0,
          path: [{ kind: 'file', file: fromFile, label: fromFile }],
          edges: [],
        };
        pgRefreshLensState();
        pgRenderToolbarAndStats();
        pgRenderInspector();
        pgStartLoop();
        return;
      }

      pgState.pathLoading = true;
      pgRenderToolbarAndStats();
      pgRenderInspector();

      try {
        const params = new URLSearchParams();
        params.set('from', fromFile);
        params.set('to', toFile);
        params.set('maxDepth', '6');
        params.set('direction', 'both');
        const res = await panelFetch('/api/project-graph/path?' + params.toString());
        const data = await res.json();
        pgState.pathResult = data || { ok: false, found: false };
      } catch (err) {
        pgState.pathResult = { ok: false, found: false, error: err && err.message ? err.message : 'Path query error' };
      } finally {
        pgState.pathLoading = false;
        pgRefreshLensState();
        pgRenderToolbarAndStats();
        pgRenderInspector();
        pgStartLoop();
      }
    }

    function pgStartPathFromSelected() {
      const sel = pgResolveFileTargetFromNode(pgState.selectedNodeId);
      if (!sel) return;
      pgState.lens = 'path';
      if (pgState.pathFrom && pgState.pathFrom !== sel && !pgState.pathTo) {
        void pgQueryGraphPath(pgState.pathFrom, sel);
        return;
      }
      pgState.pathFrom = sel;
      pgState.pathTo = '';
      pgState.pathResult = null;
      if (pgState.viewLevel === 'folders' && pgState.mode === 'global' && !pgState.drillFolder && pgState.rawGraphData) {
        pgState.viewLevel = 'files';
        pgHydrateSimulation(pgState.rawGraphData);
      }
      pgRefreshLensState();
      pgRenderToolbarAndStats();
      pgRenderInspector();
      pgStartLoop();
      flashStatus(L('Старт пути A выбран — кликните по узлу B (или Shift+клик)', 'Path start A set — click target node B (or Shift+click)'));
    }

    function pgSwapPathEndpoints() {
      if (!pgState.pathFrom && !pgState.pathTo) return;
      const a = pgState.pathFrom;
      const b = pgState.pathTo;
      pgState.pathFrom = b;
      pgState.pathTo = a;
      if (pgState.pathFrom && pgState.pathTo) {
        void pgQueryGraphPath(pgState.pathFrom, pgState.pathTo);
      } else {
        pgRefreshLensState();
        pgRenderInspector();
        pgStartLoop();
      }
    }

    function pgClearPath() {
      pgState.pathFrom = '';
      pgState.pathTo = '';
      pgState.pathResult = null;
      pgState.pathLoading = false;
      pgRefreshLensState();
      pgRenderInspector();
      pgStartLoop();
    }

    function pgToggleNodeInCart(nodeIdArg) {
      const rawId = nodeIdArg || pgState.selectedNodeId;
      if (!rawId) return;
      const node = pgState.nodeById.get(rawId);
      if (node && node.isFolder && Array.isArray(node.fileIds) && node.fileIds.length > 0) {
        const allIn = node.fileIds.every(function (fid) { return pgState.contextCart.has(fid); });
        if (allIn) {
          for (let i = 0; i < node.fileIds.length; i++) pgState.contextCart.delete(node.fileIds[i]);
          flashStatus(L('Папка убрана из пакета', 'Folder removed from cart'));
        } else {
          const cap = Math.min(node.fileIds.length, 20);
          for (let i = 0; i < cap; i++) pgState.contextCart.add(node.fileIds[i]);
          flashStatus(L('Добавлено файлов из папки: ', 'Added files from folder: ') + cap);
        }
      } else {
        const fileId = pgResolveFileTargetFromNode(rawId);
        if (!fileId) return;
        if (pgState.contextCart.has(fileId)) {
          pgState.contextCart.delete(fileId);
        } else {
          pgState.contextCart.add(fileId);
        }
      }
      pgRenderContextCart();
      pgRenderInspector();
      pgDrawGraph();
    }

    function pgAddBlastWaveToCart() {
      const waveMap = pgState.blastFileWaveMap;
      if (!(waveMap instanceof Map) || waveMap.size === 0) return;
      const ordered = [];
      for (let h = 0; h <= 3; h++) {
        const list = Array.isArray(pgState.blastByHop?.[h]) ? pgState.blastByHop[h] : [];
        for (let i = 0; i < list.length; i++) ordered.push(list[i]);
      }
      const cap = Math.min(25, ordered.length);
      let added = 0;
      for (let i = 0; i < cap; i++) {
        if (!pgState.contextCart.has(ordered[i])) added += 1;
        pgState.contextCart.add(ordered[i]);
      }
      pgRenderContextCart();
      pgRenderInspector();
      pgDrawGraph();
      flashStatus(L('Волна добавлена в пакет: ', 'Wave added to cart: ') + cap + L(' ф. (+', ' f. (+') + added + ')');
    }

    function pgAddPathToCart() {
      const seq = Array.isArray(pgState.pathFileSequence) ? pgState.pathFileSequence : [];
      if (seq.length === 0) return;
      let added = 0;
      for (let i = 0; i < seq.length; i++) {
        if (!pgState.contextCart.has(seq[i])) added += 1;
        pgState.contextCart.add(seq[i]);
      }
      pgRenderContextCart();
      pgRenderInspector();
      pgDrawGraph();
      flashStatus(L('Путь добавлен в пакет (+', 'Path added to cart (+') + added + ')');
    }

    function pgClearContextCart() {
      pgState.contextCart.clear();
      pgRenderContextCart();
      pgRenderInspector();
      pgDrawGraph();
    }

    function pgInsertFilesIntoComposer(fileIds) {
      const cleanList = [];
      const seen = new Set();
      for (let i = 0; i < fileIds.length; i++) {
        const f = String(fileIds[i] || '').trim();
        if (f && !seen.has(f)) {
          seen.add(f);
          cleanList.push(f);
        }
      }
      if (cleanList.length === 0) return;
      const tokens = cleanList.map(function (f) { return '@file:' + f; });

      if (typeof pgIsStandaloneView === 'function' && pgIsStandaloneView()) {
        const joined = tokens.join(' ') + ' ';
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            void navigator.clipboard.writeText(joined);
          }
        } catch {}
        flashStatus(L('Скопировано для вставки в чат: ', 'Copied to paste in chat: ') + tokens.length + ' @file');
        return;
      }

      const inputEl = document.getElementById('smartComposerInput');
      if (inputEl) {
        let cur = inputEl.value || '';
        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          if (cur.indexOf(tok) === -1) {
            const sep = cur && !/\s$/.test(cur) ? ' ' : '';
            cur = cur + sep + tok;
          }
        }
        inputEl.value = cur && !/\s$/.test(cur) ? (cur + ' ') : cur;
        if (typeof _smartLastDraft !== 'undefined') {
          _smartLastDraft = inputEl.value;
        }
        if (typeof renderSmartComposerMirror === 'function') {
          renderSmartComposerMirror();
        }
      }
      if (typeof closeProjectGraphModal === 'function') {
        closeProjectGraphModal();
      }
      if (inputEl) {
        inputEl.focus();
      }
      flashStatus(L('Добавлено в Композер: ', 'Added to Composer: ') + tokens.length + ' @file');
    }

    function pgSendCartToComposer() {
      if (!pgState.contextCart || pgState.contextCart.size === 0) return;
      pgInsertFilesIntoComposer(Array.from(pgState.contextCart));
    }

    function pgRenderContextCart() {
      const box = document.getElementById('pgContextCart');
      const sumEl = document.getElementById('pgCartSummary');
      if (!box) return;
      const size = pgState.contextCart ? pgState.contextCart.size : 0;
      if (size === 0) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'flex';
      let totalTok = 0;
      pgState.contextCart.forEach(function (fid) {
        totalTok += pgGetNodeEstTokens(fid);
      });
      if (sumEl) {
        sumEl.textContent = L('Пакет: ', 'Cart: ') + size + L(' ф. · ', ' f. · ') + pgFormatTokenEstimate(totalTok) + L(' ток.', ' tok.');
      }
    }

    function pgRenderLensToolbarBadges() {
      const lens = pgState.lens || 'arch';
      const archBtn = document.getElementById('pgLensArchBtn');
      const blastBtn = document.getElementById('pgLensBlastBtn');
      const cyclesBtn = document.getElementById('pgLensCyclesBtn');
      const hotspotsBtn = document.getElementById('pgLensHotspotsBtn');
      const pathBtn = document.getElementById('pgLensPathBtn');
      if (archBtn) archBtn.classList.toggle('active', lens === 'arch');
      if (blastBtn) blastBtn.classList.toggle('active', lens === 'blast');
      if (cyclesBtn) {
        cyclesBtn.classList.toggle('active', lens === 'cycles');
        const cCount = Array.isArray(pgState.cycles) ? pgState.cycles.length : 0;
        cyclesBtn.classList.toggle('has-alert', cCount > 0);
        cyclesBtn.textContent = cCount > 0 ? (L('Циклы', 'Cycles') + ' (' + cCount + ')') : L('Циклы', 'Cycles');
      }
      if (hotspotsBtn) hotspotsBtn.classList.toggle('active', lens === 'hotspots');
      if (pathBtn) pathBtn.classList.toggle('active', lens === 'path');
    }

    function pgRenderLegendExtra() {
      const el = document.getElementById('pgLegendExtra');
      if (!el) return;
      const lens = pgState.lens || 'arch';
      const parts = [];
      if (lens === 'blast') {
        parts.push('<span class="pg-dot-wave"></span><span>' + L('Волна 0→3 хопа', '0→3 hop wave') + '</span>');
      } else if (lens === 'cycles') {
        parts.push('<span class="pg-dot-cycle"></span><span>' + L('Цикл SCC', 'SCC cycle') + '</span>');
      } else if (lens === 'hotspots') {
        parts.push('<span class="pg-dot-hotspot"></span><span>' + L('Горячая точка Git', 'Git hotspot') + '</span>');
      } else if (lens === 'path') {
        parts.push('<span class="pg-dot-path"></span><span>' + L('Кратчайший путь', 'Shortest path') + '</span>');
      }
      if (pgState.semanticSearchEnabled && pgState.semanticScores && pgState.semanticScores.size > 0) {
        parts.push('<span class="pg-dot-semantic"></span><span>GPU (' + pgState.semanticScores.size + ')</span>');
      }
      if (parts.length > 0) {
        el.style.display = 'inline-flex';
        el.innerHTML = parts.join('');
      } else {
        el.style.display = 'none';
        el.innerHTML = '';
      }
    }

    function pgRenderLensInspectorSection() {
      const panel = document.getElementById('pgInspLensPanel');
      if (!panel) return;
      const lens = pgState.lens || 'arch';
      if (lens === 'arch') {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
      }

      panel.style.display = 'flex';
      if (lens === 'blast') {
        const diffCnt = Array.isArray(pgState.gitDiffFiles) ? pgState.gitDiffFiles.length : 0;
        const waveFiles = pgState.blastFileWaveMap ? pgState.blastFileWaveMap.size : 0;
        const testsCnt = Array.isArray(pgState.blastAffectedTests) ? pgState.blastAffectedTests.length : 0;
        const tokStr = pgFormatTokenEstimate(pgState.blastEstTokens || 0);
        const diffBtnLabel = pgState.gitDiffLoading
          ? L('Git Diff…', 'Git Diff…')
          : (pgState.gitDiffAvailable ? ('Git Diff (' + diffCnt + ')') : L('Без Git', 'No Git'));

        let html =
          '<div class="pg-lens-head-row">' +
            '<span class="pg-lens-title">🌊 ' + L('Волна Blast & Diff (1–3 хопа)', 'Blast & Diff Wave (1–3 hops)') + '</span>' +
            '<button type="button" class="pg-toggle-pill' + (pgState.blastUseGitDiff ? ' active' : '') + '" data-action="pgToggleGitDiffWave"' + (!pgState.gitDiffAvailable && pgState.gitDiffLoaded ? ' disabled' : '') + '>' + escapeHtml(diffBtnLabel) + '</button>' +
          '</div>' +
          '<div class="pg-lens-sub">' +
            L('Затронуто: ', 'Impacted: ') + '<strong>' + waveFiles + '</strong> ' + L('ф.', 'f.') +
            ' · <strong>' + testsCnt + '</strong> ' + L('тестов', 'tests') +
            ' · <strong>' + tokStr + '</strong> ' + L('ток.', 'tok.') +
          '</div>';

        if (waveFiles > 0) {
          html += '<button type="button" class="win-btn pg-btn-full" data-action="pgAddBlastWaveToCart">＋ ' + L('Всю волну в пакет', 'Add wave to cart') + ' (' + Math.min(25, waveFiles) + ')</button>';
        } else {
          html += '<div class="pg-lens-sub">' + L('Выберите узел на карте или нажмите Git Diff для расчёта волны.', 'Select a node or toggle Git Diff to compute impact wave.') + '</div>';
        }
        panel.innerHTML = html;
        return;
      }

      if (lens === 'cycles') {
        const cycles = Array.isArray(pgState.cycles) ? pgState.cycles : [];
        const orphans = Array.from(pgState.orphanSet || []);
        let html =
          '<div class="pg-lens-head-row">' +
            '<span class="pg-lens-title">⟳ ' + L('Циклы импортов (Tarjan SCC)', 'Import Cycles (Tarjan SCC)') + '</span>' +
            '<span class="pg-badge-pill' + (cycles.length > 0 ? ' is-cycle' : '') + '">' + cycles.length + '</span>' +
          '</div>';

        if (cycles.length === 0) {
          html += '<div class="pg-lens-sub">' + L('Циклических зависимостей в видимых модулях не найдено ✓', 'No circular imports detected among shown modules ✓') + '</div>';
        } else {
          html += cycles.map(function (chain, idx) {
            const isAct = pgState.activeCycleIdx === idx;
            const shortNames = chain.map(function (f) {
              const slash = f.lastIndexOf('/');
              return slash >= 0 ? f.slice(slash + 1) : f;
            });
            return '<button type="button" class="pg-cycle-card' + (isAct ? ' active' : '') + '" data-action="pgSelectCycleIdx" data-arg="' + idx + '">' +
              '<div class="pg-cycle-card-head"><span>' + L('Цикл #', 'Cycle #') + (idx + 1) + '</span><span>' + Math.max(1, chain.length - 1) + ' ' + L('ф.', 'f.') + '</span></div>' +
              '<div class="pg-cycle-chain">' + escapeHtml(shortNames.join(' → ')) + '</div>' +
            '</button>';
          }).join('');
        }

        if (orphans.length > 0) {
          html += '<div class="pg-hop-group-hdr"><span>○ ' + L('Изолированные файлы (сироты)', 'Isolated files (orphans)') + '</span><span>' + orphans.length + '</span></div>';
          html += orphans.slice(0, 12).map(function (oid) {
            return '<button type="button" class="pg-dep-row" data-action="pgSelectNodeById" data-arg="' + escapeHtml(oid) + '">' +
              '<span class="pg-dep-name">' + escapeHtml(oid) + '</span>' +
              '<span class="pg-dep-kind">' + L('сирота', 'orphan') + '</span>' +
            '</button>';
          }).join('');
        }
        panel.innerHTML = html;
        return;
      }

      if (lens === 'hotspots') {
        const list = Array.isArray(pgState.hotspotRankList) ? pgState.hotspotRankList : [];
        const days = pgState.churnDays === 30 ? 30 : 90;
        let html =
          '<div class="pg-lens-head-row">' +
            '<span class="pg-lens-title">🔥 ' + L('Горячие точки Git (Hotspots)', 'Git Hotspots (Churn × Coupling)') + '</span>' +
            '<div class="pg-days-switch">' +
              '<button type="button" class="pg-toggle-pill' + (days === 30 ? ' active' : '') + '" data-action="pgChangeChurnDays" data-arg="30">' + L('30д', '30d') + '</button>' +
              '<button type="button" class="pg-toggle-pill' + (days === 90 ? ' active' : '') + '" data-action="pgChangeChurnDays" data-arg="90">' + L('90д', '90d') + '</button>' +
            '</div>' +
          '</div>';

        if (pgState.churnLoading) {
          html += '<div class="pg-lens-sub">' + L('Считаем историю правок Git…', 'Analyzing Git commit churn…') + '</div>';
        } else if (!pgState.churnAvailable && pgState.churnLoaded) {
          html += '<div class="pg-lens-sub">' + L('История Git недоступна для этой папки.', 'Git history unavailable in this folder.') + '</div>';
        } else if (list.length === 0) {
          html += '<div class="pg-lens-sub">' + L('За выбранный период нет коммитов по файлам карты.', 'No file commits found in selected window.') + '</div>';
        } else {
          html += list.slice(0, 12).map(function (item) {
            const pct = Math.max(8, Math.round(item.score * 100));
            return '<button type="button" class="pg-hotspot-card" data-action="pgSelectNodeById" data-arg="' + escapeHtml(item.id) + '" title="' + escapeHtml(item.id) + '">' +
              '<div class="pg-hotspot-card-head">' +
                '<span class="pg-dep-name">' + escapeHtml(item.displayLabel || item.label) + '</span>' +
                '<span class="pg-dep-kind">' + item.commits + L(' пр. · ←', 'c · ←') + item.inDeg + '</span>' +
              '</div>' +
              '<div class="pg-hotspot-bar"><div class="pg-hotspot-bar-fill" style="width:' + pct + '%;"></div></div>' +
            '</button>';
          }).join('');
          html += '<button type="button" class="win-btn pg-btn-full" data-action="pgAddTopHotspotsToCart">＋ ' + L('Топ-5 горячих в пакет', 'Top-5 hotspots to cart') + '</button>';
        }
        panel.innerHTML = html;
        return;
      }

      if (lens === 'path') {
        const fromStr = pgState.pathFrom || L('не выбран (кликните узел)', 'not set (click a node)');
        const toStr = pgState.pathTo || L('Shift+клик по цели B', 'Shift+click target B');
        const res = pgState.pathResult;
        let html =
          '<div class="pg-lens-head-row">' +
            '<span class="pg-lens-title">⇄ ' + L('Поиск пути A → B', 'Path Finder A → B') + '</span>' +
            '<div class="pg-zoom-group">' +
              '<button type="button" class="pg-mini-btn" data-action="pgSwapPathEndpoints" title="' + L('Поменять A и B местами', 'Swap A and B') + '">⇄</button>' +
              '<button type="button" class="pg-mini-btn" data-action="pgClearPath" title="' + L('Сбросить путь', 'Clear path') + '">×</button>' +
            '</div>' +
          '</div>' +
          '<div class="pg-path-bar">' +
            '<div class="pg-path-endpoint"><span class="pg-path-tag">A</span><span class="pg-path-name" title="' + escapeHtml(fromStr) + '">' + escapeHtml(fromStr) + '</span></div>' +
            '<div class="pg-path-endpoint"><span class="pg-path-tag">B</span><span class="pg-path-name" title="' + escapeHtml(toStr) + '">' + escapeHtml(toStr) + '</span></div>' +
          '</div>';

        if (pgState.pathLoading) {
          html += '<div class="pg-lens-sub">' + L('Ищем кратчайший путь в графе RAM…', 'Searching shortest path in RAM graph…') + '</div>';
        } else if (pgState.pathFrom && pgState.pathTo && res) {
          if (res.found && Array.isArray(res.path) && res.path.length > 0) {
            html += '<div class="pg-lens-sub">' + L('Найдено за ', 'Found in ') + '<strong>' + Number(res.hops || Math.max(0, res.path.length - 1)) + '</strong> ' + L('шаг(а/ов)', 'hop(s)') + '</div>';
            for (let i = 0; i < res.path.length; i++) {
              const step = res.path[i];
              const targetFile = step.file || '';
              const labelTxt = step.kind === 'symbol' && step.file
                ? (step.label + ' (' + step.file + ':' + (step.line || 1) + ')')
                : (step.file || step.label || '');
              const edgeRel = i > 0 && Array.isArray(res.edges) && res.edges[i - 1] ? res.edges[i - 1].relation : (i === 0 ? 'START' : 'STEP');
              html += '<button type="button" class="pg-path-step" data-action="pgSelectNodeById" data-arg="' + escapeHtml(targetFile) + '">' +
                '<span class="pg-dep-name">' + escapeHtml(labelTxt) + '</span>' +
                '<span class="pg-dep-kind">' + escapeHtml(edgeRel) + '</span>' +
              '</button>';
            }
            if (Array.isArray(pgState.pathFileSequence) && pgState.pathFileSequence.length > 0) {
              html += '<button type="button" class="win-btn pg-btn-full" data-action="pgAddPathToCart">＋ ' + L('Весь путь в пакет', 'Add path to cart') + ' (' + pgState.pathFileSequence.length + ')</button>';
            }
          } else {
            html += '<div class="pg-lens-sub">' + L('Связь между A и B в пределах 6 шагов не найдена.', 'No path found between A and B within 6 hops.') + '</div>';
          }
        } else {
          html += '<div class="pg-lens-sub">' + L('Совет: Shift+клик по любому узлу сразу строит путь от текущего узла.', 'Tip: Shift+click any node to immediately trace path from current node.') + '</div>';
        }
        panel.innerHTML = html;
      }
    }

    function pgRenderBlastWaveList(listEl) {
      if (!listEl) return false;
      if (pgState.lens !== 'blast') return false;
      const byHop = pgState.blastByHop || {};
      const total = pgState.blastFileWaveMap ? pgState.blastFileWaveMap.size : 0;
      if (total === 0) return false;

      let html = '';
      for (let h = 0; h <= 3; h++) {
        const files = Array.isArray(byHop[h]) ? byHop[h] : [];
        if (files.length === 0) continue;
        const hopTitle = h === 0 ? L('Источник изменений', 'Change source') : (L('Зависимые ', 'Dependents ') + 'Hop ' + h);
        html += '<div class="pg-hop-group-hdr">' +
          '<span class="pg-hop-badge hop-' + h + '">Hop ' + h + '</span>' +
          '<span>' + escapeHtml(hopTitle) + ' (' + files.length + ')</span>' +
        '</div>';
        html += files.slice(0, 25).map(function (fid) {
          const inCart = pgState.contextCart && pgState.contextCart.has(fid);
          const tok = pgFormatTokenEstimate(pgGetNodeEstTokens(fid));
          return '<button type="button" class="pg-dep-row" data-action="pgSelectNodeById" data-arg="' + escapeHtml(fid) + '" title="' + escapeHtml(fid) + '">' +
            '<span class="pg-dep-name">' + escapeHtml(fid) + (inCart ? ' ✓' : '') + '</span>' +
            '<span class="pg-dep-kind">' + escapeHtml(tok) + '</span>' +
          '</button>';
        }).join('');
      }
      if (Array.isArray(pgState.blastAffectedTests) && pgState.blastAffectedTests.length > 0) {
        html += '<div class="pg-hop-group-hdr"><span>🧪 ' + L('Затронутые тесты', 'Affected tests') + '</span><span>' + pgState.blastAffectedTests.length + '</span></div>';
        html += pgState.blastAffectedTests.slice(0, 15).map(function (tid) {
          return '<button type="button" class="pg-dep-row" data-action="pgSelectNodeById" data-arg="' + escapeHtml(tid) + '" title="' + escapeHtml(tid) + '">' +
            '<span class="pg-dep-name">' + escapeHtml(tid) + '</span>' +
            '<span class="pg-dep-kind">' + L('тест', 'test') + '</span>' +
          '</button>';
        }).join('');
      }
      listEl.innerHTML = html;
      return true;
    }
