    // =========================================================================
    // 07d. SPATIAL BARNES-HUT QUADTREE & ZERO-DEPS WEBGL2 INSTANCED RENDERER
    // =========================================================================

    function pgBuildQuadtree(nodes) {
      if (!Array.isArray(nodes) || nodes.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      if (!Number.isFinite(minX)) return null;
      const span = Math.max(64, maxX - minX, maxY - minY) + 16;
      const midX = (minX + maxX) * 0.5;
      const midY = (minY + maxY) * 0.5;
      const root = {
        x1: midX - span * 0.5,
        y1: midY - span * 0.5,
        size: span,
        cx: 0,
        cy: 0,
        mass: 0,
        body: null,
        bucket: null,
        children: null
      };

      const MAX_DEPTH = 18;
      const MIN_CELL = 1.0;

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;

        let cur = root;
        let depth = 0;
        while (true) {
          // Update center of mass incrementally on every visited cell
          const newMass = cur.mass + 1;
          cur.cx = (cur.cx * cur.mass + n.x) / newMass;
          cur.cy = (cur.cy * cur.mass + n.y) / newMass;
          cur.mass = newMass;

          if (!cur.children && cur.body === null && !cur.bucket) {
            cur.body = n;
            break;
          }

          if (depth >= MAX_DEPTH || cur.size * 0.5 < MIN_CELL) {
            if (!cur.bucket) {
              cur.bucket = cur.body ? [cur.body] : [];
              cur.body = null;
            }
            cur.bucket.push(n);
            break;
          }

          if (!cur.children) {
            const half = cur.size * 0.5;
            const prevBody = cur.body;
            cur.body = null;
            cur.children = [
              { x1: cur.x1, y1: cur.y1, size: half, cx: 0, cy: 0, mass: 0, body: null, bucket: null, children: null },
              { x1: cur.x1 + half, y1: cur.y1, size: half, cx: 0, cy: 0, mass: 0, body: null, bucket: null, children: null },
              { x1: cur.x1, y1: cur.y1 + half, size: half, cx: 0, cy: 0, mass: 0, body: null, bucket: null, children: null },
              { x1: cur.x1 + half, y1: cur.y1 + half, size: half, cx: 0, cy: 0, mass: 0, body: null, bucket: null, children: null }
            ];
            if (prevBody) {
              const pQuad = (prevBody.x >= cur.x1 + half ? 1 : 0) + (prevBody.y >= cur.y1 + half ? 2 : 0);
              const pc = cur.children[pQuad];
              pc.cx = prevBody.x;
              pc.cy = prevBody.y;
              pc.mass = 1;
              pc.body = prevBody;
            }
          }

          const half = cur.size * 0.5;
          const quad = (n.x >= cur.x1 + half ? 1 : 0) + (n.y >= cur.y1 + half ? 2 : 0);
          cur = cur.children[quad];
          depth += 1;
        }
      }
      return root;
    }

    const _bhStack = [];

    function pgApplyBarnesHutRepulsion(tree, target, theta, repulseK, alpha) {
      if (!tree || !target) return;
      const thetaSq = theta * theta;
      let sp = 0;
      _bhStack[sp++] = tree;
      const maxDistSq = 180000;

      while (sp > 0) {
        const cell = _bhStack[--sp];
        if (!cell || cell.mass === 0) continue;

        if (!cell.children) {
          if (cell.body && cell.body !== target) {
            const b = cell.body;
            let dx = b.x - target.x;
            let dy = b.y - target.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 1) {
              dx = ((target._tier || 1) * 0.37) - 0.18;
              dy = 0.65;
              distSq = 1;
            }
            if (distSq <= maxDistSq) {
              const dist = Math.sqrt(distSq);
              const minSep = target.radius + b.radius + 22;
              const overlapBoost = dist < minSep ? (minSep - dist) * 0.22 : 0;
              const force = ((repulseK / distSq) * alpha) + overlapBoost * alpha;
              target.vx -= (dx / dist) * force;
              target.vy -= (dy / dist) * force;
            }
          } else if (cell.bucket) {
            for (let k = 0; k < cell.bucket.length; k++) {
              const b = cell.bucket[k];
              if (b === target) continue;
              let dx = b.x - target.x;
              let dy = b.y - target.y;
              let distSq = dx * dx + dy * dy;
              if (distSq < 1) {
                dx = ((k & 1) ? 0.6 : -0.6);
                dy = ((k & 2) ? 0.6 : -0.6);
                distSq = 1;
              }
              if (distSq <= maxDistSq) {
                const dist = Math.sqrt(distSq);
                const minSep = target.radius + b.radius + 22;
                const overlapBoost = dist < minSep ? (minSep - dist) * 0.22 : 0;
                const force = ((repulseK / distSq) * alpha) + overlapBoost * alpha;
                target.vx -= (dx / dist) * force;
                target.vy -= (dy / dist) * force;
              }
            }
          }
          continue;
        }

        const dx = cell.cx - target.x;
        const dy = cell.cy - target.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > 0 && (cell.size * cell.size) < thetaSq * distSq) {
          if (distSq <= maxDistSq * 2.5) {
            const dist = Math.sqrt(distSq);
            const force = ((repulseK * cell.mass) / distSq) * alpha;
            target.vx -= (dx / dist) * force;
            target.vy -= (dy / dist) * force;
          }
        } else {
          for (let c = 0; c < 4; c++) {
            const ch = cell.children[c];
            if (ch && ch.mass > 0) _bhStack[sp++] = ch;
          }
        }
      }
    }

    function pgFindNodeQuadtree(tree, worldX, worldY, sx, sy, scale) {
      if (!tree) return null;
      const worldSearchR = Math.max(24, 96 / Math.max(0.18, scale || 1));
      let best = null;
      let bestDist = Infinity;
      let sp = 0;
      _bhStack[sp++] = tree;

      while (sp > 0) {
        const cell = _bhStack[--sp];
        if (!cell || cell.mass === 0) continue;
        if (
          worldX + worldSearchR < cell.x1 ||
          worldX - worldSearchR > cell.x1 + cell.size ||
          worldY + worldSearchR < cell.y1 ||
          worldY - worldSearchR > cell.y1 + cell.size
        ) {
          continue;
        }
        if (cell.children) {
          for (let c = 0; c < 4; c++) {
            const ch = cell.children[c];
            if (ch && ch.mass > 0) _bhStack[sp++] = ch;
          }
          continue;
        }
        const checkCandidate = function (n) {
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
            return;
          }
          const hitRadius = Math.max(7, pgGetNodeScreenRadius(n, scale) + 5);
          const dx = sx - pt.x;
          const dy = sy - pt.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d <= hitRadius && d < bestDist) {
            best = n;
            bestDist = d;
          }
        };
        if (cell.body) checkCandidate(cell.body);
        if (cell.bucket) {
          for (let k = 0; k < cell.bucket.length; k++) checkCandidate(cell.bucket[k]);
        }
      }
      return best;
    }

    // =========================================================================
    // ZERO-DEPS WEBGL2 INSTANCED RENDERER (EDGES + SDF NODES IN 2 DRAW CALLS)
    // =========================================================================
    const pgGlState = {
      gl: null,
      failed: false,
      edgeProg: null,
      nodeProg: null,
      edgeBufPos: null,
      edgeBufCol: null,
      quadBuf: null,
      nodeInstBuf: null,
      edgePosArr: null,
      edgeColArr: null,
      nodeInstArr: null,
      colorCache: new Map()
    };

    const PG_GL_EDGE_VERT = `#version 300 es
      precision highp float;
      in vec2 a_pos;
      in vec4 a_color;
      uniform vec2 u_res;
      uniform vec2 u_cam;
      uniform float u_scale;
      out vec4 v_color;
      void main() {
        vec2 screen = (a_pos - u_cam) * u_scale + u_res * 0.5;
        vec2 clip = (screen / u_res) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        v_color = a_color;
      }
    `;

    const PG_GL_EDGE_FRAG = `#version 300 es
      precision mediump float;
      in vec4 v_color;
      out vec4 outColor;
      void main() {
        outColor = vec4(v_color.rgb * v_color.a, v_color.a);
      }
    `;

    const PG_GL_NODE_VERT = `#version 300 es
      precision highp float;
      in vec2 a_corner;
      in vec2 a_nodePos;
      in float a_radius;
      in vec4 a_fillColor;
      in vec4 a_ringColor;
      in float a_shape;
      uniform vec2 u_res;
      uniform vec2 u_cam;
      uniform float u_scale;
      out vec2 v_uv;
      out float v_radius;
      out vec4 v_fill;
      out vec4 v_ring;
      out float v_shape;
      void main() {
        vec2 centerScreen = (a_nodePos - u_cam) * u_scale + u_res * 0.5;
        float padR = a_radius + 3.0;
        vec2 posScreen = centerScreen + a_corner * padR;
        vec2 clip = (posScreen / u_res) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        v_uv = a_corner * padR;
        v_radius = a_radius;
        v_fill = a_fillColor;
        v_ring = a_ringColor;
        v_shape = a_shape;
      }
    `;

    const PG_GL_NODE_FRAG = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      in float v_radius;
      in vec4 v_fill;
      in vec4 v_ring;
      in float v_shape;
      out vec4 outColor;
      void main() {
        float dist;
        if (v_shape > 0.5) {
          dist = abs(v_uv.x) + abs(v_uv.y) - v_radius;
        } else {
          dist = length(v_uv) - v_radius;
        }
        float aa = max(0.85, fwidth(dist));
        if (v_ring.a > 0.01) {
          float outerD = dist - 2.2;
          float outerMask = 1.0 - smoothstep(-aa, aa, outerD);
          float innerMask = 1.0 - smoothstep(-aa, aa, dist);
          float ringMask = clamp(outerMask - innerMask, 0.0, 1.0);
          vec4 fillP = vec4(v_fill.rgb * v_fill.a, v_fill.a) * innerMask;
          vec4 ringP = vec4(v_ring.rgb * v_ring.a, v_ring.a) * ringMask;
          vec4 combined = fillP + ringP * (1.0 - innerMask);
          if (combined.a < 0.01) discard;
          outColor = combined;
        } else {
          float fillMask = 1.0 - smoothstep(-aa, aa, dist);
          float a = v_fill.a * fillMask;
          if (a < 0.01) discard;
          outColor = vec4(v_fill.rgb * a, a);
        }
      }
    `;

    function pgParseColorRgba01(colorStr, alphaMul) {
      const key = String(colorStr || '#f04848');
      let base = pgGlState.colorCache.get(key);
      if (!base) {
        if (key[0] === '#' && (key.length === 7 || key.length === 4)) {
          let r, g, b;
          if (key.length === 7) {
            r = parseInt(key.slice(1, 3), 16) / 255;
            g = parseInt(key.slice(3, 5), 16) / 255;
            b = parseInt(key.slice(5, 7), 16) / 255;
          } else {
            r = parseInt(key[1] + key[1], 16) / 255;
            g = parseInt(key[2] + key[2], 16) / 255;
            b = parseInt(key[3] + key[3], 16) / 255;
          }
          base = [r || 0, g || 0, b || 0, 1];
        } else {
          const m = key.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
          base = m
            ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] !== undefined ? Number(m[4]) : 1]
            : [0.4, 0.7, 1.0, 1];
        }
        pgGlState.colorCache.set(key, base);
      }
      return [base[0], base[1], base[2], base[3] * (alphaMul === undefined ? 1 : alphaMul)];
    }

    function pgCompileGlProgram(gl, vertSrc, fragSrc) {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vertSrc);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        gl.deleteShader(vs);
        return null;
      }
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fragSrc);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return null;
      }
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        gl.deleteProgram(prog);
        return null;
      }
      return prog;
    }

    function pgInitWebgl2Context(canvas) {
      if (pgGlState.failed || !canvas || typeof canvas.getContext !== 'function') return null;
      if (pgGlState.gl && pgGlState.edgeProg && pgGlState.nodeProg) return pgGlState;

      let gl = null;
      try {
        gl = canvas.getContext('webgl2', {
          antialias: true,
          alpha: true,
          premultipliedAlpha: true,
          preserveDrawingBuffer: true
        });
      } catch {
        gl = null;
      }
      if (!gl || typeof gl.drawArraysInstanced !== 'function') {
        pgGlState.failed = true;
        return null;
      }

      const edgeProg = pgCompileGlProgram(gl, PG_GL_EDGE_VERT, PG_GL_EDGE_FRAG);
      const nodeProg = pgCompileGlProgram(gl, PG_GL_NODE_VERT, PG_GL_NODE_FRAG);
      if (!edgeProg || !nodeProg) {
        pgGlState.failed = true;
        return null;
      }

      const quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      pgGlState.gl = gl;
      pgGlState.edgeProg = edgeProg;
      pgGlState.nodeProg = nodeProg;
      pgGlState.edgeBufPos = gl.createBuffer();
      pgGlState.edgeBufCol = gl.createBuffer();
      pgGlState.quadBuf = quadBuf;
      pgGlState.nodeInstBuf = gl.createBuffer();
      return pgGlState;
    }

    function pgHideWebglCanvas() {
      const glCanvas = document.getElementById('projectGraphWebglCanvas');
      if (glCanvas) {
        glCanvas.classList.remove('active');
        if (pgGlState.gl) {
          pgGlState.gl.clearColor(0, 0, 0, 0);
          pgGlState.gl.clear(pgGlState.gl.COLOR_BUFFER_BIT);
        }
      }
    }

    function pgShouldUseWebglRenderer(nodeCount) {
      if (pgGlState.failed) return false;
      const mode = pgState.renderMode || 'auto';
      if (mode === '2d') return false;
      if (mode === 'webgl2') return true;
      return Number(nodeCount || 0) >= 1200;
    }

    function pgRenderWebgl2Scene(scene) {
      const glCanvas = document.getElementById('projectGraphWebglCanvas');
      if (!glCanvas || !scene || !Array.isArray(scene.nodes)) return false;
      const state = pgInitWebgl2Context(glCanvas);
      if (!state) return false;

      const gl = state.gl;
      const dpr = scene.dpr || 1;
      const pw = Math.max(1, Math.round((scene.w || 600) * dpr));
      const ph = Math.max(1, Math.round((scene.h || 420) * dpr));
      if (glCanvas.width !== pw) glCanvas.width = pw;
      if (glCanvas.height !== ph) glCanvas.height = ph;
      glCanvas.classList.add('active');

      gl.viewport(0, 0, pw, ph);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const edges = scene.edges || [];
      const nodes = scene.nodes || [];
      const lens = pgState.lens || 'arch';
      const activeId = scene.activeId || '';

      // 1) Batch Edges
      const maxEdges = edges.length;
      if (maxEdges > 0) {
        if (!state.edgePosArr || state.edgePosArr.length < maxEdges * 4) {
          state.edgePosArr = new Float32Array(Math.max(1024, maxEdges * 4));
          state.edgeColArr = new Float32Array(Math.max(2048, maxEdges * 8));
        }
        const posArr = state.edgePosArr;
        const colArr = state.edgeColArr;
        let eCount = 0;

        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          if (!e.source._inView && !e.target._inView) continue;
          const isAct = Boolean(activeId && (e.source.id === activeId || e.target.id === activeId));
          let colStr = 'rgba(200, 215, 245, 0.18)';
          let alpha = 1;
          const ek = e.source.id + '->' + e.target.id;

          if (scene.hasBlastWave) {
            const sH = pgState.blastWaveMap.get(e.source.id);
            const tH = pgState.blastWaveMap.get(e.target.id);
            if (sH !== undefined && tH !== undefined && sH !== tH) {
              colStr = typeof pgGetHopColor === 'function' ? pgGetHopColor(Math.max(sH, tH)) : '#ff9f0a';
              alpha = 0.92;
            } else {
              alpha = isAct ? 0.30 : 0.10;
            }
          } else if (scene.hasActiveCycleHighlight && scene.activeCycleEdges && scene.activeCycleEdges.has(ek)) {
            colStr = '#f04848';
            alpha = 0.94;
          } else if (scene.hasPathHighlight && pgState.pathEdgeSet && pgState.pathEdgeSet.has(ek)) {
            colStr = '#f04848';
            alpha = 0.94;
          } else if (isAct) {
            colStr = e.target.id === activeId
              ? 'rgba(240, 72, 72, 0.90)'
              : 'rgba(48, 209, 88, 0.84)';
          } else if (activeId) {
            alpha = 0.14;
          }

          const rgba = pgParseColorRgba01(colStr, alpha);
          const pOff = eCount * 4;
          posArr[pOff] = e.source.x;
          posArr[pOff + 1] = e.source.y;
          posArr[pOff + 2] = e.target.x;
          posArr[pOff + 3] = e.target.y;

          const cOff = eCount * 8;
          colArr[cOff] = rgba[0]; colArr[cOff + 1] = rgba[1]; colArr[cOff + 2] = rgba[2]; colArr[cOff + 3] = rgba[3];
          colArr[cOff + 4] = rgba[0]; colArr[cOff + 5] = rgba[1]; colArr[cOff + 6] = rgba[2]; colArr[cOff + 7] = rgba[3];
          eCount += 1;
        }

        if (eCount > 0) {
          const ep = state.edgeProg;
          gl.useProgram(ep);
          gl.uniform2f(gl.getUniformLocation(ep, 'u_res'), scene.w, scene.h);
          gl.uniform2f(gl.getUniformLocation(ep, 'u_cam'), pgState.camX, pgState.camY);
          gl.uniform1f(gl.getUniformLocation(ep, 'u_scale'), scene.scale);

          const posLoc = gl.getAttribLocation(ep, 'a_pos');
          const colLoc = gl.getAttribLocation(ep, 'a_color');

          gl.bindBuffer(gl.ARRAY_BUFFER, state.edgeBufPos);
          gl.bufferData(gl.ARRAY_BUFFER, posArr.subarray(0, eCount * 4), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(posLoc);
          gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(posLoc, 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, state.edgeBufCol);
          gl.bufferData(gl.ARRAY_BUFFER, colArr.subarray(0, eCount * 8), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(colLoc);
          gl.vertexAttribPointer(colLoc, 4, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(colLoc, 0);

          gl.drawArrays(gl.LINES, 0, eCount * 2);
        }
      }

      // 2) Batch Instanced SDF Nodes (12 floats per instance: x, y, r, fillRGBA, ringRGBA, shape)
      const STRIDE_FLOATS = 12;
      if (nodes.length > 0) {
        if (!state.nodeInstArr || state.nodeInstArr.length < nodes.length * STRIDE_FLOATS) {
          state.nodeInstArr = new Float32Array(Math.max(256 * STRIDE_FLOATS, nodes.length * STRIDE_FLOATS));
        }
        const nArr = state.nodeInstArr;
        let nCount = 0;

        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (!n._inView) continue;

          const baseCol = pgGetClusterColor(n.clusterId);
          const hs = scene.hasHotspotsLens ? (pgState.hotspotScoreMap.get(n.id) || 0) : 0;
          const ss = scene.hasSemanticHeat ? (pgState.semanticScores.get(n.id) || 0) : 0;
          const waveHop = scene.hasBlastWave ? pgState.blastWaveMap.get(n.id) : undefined;
          const isCycle = Boolean(scene.hasCycleLens && scene.activeCycleNodes && scene.activeCycleNodes.has(n.id));
          const isPath = Boolean(scene.hasPathLens && pgState.pathNodeSet && pgState.pathNodeSet.has(n.id));
          const isSel = n.id === pgState.selectedNodeId || n.id === pgState.hoveredNodeId;
          const isCart = Boolean(
            pgState.contextCart && (
              pgState.contextCart.has(n.id) ||
              (n.isSymbol && n.file && pgState.contextCart.has(n.file)) ||
              (n.isFolder && Array.isArray(n.fileIds) && n.fileIds.some(function (fid) { return pgState.contextCart.has(fid); }))
            )
          );
          const matches = pgNodeMatchesFilters(n);

          let alpha = 1;
          if (scene.hasBlastWave && waveHop === undefined) alpha *= 0.16;
          else if (scene.hasCycleLens && scene.activeCycleNodes && scene.activeCycleNodes.size > 0 && !isCycle) alpha *= 0.18;
          else if (scene.hasHotspotsLens && hs <= 0 && !isSel && !isCart) alpha *= 0.24;
          else if (scene.hasPathLens && pgState.pathNodeSet && pgState.pathNodeSet.size > 0 && !isPath) alpha *= 0.16;
          else if (activeId && scene.activeNeighbors && !scene.activeNeighbors.has(n.id) && !isCart) alpha *= 0.22;
          if (scene.hasQueryOrCluster && !matches) alpha *= 0.18;

          const fillColStr = (hs >= 0.45 && typeof pgGetHotspotColor === 'function')
            ? pgGetHotspotColor(hs)
            : baseCol;
          const fillRgba = pgParseColorRgba01(fillColStr, alpha);

          let ringColorStr = '';
          if (isCart) ringColorStr = '#30d158';
          else if (isSel) ringColorStr = '#ffffff';
          else if (waveHop !== undefined && typeof pgGetHopColor === 'function') ringColorStr = pgGetHopColor(waveHop);
          else if (isCycle) ringColorStr = '#f04848';
          else if (ss > 0.12) ringColorStr = '#10b981';
          else if (hs > 0.15 && typeof pgGetHotspotColor === 'function') ringColorStr = pgGetHotspotColor(hs);
          else if (n.isFragile) ringColorStr = '#ff453a';
          const ringRgba = ringColorStr ? pgParseColorRgba01(ringColorStr, Math.min(1, alpha + 0.15)) : [0, 0, 0, 0];

          const off = nCount * STRIDE_FLOATS;
          nArr[off] = n.x;
          nArr[off + 1] = n.y;
          nArr[off + 2] = n.isFolder ? Math.max(8, (n._bh || 24) * 0.48) : (n._sr || 4.2);
          nArr[off + 3] = fillRgba[0]; nArr[off + 4] = fillRgba[1]; nArr[off + 5] = fillRgba[2]; nArr[off + 6] = fillRgba[3];
          nArr[off + 7] = ringRgba[0]; nArr[off + 8] = ringRgba[1]; nArr[off + 9] = ringRgba[2]; nArr[off + 10] = ringRgba[3];
          nArr[off + 11] = (n.isSymbol && n.kind === 'class') ? 1.0 : 0.0;
          nCount += 1;
        }

        if (nCount > 0) {
          const np = state.nodeProg;
          gl.useProgram(np);
          gl.uniform2f(gl.getUniformLocation(np, 'u_res'), scene.w, scene.h);
          gl.uniform2f(gl.getUniformLocation(np, 'u_cam'), pgState.camX, pgState.camY);
          gl.uniform1f(gl.getUniformLocation(np, 'u_scale'), scene.scale);

          const cornerLoc = gl.getAttribLocation(np, 'a_corner');
          gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuf);
          gl.enableVertexAttribArray(cornerLoc);
          gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(cornerLoc, 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, state.nodeInstBuf);
          gl.bufferData(gl.ARRAY_BUFFER, nArr.subarray(0, nCount * STRIDE_FLOATS), gl.DYNAMIC_DRAW);

          const strideBytes = STRIDE_FLOATS * 4;
          const posLoc = gl.getAttribLocation(np, 'a_nodePos');
          const radLoc = gl.getAttribLocation(np, 'a_radius');
          const fillLoc = gl.getAttribLocation(np, 'a_fillColor');
          const ringLoc = gl.getAttribLocation(np, 'a_ringColor');
          const shpLoc = gl.getAttribLocation(np, 'a_shape');

          gl.enableVertexAttribArray(posLoc);
          gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, strideBytes, 0);
          gl.vertexAttribDivisor(posLoc, 1);

          gl.enableVertexAttribArray(radLoc);
          gl.vertexAttribPointer(radLoc, 1, gl.FLOAT, false, strideBytes, 8);
          gl.vertexAttribDivisor(radLoc, 1);

          gl.enableVertexAttribArray(fillLoc);
          gl.vertexAttribPointer(fillLoc, 4, gl.FLOAT, false, strideBytes, 12);
          gl.vertexAttribDivisor(fillLoc, 1);

          gl.enableVertexAttribArray(ringLoc);
          gl.vertexAttribPointer(ringLoc, 4, gl.FLOAT, false, strideBytes, 28);
          gl.vertexAttribDivisor(ringLoc, 1);

          gl.enableVertexAttribArray(shpLoc);
          gl.vertexAttribPointer(shpLoc, 1, gl.FLOAT, false, strideBytes, 44);
          gl.vertexAttribDivisor(shpLoc, 1);

          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nCount);
          gl.vertexAttribDivisor(posLoc, 0);
          gl.vertexAttribDivisor(radLoc, 0);
          gl.vertexAttribDivisor(fillLoc, 0);
          gl.vertexAttribDivisor(ringLoc, 0);
          gl.vertexAttribDivisor(shpLoc, 0);
        }
      }
      return true;
    }

    (function initProjectGraphStandaloneBoot() {
      if (pgIsStandaloneView()) {
        pgInitStandaloneIfNeeded();
      }
    })();
