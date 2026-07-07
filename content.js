// content.js — MCP Multi Bridge 内容脚本
// 职责：只留"一只手"——在 AI 网页里注入文本/文件、检测 AI 输出的工具调用、执行并回注结果。
// 不再渲染任何面板 UI（UI 已迁至 sidePanel）；网页内仅保留低调的行内状态标。
// 与 sidePanel 的通信：chrome.tabs.sendMessage（指令进）+ chrome.runtime.sendMessage（状态广播出）。

'use strict';

(function () {
  // 防止重复注入
  if (window.__mcpMultiBridgeLoaded) return;
  window.__mcpMultiBridgeLoaded = true;

  // ==================== 平台检测 ====================
  const PLATFORM = detectPlatform();

  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
    if (h.includes('gemini.google.com')) return 'gemini';
    if (h.includes('chat.deepseek.com')) return 'deepseek';
    if (h.includes('grok.com')) return 'grok';
    if (h.includes('perplexity.ai')) return 'perplexity';
    if (h.includes('aistudio.google.com')) return 'aistudio';
    if (h.includes('chat.mistral.ai')) return 'mistral';
    if (h.includes('kimi.com') || h.includes('kimi.moonshot.cn')) return 'kimi';
    if (h.includes('t3.chat')) return 't3';
    if (h.includes('qwen.ai') || h.includes('qianwen.com')) return 'qwen';
    if (h.includes('chatglm.cn') || h.includes('chat.z.ai')) return 'chatglm';
    if (h.includes('github.com')) return 'copilot';
    if (h.includes('doubao.com')) return 'doubao';
    return 'unknown';
  }

  // 判断当前平台是否使用拖放注入方式（仅 Gemini）
  function usesDragDropInjection() {
    return PLATFORM === 'gemini';
  }

  // ==================== 保活端口 ====================
  let keepalivePort = null;
  function ensureKeepalive() {
    if (!keepalivePort) {
      keepalivePort = chrome.runtime.connect({ name: 'keepalive' });
      keepalivePort.onDisconnect.addListener(() => { keepalivePort = null; });
    }
  }
  ensureKeepalive();

  // ==================== 消息通信（→ background MCP 层） ====================
  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error('无响应'));
        if (!resp.ok) return reject(new Error(resp.error || '未知错误'));
        resolve(resp.data);
      });
    });
  }

  const MAX_RETRIES = 5;
  const RETRY_BASE_DELAY = 1000; // ms

  async function sendWithRetry(msg, onRetry) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await send(msg);
      } catch (e) {
        lastError = e;
        console.warn(`[MCP] 调用失败 (第${attempt}/${MAX_RETRIES}次):`, e.message);
        if (onRetry) onRetry(attempt, MAX_RETRIES, e);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY * attempt));
        }
      }
    }
    throw lastError;
  }

  // ==================== 状态广播（→ sidePanel 时间线） ====================
  function reportStatus(event, extra = {}) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'mcpStatus', event, ...extra });
      if (p && p.catch) p.catch(() => { });
    } catch (_) { /* 扩展上下文失效等，忽略 */ }
  }

  // ==================== 设置（chrome.storage 共享，sidePanel 修改 → 此处热更新） ====================
  let autoExecute = true;   // 一步式体验默认开启
  let autoSubmit = true;
  let pasteIntercept = true;
  let autoSendDelay = 4;   // 秒：最后一个MCP返回后等待多久再注入（等待AI继续输出新调用）
  let fileParsDelay = 8;   // 秒：注入文件后等待多久再发送（等待平台解析文件）

  function loadSettings() {
    chrome.storage?.local?.get(
      ['mcpAutoExecute', 'mcpAutoSubmit', 'mcpPasteIntercept', 'mcpAutoSendDelay', 'mcpFileParsDelay'],
      (result) => {
        if (!result) return;
        if (result.mcpAutoExecute !== undefined) autoExecute = result.mcpAutoExecute;
        if (result.mcpAutoSubmit !== undefined) autoSubmit = result.mcpAutoSubmit;
        if (result.mcpPasteIntercept !== undefined) pasteIntercept = result.mcpPasteIntercept;
        if (result.mcpAutoSendDelay !== undefined) autoSendDelay = result.mcpAutoSendDelay;
        if (result.mcpFileParsDelay !== undefined) fileParsDelay = result.mcpFileParsDelay;
      },
    );
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.mcpAutoExecute) autoExecute = changes.mcpAutoExecute.newValue;
    if (changes.mcpAutoSubmit) autoSubmit = changes.mcpAutoSubmit.newValue;
    if (changes.mcpPasteIntercept) pasteIntercept = changes.mcpPasteIntercept.newValue;
    if (changes.mcpAutoSendDelay) autoSendDelay = changes.mcpAutoSendDelay.newValue;
    if (changes.mcpFileParsDelay) fileParsDelay = changes.mcpFileParsDelay.newValue;
  });

  // ==================== 检测/执行状态 ====================
  const processedBlocks = new WeakMap(); // element → 已处理的调用数量（支持流式增量检测）
  // Gemini 专用：基于内容签名的去重集合
  // Gemini 在流式输出时会销毁并重建 <code> 元素，导致 WeakMap 丢失引用
  // 通过 name+callId+params 生成唯一签名来避免重复检测
  const processedCallSignatures = new Set();

  // ==================== 批量执行状态 ====================
  // 当同一批检测到多个工具调用时，收集所有结果后再统一注入+发送
  let pendingExecutions = 0;
  let collectedResults = []; // { call, result, error }

  // ==================== 跨周期累积 & 统一计时器 ====================
  // 跨扫描周期累积的所有已完成结果（等最后一个调用完成后 N 秒再统一注入）
  let accumulatedResults = [];
  let autoSendTimer = null; // 自动发送定时器 ID
  let sendRetryTimer = null; // 发送延迟定时器 ID（可取消，防止调用未完成就发送）

  // ==================== 调用注册表（供 sidePanel 手动执行/重试） ====================
  let callSeq = 0;
  const callRegistry = new Map(); // callKey → { call, chip, status }

  // ==================== Gemini 拖放监听器注入 ====================
  let geminiDragDropInjected = false;
  let geminiDragDropReady = null; // Promise that resolves when script is loaded

  function injectGeminiDragDropListener() {
    if (!usesDragDropInjection()) return Promise.resolve(false);
    if (geminiDragDropInjected && geminiDragDropReady) return geminiDragDropReady;
    geminiDragDropReady = new Promise((resolve) => {
      try {
        const scriptEl = document.createElement('script');
        scriptEl.src = chrome.runtime.getURL('dragDropListener.js');
        scriptEl.onload = () => {
          scriptEl.remove();
          geminiDragDropInjected = true;
          console.log('[MCP] Gemini dragDropListener 已注入到页面主世界');
          resolve(true);
        };
        scriptEl.onerror = () => {
          console.warn('[MCP] Gemini dragDropListener 脚本加载失败');
          resolve(false);
        };
        (document.head || document.documentElement).appendChild(scriptEl);
      } catch (e) {
        console.warn('[MCP] Gemini dragDropListener 注入失败:', e);
        resolve(false);
      }
    });
    return geminiDragDropReady;
  }

  // Gemini 专用：通过 postMessage 让主世界的 dragDropListener 执行拖放
  async function geminiDropFile(file) {
    // 确保 dragDropListener.js 已加载到页面主世界
    const injected = await injectGeminiDragDropListener();
    if (!injected) {
      console.warn('[MCP] geminiDropFile: dragDropListener 未就绪');
      return false;
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        // Gemini 仅接受 text/plain，不接受 text/markdown
        // 保留 .md 文件扩展名，但使用 text/plain MIME 类型
        const safeType = file.type === 'text/markdown' ? 'text/plain' : file.type;
        window.postMessage({
          type: 'MCP_DROP_FILE',
          platform: PLATFORM,
          fileName: file.name,
          fileType: safeType,
          fileSize: file.size,
          lastModified: file.lastModified,
          fileData: reader.result, // base64 data URL
        }, '*');
        // 给平台时间处理拖放事件，然后检查文件预览元素
        setTimeout(() => {
          const preview = document.querySelector('.file-preview, .xap-filed-upload-preview, .attachment-preview');
          if (preview) {
            console.log('[MCP] 文件预览已出现，附件成功');
          } else {
            console.warn('[MCP] 文件预览未出现，但仍视为成功（乐观模式）');
          }
          resolve(true);
        }, 800);
      };
      reader.onerror = () => {
        console.warn('[MCP] geminiDropFile: FileReader 读取失败');
        resolve(false);
      };
      reader.readAsDataURL(file);
    });
  }

  // ==================== 会话切换检测 ====================
  // 防止切换会话时自动执行旧会话中已存在的工具调用
  // 原理：不额外轮询，而是在已有的 MutationObserver 回调中顺便检测 URL 变化
  // SPA 切换会话时 pushState 改 URL → 框架更新 DOM → MutationObserver 触发 → 检测到 URL 变化
  let lastUrl = location.href;
  let suppressAutoExecuteUntil = 0;

  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onConversationSwitch();
    }
  }

  // ==================== 对话级"已注入工具定义"标记 ====================
  // 关键坑：新对话发出第一条消息前 URL 是根路径（如 chatgpt.com/），
  // 发送后平台跳到 /c/<id>。若不迁移标记，会把"URL 定型"误判为切换会话，
  // 导致下一问重复注入工具定义。
  // 解法：compose 附加工具定义后开一个 30 秒迁移窗口；窗口内的首次 URL 变化
  // 视为同一对话定型 → 把标记从旧 URL 迁到新 URL，且不做会话重置。
  const CONV_MIGRATION_WINDOW = 30000; // ms
  let pendingConvMigration = 0;  // 时间戳；0 = 无待迁移
  let pendingConvMigrationFrom = ''; // compose 时的对话 key

  function getConversationKey() {
    return location.origin + location.pathname; // 忽略 query/hash
  }

  function getInjectedConvs() {
    try {
      return JSON.parse(sessionStorage.getItem('mcpInjectedConvs') || '[]');
    } catch (_) {
      return [];
    }
  }

  function isConvInjected(key) {
    return getInjectedConvs().includes(key);
  }

  function markConvInjected(key) {
    const list = getInjectedConvs();
    if (!list.includes(key)) {
      list.push(key);
      try { sessionStorage.setItem('mcpInjectedConvs', JSON.stringify(list.slice(-50))); } catch (_) { }
    }
  }

  function unmarkConvInjected(key) {
    const list = getInjectedConvs().filter((k) => k !== key);
    try { sessionStorage.setItem('mcpInjectedConvs', JSON.stringify(list)); } catch (_) { }
  }

  function onConversationSwitch() {
    // 迁移窗口内的首次 URL 变化：同一对话 URL 定型，迁移标记，不重置状态
    if (pendingConvMigration && Date.now() - pendingConvMigration < CONV_MIGRATION_WINDOW) {
      pendingConvMigration = 0;
      const newKey = getConversationKey();
      unmarkConvInjected(pendingConvMigrationFrom); // 根 URL 的标记必须摘掉，否则下一个新对话会漏注入
      markConvInjected(newKey);
      console.log('[MCP] 对话 URL 定型，注入标记已迁移 →', newKey);
      return;
    }
    pendingConvMigration = 0;

    console.log('[MCP] 检测到会话切换，暂停自动执行 3 秒');
    // 设置 3 秒抑制窗口：在此期间扫描到的工具调用不自动执行
    suppressAutoExecuteUntil = Date.now() + 3000;

    // 清理跨周期累积状态 & 取消待发送的自动发送定时器
    clearTimeout(autoSendTimer);
    autoSendTimer = null;
    clearTimeout(sendRetryTimer);
    sendRetryTimer = null;
    accumulatedResults = [];
    // 清空签名去重集合与调用注册表，新会话重新开始
    processedCallSignatures.clear();
    callRegistry.clear();
    reportStatus('conversation_switch');
  }

  // ==================== 工具调用检测 ====================
  function startDetection() {
    let scanTimer = null;
    const debouncedScan = () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => scanForToolCalls(), 300);
    };

    const observer = new MutationObserver((mutations) => {
      // 在已有的 MutationObserver 中顺便检测 URL 变化（零额外开销）
      // SPA 切换会话：pushState 改 URL → 框架更新 DOM → 此回调触发
      checkUrlChange();

      let shouldScan = false;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length > 0) shouldScan = true;
        if (m.type === 'characterData') shouldScan = true;
      }
      if (shouldScan) debouncedScan();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // popstate 监听浏览器前进/后退导航
    window.addEventListener('popstate', () => checkUrlChange());

    // 定时扫描作为备用
    setInterval(() => scanForToolCalls(), 2000);
  }

  function scanForToolCalls() {
    // 去重逻辑：优先选 <pre> 内的 <code>，避免 <pre> 和 <code> 同时匹配导致重复检测
    const allBlocks = document.querySelectorAll('pre code, pre, code');
    const deduped = [];
    const seen = new Set();
    for (const block of allBlocks) {
      // 如果这个元素已经被处理过（作为另一个元素的子/父），跳过
      if (seen.has(block)) continue;
      // 如果是 <pre> 且内部有 <code>，跳过 <pre>（让内部的 <code> 处理）
      if (block.tagName === 'PRE' && block.querySelector('code')) {
        seen.add(block);
        continue;
      }
      // 如果是 <code> 且在 <pre> 内，标记父 <pre> 为已见
      if (block.tagName === 'CODE' && block.parentElement?.tagName === 'PRE') {
        seen.add(block.parentElement);
      }
      seen.add(block);
      deduped.push(block);
    }

    for (const block of deduped) {
      const text = block.textContent || '';
      if (!text.includes('function_call_start') || !text.includes('function_call_end')) continue;

      const calls = parseToolCalls(text);
      const alreadyProcessed = processedBlocks.get(block) || 0;

      if (calls.length > alreadyProcessed) {
        // 有新的调用（流式增量：只处理新增的部分）
        const newCalls = calls.slice(alreadyProcessed);
        processedBlocks.set(block, calls.length);
        for (const call of newCalls) {
          // 基于内容签名的去重（Gemini + ChatGPT）
          // Gemini 流式输出时会销毁并重建 <code> DOM 元素，导致 WeakMap 丢失引用；
          // ChatGPT 辅助扫描可能与代码块扫描重复检测同一个调用。
          // 通过 name+callId+params 生成唯一签名来避免重复检测。
          if (PLATFORM === 'gemini' || PLATFORM === 'chatgpt') {
            const sig = `${call.name}|${call.callId}|${JSON.stringify(call.params)}`;
            if (processedCallSignatures.has(sig)) continue;
            processedCallSignatures.add(sig);
          }
          registerToolCall(call, block);
        }
      }
    }

    // ChatGPT 辅助扫描：扫描助手消息容器元素
    // 当 ChatGPT 不使用标准 <pre><code> 渲染代码块时（如新版 DOM 结构），
    // 或当 LLM 将 JSON 输出为纯文本时，代码块扫描可能遗漏工具调用。
    // 此辅助扫描直接检查助手消息的完整文本内容。
    if (PLATFORM === 'chatgpt') {
      const messageEls = document.querySelectorAll(
        '[data-message-author-role="assistant"]'
      );
      // 仅扫描最近的几条消息，避免性能问题
      const recent = Array.from(messageEls).slice(-5);
      for (const el of recent) {
        const text = el.textContent || '';
        if (!text.includes('function_call_start') || !text.includes('function_call_end')) continue;

        // 如果该消息内的代码块已被主扫描检测到，跳过（避免重复）
        const childCodeBlocks = el.querySelectorAll('pre code, pre, code');
        let childAlreadyDetected = false;
        for (const cb of childCodeBlocks) {
          if (processedBlocks.has(cb) && processedBlocks.get(cb) > 0) {
            childAlreadyDetected = true;
            break;
          }
        }
        if (childAlreadyDetected) continue;

        const calls = parseToolCalls(text);
        const alreadyProcessed = processedBlocks.get(el) || 0;

        if (calls.length > alreadyProcessed) {
          const newCalls = calls.slice(alreadyProcessed);
          processedBlocks.set(el, calls.length);
          for (const call of newCalls) {
            // 签名去重（与代码块扫描共享同一个签名集合）
            const sig = `${call.name}|${call.callId}|${JSON.stringify(call.params)}`;
            if (processedCallSignatures.has(sig)) continue;
            processedCallSignatures.add(sig);
            registerToolCall(call, el);
          }
        }
      }
    }
  }

  function parseToolCalls(text) {
    const calls = [];
    const lines = text.split('\n');
    let current = null;

    // 策略 1: JSONL 格式（每行一个 JSON 对象）— 原始方式
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'function_call_start') {
          current = {
            name: obj.name,
            callId: obj.call_id,
            description: '',
            params: {},
          };
        } else if (obj.type === 'description' && current) {
          current.description = obj.text || '';
        } else if (obj.type === 'parameter' && current) {
          let val = obj.value;
          if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) { }
          }
          current.params[obj.key] = val;
        } else if (obj.type === 'function_call_end' && current) {
          calls.push(current);
          current = null;
        }
      } catch (_) {
        // 非 JSON，跳过
      }
    }

    // 策略 2: 多行 JSON 格式（ChatGPT 等 LLM 可能将 JSON 美化输出）
    // 如果策略 1 未找到任何调用，尝试提取多行 JSON 对象
    if (calls.length === 0 && text.includes('function_call_start')) {
      const jsonObjects = extractJsonObjects(text);
      current = null;
      for (const obj of jsonObjects) {
        if (obj.type === 'function_call_start') {
          current = {
            name: obj.name,
            callId: obj.call_id,
            description: '',
            params: {},
          };
        } else if (obj.type === 'description' && current) {
          current.description = obj.text || '';
        } else if (obj.type === 'parameter' && current) {
          let val = obj.value;
          if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) { }
          }
          current.params[obj.key] = val;
        } else if (obj.type === 'function_call_end' && current) {
          calls.push(current);
          current = null;
        }
      }
    }

    return calls;
  }

  // 从文本中提取所有 JSON 对象，支持多行美化格式
  // 使用状态机正确处理字符串内的花括号
  function extractJsonObjects(text) {
    const objects = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const jsonStr = text.substring(start, i + 1);
          try {
            const obj = JSON.parse(jsonStr);
            if (obj && typeof obj === 'object' && obj.type) {
              objects.push(obj);
            }
          } catch (_) { /* 忽略无效 JSON */ }
          start = -1;
        }
      }
    }

    return objects;
  }

  // ==================== 调用注册 + 行内状态标（低调版） ====================
  function registerToolCall(call, codeBlock) {
    const callKey = String(++callSeq);
    const entry = { call, chip: null, status: 'waiting' };
    callRegistry.set(callKey, entry);

    entry.chip = injectInlineChip(call, codeBlock, callKey);

    const willAutoRun = autoExecute && Date.now() > suppressAutoExecuteUntil;
    reportStatus('call_detected', {
      callKey,
      name: call.name,
      detail: truncate(JSON.stringify(call.params), 100),
      needsManualRun: !willAutoRun,
    });

    if (willAutoRun) {
      executeToolCall(callKey, true);
    }
  }

  /** 低调的行内状态标：⚙ 正在调用 xxx… → ✓ 已调用；不自动执行时显示执行按钮 */
  function injectInlineChip(call, codeBlock, callKey) {
    const chip = document.createElement('div');
    chip.className = 'mcp-chip';
    chip.innerHTML = `<span class="mcp-chip-icon"></span><span class="mcp-chip-text"></span>`;

    setChip(chip, 'waiting', `检测到工具调用 ${call.name}`);
    const willAutoRun = autoExecute && Date.now() > suppressAutoExecuteUntil;
    if (!willAutoRun) {
      appendChipButton(chip, '执行', callKey);
    }

    const pre = codeBlock.closest('pre') || codeBlock;
    pre.parentNode?.insertBefore(chip, pre.nextSibling);
    return chip;
  }

  function setChip(chip, state, text) {
    if (!chip) return;
    chip.classList.remove('waiting', 'running', 'done', 'error');
    chip.classList.add(state);
    const icons = { waiting: '·', running: '⚙', done: '✓', error: '✕' };
    const iconEl = chip.querySelector('.mcp-chip-icon');
    const textEl = chip.querySelector('.mcp-chip-text');
    if (iconEl) iconEl.textContent = icons[state] || '·';
    if (textEl) textEl.textContent = text;
  }

  function appendChipButton(chip, label, callKey) {
    chip.querySelector('.mcp-chip-btn')?.remove();
    const btn = document.createElement('button');
    btn.className = 'mcp-chip-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      btn.remove();
      executeToolCall(callKey, false);
    });
    chip.appendChild(btn);
  }

  // ==================== 工具执行（批量编排逻辑保持原样） ====================
  async function executeToolCall(callKey, isBatch = false) {
    const entry = callRegistry.get(callKey);
    if (!entry || entry.status === 'running') return;
    const { call, chip } = entry;

    entry.status = 'running';
    setChip(chip, 'running', `正在调用 ${call.name}…`);
    reportStatus('call_running', { callKey, name: call.name });

    if (isBatch) {
      pendingExecutions++;
      console.log(`[MCP][auto-send] executeToolCall START: ${call.name}#${call.callId}, pendingExecutions=${pendingExecutions}`);
      // 新的调用开始 → 取消已有的自动发送定时器和发送延迟定时器
      // 确保在所有调用完成前不会提前发送
      clearTimeout(autoSendTimer);
      autoSendTimer = null;
      clearTimeout(sendRetryTimer);
      sendRetryTimer = null;
    }

    try {
      const result = await sendWithRetry(
        { type: 'callTool', toolName: call.name, arguments: call.params },
        (attempt, max) => {
          setChip(chip, 'running', `重试中 (${attempt}/${max})：${call.name}`);
        }
      );

      entry.status = 'done';
      setChip(chip, 'done', `已调用 ${call.name}`);
      reportStatus('call_done', {
        callKey,
        name: call.name,
        detail: truncate(formatResult(result), 120),
      });

      if (isBatch) {
        collectedResults.push({ call, result, error: null });
      } else {
        // 手动执行：直接注入，并按设置自动发送
        await injectResult(call, result);
        if (autoSubmit) {
          clickSendButtonWithRetry();
        }
      }
    } catch (e) {
      entry.status = 'error';
      setChip(chip, 'error', `调用失败：${call.name}`);
      appendChipButton(chip, '重试', callKey);
      reportStatus('call_error', { callKey, name: call.name, detail: e.message });
      console.error('[MCP] 工具调用错误:', e);

      if (isBatch) {
        collectedResults.push({ call, result: null, error: e });
      }
    } finally {
      if (isBatch) {
        pendingExecutions--;
        console.log(`[MCP][auto-send] executeToolCall END: ${call.name}#${call.callId}, pendingExecutions=${pendingExecutions}, collectedResults=${collectedResults.length}`);
        onBatchExecutionComplete();
      }
    }
  }

  function onBatchExecutionComplete() {
    console.log(`[MCP][auto-send] onBatchExecutionComplete: pendingExecutions=${pendingExecutions}, collectedResults=${collectedResults.length}`);
    if (pendingExecutions > 0) return;

    // 所有批量执行完成，收集成功结果 → 累积到 accumulatedResults
    const successes = collectedResults.filter((r) => r.result !== null);
    const failures = collectedResults.filter((r) => r.error !== null);

    if (successes.length > 0) {
      accumulatedResults.push(...successes);
      console.log(`[MCP] 累积结果: +${successes.length}，总计 ${accumulatedResults.length} 个`);
    }

    if (failures.length > 0) {
      accumulatedResults.push(...failures);
      console.log(`[MCP] 累积错误: +${failures.length}，将错误报告发送给AI自我纠错`);
    }

    // 清空本轮收集的结果（已转移到 accumulatedResults）
    collectedResults = [];

    // 取消之前的定时器，重新开始计时
    // 这样如果后续还有新的工具调用完成，会再次重置定时器
    // 最终效果：最后一个 MCP 返回后 N 秒才发送
    clearTimeout(autoSendTimer);
    autoSendTimer = null;

    if (accumulatedResults.length > 0) {
      autoSendTimer = setTimeout(() => {
        autoSendTimer = null;
        // 安全检查：如果此时仍有调用在执行，不注入，等调用完成后重新计时
        if (pendingExecutions > 0) {
          console.log('[MCP] 定时器到期但仍有调用在执行，跳过注入，等待完成后重新计时');
          return;
        }
        console.log(`[MCP] ${autoSendDelay}s 定时器到期，统一注入 ${accumulatedResults.length} 个结果`);
        const resultsToInject = accumulatedResults.slice(); // 复制一份
        accumulatedResults = [];
        injectBatchResults(resultsToInject);
      }, autoSendDelay * 1000);
      console.log(`[MCP] 已启动/重置 ${autoSendDelay}s 自动发送定时器`);
    }
  }

  async function injectBatchResults(results) {
    console.log(`[MCP][auto-send] injectBatchResults: ${results.length} results, autoSubmit=${autoSubmit}`);
    // 区分成功和失败
    const hasErrors = results.some((r) => r.error !== null);
    const hasSuccesses = results.some((r) => r.result !== null);
    const toolNames = results.map((r) => r.call.name).join(', ');

    // 粘贴拦截关闭时，直接以纯文本注入，不创建 .md 文件
    if (!pasteIntercept) {
      console.log('[MCP] pasteIntercept=OFF, 批量结果以纯文本注入');
      const combinedBlocks = results.map(({ call, result, error }) => {
        const contentText = error
          ? `ERROR: ${error.message}\n\nParameters used:\n${JSON.stringify(call.params, null, 2)}\n\nPlease analyze the error, fix the parameters, and retry this tool call.`
          : formatResult(result);
        return [
          '```jsonl',
          JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
          JSON.stringify({ type: 'content', text: contentText }),
          JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
          '```',
        ].join('\n');
      }).join('\n\n');

      if (hasErrors) {
        setInputValue(`[工具结果] ${toolNames} 调用出错，请分析错误、修正参数后重试：\n\n${combinedBlocks}`);
      } else {
        setInputValue(`[工具结果] ${toolNames} 已执行完毕，结果如下，请继续：\n\n${combinedBlocks}`);
      }

      reportStatus('results_injected', { detail: toolNames });
      if (autoSubmit) {
        console.log('[MCP][auto-send] autoSubmit=true, calling clickSendButtonWithRetry()');
        clickSendButtonWithRetry();
      }
      return;
    }

    // 构建合并的 .md 内容（同时支持成功结果和错误报告）
    const blocks = results.map(({ call, result, error }) => {
      if (error) {
        // 错误结果：包含错误信息和使用的参数，让 AI 可以分析并纠错
        const paramsText = JSON.stringify(call.params, null, 2);
        const errorContent = `ERROR: ${error.message}\n\nParameters used:\n${paramsText}\n\nPlease analyze the error, fix the parameters, and retry this tool call.`;
        return [
          `## Tool Error: ${call.name} (call_id: ${call.callId})`,
          '',
          '```jsonl',
          JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
          JSON.stringify({ type: 'content', text: errorContent }),
          JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
          '```',
        ].join('\n');
      } else {
        // 成功结果
        const resultText = formatResult(result);
        return [
          `## Tool: ${call.name} (call_id: ${call.callId})`,
          '',
          '```jsonl',
          JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
          JSON.stringify({ type: 'content', text: resultText }),
          JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
          '```',
        ].join('\n');
      }
    });

    const mdTitle = hasErrors ? '# MCP Tool Results (with errors)' : '# MCP Tool Results';
    const fullMdContent = `${mdTitle}\n\n${blocks.join('\n\n')}`;
    // Gemini 仅接受 text/plain，其他平台用 text/markdown
    const fileMimeType = PLATFORM === 'gemini' ? 'text/plain' : 'text/markdown';
    const file = new File([fullMdContent], `mcp-results-batch.md`, {
      type: fileMimeType,
      lastModified: Date.now(),
    });

    let attached = false;

    // Gemini 专用路径：直接走 dragDropListener.js postMessage 机制（Gemini 不支持 fileInput）
    if (!attached && PLATFORM === 'gemini') {
      try {
        attached = await geminiDropFile(file);
        if (attached) console.log('[MCP] 批量结果通过拖放注入成功');
      } catch (e) {
        console.warn('[MCP] 批量结果拖放注入失败:', e);
      }
    }

    // 策略 1: 文件输入框（非 Gemini 平台）
    if (!attached && PLATFORM !== 'gemini') {
      const fileInput = await findFileInputWithRetry();
      if (fileInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 批量结果文件输入注入失败:', e);
        }
      }
    }

    // 策略 2: 通用拖放（非 Gemini 平台的后备方案）
    if (!attached) {
      const dropZone = getDropZone();
      if (dropZone) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 批量结果拖放注入失败:', e);
        }
      }
    }

    // 策略 3: 粘贴事件
    if (!attached) {
      const inputEl = getInputElement();
      if (inputEl) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          inputEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 批量结果粘贴注入失败:', e);
        }
      }
    }

    if (attached) {
      if (hasErrors && hasSuccesses) {
        setInputValue(`[工具结果] ${toolNames} 的结果见附件，其中部分调用出错；请阅读附件，分析错误、修正参数后重试失败的调用。`);
      } else if (hasErrors) {
        setInputValue(`[工具结果] ${toolNames} 调用出错，详情见附件；请阅读附件，分析错误、修正参数后重试。`);
      } else {
        setInputValue(`[工具结果] ${toolNames} 的结果见附件，请阅读后继续。`);
      }
    } else {
      // 回退：合并文本直接粘贴
      const combinedBlocks = results.map(({ call, result, error }) => {
        const contentText = error
          ? `ERROR: ${error.message}\n\nParameters used:\n${JSON.stringify(call.params, null, 2)}\n\nPlease analyze the error, fix the parameters, and retry this tool call.`
          : formatResult(result);
        return [
          '```jsonl',
          JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
          JSON.stringify({ type: 'content', text: contentText }),
          JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
          '```',
        ].join('\n');
      }).join('\n\n');

      if (hasErrors) {
        setInputValue(`[工具结果] ${toolNames} 调用出错，请分析错误、修正参数后重试：\n\n${combinedBlocks}`);
      } else {
        setInputValue(`[工具结果] ${toolNames} 已执行完毕，结果如下，请继续：\n\n${combinedBlocks}`);
      }
    }

    reportStatus('results_injected', { detail: toolNames });
    if (autoSubmit) {
      console.log('[MCP][auto-send] autoSubmit=true, calling clickSendButtonWithRetry()');
      clickSendButtonWithRetry();
    } else {
      console.log('[MCP][auto-send] autoSubmit=false, skipping auto-send');
    }
  }

  // ==================== 结果格式化与注入 ====================
  function formatResult(result) {
    if (!result) return 'null';
    if (result.content && Array.isArray(result.content)) {
      return result.content.map((c) => c.text || JSON.stringify(c)).join('\n');
    }
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  function createResultFile(call, resultMdContent) {
    // Gemini 仅接受 text/plain，其他平台用 text/markdown
    const fileMimeType = PLATFORM === 'gemini' ? 'text/plain' : 'text/markdown';
    return new File([resultMdContent], `mcp-result-${call.name}-${call.callId}.md`, {
      type: fileMimeType,
      lastModified: Date.now(),
    });
  }

  async function injectResult(call, result) {
    const resultText = formatResult(result);

    const block = [
      '```jsonl',
      JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
      JSON.stringify({ type: 'content', text: resultText }),
      JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
      '```',
    ].join('\n');

    // 粘贴拦截关闭时，直接以纯文本注入，不创建 .md 文件
    if (!pasteIntercept) {
      console.log('[MCP] pasteIntercept=OFF, 直接以纯文本注入结果');
      const fullText = `[工具结果] ${call.name} 已执行完毕，结果如下，请继续：\n\n${block}`;
      setInputValue(fullText);
      reportStatus('results_injected', { detail: call.name });
      return;
    }

    const fullMdContent = `# MCP Tool Result: ${call.name}\n\n${block}`;
    const file = createResultFile(call, fullMdContent);

    let attached = false;

    // Gemini 专用路径：直接走 dragDropListener.js postMessage 机制（Gemini 不支持 fileInput）
    if (!attached && PLATFORM === 'gemini') {
      try {
        attached = await geminiDropFile(file);
        if (attached) console.log('[MCP] 结果通过拖放注入成功');
      } catch (e) {
        console.warn('[MCP] 结果拖放注入失败:', e);
      }
    }

    // 策略 1: 通过文件输入框注入（非 Gemini 平台）
    if (!attached && PLATFORM !== 'gemini') {
      const fileInput = await findFileInputWithRetry();
      if (fileInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 结果文件输入注入失败:', e);
        }
      }
    }

    // 策略 2: 通用拖放（非 Gemini 平台的后备方案）
    if (!attached) {
      const dropZone = getDropZone();
      if (dropZone) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 结果拖放注入失败:', e);
        }
      }
    }

    // 策略 3: 通过粘贴事件注入
    if (!attached) {
      const inputEl = getInputElement();
      if (inputEl) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          inputEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 结果粘贴注入失败:', e);
        }
      }
    }

    if (attached) {
      // 在输入框留一条简短提示（中文、低调，AI 可读）
      setInputValue(`[工具结果] ${call.name} 的结果见附件，请阅读后继续。`);
    } else {
      // 回退：直接粘贴完整结果
      const fullText = `[工具结果] ${call.name} 已执行完毕，结果如下，请继续：\n\n${block}`;
      setInputValue(fullText);
    }
    reportStatus('results_injected', { detail: call.name });
    // 注意: autoSubmit 逻辑由调用方（injectBatchResults / 手动执行路径）处理
  }

  // ==================== 通用文件附加（工具定义 .md / Skills，供 sidePanel 指令使用） ====================
  async function attachFile(file) {
    // Gemini 专用路径：直接走 dragDropListener.js postMessage 机制（Gemini 不支持 fileInput）
    if (PLATFORM === 'gemini') {
      try {
        const success = await geminiDropFile(file);
        if (success) return true;
      } catch (e) {
        console.warn('[MCP] 文件拖放注入失败:', e);
      }
    }

    // 策略 1: 文件输入框（非 Gemini 平台）
    if (PLATFORM !== 'gemini') {
      const fileInput = await findFileInputWithRetry();
      if (fileInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        } catch (e) {
          console.warn('[MCP] 文件输入注入失败:', e);
        }
      }
    }

    // 策略 2: 通用拖放
    const dropZone = getDropZone();
    if (dropZone) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return true;
      } catch (e) {
        console.warn('[MCP] 拖放注入失败:', e);
      }
    }

    // 策略 3: 粘贴事件
    const inputEl = getInputElement();
    if (inputEl) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        inputEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        return true;
      } catch (e) {
        console.warn('[MCP] 粘贴注入失败:', e);
      }
    }

    return false;
  }

  function makeMdFile(fileName, content) {
    // Gemini 仅接受 text/plain，其他平台用 text/markdown
    const fileMimeType = PLATFORM === 'gemini' ? 'text/plain' : 'text/markdown';
    return new File([content], fileName, { type: fileMimeType, lastModified: Date.now() });
  }

  // ==================== 平台文件输入 / 拖放区域辅助 ====================

  // Gemini-specific: click the upload button to trigger file input creation, then find it
  async function findFileInputWithRetry(maxWait = 3000) {
    // Try existing file input first
    let input = findFileInput();
    if (input) return input;

    // For Gemini, try clicking the upload/attachment button to create the file input
    if (PLATFORM === 'gemini') {
      const uploadBtn = document.querySelector('button[aria-label*="upload" i]') ||
        document.querySelector('button[aria-label*="attach" i]') ||
        document.querySelector('button[aria-label*="file" i]') ||
        document.querySelector('button[data-tooltip*="upload" i]') ||
        document.querySelector('button[data-tooltip*="attach" i]') ||
        document.querySelector('[class*="upload" i] button') ||
        document.querySelector('[class*="attach" i] button');
      if (uploadBtn) {
        uploadBtn.click();
        // Wait for the file input to appear in DOM
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 200));
          input = document.querySelector('input[type="file"]');
          if (input) return input;
        }
      }
    }

    // For ChatGPT, try clicking the upload/attachment button to create the file input
    if (PLATFORM === 'chatgpt') {
      const uploadBtn = document.querySelector('button[data-testid="composer-action-file-upload"]') ||
        document.querySelector('#upload-file-btn') ||
        document.querySelector('button[aria-label*="Attach" i]') ||
        document.querySelector('button[aria-label*="Add photos" i]') ||
        document.querySelector('button[aria-label*="upload" i]') ||
        document.querySelector('button[aria-label*="file" i]');
      if (uploadBtn) {
        uploadBtn.click();
        // Wait for the file input to appear in DOM
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 200));
          input = document.querySelector('input[type="file"][multiple]') ||
            document.querySelector('input[type="file"]');
          if (input) return input;
        }
      }
    }

    return null;
  }

  function findFileInput() {
    switch (PLATFORM) {
      case 'chatgpt':
        return document.querySelector('input[type="file"][multiple]') ||
          document.querySelector('input[type="file"][accept*="*"]') ||
          document.querySelector('input[type="file"]');
      case 'gemini':
        return document.querySelector('input[type="file"]');
      case 'deepseek':
        return document.querySelector('input[type="file"]');
      case 'grok':
        return document.querySelector('input[type="file"]');
      case 'perplexity':
        return document.querySelector('input[type="file"]');
      case 'aistudio':
        return document.querySelector('input[type="file"]');
      case 'mistral':
        return document.querySelector('input[type="file"]');
      case 'kimi':
        return document.querySelector('input[type="file"]');
      case 'qwen':
        return document.querySelector('input[type="file"]');
      case 'chatglm':
        return document.querySelector('input[type="file"]');
      case 't3':
        return document.querySelector('input[type="file"]');
      case 'copilot':
        return document.querySelector('input[type="file"]');
      case 'doubao':
        return document.querySelector('input[type="file"]');
      default:
        return document.querySelector('input[type="file"]');
    }
  }

  function getDropZone() {
    switch (PLATFORM) {
      case 'chatgpt':
        return document.querySelector('#prompt-textarea') ||
          document.querySelector('.ProseMirror') ||
          document.querySelector('[data-testid="composer-text-input"]') ||
          document.querySelector('.composer-parent') ||
          document.querySelector('div[contenteditable="true"]')?.closest('form') ||
          document.querySelector('main');
      case 'gemini':
        return document.querySelector('div[xapfileselectordropzone]') ||
          document.querySelector('.text-input-field') ||
          document.querySelector('.input-area') ||
          document.querySelector('.ql-editor') ||
          document.querySelector('.input-area-container') ||
          document.querySelector('div[contenteditable="true"]')?.parentElement;
      case 'deepseek':
        return document.querySelector('textarea#chat-input')?.closest('div[class*="input"]') ||
          document.querySelector('textarea')?.parentElement;
      case 'grok':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'perplexity':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'aistudio':
        return document.querySelector('textarea')?.closest('div') ||
          document.querySelector('textarea')?.parentElement;
      case 'mistral':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'kimi':
        return document.querySelector('div[contenteditable="true"]')?.parentElement;
      case 'qwen':
        return document.querySelector('textarea#chat-input')?.closest('form') ||
          document.querySelector('textarea#chat-input')?.parentElement ||
          document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'chatglm':
        return document.querySelector('div[contenteditable="true"]')?.parentElement ||
          document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 't3':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'copilot':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'doubao':
        return document.querySelector('div[contenteditable="true"]')?.parentElement ||
          document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      default:
        return document.querySelector('textarea')?.parentElement ||
          document.querySelector('div[contenteditable="true"]')?.parentElement;
    }
  }

  // ==================== 平台适配器 ====================
  function getInputElement() {
    switch (PLATFORM) {
      case 'chatgpt':
        return document.querySelector('#prompt-textarea') ||
          document.querySelector('.ProseMirror[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][data-id*="prompt"]') ||
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
      case 'deepseek':
        return document.querySelector('textarea#chat-input') ||
          document.querySelector('textarea');
      case 'gemini':
        return document.querySelector('div.ql-editor.textarea p') ||
          document.querySelector('div.ql-editor.textarea') ||
          document.querySelector('.ql-editor p') ||
          document.querySelector('.ql-editor') ||
          document.querySelector('div[contenteditable="true"]');
      case 'grok':
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'perplexity':
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'aistudio':
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'mistral':
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'kimi':
        return document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
      case 'qwen':
        return document.querySelector('textarea#chat-input') ||
          document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'chatglm':
        return document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
      case 'doubao':
        return document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
      default:
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
    }
  }

  function setInputValue(text) {
    const el = getInputElement();
    if (!el) {
      console.warn('[MCP] 找不到输入框元素');
      navigator.clipboard?.writeText(text).then(() => {
        console.warn('[MCP] 结果已复制到剪贴板（未找到输入框）');
      });
      return;
    }

    el.focus();

    if (PLATFORM === 'chatgpt') {
      // ChatGPT ProseMirror 专用：需要创建 <p> 元素结构
      const placeholder = el.querySelector('[data-placeholder]');
      if (placeholder) placeholder.remove();
      el.innerHTML = '';
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      el.appendChild(paragraph);
      // 将光标移到末尾
      const range = document.createRange();
      const selection = window.getSelection();
      if (selection && paragraph.firstChild) {
        range.setStartAfter(paragraph.lastChild || paragraph);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    } else if (PLATFORM === 'gemini') {
      // Gemini Quill 编辑器专用：直接设置 textContent
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // 标准 textarea/input（DeepSeek 等）
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (setter) {
        setter.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // 其他 contenteditable 平台（execCommand 方式）
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  // delaySec: 发送前延迟（默认等平台解析文件）；doneEvent: 发送完成后广播的事件名
  function clickSendButtonWithRetry(delaySec = fileParsDelay, doneEvent = 'auto_sent') {
    // 取消之前的发送定时器（防止重复发送）
    clearTimeout(sendRetryTimer);
    console.log(`[MCP][auto-send] clickSendButtonWithRetry: scheduling ${delaySec}s delay send (等待平台解析文件)`);
    // 等待平台解析上传的文件（大模型解析文件一般需要数秒，用户可在设置中调整）
    sendRetryTimer = setTimeout(() => {
      sendRetryTimer = null;
      // 最终安全检查：如果此时有新的调用正在执行，中止发送
      if (pendingExecutions > 0) {
        console.log('[MCP][auto-send] 发送前检测到有调用正在执行，中止自动发送, pendingExecutions=' + pendingExecutions);
        return;
      }

      let sent = false;

      // 策略 1：尝试点击平台的发送按钮（最可靠）
      const sendBtn = findSendButton();
      if (sendBtn) {
        console.log('[MCP][auto-send] 找到发送按钮，点击发送');
        sendBtn.click();
        sent = true;
      }

      // 策略 2：模拟 Enter 键
      if (!sent) {
        const input = getInputElement();
        console.log('[MCP][auto-send] Sending via Enter key, input found:', !!input, 'platform:', PLATFORM);
        if (input) {
          input.focus();
          const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
          input.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
          input.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
          input.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
        }
        // 策略 3：尝试表单提交
        const form = input?.closest('form');
        if (form) {
          try { form.requestSubmit(); } catch (e) { /* ignore */ }
        }
      }

      console.log('[MCP][auto-send] 自动发送完成');
      reportStatus(doneEvent);
    }, delaySec * 1000);
  }

  function findSendButton() {
    switch (PLATFORM) {
      case 'chatgpt':
        return document.querySelector('[data-testid="send-button"]')
          || document.querySelector('button[data-testid="fruitjuice-send-button"]')
          || document.querySelector('button[aria-label*="Send"]')
          || document.querySelector('form button[class*="send" i]');
      case 'claude':
        return document.querySelector('button[aria-label="Send Message"]')
          || document.querySelector('div.flex button:last-child');
      case 'gemini':
        return document.querySelector('button.mat-mdc-icon-button.send-button')
          || document.querySelector('button.send-button')
          || document.querySelector('button[aria-label*="Send"]')
          || document.querySelector('button[data-testid="send-button"]')
          || document.querySelector('mat-icon[data-mat-icon-name="send"]')?.closest('button');
      case 'deepseek':
        return document.querySelector('div[class*="chat-input"] button:not([disabled])')
          || document.querySelector('textarea + button')
          || document.querySelector('div[role="presentation"] button[class*="send" i]');
      case 'qianwen':
        return document.querySelector('button[class*="send" i]')
          || document.querySelector('div[class*="chat-input"] button');
      case 'doubao':
        return document.querySelector('div[class*="send-btn"]')
          || document.querySelector('button[class*="send" i]')
          || document.querySelector('div[class*="chat-input"] button');
      case 'kimi':
        return document.querySelector('button[class*="send" i]')
          || document.querySelector('div[class*="editor"] ~ button');
      case 'zhipu':
        return document.querySelector('button[class*="send" i]');
      case 'yuanbao':
        return document.querySelector('button[class*="send" i]')
          || document.querySelector('div[class*="input"] button');
      default: {
        // 通用回退：查找输入框附近的按钮
        const candidates = document.querySelectorAll('button');
        for (const btn of candidates) {
          const text = (btn.textContent || '').trim().toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (text === '发送' || text === 'send' || ariaLabel.includes('send') || ariaLabel.includes('发送')) {
            return btn;
          }
        }
        // 查找 SVG 发送图标按钮（很多平台用 SVG 箭头图标）
        const svgBtns = document.querySelectorAll('button svg');
        for (const svg of svgBtns) {
          const btn = svg.closest('button');
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            // 检查是否在输入区域附近
            const form = btn.closest('form');
            if (form) return btn;
          }
        }
        return null;
      }
    }
  }

  // ==================== 工具函数 ====================
  function truncate(s, max) {
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  // ==================== 粘贴拦截：MCP 结果文本 → 文件附件 ====================
  function isMCPResultContent(text) {
    // 判定条件：同时包含 jsonl 代码块标记和 MCP 结果标记
    return text.includes('```jsonl') && text.includes('function_result_start');
  }

  async function handleMCPPaste(e) {
    // 开关未启用 → 放行
    if (!pasteIntercept) return;

    // 仅在支持的 AI 平台上拦截
    if (!PLATFORM || PLATFORM === 'unknown') return;

    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    // 非 MCP 结果内容 → 放行正常粘贴
    if (!isMCPResultContent(text)) return;

    // 拦截粘贴
    e.preventDefault();
    e.stopImmediatePropagation();

    console.log('[MCP] 检测到 MCP 结果粘贴，转换为文件附件');

    const file = makeMdFile(`mcp-result-paste-${Date.now()}.md`, text);
    const ok = await attachFile(file);
    if (!ok) {
      // 回退：直接粘贴为文本
      const inputEl = getInputElement();
      if (inputEl) {
        setInputValue(text);
        console.warn('[MCP] 文件注入失败，已回退为文字粘贴');
      }
    }
  }

  // ==================== sidePanel 指令处理 ====================
  const CAPS = ['attach', 'compose']; // 能力声明：attach = 附加文件；compose = 一步式编排

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    const handlers = {
      // 健康检查：sidePanel 用它判断 content script 是否就绪
      ping: async () => ({ platform: PLATFORM, caps: CAPS }),

      // 附加文件（+ 可选输入文本 + 可选发送）——工具定义 .md / Skills 注入的通用原语
      attachFileAndText: async ({ fileName, fileContent, text, send: doSend }) => {
        const file = makeMdFile(fileName || 'attachment.md', fileContent || '');
        const attached = await attachFile(file);
        if (!attached) throw new Error('无法附加文件（未找到文件输入/拖放区域）');
        reportStatus('compose_attached', { detail: fileName });
        if (text) setInputValue(text);
        if (doSend) clickSendButtonWithRetry();
        return { attached: true };
      },

      // 一步式编排：「(按需)附加工具定义 + 注入提问 + 发送」，用户感知只有一步
      composeAndSend: async ({ question, toolsMd }) => {
        if (!question) throw new Error('提问内容为空');
        const convKey = getConversationKey();
        const needTools = !!toolsMd && !isConvInjected(convKey);

        if (needTools) {
          const file = makeMdFile('mcp-tools.md', toolsMd);
          const ok = await attachFile(file);
          if (!ok) throw new Error('无法附加工具定义文件（未找到文件输入/拖放区域）');
          markConvInjected(convKey);
          // 开迁移窗口：新对话发送后 URL 会从根路径定型为 /c/<id>
          pendingConvMigration = Date.now();
          pendingConvMigrationFrom = convKey;
          reportStatus('compose_attached', { detail: 'mcp-tools.md' });
        }

        setInputValue(question);
        // 带附件时等平台解析（fileParsDelay）；纯文本提问只留 0.5s 让输入事件落定
        clickSendButtonWithRetry(needTools ? fileParsDelay : 0.5, 'question_sent');
        return { injectedTools: needTools };
      },

      // sidePanel 时间线上的「执行/重试」按钮
      executeCall: async ({ callKey }) => {
        if (!callRegistry.has(callKey)) throw new Error('调用不存在（可能已切换会话）');
        executeToolCall(callKey, false);
        return { started: true };
      },
    };

    const handler = handlers[msg.type];
    if (!handler) return; // 广播类消息（serverStatus 等）不占用响应通道

    handler(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // 异步响应
  });

  // ==================== 初始化 ====================
  function init() {
    console.log(`[MCP Multi Bridge] 已加载，平台: ${PLATFORM}`);
    loadSettings();
    startDetection();

    // 注册粘贴拦截（capturing 阶段，优先于页面自身处理）
    document.addEventListener('paste', handleMCPPaste, true);

    // 初始加载时也设置抑制窗口，防止页面刷新时自动执行历史工具调用
    suppressAutoExecuteUntil = Date.now() + 3000;

    // Gemini: 预注入拖放监听器到页面主世界（用于文件上传）
    injectGeminiDragDropListener();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
