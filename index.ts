#!/usr/bin/env node
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

function buildServer() {
    const server = new McpServer({ name: 'greeting-server', version: '1.0.0' });

    server.registerTool(
        'greet',
        {
            description: 'Greet someone by name',
            inputSchema: z.object({ name: z.string() })
        },
        async ({ name }) => ({
            content: [{ type: 'text', text: `Hello, ${name}!` }]
        })
    );

    return server;
}

// Uma instância nova do servidor por requisição (modo stateless, ideal para deploy na web)
const mcp = createMcpHandler(() => buildServer());

const port = Number(process.env.PORT ?? 3000);

const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        return;
    }

    if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}');
        return;
    }

    try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }

        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
        const request = new Request(url, {
            method: req.method,
            headers,
            body: hasBody ? (Readable.toWeb(req) as NodeReadableStream<Uint8Array>) : undefined,
            duplex: 'half'
        } as RequestInit);

        const response = await mcp.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));

        if (!response.body) {
            res.end();
            return;
        }

        // Repassa o corpo aos poucos, necessário para respostas em SSE
        const reader = response.body.getReader();
        res.on('close', () => void reader.cancel().catch(() => {}));
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
        res.end();
    } catch (err) {
        console.error('Error handling request:', err);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"Internal server error"}');
    }
});

httpServer.listen(port, () => {
    console.log(`MCP server listening on http://localhost:${port}/mcp`);
});

process.on('SIGTERM', () => {
    void mcp.close?.();
    httpServer.close(() => process.exit(0));
});
