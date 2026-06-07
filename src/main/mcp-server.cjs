const { randomUUID } = require('crypto');
const { ipcMain } = require('electron');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js');
const z = require('zod/v4');
const { buildMcpPayload } = require('../shared/mcp-payloads.cjs');

const DEFAULT_PORT = 37373;
const RESPONSE_TIMEOUT_MS = 2500;

function parsePort(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return DEFAULT_PORT;
  return value;
}

function jsonToolResult(payload) {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }]
  };
}

function createRendererRuntimeRequester({ getWindow }) {
  const pending = new Map();

  ipcMain.on('mcp:runtime-state-response', (_evt, message) => {
    const requestId = message?.requestId;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timeout);

    if (message?.error) {
      entry.reject(new Error(message.error));
      return;
    }
    entry.resolve(message?.payload);
  });

  return function requestRendererRuntimeState() {
    const win = getWindow?.();
    if (!win || win.isDestroyed()) {
      return Promise.resolve(null);
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Timed out waiting for UI runtime state.'));
      }, RESPONSE_TIMEOUT_MS);

      pending.set(requestId, { resolve, reject, timeout });
      win.webContents.send('mcp:runtime-state-request', { requestId });
    });
  };
}

function createDashboardMcpServer({ requestRuntimeState }) {
  const server = new McpServer({
    name: 'is-vol-open-ui',
    version: '1.0.0'
  });

  async function runtimePayload(toolName, args) {
    let runtime = null;
    try {
      runtime = await requestRuntimeState();
    } catch (error) {
      return {
        status: 'error',
        error: {
          code: 'renderer_unavailable',
          message: error?.message || 'Open UI runtime is unavailable.'
        }
      };
    }
    return buildMcpPayload(runtime, toolName, args);
  }

  server.registerTool('get_app_info', {
    title: 'Get App Info',
    description: 'Describe the open IS-VOL dashboard app and its current UI runtime semantics.'
  }, async () => jsonToolResult(await runtimePayload('get_app_info')));

  server.registerTool('list_dashboards', {
    title: 'List Dashboards',
    description: 'List dashboard tabs currently known by the open UI runtime.'
  }, async () => jsonToolResult(await runtimePayload('list_dashboards')));

  server.registerTool('list_widgets', {
    title: 'List Widgets',
    description: 'List widgets in a dashboard tab and report whether each has loaded runtime data.',
    inputSchema: {
      tabId: z.string().min(1).describe('Dashboard tab id.')
    }
  }, async ({ tabId }) => jsonToolResult(await runtimePayload('list_widgets', { tabId })));

  server.registerTool('get_widget_data', {
    title: 'Get Widget Data',
    description: 'Return the current in-app dataset for a specific widget without refreshing or recomputing data.',
    inputSchema: {
      tabId: z.string().min(1).describe('Dashboard tab id.'),
      widgetId: z.string().min(1).describe('Widget id within the dashboard tab.')
    }
  }, async ({ tabId, widgetId }) => jsonToolResult(await runtimePayload('get_widget_data', { tabId, widgetId })));

  return server;
}

function startMcpServer({ getWindow, port = parsePort(process.env.IS_VOL_MCP_PORT) }) {
  const requestRuntimeState = createRendererRuntimeRequester({ getWindow });
  const app = createMcpExpressApp();

  app.post('/mcp', async (req, res) => {
    const server = createDashboardMcpServer({ requestRuntimeState });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (error) {
      console.error('[MCP] request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error?.message || 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. Use POST /mcp for Streamable HTTP MCP.'
      },
      id: null
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'is-vol-mcp', endpoint: '/mcp' });
  });

  const httpServer = app.listen(port, '127.0.0.1', () => {
    console.log(`[MCP] IS-VOL open UI MCP server listening at http://127.0.0.1:${port}/mcp`);
  });

  httpServer.on('error', (error) => {
    console.error(`[MCP] Failed to start MCP server on 127.0.0.1:${port}:`, error?.message || error);
  });

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => httpServer.close(resolve))
  };
}

module.exports = {
  DEFAULT_PORT,
  createDashboardMcpServer,
  createRendererRuntimeRequester,
  startMcpServer
};
