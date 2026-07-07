// background.js — MCP Multi Bridge Service Worker
// Manages multiple MCP server connections via SSE and Streamable HTTP transports.

'use strict';

// ===================== State =====================
let nextRequestId = 1;

// ===================== Chrome Storage =====================
async function loadServerConfigs() {
  const result = await chrome.storage.local.get('mcpServers');
  return result.mcpServers || [];
}

async function saveServerConfigs(servers) {
  await chrome.storage.local.set({ mcpServers: servers });
}

// ===================== SSE Stream Parser =====================
class SSEParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.eventType = '';
    this.data = '';
  }

  feed(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // keep the incomplete trailing line
    for (const line of lines) {
      if (line.startsWith('event:')) {
        this.eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        this.data += (this.data ? '\n' : '') + line.slice(5).trim();
      } else if (line.trim() === '') {
        if (this.data) {
          this.onEvent({ type: this.eventType || 'message', data: this.data });
        }
        this.eventType = '';
        this.data = '';
      }
    }
  }
}

// ===================== MCP Connection =====================
class MCPConnection {
  constructor(config) {
    this.config = config;
    this.messageEndpoint = null;
    this.sessionId = null;
    this.tools = [];
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.abortController = null;
    this.nativePort = null; // for stdio transport
    this.connected = false;
  }

  // ---- Connect ----
  async connect() {
    if (this.config.transport === 'streamable-http') {
      await this.connectStreamableHTTP();
    } else if (this.config.transport === 'stdio') {
      await this.connectStdio();
    } else {
      await this.connectSSE();
    }
  }

