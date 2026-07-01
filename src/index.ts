import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

const formatSuccess = (data: any) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }]
});

const formatError = (error: any) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error?.message || String(error) }]
});

function createMcpServer(octokitClient: Octokit) {
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
      const matched = res.data.filter(r => regex.test(r.name) || regex.test(r.full_name));
      if (matched.length === 0) {
        const globalRes = await octokitClient.search.repos({ q: `${q} in:name`, per_page: 5 });
        return formatSuccess(globalRes.data.items.map(r => `${r.full_name} [${r.default_branch}]${r.private ? ' (private)' : ''}`).join('\n'));
      }
      return formatSuccess(matched.map(r => `${r.full_name} [${r.default_branch}]${r.private ? ' (private)' : ''}`).join('\n'));
    } catch (err) { return formatError(err); }
  });

  server.registerTool('list_branches', {
    description: 'List branches',
    inputSchema: {
      owner: z.string(),
      repo: z.string()
    }
  }, async ({ owner, repo }) => {
    try {
      const res = await octokitClient.repos.listBranches({ owner, repo, per_page: 30 });
      return formatSuccess(res.data.map(b => `${b.name} (${b.commit.sha.substring(0, 7)})`).join('\n'));
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
    description: 'Get file tree',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      tree_sha: z.string()
    }
  }, async ({ owner, repo, tree_sha }) => {
    try {
      const res = await octokitClient.git.getTree({ owner, repo, tree_sha, recursive: 'true' });
      const items = res.data.tree.slice(0, 150).map(t => `${t.type === 'tree' ? '[D]' : '[F]'} ${t.path}`);
      if (res.data.tree.length > 150) items.push(`... truncated ${res.data.tree.length - 150} files`);
      return formatSuccess(items.join('\n'));
    } catch (err) { return formatError(err); }
  });

  server.registerTool('get_contents', {
    description: 'Read file lines',
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
        if (end - start > 500) return formatError(new Error('Max 500 lines'));
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

  return server;
}

const app = express();
app.use(express.json());

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  const clientApiKey = (req.headers['x-api-key'] as string) || req.headers['authorization']?.toString().replace('Bearer ', '');
  
  if (MCP_API_KEY && clientApiKey !== MCP_API_KEY) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: Invalid or missing MCP_API_KEY' },
      id: req.body?.id || null
    });
    return;
  }

  const token = (req.headers['x-github-token'] as string) || DEFAULT_GITHUB_PAT;
  if (!token) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Missing GitHub token.' },
      id: req.body?.id || null
    });
    return;
  }

  const octokit = new Octokit({ auth: token });
  const server = createMcpServer(octokit);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as any });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error?.message || 'Handshake Error' },
        id: req.body?.id || null
      });
    }
  }
});

app.get('/', (req: Request, res: Response) => {
  res.send('🚀 Stateless GitHub Agent Server active.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Port ${PORT}`);
});
