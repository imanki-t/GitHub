import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
if (!DEFAULT_GITHUB_PAT) {
  console.warn("⚠️ Warning: GITHUB_PAT/GITHUB_PERSONAL_ACCESS_TOKEN env variable is missing.");
}

// Token-saving formatting helpers
const formatSuccess = (data: any) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
});

const formatError = (error: any) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error?.message || String(error) }]
});

// Helper function to create the MCP server instance
function createMcpServer(octokitClient: Octokit) {
  const server = new McpServer({
    name: 'github-lean-agent',
    version: '1.1.0', // Bumped version for repo tools
  });

  // ==========================================================================
  // IDENTITY & REPOSITORY CONTEXT TOOLS (New)
  // ==========================================================================

  /** 1. GET AUTHENTICATED USER */
  server.registerTool('get_authenticated_user', {
    description: 'Get the exact GitHub username of the token owner to establish user context.',
    inputSchema: {} 
  }, async () => {
    try {
      const res = await octokitClient.users.getAuthenticated();
      return formatSuccess({ username: res.data.login, name: res.data.name });
    } catch (err) { return formatError(err); }
  });

  /** 2. LIST USER REPOSITORIES */
  server.registerTool('list_user_repos', {
    description: 'List the most recently updated repositories owned by the authenticated user.',
    inputSchema: {
      limit: z.number().optional().default(15).describe('Number of repositories to fetch (keep low to save tokens)')
    }
  }, async ({ limit }) => {
    try {
      const res = await octokitClient.repos.listForAuthenticatedUser({ sort: 'updated', per_page: limit });
      return formatSuccess(res.data.map(r => ({ 
        name: r.name, 
        full_name: r.full_name, 
        is_private: r.private, 
        default_branch: r.default_branch 
      })));
    } catch (err) { return formatError(err); }
  });

  /** 3. LIST REPOSITORY BRANCHES */
  server.registerTool('list_branches', {
    description: 'List all existing branches for a specific repository target.',
    inputSchema: {
      owner: z.string(),
      repo: z.string()
    }
  }, async ({ owner, repo }) => {
    try {
      const res = await octokitClient.repos.listBranches({ owner, repo, per_page: 30 });
      return formatSuccess(res.data.map(b => ({ branch_name: b.name, latest_sha: b.commit.sha })));
    } catch (err) { return formatError(err); }
  });

  // ==========================================================================
  // CORE FILE SYSTEM TOOLS
  // ==========================================================================

  /** 4. SEARCH CODE */
  server.registerTool('search_code', { 
    description: 'Search code snippets inside GitHub repositories using structural query syntax.',
    inputSchema: {
      q: z.string().describe('Query string e.g., "functionName repo:owner/repo"') 
    }
  }, async ({ q }) => {
    try {
      const res = await octokitClient.search.code({ q, per_page: 10 });
      return formatSuccess(res.data.items.map(i => ({ name: i.name, path: i.path, repo: i.repository.full_name })));
    } catch (err) { return formatError(err); }
  });

  /** 5. GET REPO TREE */
  server.registerTool('get_repo_tree', {
    description: 'Look up the full recursive directory hierarchy mapping of a repository.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      tree_sha: z.string().describe('Branch name or commit SHA to map')
    }
  }, async ({ owner, repo, tree_sha }) => {
    try {
      const res = await octokitClient.git.getTree({ owner, repo, tree_sha, recursive: 'true' });
      return formatSuccess(res.data.tree.map(t => ({ path: t.path, type: t.type, sha: t.sha })));
    } catch (err) { return formatError(err); }
  });

  /** 6. GET FILE CONTENTS */
  server.registerTool('get_file_contents', {
    description: 'Fetch the raw string contents of a specific code file.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      ref: z.string().default('main').describe('Branch or target commit SHA')
    }
  }, async ({ owner, repo, path, ref }) => {
    try {
      const res = await octokitClient.repos.getContent({ owner, repo, path, ref });
      if ('content' in res.data && typeof res.data.content === 'string') {
        return formatSuccess(Buffer.from(res.data.content, 'base64').toString('utf-8'));
      }
      return formatSuccess('Target is a directory, not a file.');
    } catch (err) { return formatError(err); }
  });

  // ==========================================================================
  // SURGICAL ENGINEERING & MODIFICATION TOOLS
  // ==========================================================================

  /** 7. CREATE OR UPDATE FILE */
  server.registerTool('create_or_update_file', {
    description: 'Write complete new files or overwrite existing ones (Use patch_file_contents for partial edits instead to save tokens).',
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
      return formatSuccess(`Commit successful. SHA: ${res.data.commit.sha}`);
    } catch (err) { return formatError(err); }
  });

  /** 8. PATCH FILE CONTENTS (The Token Optimizer) */
  server.registerTool('patch_file_contents', {
    description: 'Surgically replace specific rows in a file without rewriting the whole document.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      branch: z.string(),
      startLine: z.number().describe('1-indexed starting line number of block to replace'),
      endLine: z.number().describe('1-indexed ending line number of block to replace'),
      newContent: z.string().describe('Clean replacement code block'),
      message: z.string()
    }
  }, async ({ owner, repo, path, branch, startLine, endLine, newContent, message }) => {
    try {
      const fileData = await octokitClient.repos.getContent({ owner, repo, path, ref: branch });
      if (Array.isArray(fileData.data) || !('content' in fileData.data)) throw new Error('Not a valid file.');
      
      const fileSha = fileData.data.sha;
      const rawText = Buffer.from(fileData.data.content, 'base64').toString('utf-8');
      const lines = rawText.split('\n');
      const zeroIndexedStart = startLine - 1;
      
      if (zeroIndexedStart < 0 || endLine > lines.length || zeroIndexedStart > endLine) {
        throw new Error(`Invalid bounds. File has ${lines.length} lines.`);
      }

      lines.splice(zeroIndexedStart, endLine - zeroIndexedStart, ...newContent.split('\n'));
      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: Buffer.from(lines.join('\n')).toString('base64'), branch, sha: fileSha
      });
      return formatSuccess(`Lines ${startLine}-${endLine} patched. New SHA: ${res.data.commit.sha}`);
    } catch (err) { return formatError(err); }
  });

  /** 9. DELETE FILE */
  server.registerTool('delete_file', {
    description: 'Remove an obsolete file from a branch workspace.',
    inputSchema: {
      owner: z.string(), repo: z.string(), path: z.string(), message: z.string(), sha: z.string(), branch: z.string()
    }
  }, async ({ owner, repo, path, message, sha, branch }) => {
    try {
      const res = await octokitClient.repos.deleteFile({ owner, repo, path, message, sha, branch });
      return formatSuccess(`Deleted ${path}.`);
    } catch (err) { return formatError(err); }
  });

  // ==========================================================================
  // VERSION CONTROL & PR PIPELINE TOOLS
  // ==========================================================================

  /** 10. CREATE BRANCH */
  server.registerTool('create_branch', {
    description: 'Create an isolated working branch off a base SHA.',
    inputSchema: {
      owner: z.string(), repo: z.string(), branch: z.string(), refSha: z.string()
    }
  }, async ({ owner, repo, branch, refSha }) => {
    try {
      await octokitClient.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: refSha });
      return formatSuccess(`Branch refs/heads/${branch} created.`);
    } catch (err) { return formatError(err); }
  });

  /** 11. DELETE BRANCH */
  server.registerTool('delete_branch', {
    description: 'Wipe an old branch reference.',
    inputSchema: {
      owner: z.string(), repo: z.string(), branch: z.string()
    }
  }, async ({ owner, repo, branch }) => {
    try {
      await octokitClient.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
      return formatSuccess(`Branch deleted.`);
    } catch (err) { return formatError(err); }
  });

  /** 12. CREATE PULL REQUEST */
  server.registerTool('create_pull_request', {
    description: 'Open a PR for human review.',
    inputSchema: {
      owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), head: z.string(), base: z.string().default('main')
    }
  }, async ({ owner, repo, title, body, head, base }) => {
    try {
      const res = await octokitClient.pulls.create({ owner, repo, title, body, head, base });
      return formatSuccess(`PR open: ${res.data.html_url} [#${res.data.number}]`);
    } catch (err) { return formatError(err); }
  });

  return server;
}

// ============================================================================
// 🔌 OFFICIAL COMPLIANT STREAMABLE HTTP TRANSPORT RUNTIME
// ============================================================================
const app = express();
app.use(express.json());

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  try {
    const customPat = req.headers['x-github-token'] as string;
    const activeToken = customPat || DEFAULT_GITHUB_PAT;
    const activeOctokit = new Octokit({ auth: activeToken });

    const activeServer = createMcpServer(activeOctokit);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined // Enforces stateless mode
    });

    await activeServer.connect(transport);
    
    // Explicitly pass pre-parsed req.body to prevent 400 Empty Stream Errors
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: error?.message || 'Internal Handshake Failure' },
      id: req.body?.id || null
    });
  }
});

app.get('/', (req: Request, res: Response) => {
  res.send('🚀 Stateless GitHub Agent Server is fully operational.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Compliant Agent Server active on port ${PORT}`);
});
             