  async connectSSE() {
    this.abortController = new AbortController();
    const url = this.config.url; // e.g. http://localhost:3006/sse

    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: this.abortController.signal,
    });
    if (!response.ok) throw new Error(`SSE connection failed: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser((evt) => this.handleSSEEvent(evt));

    this.connected = true;

    // Background read‐loop (non‐blocking)
    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        if (e.name !== 'AbortError') console.error('[MCP] SSE read error:', e);
      }
      this.connected = false;
    };
    readLoop();

    // Wait up to 10 s for the server to send the "endpoint" event
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for SSE endpoint event')), 10000);
      const iv = setInterval(() => {
        if (this.messageEndpoint) {
          clearTimeout(timeout);
          clearInterval(iv);
          resolve();
        }
      }, 100);
    });

    await this.initialize();
    await this.refreshTools();
  }

  async connectStreamableHTTP() {
    this.messageEndpoint = this.config.url; // e.g. http://localhost:3006/mcp
    this.connected = true;
    try {
      await this.initialize();
      await this.refreshTools();
    } catch (e) {
      this.connected = false;
      throw e;
    }
  }

  async connectStdio() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for native host to spawn process'));
      }, 30000);

      try {
        this.nativePort = chrome.runtime.connectNative('com.mcp.bridge');
      } catch (e) {
        clearTimeout(timeout);
        reject(new Error('Failed to connect native host: ' + e.message));
        return;
      }

      this.nativePort.onMessage.addListener((msg) => {
        if (msg.type === 'spawned') {
          clearTimeout(timeout);
          this.connected = true;
          // After spawn confirmed, initialize MCP
          this.initialize()
            .then(() => this.refreshTools())
            .then(() => resolve())
            .catch((e) => {
              this.connected = false;
              reject(e);
            });
        } else if (msg.type === 'stdout') {
          // Parse JSON-RPC message from child process stdout
          try {
            const rpcMsg = JSON.parse(msg.data);
            this.handleResponse(rpcMsg);
          } catch (_) {
            // Not valid JSON-RPC, ignore (e.g. startup logs)
          }
        } else if (msg.type === 'error') {
          console.error('[MCP] Native host error:', msg.error);
          // If we haven't connected yet, reject
          if (!this.connected) {
            clearTimeout(timeout);
            reject(new Error(msg.error));
          }
        } else if (msg.type === 'closed') {
          console.log('[MCP] Child process closed with code:', msg.code);
          this.connected = false;
        }
      });

      this.nativePort.onDisconnect.addListener(() => {
        this.connected = false;
        const err = chrome.runtime.lastError;
        if (err) {
          console.error('[MCP] Native port disconnected:', err.message);
          if (!this.connected) {
            clearTimeout(timeout);
            reject(new Error('Native host disconnected: ' + err.message));
          }
        }
      });

      // Send spawn command
      const args = this.config.args
        ? (typeof this.config.args === 'string' ? this.config.args.split(/\s+/) : this.config.args)
        : [];
      this.nativePort.postMessage({
        action: 'spawn',
        command: this.config.command || 'npx',
        args: args,
      });
    });
  }

  // ---- SSE event handler ----
  handleSSEEvent(event) {
    if (event.type === 'endpoint') {
      const base = new URL(this.config.url);
      this.messageEndpoint = new URL(event.data, base.origin).href;
    } else if (event.type === 'message') {
      try {
        const msg = JSON.parse(event.data);
        this.handleResponse(msg);
      } catch (e) {
        console.error('[MCP] Failed to parse SSE message:', e);
      }
    }
  }

  handleResponse(msg) {
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this.pendingRequests.get(msg.id);
      clearTimeout(timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  // ---- JSON‐RPC request ----
  async sendRequest(method, params = {}) {
    const id = nextRequestId++;
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });

    if (this.config.transport === 'stdio') {
      return this._sendStdio(id, body);
    } else if (this.config.transport === 'sse') {
      return this._sendSSE(id, body);
    } else {
      return this._sendStreamableHTTP(id, body);
    }
  }

  _sendStdio(id, body) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout (30 s)'));
      }, 30000);
      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.nativePort.postMessage({ action: 'send', data: body });
      } catch (e) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error('Failed to send via native port: ' + e.message));
      }
    });
  }

  _sendSSE(id, body) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout (30 s)'));
      }, 30000);
      this.pendingRequests.set(id, { resolve, reject, timer });

      fetch(this.messageEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then((resp) => {
        if (!resp.ok) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`POST failed: ${resp.status}`));
        }
        // Response comes back on the SSE stream → handled by handleResponse
      }).catch((e) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(e);
      });
    });
  }

  async _sendStreamableHTTP(id, body) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const resp = await fetch(this.messageEndpoint, { method: 'POST', headers, body });
    if (!resp.ok) throw new Error(`Request failed: ${resp.status}`);

    const sid = resp.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    const ct = resp.headers.get('Content-Type') || '';
    if (ct.includes('text/event-stream')) {
      return this._readStreamableSSE(resp, id);
    }
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  }

  _readStreamableSSE(resp, expectedId) {
    return new Promise(async (resolve, reject) => {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SSEParser((event) => {
        if (event.type === 'message') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.id === expectedId) {
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          } catch (e) { reject(e); }
        }
      });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (e) { reject(e); }
    });
  }

  // ---- MCP lifecycle ----
  async initialize() {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'MCP-Multi-Bridge', version: '1.0.0' },
    });

    // Send notifications/initialized — must use the correct transport
    const notifBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    if (this.config.transport === 'stdio') {
      // Send via native messaging port
      this.nativePort.postMessage({ action: 'send', data: notifBody });
    } else {
      // Send via HTTP (SSE / Streamable HTTP)
      const headers = { 'Content-Type': 'application/json' };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      await fetch(this.messageEndpoint, {
        method: 'POST',
        headers,
        body: notifBody,
      });
    }

    return result;
  }

  async refreshTools() {
    const result = await this.sendRequest('tools/list', {});
    this.tools = result.tools || [];
    return this.tools;
  }

  async callTool(name, args) {
    return await this.sendRequest('tools/call', { name, arguments: args });
  }

  disconnect() {
    if (this.abortController) this.abortController.abort();
    if (this.nativePort) {
      try { this.nativePort.postMessage({ action: 'kill' }); } catch (_) { }
      try { this.nativePort.disconnect(); } catch (_) { }
      this.nativePort = null;
    }
    for (const { timer } of this.pendingRequests.values()) clearTimeout(timer);
    this.pendingRequests.clear();
    this.connected = false;
    this.tools = [];
    this.messageEndpoint = null;
    this.sessionId = null;
  }
}

// ===================== Server Manager =====================
class ServerManager {
  constructor() {
    /** @type {Map<string, MCPConnection>} */
    this.connections = new Map();
  }

  async init() {
    const configs = await loadServerConfigs();
    for (const cfg of configs) {
      if (cfg.enabled) {
        this.connectServer(cfg).catch((e) =>
          console.warn(`[MCP] Auto‐connect ${cfg.name} failed:`, e.message),
        );
      }
    }
  }

  async connectServer(config) {
    this.disconnectServer(config.id);
    const conn = new MCPConnection(config);
    this.connections.set(config.id, conn);
    broadcast('serverStatus', { serverId: config.id, status: 'connecting' });

    try {
      await conn.connect();
      broadcast('serverStatus', {
        serverId: config.id,
        status: 'connected',
        tools: conn.tools,
      });
    } catch (e) {
      broadcast('serverStatus', {
        serverId: config.id,
        status: 'error',
        error: e.message,
      });
      this.connections.delete(config.id);
      throw e;
    }
  }

  disconnectServer(id) {
    const conn = this.connections.get(id);
    if (conn) {
      conn.disconnect();
      this.connections.delete(id);
      broadcast('serverStatus', { serverId: id, status: 'disconnected' });
    }
  }

  /** Return aggregated tool list from all connected servers */
  getAllTools() {
    const tools = [];
    for (const [id, conn] of this.connections) {
      if (!conn.connected) continue;
      for (const t of conn.tools) {
        tools.push({ ...t, serverId: id, serverName: conn.config.name });
      }
    }
    return tools;
  }

  /** Find the connection that owns a given tool name */
  findConnectionForTool(toolName) {
    for (const [id, conn] of this.connections) {
      if (conn.connected && conn.tools.some((t) => t.name === toolName)) {
        return conn;
      }
    }
    return null;
  }

  getStatuses() {
    const out = {};
    for (const [id, conn] of this.connections) {
      out[id] = { connected: conn.connected, toolCount: conn.tools.length };
    }
    return out;
  }
}

const manager = new ServerManager();

// ===================== Broadcast helper =====================
function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => { });
}

// ===================== Message handler =====================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // keep the channel open for async
});

async function handleMessage(msg) {
  switch (msg.type) {
    // ---- Server CRUD ----
    case 'getServers': {
      const configs = await loadServerConfigs();
      const statuses = manager.getStatuses();
      return configs.map((c) => ({
        ...c,
        status: statuses[c.id]?.connected ? 'connected' : 'disconnected',
        toolCount: statuses[c.id]?.toolCount || 0,
      }));
    }

    case 'addServer': {
      const configs = await loadServerConfigs();
      const srv = {
        id: crypto.randomUUID(),
        name: msg.name,
        url: msg.url || '',
        transport: msg.transport || 'sse',
        enabled: true,
      };
      // stdio-specific fields
      if (msg.transport === 'stdio') {
        srv.command = msg.command || 'npx';
        srv.args = msg.args || '';
      }
      configs.push(srv);
      await saveServerConfigs(configs);
      // auto‐connect
      try { await manager.connectServer(srv); } catch (_) { }
      return srv;
    }

    case 'removeServer': {
      manager.disconnectServer(msg.serverId);
      const configs = await loadServerConfigs();
      await saveServerConfigs(configs.filter((c) => c.id !== msg.serverId));
      return { success: true };
    }

    case 'updateServer': {
      const configs = await loadServerConfigs();
      const idx = configs.findIndex((c) => c.id === msg.server.id);
      if (idx < 0) throw new Error('Server not found');
      configs[idx] = { ...configs[idx], ...msg.server };
      await saveServerConfigs(configs);
      manager.disconnectServer(msg.server.id);
      if (configs[idx].enabled) {
        try { await manager.connectServer(configs[idx]); } catch (_) { }
      }
      return { success: true };
    }

    case 'toggleServer': {
      const configs = await loadServerConfigs();
      const cfg = configs.find((c) => c.id === msg.serverId);
      if (!cfg) throw new Error('Server not found');
      cfg.enabled = msg.enabled;
      await saveServerConfigs(configs);
      if (cfg.enabled) {
        try { await manager.connectServer(cfg); } catch (_) { }
      } else {
        manager.disconnectServer(cfg.id);
      }
      return { success: true };
    }

    case 'connectServer': {
      const configs = await loadServerConfigs();
      const cfg = configs.find((c) => c.id === msg.serverId);
      if (!cfg) throw new Error('Server not found');
      await manager.connectServer(cfg);
      return { success: true };
    }

    case 'disconnectServer': {
      manager.disconnectServer(msg.serverId);
      return { success: true };
    }

    // ---- Tools ----
    case 'getTools': {
      return manager.getAllTools();
    }

    case 'callTool': {
      const conn = manager.findConnectionForTool(msg.toolName);
      if (!conn) throw new Error(`No connected server provides tool "${msg.toolName}"`);
      return await conn.callTool(msg.toolName, msg.arguments || {});
    }

    // ---- 状态广播（content → sidePanel），background 不处理，仅避免报"未知消息" ----
    case 'mcpStatus': {
      return true;
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// ===================== Keepalive =====================
// A connected port from content scripts keeps the service worker alive
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onDisconnect.addListener(() => { });
  }
});

// ===================== Side Panel =====================
// 点击工具栏图标 → 打开/关闭侧边栏（取代原 popup）
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[MCP] setPanelBehavior failed:', e));
} catch (e) {
  console.warn('[MCP] sidePanel API unavailable:', e);
}

// ===================== Init =====================
manager.init();
