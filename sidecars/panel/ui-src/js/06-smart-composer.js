    let _smartGhostText = '';
    let _smartGhostSource = '';
    let _smartLastDraft = '';
    let _smartReqSeq = 0;
    let _smartFastTimer = null;
    let _smartGpuTimer = null;
    let _smartGpuAbortCtrl = null;
    let _smartChipsLastSig = '';
    let _smartChipsLastList = [];
    let _smartComposerBound = false;
    let _composerGrillArmed = false;

    function syncComposerGrillToggleUi() {
      const btn = document.getElementById('btnToggleComposerGrill');
      if (!btn) return;
      btn.classList.toggle('active', _composerGrillArmed);
      btn.setAttribute('aria-pressed', _composerGrillArmed ? 'true' : 'false');
    }

    function toggleComposerGrillMe() {
      _composerGrillArmed = !_composerGrillArmed;
      syncComposerGrillToggleUi();
      flashComposerStatus(
        _composerGrillArmed
          ? L('🔥 Детальный опрос (Grill-Me) включён для следующего запроса', '🔥 Deep interview (Grill-Me) armed for the next prompt')
          : L('Режим детального опроса отключён', 'Deep interview (Grill-Me) disabled'),
        'info',
        2600
      );
    }

    function updateComposerEngineBadge(_mode, _label) {
      // Badge element was removed from header; kept as safe no-op for legacy callers.
      return;
    }

    function syncSmartComposerSizeAndScroll() {
      const inputEl = document.getElementById('smartComposerInput');
      const mirrorEl = document.getElementById('composerMirror');
      if (!inputEl) return;
      inputEl.style.height = 'auto';
      const nextH = Math.min(148, Math.max(56, inputEl.scrollHeight || 56));
      inputEl.style.height = nextH + 'px';
      if (mirrorEl) {
        if (inputEl.clientWidth > 0) {
          mirrorEl.style.width = inputEl.clientWidth + 'px';
        }
        mirrorEl.scrollTop = inputEl.scrollTop;
      }
    }

    function renderSmartComposerMirror() {
      const inputEl = document.getElementById('smartComposerInput');
      const typedEl = document.getElementById('composerMirrorTyped');
      const ghostEl = document.getElementById('composerMirrorGhost');
      const tabPillEl = document.getElementById('composerGhostTabPill');
      const clearBtn = document.getElementById('btnClearComposer');
      if (!inputEl) return;

      const val = inputEl.value || '';
      if (clearBtn) {
        clearBtn.style.display = val.length > 0 ? 'inline-flex' : 'none';
      }
      const caretInMiddle = Boolean(
        document.activeElement === inputEl &&
        (inputEl.selectionStart !== val.length || inputEl.selectionEnd !== val.length)
      );
      const visibleGhost = (!caretInMiddle && val.trim().length > 0) ? _smartGhostText : '';
      if (typedEl) typedEl.textContent = val;
      if (ghostEl) ghostEl.textContent = visibleGhost;
      if (tabPillEl) tabPillEl.style.display = visibleGhost ? 'inline-block' : 'none';
      syncSmartComposerSizeAndScroll();
    }

    function renderSmartComposerChips(chips) {
      const rowEl = document.getElementById('composerChipsRow');
      if (Array.isArray(chips) && chips.length > 0) {
        _smartChipsLastList = chips;
      }
      const list = (Array.isArray(chips) && chips.length > 0) ? chips : _smartChipsLastList;
      if (!rowEl || !Array.isArray(list) || list.length === 0) return;
      const sig = getUiLanguage() + '|' + JSON.stringify(list);
      if (sig === _smartChipsLastSig) return;
      _smartChipsLastSig = sig;
      rowEl.textContent = '';
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c || !c.label || !c.prompt) continue;
        const lbl = pickText(c, 'label', 'labelEn', c.label);
        const prm = pickText(c, 'prompt', 'promptEn', c.prompt);
        const ttl = pickText(c, 'title', 'titleEn', prm);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'composer-chip-btn';
        btn.setAttribute('data-action', 'applyComposerChip');
        btn.setAttribute('data-prompt', String(prm));
        btn.textContent = String(lbl);
        btn.title = String(ttl);
        rowEl.appendChild(btn);
      }
    }

    function cancelSmartComposerPendingRequests() {
      if (_smartFastTimer) {
        clearTimeout(_smartFastTimer);
        _smartFastTimer = null;
      }
      if (_smartGpuTimer) {
        clearTimeout(_smartGpuTimer);
        _smartGpuTimer = null;
      }
      if (_smartGpuAbortCtrl) {
        try { _smartGpuAbortCtrl.abort(); } catch {}
        _smartGpuAbortCtrl = null;
      }
    }

    function dismissSmartComposerGhost() {
      _smartGhostText = '';
      _smartGhostSource = '';
      renderSmartComposerMirror();
    }

    function scheduleSmartAutocomplete(draftVal, opts) {
      _smartReqSeq += 1;
      const seq = _smartReqSeq;
      cancelSmartComposerPendingRequests();

      const text = String(draftVal || '');
      const trimmed = text.trim();
      const afterAccept = Boolean(opts && opts.afterAccept);
      const isDoneSentence = (function (raw) {
        const s = String(raw || '').trimEnd();
        if (!s) return false;
        if (/[?!…]$/.test(s)) return true;
        if (!s.endsWith('.')) return false;
        const noDot = s.slice(0, -1);
        if (/(?:^|[\s(«"'])(?:т\.\s*[дпе]|и\s+др|и\s+пр|др|пр|см|напр|рис|стр|e\.g|i\.e|vs|etc)$/i.test(noDot)) {
          return false;
        }
        if (/\.\s+$/.test(raw)) return true;
        const lastTok = (noDot.match(/(\S+)$/) || [])[1] || '';
        if (!lastTok) return false;
        if (/[А-Яа-яЁё]$/.test(lastTok)) return true;
        if (/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(lastTok)) return true;
        return false;
      })(text);
      if (!trimmed || text.length > 1200) {
        _smartGhostText = '';
        _smartGhostSource = '';
        updateComposerEngineBadge('', L('RAM + GPU · 0 тк', 'RAM + GPU · 0 tok'));
        renderSmartComposerMirror();
        return;
      }

      if (!isDoneSentence) {
        _smartFastTimer = setTimeout(async function () {
          _smartFastTimer = null;
          if (seq !== _smartReqSeq) return;
          try {
            const res = await panelFetch('/api/autocomplete', {
              method: 'POST',
              body: JSON.stringify({ draft: text, stage: 'fast', seq: seq }),
            });
            if (!res || !res.ok || seq !== _smartReqSeq) return;
            const data = await res.json();
            if (!data || !data.ok || seq !== _smartReqSeq) return;
            if (Array.isArray(data.chips)) renderSmartComposerChips(data.chips);
            if (data.continuation && (_smartGhostSource !== 'gpu' || !_smartGhostText)) {
              _smartGhostText = String(data.continuation);
              _smartGhostSource = 'ram';
              updateComposerEngineBadge('ram', L('RAM · <5 мс', 'RAM · <5 ms'));
              renderSmartComposerMirror();
            }
          } catch {}
        }, 65);
      }

      if (trimmed.length >= 3 && currentState && currentState.gpuEnabled !== false) {
        const gpuDelayMs = afterAccept ? 85 : 210;
        const recentMessages = _localRagHistory
          .filter(function (m) { return m && !m.error && (m.role === 'user' || m.role === 'assistant') && m.content; })
          .slice(-4)
          .map(function (m) {
            return { role: m.role, content: String(m.content || '').trim().slice(0, 220) };
          });
        _smartGpuTimer = setTimeout(async function () {
          _smartGpuTimer = null;
          if (seq !== _smartReqSeq) return;
          updateComposerEngineBadge('loading', L('GPU · подбор...', 'GPU · drafting...'));
          const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
          _smartGpuAbortCtrl = ac;
          try {
            const fetchOpts = {
              method: 'POST',
              body: JSON.stringify({
                draft: text,
                stage: 'gpu',
                seq: seq,
                allowFollowUp: true,
                afterAccept: afterAccept,
                recentMessages: recentMessages,
              }),
            };
            if (ac) fetchOpts.signal = ac.signal;
            const res = await panelFetch('/api/autocomplete', fetchOpts);
            if (_smartGpuAbortCtrl === ac) _smartGpuAbortCtrl = null;
            if (!res || !res.ok || seq !== _smartReqSeq || (ac && ac.signal.aborted)) return;
            const data = await res.json();
            if (!data || data.aborted || seq !== _smartReqSeq) return;
            if (Array.isArray(data.chips)) renderSmartComposerChips(data.chips);
            if (data.ok && data.continuation) {
              _smartGhostText = String(data.continuation);
              _smartGhostSource = data.source || 'gpu';
              if (_smartGhostSource === 'gpu') {
                const msText = data.fromRamCache
                  ? L('кэш', 'cache')
                  : (Math.max(1, Math.round(Number(data.latencyMs || 0))) + L(' мс', ' ms'));
                updateComposerEngineBadge('gpu', 'GPU · ' + msText);
              } else {
                updateComposerEngineBadge('ram', L('RAM · <5 мс', 'RAM · <5 ms'));
              }
              renderSmartComposerMirror();
            } else {
              updateComposerEngineBadge(
                _smartGhostText ? 'ram' : '',
                _smartGhostText ? L('RAM · <5 мс', 'RAM · <5 ms') : L('RAM + GPU · 0 тк', 'RAM + GPU · 0 tok')
              );
            }
          } catch (err) {
            if (_smartGpuAbortCtrl === ac) _smartGpuAbortCtrl = null;
            if (seq === _smartReqSeq && !_smartGhostText && (!err || err.name !== 'AbortError')) {
              updateComposerEngineBadge('', L('RAM + GPU · 0 тк', 'RAM + GPU · 0 tok'));
            }
          }
        }, gpuDelayMs);
      }
    }

    function handleSmartComposerInput() {
      const inputEl = document.getElementById('smartComposerInput');
      if (!inputEl) return;
      const val = inputEl.value || '';
      const caretAtEnd = inputEl.selectionStart === val.length && inputEl.selectionEnd === val.length;
      if (
        caretAtEnd &&
        _smartGhostText &&
        _smartLastDraft &&
        val.length > _smartLastDraft.length &&
        val.indexOf(_smartLastDraft) === 0
      ) {
        const typedDelta = val.slice(_smartLastDraft.length);
        if (_smartGhostText.toLowerCase().indexOf(typedDelta.toLowerCase()) === 0) {
          _smartGhostText = _smartGhostText.slice(typedDelta.length);
        } else {
          _smartGhostText = '';
          _smartGhostSource = '';
        }
      } else if (val !== _smartLastDraft) {
        _smartGhostText = '';
        _smartGhostSource = '';
      }
      _smartLastDraft = val;
      renderSmartComposerMirror();
      scheduleSmartAutocomplete(val);
      checkSmartComposerAtTrigger(val);
    }

    function acceptSmartComposerGhost(wordOnly) {
      const inputEl = document.getElementById('smartComposerInput');
      if (!inputEl || !_smartGhostText) return;
      const len = inputEl.value.length;
      if (inputEl.selectionStart !== len || inputEl.selectionEnd !== len) return;

      if (wordOnly) {
        const m = /^(\s*\S+)/.exec(_smartGhostText);
        const piece = m ? m[1] : _smartGhostText;
        inputEl.value += piece;
        _smartGhostText = _smartGhostText.slice(piece.length);
      } else {
        inputEl.value += _smartGhostText;
        _smartGhostText = '';
      }
      _smartLastDraft = inputEl.value;
      const endPos = inputEl.value.length;
      inputEl.focus();
      try { inputEl.setSelectionRange(endPos, endPos); } catch {}
      renderSmartComposerMirror();
      if (!_smartGhostText && inputEl.value.trim().length >= 3 && inputEl.value.length <= 1200) {
        scheduleSmartAutocomplete(inputEl.value, { afterAccept: true });
      }
    }

    let _smartComposerStatusTimer = null;
    let _smartSendBtnResetTimer = null;
    function getDefaultComposerHintHtml() {
      return (
        '<span><kbd class="composer-kbd-hint">Tab</kbd> ' + L('принять', 'accept') + '</span>' +
        '<span><kbd class="composer-kbd-hint">Ctrl+→</kbd> ' + L('слово', 'word') + '</span>' +
        '<span><kbd class="composer-kbd-hint">Ctrl+↵</kbd> ' + L('локально', 'local') + '</span>' +
        '<span><kbd class="composer-kbd-hint">Enter</kbd> ' + L('в чат', 'to chat') + '</span>'
      );
    }

    const _localRagHistory = [];
    let _localRagBusy = false;

    function formatSafeLocalRagMarkdown(rawText) {
      let safe = escapeHtml(String(rawText || ''));
      const codeBlocks = [];
      safe = safe.replace(/```[^\n]*\n([\s\S]*?)```/g, function (_m, inner) {
        const idx = codeBlocks.length;
        codeBlocks.push('<pre class="rag-code-block"><code>' + inner.replace(/\n$/, '') + '</code></pre>');
        return '\x00CB' + idx + '\x00';
      });
      safe = safe.replace(/`([^`\n]+)`/g, '<code class="rag-inline-code">$1</code>');
      safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      safe = safe
        .split('\n')
        .map(function (ln) {
          if (/^#{1,4}\s+/.test(ln)) {
            return '<div class="rag-md-heading">' + ln.replace(/^#{1,4}\s+/, '') + '</div>';
          }
          if (/^\s*[-*]\s+/.test(ln)) {
            return '<div class="rag-md-li">• ' + ln.replace(/^\s*[-*]\s+/, '') + '</div>';
          }
          return ln;
        })
        .join('\n');
      for (let i = 0; i < codeBlocks.length; i++) {
        safe = safe.replace('\x00CB' + i + '\x00', codeBlocks[i]);
      }
      return safe;
    }

    function renderLocalRagMessages() {
      const boxEl = document.getElementById('localRagChatBox');
      const listEl = document.getElementById('localRagMessages');
      if (!boxEl || !listEl) return;
      if (_localRagHistory.length === 0) {
        boxEl.style.display = 'none';
        listEl.textContent = '';
        return;
      }
      boxEl.style.display = 'flex';
      listEl.textContent = '';
      for (let i = 0; i < _localRagHistory.length; i++) {
        const msg = _localRagHistory[i];
        const card = document.createElement('div');
        card.className = 'local-rag-msg ' + (msg.error ? 'is-error' : (msg.role === 'user' ? 'is-user' : 'is-assistant'));

        const head = document.createElement('div');
        head.className = 'local-rag-msg-head';
        const roleSpan = document.createElement('span');
        roleSpan.textContent = msg.role === 'user'
          ? L('Вы', 'You')
          : (msg.error ? L('⚠ Локальная модель', '⚠ Local model') : ('🧠 ' + (msg.model || 'GPU') + L(' · 0 тк', ' · 0 tok')));
        head.appendChild(roleSpan);
        let displayMetaText = msg.metaText || '';
        if (!displayMetaText && msg.grounding && typeof msg.grounding === 'object') {
          if (msg.grounding.grounded === false) {
            displayMetaText = L('⚠ Есть неподтверждённые имена', '⚠ Contains unverified symbols');
          } else {
            const vf = Array.isArray(msg.grounding.verifiedFiles) ? msg.grounding.verifiedFiles.length : 0;
            const vs = Array.isArray(msg.grounding.verifiedSymbols) ? msg.grounding.verifiedSymbols.length : 0;
            displayMetaText = (vf + vs) > 0 ? ('✓ AST · ' + (vf + vs)) : L('✓ Проверено в RAM', '✓ Verified in RAM');
          }
        }
        if (displayMetaText) {
          const metaSpan = document.createElement('span');
          metaSpan.textContent = displayMetaText;
          if (msg.grounding && typeof msg.grounding === 'object') {
            if (msg.grounding.grounded === false && (msg.grounding.warningRu || msg.grounding.warningEn)) {
              metaSpan.title = String(pickText(msg.grounding, 'warningRu', 'warningEn', ''));
            } else if (msg.grounding.grounded !== false) {
              metaSpan.title = L('Сверено с AST и индексом файлов проекта в RAM', 'Verified against AST and in-RAM workspace file index');
            }
          }
          head.appendChild(metaSpan);
        }
        card.appendChild(head);

        const body = document.createElement('div');
        body.className = 'local-rag-msg-body';
        if (msg.role === 'assistant' && !msg.error) {
          body.innerHTML = formatSafeLocalRagMarkdown(msg.content);
        } else {
          body.textContent = String(msg.content || '');
        }
        card.appendChild(body);

        if (Array.isArray(msg.sources) && msg.sources.length > 0) {
          const srcWrap = document.createElement('div');
          srcWrap.className = 'local-rag-sources';
          for (let j = 0; j < msg.sources.length; j++) {
            const s = msg.sources[j];
            if (!s || !s.file) continue;
            const refStr = s.file + (s.startLine ? (':L' + s.startLine + (s.endLine >= s.startLine ? '-' + s.endLine : '')) : '');
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'local-rag-source-pill';
            pill.setAttribute('data-action', 'insertRagSourceRef');
            pill.setAttribute('data-source', refStr);
            pill.textContent = refStr;
            pill.title = L('Вставить ссылку ', 'Insert reference ') + refStr + L(' в поле ввода', ' into input');
            srcWrap.appendChild(pill);
          }
          card.appendChild(srcWrap);
        }

        listEl.appendChild(card);
      }
      listEl.scrollTop = listEl.scrollHeight;
    }

    function insertRagSourceRef(refText) {
      const inputEl = document.getElementById('smartComposerInput');
      const ref = String(refText || '').trim();
      if (!inputEl || !ref) return;
      const cur = inputEl.value || '';
      const sep = cur && !/\s$/.test(cur) ? ' ' : '';
      inputEl.value = cur + sep + ref + ' ';
      _smartLastDraft = inputEl.value;
      inputEl.focus();
      const endPos = inputEl.value.length;
      try { inputEl.setSelectionRange(endPos, endPos); } catch {}
      renderSmartComposerMirror();
      if (inputEl.value.trim().length >= 3 && inputEl.value.length <= 1200) {
        scheduleSmartAutocomplete(inputEl.value, { afterAccept: true });
      }
    }

    function clearLocalRagChat() {
      _localRagHistory.length = 0;
      const labelEl = document.getElementById('localRagMetaLabel');
      if (labelEl) labelEl.textContent = L('🧠 Локальный RAG-диалог · 0 тк', '🧠 Local RAG Chat · 0 tok');
      renderLocalRagMessages();
    }

    async function askLocalRagChat() {
      if (_localRagBusy) return;
      const inputEl = document.getElementById('smartComposerInput');
      const btnEl = document.getElementById('btnAskLocalRag');
      const metaEl = document.getElementById('localRagMetaLabel');
      const text = inputEl ? inputEl.value.trim() : '';
      if (!text) {
        flashComposerStatus(L('Введите вопрос по проекту для локального RAG-чата', 'Enter a workspace question for Local RAG Chat'), 'warn', 3200);
        if (inputEl) inputEl.focus();
        return;
      }

      cancelSmartComposerPendingRequests();
      _smartReqSeq += 1;
      _smartGhostText = '';
      _smartGhostSource = '';
      _smartLastDraft = '';
      if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = '56px';
        inputEl.focus();
      }
      updateComposerEngineBadge('loading', L('GPU RAG · ответ...', 'GPU RAG · answering...'));
      renderSmartComposerMirror();

      const priorTurns = _localRagHistory
        .filter(function (m) { return !m.error && (m.role === 'user' || m.role === 'assistant'); })
        .slice(-10)
        .map(function (m) { return { role: m.role, content: m.content }; });

      _localRagHistory.push({ role: 'user', content: text });
      renderLocalRagMessages();

      _localRagBusy = true;
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = L('Думает…', 'Thinking…');
      }
      flashComposerStatus(L('Локальный RAG-поиск и ответ на GPU (0% квоты)…', 'Local RAG search & GPU answer (0% cloud quota)…'), 'info', 25000);

      try {
        const res = await panelFetch('/api/local-chat', {
          method: 'POST',
          body: JSON.stringify({ message: text, messages: priorTurns }),
        });
        const data = res ? await res.json() : null;
        if (data && data.ok && data.answer) {
          const tokText = data.contextTokensEst ? (data.contextTokensEst + L(' тк окна', ' ctx tok')) : '';
          const msText = data.latencyMs ? (Math.round(Number(data.latencyMs) / 100) / 10 + L(' с', ' s')) : '';
          const groundingObj = (data.grounding && typeof data.grounding === 'object') ? data.grounding : null;
          let groundingBadgeText = '';
          if (groundingObj) {
            if (groundingObj.grounded === false) {
              groundingBadgeText = L('⚠ Есть неподтверждённые имена', '⚠ Contains unverified symbols');
            } else {
              const vFilesCount = Array.isArray(groundingObj.verifiedFiles) ? groundingObj.verifiedFiles.length : 0;
              const vSymsCount = Array.isArray(groundingObj.verifiedSymbols) ? groundingObj.verifiedSymbols.length : 0;
              const vCount = vFilesCount + vSymsCount;
              groundingBadgeText = vCount > 0 ? ('✓ AST · ' + vCount) : L('✓ Проверено в RAM', '✓ Verified in RAM');
            }
          }
          const metaText = [groundingBadgeText, tokText, msText].filter(Boolean).join(' · ');
          _localRagHistory.push({
            role: 'assistant',
            content: data.answer,
            model: data.model || 'GPU',
            metaText: metaText,
            grounding: groundingObj,
            sources: Array.isArray(data.sources) ? data.sources : [],
          });
          if (metaEl) {
            metaEl.textContent = '🧠 ' + (data.model || 'GPU') + (data.numCtxUsed ? (' · ctx ' + data.numCtxUsed) : '') + L(' · 0 тк облака', ' · 0 cloud tok');
          }
          updateComposerEngineBadge('gpu', L('GPU · 0 тк', 'GPU · 0 tok'));
          flashComposerStatus(L('✓ Ответ получен локально (0% облачной квоты)', '✓ Local answer received (0% cloud quota)'), 'ok', 4200);
        } else {
          const errText = (data && data.error) ? String(data.error) : L('Локальная модель не ответила (проверьте Ollama и переключатель GPU)', 'Local model did not respond (check Ollama and GPU toggle)');
          _localRagHistory.push({ role: 'assistant', content: errText, error: true });
          updateComposerEngineBadge('', L('RAM + GPU · 0 тк', 'RAM + GPU · 0 tok'));
          flashComposerStatus('⚠ ' + errText, 'err', 5500);
        }
      } catch (err) {
        const errMsg = (err && err.message) ? String(err.message) : L('Сетевой сбой sidecar при обращении к /api/local-chat', 'Sidecar network error calling /api/local-chat');
        _localRagHistory.push({ role: 'assistant', content: errMsg, error: true });
        updateComposerEngineBadge('', L('RAM + GPU · 0 тк', 'RAM + GPU · 0 tok'));
        flashComposerStatus('⚠ ' + errMsg, 'err', 5500);
      } finally {
        _localRagBusy = false;
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.textContent = L('💬 Локально · 0 тк', '💬 Local · 0 tok');
        }
        renderLocalRagMessages();
      }
    }

    function flashComposerStatus(message, tone, durationMs) {
      const hintEl = document.getElementById('composerHintText');
      if (!hintEl) return;
      if (_smartComposerStatusTimer) {
        clearTimeout(_smartComposerStatusTimer);
        _smartComposerStatusTimer = null;
      }
      if (!message) {
        hintEl.className = 'composer-shortcuts';
        hintEl.innerHTML = getDefaultComposerHintHtml();
        return;
      }
      const safeTone = (tone === 'ok' || tone === 'warn' || tone === 'err' || tone === 'info') ? tone : 'info';
      hintEl.className = 'composer-shortcuts is-status-' + safeTone;
      hintEl.textContent = String(message);
      const ttl = Number(durationMs) > 0 ? Number(durationMs) : 4500;
      _smartComposerStatusTimer = setTimeout(function () {
        _smartComposerStatusTimer = null;
        hintEl.className = 'composer-shortcuts';
        hintEl.innerHTML = getDefaultComposerHintHtml();
      }, ttl);
    }

    function clearSmartComposer() {
      const inputEl = document.getElementById('smartComposerInput');
      cancelSmartComposerPendingRequests();
      _smartReqSeq += 1;
      _smartGhostText = '';
      _smartGhostSource = '';
      _smartLastDraft = '';
      if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = '56px';
        inputEl.focus();
      }
      flashComposerStatus('', '');
      updateComposerEngineBadge('', L('RAM + GPU · 0 тк', 'RAM + GPU · 0 tok'));
      renderSmartComposerMirror();
    }

    function applyComposerChip(promptText) {
      const inputEl = document.getElementById('smartComposerInput');
      if (!inputEl) return;
      cancelSmartComposerPendingRequests();
      _smartGhostText = '';
      _smartGhostSource = '';
      const text = String(promptText || '');
      inputEl.value = text;
      _smartLastDraft = text;
      inputEl.focus();
      try { inputEl.setSelectionRange(text.length, text.length); } catch {}
      renderSmartComposerMirror();
      scheduleSmartAutocomplete(text);
    }

    const _SMART_SEND_QUEUE_LIMIT = 100;
    const _SMART_SEND_QUEUE_TTL_MS = 45000;
    const _smartSendQueue = [];
    let _smartSendProcessing = false;
    let _smartSendQueueTimer = null;
    let _smartSendDroppedCount = 0;

    function syncSmartSendButtonLabel(overrideText) {
      const sendBtn = document.getElementById('btnSendSmartComposer');
      if (!sendBtn) return;
      if (overrideText) {
        sendBtn.textContent = overrideText;
        return;
      }
      const totalPending = _smartSendQueue.length + (_smartSendProcessing ? 1 : 0);
      if (_smartSendQueue.length > 0) {
        sendBtn.textContent = L('В очереди (', 'Queued (') + totalPending + ')';
      } else if (_smartSendProcessing) {
        sendBtn.textContent = L('Отправка…', 'Sending…');
      } else if (!_smartSendBtnResetTimer) {
        sendBtn.textContent = L('В чат ↑', 'Send ↑');
      }
    }

    function pruneSmartSendQueue() {
      const now = Date.now();
      let dropped = 0;
      let guard = 0;
      while (_smartSendQueue.length > 0 && guard < _SMART_SEND_QUEUE_LIMIT + 10) {
        guard += 1;
        const head = _smartSendQueue[0];
        if (!head || now >= head.expiresAt) {
          _smartSendQueue.shift();
          dropped += 1;
        } else {
          break;
        }
      }
      if (dropped > 0) {
        _smartSendDroppedCount += dropped;
      }
      return dropped;
    }

    function scheduleNextSmartSendTick() {
      if (_smartSendProcessing || _smartSendQueue.length === 0 || _smartSendQueueTimer) return;
      _smartSendQueueTimer = setTimeout(function () {
        _smartSendQueueTimer = null;
        void processNextSmartSend();
      }, 0);
    }

    function enqueueSmartComposerMessage(text) {
      const now = Date.now();
      let dropped = pruneSmartSendQueue();
      let guard = 0;
      while (_smartSendQueue.length >= _SMART_SEND_QUEUE_LIMIT && guard < _SMART_SEND_QUEUE_LIMIT + 2) {
        guard += 1;
        _smartSendQueue.shift();
        dropped += 1;
        _smartSendDroppedCount += 1;
      }
      _smartSendQueue.push({
        text: String(text || ''),
        createdAt: now,
        expiresAt: now + _SMART_SEND_QUEUE_TTL_MS,
      });
      if (_smartSendBtnResetTimer) {
        clearTimeout(_smartSendBtnResetTimer);
        _smartSendBtnResetTimer = null;
      }
      syncSmartSendButtonLabel();
      if (dropped > 0) {
        flashComposerStatus(L('Лимит 100: автосброс старых задач (' + dropped + '), в очереди: ' + _smartSendQueue.length, 'Queue limit 100: dropped oldest (' + dropped + '), queued: ' + _smartSendQueue.length), 'warn', 4200);
      } else if (_smartSendQueue.length > 1 || _smartSendProcessing) {
        flashComposerStatus(L('Добавлено в очередь (в ожидании: ' + _smartSendQueue.length + ')', 'Queued (waiting: ' + _smartSendQueue.length + ')'), 'info', 4000);
      } else {
        flashComposerStatus(L('Отправка запроса в чат Antigravity…', 'Sending prompt to Antigravity chat…'), 'info', 8000);
      }
      scheduleNextSmartSendTick();
    }

    async function processNextSmartSend() {
      if (_smartSendProcessing) return;
      _smartSendProcessing = true;
      syncSmartSendButtonLabel();
      try {
        const expiredCount = pruneSmartSendQueue();
        if (expiredCount > 0 && _smartSendQueue.length === 0) {
          flashComposerStatus(L('Автосброс устаревших задач очереди (' + expiredCount + ')', 'Expired stale queued tasks (' + expiredCount + ')'), 'warn', 4200);
          return;
        }
        const item = _smartSendQueue.shift();
        if (!item || !item.text) return;

        syncSmartSendButtonLabel();
        let res = null;
        try {
          res = await dispatchPromptToChatDetailed(
            item.text,
            L('✓ Запрос отправлен в активный чат', '✓ Sent to active chat'),
            L('📋 Активный чат недоступен — запрос скопирован в буфер (Ctrl+V)', '📋 Active chat unavailable — copied to clipboard (Ctrl+V)'),
            L('✓ Открыт новый чат и отправлен запрос', '✓ Opened new chat and sent prompt')
          );
        } catch (err) {
          res = {
            sent: false,
            copied: false,
            statusText: (err && err.message) ? String(err.message) : L('Ошибка шага очереди отправки', 'Send queue step error'),
          };
        }

        if (res && res.sent) {
          void loadSmartComposerContext();
          const remainingSuffix = _smartSendQueue.length > 0 ? (L(' · осталось: ', ' · remaining: ') + _smartSendQueue.length) : '';
          flashComposerStatus((res.statusText || L('✓ Запрос отправлен в чат', '✓ Sent to chat')) + remainingSuffix, 'ok', 4200);
          if (_smartSendQueue.length === 0) {
            syncSmartSendButtonLabel(L('Отправлено ✓', 'Sent ✓'));
            _smartSendBtnResetTimer = setTimeout(function () {
              _smartSendBtnResetTimer = null;
              syncSmartSendButtonLabel();
            }, 1800);
          }
        } else if (res && res.copied) {
          flashComposerStatus(res.statusText || L('📋 Запрос скопирован в буфер — вставьте в чат (Ctrl+V)', '📋 Copied to clipboard — paste in chat (Ctrl+V)'), 'warn', 5500);
          if (_smartSendQueue.length === 0) {
            syncSmartSendButtonLabel(L('В буфере ✓', 'Copied ✓'));
            _smartSendBtnResetTimer = setTimeout(function () {
              _smartSendBtnResetTimer = null;
              syncSmartSendButtonLabel();
            }, 2200);
          }
        } else {
          flashComposerStatus('⚠ ' + ((res && res.statusText) || L('Не удалось отправить запрос в чат', 'Failed to send prompt to chat')), 'err', 6000);
        }
      } finally {
        _smartSendProcessing = false;
        syncSmartSendButtonLabel();
        if (_smartSendQueue.length > 0) {
          scheduleNextSmartSendTick();
        }
      }
    }

    async function sendSmartComposer() {
      const inputEl = document.getElementById('smartComposerInput');
      const rawText = inputEl ? inputEl.value.trim() : '';
      if (!rawText) {
        flashComposerStatus(L('Введите запрос или выберите готовую подсказку выше', 'Enter a prompt or pick a quick chip above'), 'warn', 3200);
        if (inputEl) inputEl.focus();
        return;
      }
      const text = (_composerGrillArmed && !/^\[Grill-Me/i.test(rawText))
        ? ((isRu()
            ? '[Grill-Me: проведи детальный опрос по развилкам перед кодом] '
            : '[Grill-Me: run a detailed decision-tree interview before coding] ') + rawText)
        : rawText;
      if (_composerGrillArmed) {
        _composerGrillArmed = false;
        syncComposerGrillToggleUi();
      }
      cancelSmartComposerPendingRequests();
      _smartReqSeq += 1;
      _smartGhostText = '';
      _smartGhostSource = '';
      _smartLastDraft = '';
      if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = '56px';
        inputEl.focus();
      }
      updateComposerEngineBadge('', L('RAM + GPU · 0 тк', 'RAM + GPU · 0 tok'));
      renderSmartComposerMirror();
      enqueueSmartComposerMessage(text);
    }

    async function loadSmartComposerContext() {
      try {
        const res = await panelFetch('/api/autocomplete', {
          method: 'POST',
          body: JSON.stringify({ mode: 'context' }),
        });
        if (!res || !res.ok) return;
        const data = await res.json();
        if (data && data.ok && Array.isArray(data.chips)) {
          renderSmartComposerChips(data.chips);
        }
      } catch {}
    }

    let _composerAtTimer = null;
    let _composerAttachedImageB64 = '';
    let _composerVoiceRec = null;

    function renderComposerAtMenu(items) {
      const menuEl = document.getElementById('composerAtMenu');
      if (!menuEl) return;
      if (!Array.isArray(items) || items.length === 0) {
        menuEl.style.display = 'none';
        menuEl.innerHTML = '';
        return;
      }
      let html = '';
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        html +=
          '<button type="button" class="win-btn" data-action="selectComposerAtItem" data-token="' + escapeHtml(it.token) + '" style="display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 7px; margin-bottom: 2px; text-align: left; font-size: 10.5px;">' +
            '<span style="font-weight: 600; color: var(--accent-cyan);">' + escapeHtml(it.token) + '</span>' +
            '<span style="color: var(--text-sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px;">' + escapeHtml(pickText(it, 'detail', 'detailEn') || pickText(it, 'label', 'labelEn', '')) + '</span>' +
          '</button>';
      }
      menuEl.innerHTML = html;
      menuEl.style.display = 'block';
    }

    function checkSmartComposerAtTrigger(val) {
      const inputEl = document.getElementById('smartComposerInput');
      if (!inputEl) return;
      const caret = Number.isInteger(inputEl.selectionStart) ? inputEl.selectionStart : val.length;
      const beforeCaret = val.slice(0, caret);
      const m = /(?:^|\s)(@[A-Za-z0-9_:./-]*)$/.exec(beforeCaret);
      if (!m) {
        renderComposerAtMenu([]);
        return;
      }
      const queryToken = m[1];
      if (_composerAtTimer) clearTimeout(_composerAtTimer);
      _composerAtTimer = setTimeout(async function () {
        try {
          const res = await panelFetch('/api/composer/at-suggest', {
            method: 'POST',
            body: JSON.stringify({ query: queryToken, limit: 8 }),
          });
          if (!res || !res.ok) return;
          const data = await res.json();
          if (data && data.ok && Array.isArray(data.items)) {
            renderComposerAtMenu(data.items);
          }
        } catch {}
      }, 65);
    }

    function selectComposerAtItem(token) {
      const cleanToken = String(token || '').trim();
      const inputEl = document.getElementById('smartComposerInput');
      renderComposerAtMenu([]);
      if (!inputEl || !cleanToken) return;
      const val = inputEl.value || '';
      const caret = Number.isInteger(inputEl.selectionStart) ? inputEl.selectionStart : val.length;
      const before = val.slice(0, caret);
      const after = val.slice(caret);
      const nextBefore = before.replace(/(?:^|\s)(@[A-Za-z0-9_:./-]*)$/, function (full, tok) {
        return full.slice(0, full.length - tok.length) + cleanToken + ' ';
      });
      inputEl.value = nextBefore + after;
      _smartLastDraft = inputEl.value;
      inputEl.focus();
      try {
        inputEl.setSelectionRange(nextBefore.length, nextBefore.length);
      } catch {}
      renderSmartComposerMirror();
      if (inputEl.value.trim().length >= 3 && inputEl.value.length <= 1200) {
        scheduleSmartAutocomplete(inputEl.value, { afterAccept: true });
      }
    }

    function clearComposerScreenshot() {
      _composerAttachedImageB64 = '';
      const bar = document.getElementById('composerImagePreviewBar');
      const thumb = document.getElementById('composerImageThumb');
      if (thumb) thumb.removeAttribute('src');
      if (bar) bar.style.display = 'none';
    }

    function attachComposerScreenshotFile(file) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) return;
      if (file.size > 4 * 1024 * 1024) {
        flashComposerStatus(L('Скриншот превышает лимит 4 МБ', 'Screenshot exceeds 4 MB limit'), 'warn', 4000);
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        const resultStr = String(reader.result || '');
        if (!resultStr) return;
        _composerAttachedImageB64 = resultStr;
        const bar = document.getElementById('composerImagePreviewBar');
        const thumb = document.getElementById('composerImageThumb');
        const meta = document.getElementById('composerImageMeta');
        if (thumb) thumb.src = resultStr;
        if (meta) meta.textContent = (file.name || L('Скриншот', 'Screenshot')) + ' · ' + Math.max(1, Math.round(file.size / 1024)) + L(' КБ', ' KB');
        if (bar) bar.style.display = 'block';
        flashComposerStatus(L('Скриншот прикреплён — нажмите «🔍 Разобрать UI · 0 тк»', 'Screenshot attached — click "🔍 Audit UI · 0 tok"'), 'ok', 3500);
      };
      reader.readAsDataURL(file);
    }

    async function analyzeComposerScreenshot() {
      if (!_composerAttachedImageB64) {
        flashComposerStatus(L('Сначала вставьте скриншот (Ctrl+V)', 'Paste a screenshot first (Ctrl+V)'), 'warn', 3000);
        return;
      }
      const inputEl = document.getElementById('smartComposerInput');
      const btn = document.getElementById('btnAnalyzeVision');
      if (btn) { btn.disabled = true; btn.textContent = L('Анализ…', 'Analyzing…'); }
      flashComposerStatus(L('Локальный визуальный разбор скриншота (Gemma 4, 0% квоты)…', 'Local visual screenshot audit (Gemma 4, 0% quota)…'), 'info', 25000);
      try {
        const res = await panelFetch('/api/composer/vision', {
          method: 'POST',
          body: JSON.stringify({
            imageBase64: _composerAttachedImageB64,
            userHint: inputEl ? inputEl.value.trim() : '',
          }),
        });
        const data = res ? await res.json() : null;
        if (data && data.ok) {
          const defectsList = isRu()
            ? (Array.isArray(data.defectsRu) ? data.defectsRu : data.defectsEn)
            : (Array.isArray(data.defectsEn) ? data.defectsEn : data.defectsRu);
          const defects = Array.isArray(defectsList) && defectsList.length
            ? ('\n• ' + defectsList.join('\n• '))
            : '';
          const analysisTxt = pickText(data, 'analysisRu', 'analysisEn', '');
          const patchTxt = pickText(data, 'promptPatchRu', 'promptPatchEn', '');
          _localRagHistory.push({
            role: 'assistant',
            content: L('🖼️ Визуальный разбор UI:\n', '🖼️ Visual UI Audit:\n') + analysisTxt + defects +
              (patchTxt ? (L('\n\nПромпт для правки:\n', '\n\nFix prompt:\n') + patchTxt) : ''),
            model: data.model || 'GPU Vision',
          });
          renderLocalRagMessages();
          if (inputEl && patchTxt && !inputEl.value.trim()) {
            inputEl.value = patchTxt;
            _smartLastDraft = inputEl.value;
            renderSmartComposerMirror();
          }
          flashComposerStatus(L('✓ UI разобран локально (0 тк облака)', '✓ UI audited locally (0 cloud tok)'), 'ok', 4200);
        } else {
          flashComposerStatus('⚠ ' + ((data && data.error) || L('Локальный GPU недоступен', 'Local GPU unavailable')), 'err', 4800);
        }
      } catch {
        flashComposerStatus(L('⚠ Ошибка обращения к /api/composer/vision', '⚠ Error calling /api/composer/vision'), 'err', 4500);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = L('🔍 Разобрать UI · 0 тк', '🔍 Audit UI · 0 tok'); }
      }
    }

    async function prepareLocalCommit() {
      const btn = document.getElementById('btnPrepareCommit');
      if (btn) { btn.disabled = true; btn.textContent = L('Проверка…', 'Checking…'); }
      flashComposerStatus(L('Локальный Pre-Commit (Shadow Guard + секреты + сообщение, 0 тк)…', 'Local Pre-Commit (Shadow Guard + secrets + message, 0 tok)…'), 'info', 20000);
      try {
        const res = await panelFetch('/api/sentinel', {
          method: 'POST',
          body: JSON.stringify({ action: 'prepare_commit', force: true }),
        });
        const data = res ? await res.json() : null;
        const pc = data && data.preCommit ? data.preCommit : null;
        if (pc && pc.ok) {
          const statusLine = pc.readyToCommit
            ? L('✅ Готово к коммиту (0 критических блокеров)', '✅ Ready to commit (0 critical blockers)')
            : (L('🛑 Блокеры перед коммитом:\n• ', '🛑 Pre-commit blockers:\n• ') + (pc.blockers || []).join('\n• '));
          const warnLine = Array.isArray(pc.warnings) && pc.warnings.length
            ? (L('\n\n⚠ Замечания:\n• ', '\n\n⚠ Warnings:\n• ') + pc.warnings.join('\n• '))
            : '';
          const sumTxt = pickText(pc, 'summaryRu', 'summaryEn', '');
          const msgLine = pc.commitMessage
            ? (L('\n\nСообщение коммита:\n', '\n\nCommit message:\n') + pc.commitMessage + (sumTxt ? ('\n' + sumTxt) : ''))
            : ('\n\n' + (sumTxt || L('Изменений не обнаружено', 'No changes detected')));
          _localRagHistory.push({
            role: 'assistant',
            content: statusLine + warnLine + msgLine,
            model: pc.viaGpu ? 'GPU + Sentinel' : 'CPU + Sentinel',
          });
          renderLocalRagMessages();
          flashComposerStatus(
            pc.readyToCommit ? L('✓ Pre-Commit пройден', '✓ Pre-Commit passed') : L('⚠ Найдены блокеры перед коммитом', '⚠ Pre-Commit blockers found'),
            pc.readyToCommit ? 'ok' : 'warn',
            4500
          );
        } else {
          flashComposerStatus('⚠ ' + ((data && data.error) || L('Pre-Commit завершился с ошибкой', 'Pre-Commit failed')), 'err', 4500);
        }
      } catch {
        flashComposerStatus(L('⚠ Ошибка вызова /api/sentinel prepare_commit', '⚠ Error calling /api/sentinel prepare_commit'), 'err', 4500);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = L('✓ Коммит · 0 тк', '✓ Commit · 0 tok'); }
      }
    }

    function toggleComposerVoice() {
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Rec) {
        flashComposerStatus(L('Голосовой ввод Web Speech не поддерживается в текущем окне WebView', 'Web Speech voice input is not supported in this WebView'), 'warn', 4200);
        return;
      }
      if (_composerVoiceRec) {
        try { _composerVoiceRec.stop(); } catch {}
        _composerVoiceRec = null;
        flashComposerStatus(L('Запись остановлена', 'Recording stopped'), 'info', 2000);
        return;
      }
      const btn = document.getElementById('btnVoiceComposer');
      try {
        const rec = new Rec();
        _composerVoiceRec = rec;
        rec.lang = isRu() ? 'ru-RU' : 'en-US';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        if (btn) btn.classList.add('active');
        flashComposerStatus(L('🎙️ Слушаю диктовку...', '🎙️ Listening for dictation...'), 'info', 10000);
        rec.onresult = async function (ev) {
          const rawTranscript = (ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript) || '';
          if (!rawTranscript) return;
          try {
            const res = await panelFetch('/api/composer/voice-structure', {
              method: 'POST',
              body: JSON.stringify({ rawTranscript }),
            });
            const data = res ? await res.json() : null;
            const cleanText = (data && data.ok && data.structuredPrompt) ? data.structuredPrompt : rawTranscript;
            applyComposerChip(cleanText);
            flashComposerStatus(L('✓ Голос структурирован в промпт', '✓ Voice structured into prompt'), 'ok', 3500);
          } catch {
            applyComposerChip(rawTranscript);
          }
        };
        rec.onerror = function () {
          flashComposerStatus(L('Не удалось распознать речь', 'Could not recognize speech'), 'warn', 3200);
        };
        rec.onend = function () {
          _composerVoiceRec = null;
          if (btn) btn.classList.remove('active');
        };
        rec.start();
      } catch {
        _composerVoiceRec = null;
        if (btn) btn.classList.remove('active');
      }
    }

    function initSmartComposerWidget() {
      if (_smartComposerBound) return;
      const inputEl = document.getElementById('smartComposerInput');
      if (!inputEl) return;
      _smartComposerBound = true;
      inputEl.addEventListener('scroll', syncSmartComposerSizeAndScroll, { passive: true });
      inputEl.addEventListener('click', renderSmartComposerMirror);
      inputEl.addEventListener('paste', function (ev) {
        const items = ev.clipboardData && ev.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf('image/') === 0) {
            const imgFile = items[i].getAsFile();
            if (imgFile) {
              ev.preventDefault();
              attachComposerScreenshotFile(imgFile);
              break;
            }
          }
        }
      });
      inputEl.addEventListener('dragover', function (ev) {
        ev.preventDefault();
      });
      inputEl.addEventListener('drop', function (ev) {
        const files = ev.dataTransfer && ev.dataTransfer.files;
        if (files && files[0] && files[0].type && files[0].type.indexOf('image/') === 0) {
          ev.preventDefault();
          attachComposerScreenshotFile(files[0]);
        }
      });
      inputEl.addEventListener('keyup', function (ev) {
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
          renderSmartComposerMirror();
        }
      });
      inputEl.addEventListener('keydown', function (ev) {
        const len = inputEl.value.length;
        const caretAtEnd = inputEl.selectionStart === len && inputEl.selectionEnd === len;
        if (ev.key === 'Escape') {
          const menuEl = document.getElementById('composerAtMenu');
          if (menuEl && menuEl.style.display === 'block') {
            ev.preventDefault();
            renderComposerAtMenu([]);
            return;
          }
        }
        if (ev.key === 'Tab' && !ev.shiftKey && _smartGhostText && caretAtEnd) {
          ev.preventDefault();
          acceptSmartComposerGhost(false);
          return;
        }
        if (ev.key === 'ArrowRight' && (ev.ctrlKey || ev.metaKey) && _smartGhostText && caretAtEnd) {
          ev.preventDefault();
          acceptSmartComposerGhost(true);
          return;
        }
        if (ev.key === 'Escape' && _smartGhostText) {
          ev.preventDefault();
          dismissSmartComposerGhost();
          return;
        }
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) {
          ev.preventDefault();
          void askLocalRagChat();
          return;
        }
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          void sendSmartComposer();
        }
      });
      renderSmartComposerMirror();
    }

    document.addEventListener('input', function (ev) {
      const target = ev.target;
      if (!target || !target.getAttribute) return;
      if (target.id && target.id.indexOf('inp-gpu') === 0) {
        target.setAttribute('data-dirty', '1');
      }
      const inputAction = target.getAttribute('data-input-action');
      if (inputAction === 'filterSkillsView') {
        filterSkillsView(target.value);
      } else if (inputAction === 'onSmartComposerInput') {
        handleSmartComposerInput();
      } else if (inputAction === 'onProjectGraphSearch') {
        onProjectGraphSearch(target.value);
      } else if (inputAction === 'wizSetGpuInstallDir' && typeof wizSetGpuInstallDir === 'function') {
        wizSetGpuInstallDir(target.value);
      }
    });

    const _isStandaloneGraphView = (function () {
      try {
        return new URLSearchParams(window.location.search).get('view') === 'graph';
      } catch {
        return false;
      }
    })();

    document.body.classList.toggle('is-tab-hidden', document.visibilityState !== 'visible');
    document.addEventListener('visibilitychange', function () {
      const isHidden = document.visibilityState !== 'visible';
      document.body.classList.toggle('is-tab-hidden', isHidden);
      if (!isHidden) {
        if (!_isStandaloneGraphView) {
          pollTelemetryTick();
        }
      } else if (telemetryPollTimer) {
        clearTimeout(telemetryPollTimer);
        telemetryPollTimer = null;
      }
    });

    (async function init() {
      if (_isStandaloneGraphView) {
        return;
      }
      try {
        const savedView = localStorage.getItem(PANEL_VIEW_STORAGE_KEY);
        if (savedView === 'lite' || savedView === 'full') {
          applyPanelViewModeDom(savedView, false);
        }
        const savedScale = localStorage.getItem(PANEL_UI_SCALE_STORAGE_KEY);
        applyPanelUiScaleDom(savedScale || 'auto', false);
      } catch {}
      ensureBlockMoveControls();
      setupSpoilerPersistence();
      applyAllCollapsedCardsState();
      applyAllSpoilersOpenState();
      applyPanelBlockOrder(null);
      initBlockVisibilityObserver();
      initSmartComposerWidget();
      await refreshAll();
      void loadSmartComposerContext();
      if (typeof checkPluginUpdate === 'function') {
        void checkPluginUpdate({ force: false, silent: true });
      }
    })();
