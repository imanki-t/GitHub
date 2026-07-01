import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

const formatSuccess = (data: any) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }]
});

const formatError = (error: any) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error?.message || String(error) }]
});

async function callRenderTool(toolName: string, args: any, renderToken: string | undefined) {
  if (!renderToken) {
    return formatError(new Error('Missing Render API key. Please check your RENDER_API_KEY environment variable or headers.'));
  }
  try {
    const response = await fetch('https://mcp.render.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${renderToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        },
        id: `proxy-${toolName}`
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return formatError(new Error(`Render MCP Error: ${errText}`));
    }

    const data = await response.json() as any;
    if (data?.error) {
      return formatError(new Error(data.error.message || JSON.stringify(data.error)));
    }
    return data?.result || data;
  } catch (err: any) {
    return formatError(err);
  }
}

function createMcpServer(octokitClient: Octokit, renderToken: string | undefined) {
  const server = new McpServer({
    name: 'github-lean-agent',
    version: '1.2.0',
  });

  server.registerTool('get_viewer', {
    description: 'Get authenticated user',
    inputSchema: {}
  }, async () => {
    try {
      const res = await octokitClient.users.getAuthenticated();
      return formatSuccess(`${res.data.login} (${res.data.name || ''})`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('list_repos', {
    description: 'List recent repos',
    inputSchema: {
      limit: z.number().optional().default(10)
    }
  }, async ({ limit }) => {
    try {
      const res = await octokitClient.repos.listForAuthenticatedUser({ sort: 'updated', per_page: limit });
      return formatSuccess(res.data.map(r => `${r.full_name} [${r.default_branch}]${r.private ? ' (private)' : ''}`).join('\n'));
    } catch (err) { return formatError(err); }
  });

  server.registerTool('search_repos', {
    description: 'Search repos by keyword',
    inputSchema: {
      q: z.string()
    }
  }, async ({ q }) => {
    try {
      const res = await octokitClient.repos.listForAuthenticatedUser({ per_page: 100 });
      const regex = new RegExp(q, 'i');
      const matched = res.data.filter(r => regex.test(r.name) || regex.test(r.full_name)).slice(0, 10);
      if (matched.length === 0) {
        const globalRes = await octokitClient.search.repos({ q: `${q} in:name`, per_page: 5 });
        return formatSuccess(globalRes.data.items.map(r => `${r.full_name} [${r.default_branch}]${r.private ? ' (private)' : ''}`).join('\n'));
      }
      return formatSuccess(matched.map(r => `${r.full_name} [${r.default_branch}]${r.private ? ' (private)' : ''}`).join('\n'));
    } catch (err) { return formatError(err); }
  });

  server.registerTool('list_branches', {
    description: 'List branches with full 40-character commit SHAs (needed for branch creation).',
    inputSchema: {
      owner: z.string(),
      repo: z.string()
    }
  }, async ({ owner, repo }) => {
    try {
      const res = await octokitClient.repos.listBranches({ owner, repo, per_page: 30 });
      return formatSuccess(res.data.map(b => `${b.name} (${b.commit.sha})`).join('\n'));
    } catch (err) { return formatError(err); }
  });

  server.registerTool('search_code', {
    description: 'Search code',
    inputSchema: {
      q: z.string()
    }
  }, async ({ q }) => {
    try {
      const res = await octokitClient.search.code({ q, per_page: 10 });
      return formatSuccess(res.data.items.map(i => `${i.repository.full_name}:${i.path}`).join('\n'));
    } catch (err) { return formatError(err); }
  });

  server.registerTool('get_tree', {
    description: 'Get file tree. Slices to 50 items. Use offset to paginate. Use q to search/filter files by keyword (e.g. "memoryService") to find paths instantly.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      tree_sha: z.string().default('main'),
      offset: z.number().optional().default(0),
      q: z.string().optional()
    }
  }, async ({ owner, repo, tree_sha, offset, q }) => {
    try {
      const res = await octokitClient.git.getTree({ owner, repo, tree_sha, recursive: 'true' });
      let tree = res.data.tree;
      if (q) {
        const regex = new RegExp(q, 'i');
        tree = tree.filter(t => regex.test(t.path || ''));
      }
      const total = tree.length;
      const items = tree.slice(offset, offset + 50).map(t => `${t.type === 'tree' ? '[D]' : '[F]'} ${t.path}`);
      let out = items.join('\n');
      if (total > offset + 50) {
        out += `\n... truncated. Total files/matches: ${total}. Call again with offset: ${offset + 50} to retrieve more.`;
      }
      return formatSuccess(out || 'No files matched your search.');
    } catch (err) { return formatError(err); }
  });

  server.registerTool('get_contents', {
    description: 'Read file lines. Max 300 lines limit. ALWAYS specify startLine and endLine (e.g. startLine: 1, endLine: 150) on your first read to avoid errors on large files.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      ref: z.string().default('main'),
      startLine: z.number().optional(),
      endLine: z.number().optional()
    }
  }, async ({ owner, repo, path, ref, startLine, endLine }) => {
    try {
      const res = await octokitClient.repos.getContent({ owner, repo, path, ref });
      if ('content' in res.data && typeof res.data.content === 'string') {
        const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
        let lines = raw.split('\n');
        const total = lines.length;
        const start = startLine ? Math.max(1, startLine) : 1;
        const end = endLine ? Math.min(total, endLine) : total;
        if (end - start > 300) return formatError(new Error('Max 300 lines. Please request a smaller line range (e.g. startLine: 1, endLine: 150) to stay within limits.'));
        lines = lines.slice(start - 1, end);
        let out = lines.join('\n');
        if (total > end) out += `\n... (truncated, total lines: ${total})`;
        return formatSuccess(out);
      }
      return formatSuccess('Not a file');
    } catch (err) { return formatError(err); }
  });

  server.registerTool('put_contents', {
    description: 'Write/overwrite file',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      content: z.string(),
      message: z.string(),
      branch: z.string(),
      sha: z.string().optional()
    }
  }, async ({ owner, repo, path, content, message, branch, sha }) => {
    try {
      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: Buffer.from(content).toString('base64'), branch, sha
      });
      return formatSuccess(`Success: ${res.data.commit.sha}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('patch_contents', {
    description: 'Replace line range',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      branch: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      newContent: z.string(),
      message: z.string()
    }
  }, async ({ owner, repo, path, branch, startLine, endLine, newContent, message }) => {
    try {
      const fileData = await octokitClient.repos.getContent({ owner, repo, path, ref: branch });
      if (Array.isArray(fileData.data) || !('content' in fileData.data)) throw new Error('Not a file');
      const lines = Buffer.from(fileData.data.content, 'base64').toString('utf-8').split('\n');
      if (startLine < 1 || endLine < startLine || endLine > lines.length) {
        throw new Error(`Invalid range. Lines: ${lines.length}`);
      }
      lines.splice(startLine - 1, endLine - startLine + 1, ...newContent.split('\n'));
      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: Buffer.from(lines.join('\n')).toString('base64'), branch, sha: fileData.data.sha
      });
      return formatSuccess(`Success: ${res.data.commit.sha}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('delete_contents', {
    description: 'Delete file',
    inputSchema: {
      owner: z.string(), repo: z.string(), path: z.string(), message: z.string(), sha: z.string(), branch: z.string()
    }
  }, async ({ owner, repo, path, message, sha, branch }) => {
    try {
      await octokitClient.repos.deleteFile({ owner, repo, path, message, sha, branch });
      return formatSuccess(`Deleted ${path}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('create_ref', {
    description: 'Create branch',
    inputSchema: {
      owner: z.string(), repo: z.string(), branch: z.string(), refSha: z.string()
    }
  }, async ({ owner, repo, branch, refSha }) => {
    try {
      await octokitClient.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: refSha });
      return formatSuccess(`Created branch ${branch}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('delete_ref', {
    description: 'Delete branch',
    inputSchema: {
      owner: z.string(), repo: z.string(), branch: z.string()
    }
  }, async ({ owner, repo, branch }) => {
    try {
      await octokitClient.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
      return formatSuccess(`Deleted branch ${branch}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('create_pull', {
    description: 'Create PR',
    inputSchema: {
      owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), head: z.string(), base: z.string().default('main')
    }
  }, async ({ owner, repo, title, body, head, base }) => {
    try {
      const res = await octokitClient.pulls.create({ owner, repo, title, body, head, base });
      return formatSuccess(`PR #${res.data.number} opened: ${res.data.html_url}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('list_services', {
    description: 'List all services in your Render account.',
    inputSchema: {
      includePreviews: z.boolean().optional().default(false)
    }
  }, async (args) => {
    return callRenderTool('list_services', args, renderToken);
  });

  server.registerTool('get_service', {
    description: 'Get details about a specific service.',
    inputSchema: {
      serviceId: z.string()
    }
  }, async (args) => {
    return callRenderTool('get_service', args, renderToken);
  });

  server.registerTool('list_deploys', {
    description: 'List deploy history.',
    inputSchema: {
      serviceId: z.string(),
      limit: z.number().optional().default(10)
    }
  }, async (args) => {
    return callRenderTool('list_deploys', args, renderToken);
  });

  server.registerTool('get_deploy', {
    description: 'Get deployment details.',
    inputSchema: {
      serviceId: z.string(),
      deployId: z.string()
    }
  }, async (args) => {
    return callRenderTool('get_deploy', args, renderToken);
  });

  server.registerTool('list_logs', {
    description: 'Get service logs.',
    inputSchema: {
      serviceId: z.string(),
      limit: z.number().optional().default(100)
    }
  }, async (args) => {
    return callRenderTool('list_logs', args, renderToken);
  });

  return server;
}

const activeInstances = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

const app = express();
app.use(express.json());

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  if (!MCP_API_KEY) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Server configuration error: MCP_API_KEY is not configured on host.' },
      id: req.body?.id || null
    });
    return;
  }

  const clientApiKey = (req.headers['x-api-key'] as string)
    || req.headers['authorization']?.toString().replace('Bearer ', '')
    || (req.query.api_key as string);
  
  if (clientApiKey !== MCP_API_KEY) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: Invalid or missing MCP_API_KEY' },
      id: req.body?.id || null
    });
    return;
  }

  const githubToken = (req.headers['x-github-token'] as string) || DEFAULT_GITHUB_PAT;
  const renderToken = (req.headers['x-render-token'] as string)
    || (req.headers['x-render-api-key'] as string)
    || DEFAULT_RENDER_API_KEY;

  const cacheKey = `${githubToken || ''}_${renderToken || ''}`;
  let instance = activeInstances.get(cacheKey);

  if (!instance) {
    const octokit = new Octokit({ auth: githubToken || '' });
    const server = createMcpServer(octokit, renderToken);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => Math.random().toString(36).substring(2, 15)
    });

    try {
      await server.connect(transport);
      instance = { server, transport };
      activeInstances.set(cacheKey, instance);
    } catch (connectError: any) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: connectError?.message || 'Handshake Error' },
        id: req.body?.id || null
      });
      return;
    }
  }

  try {
    await instance.transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error?.message || 'Request Handling Error' },
        id: req.body?.id || null
      });
    }
  }
});

app.get('/', (req: Request, res: Response) => {
  res.send('🚀 Stateless Unified MCP Server active.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Port ${PORT}`);
});
