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

// Response Format Helpers
const formatSuccess = (data: any) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
});

const formatError = (error: any) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error?.message || String(error) }]
});

// Helper function to create the MCP server instance pre-loaded with tools
function createMcpServer(octokitClient: Octokit) {
  const server = new McpServer({
    name: 'github-lean-agent',
    version: '1.0.0',
  });

  /** 1. SEARCH CODE */
  server.registerTool('search_code', { 
    description: 'Search code snippets inside GitHub repositories',
    inputSchema: {
      q: z.string().describe('Query strings like "functionName repo:owner/repo"') 
    }
  }, async ({ q }) => {
    try {
      const res = await octokitClient.search.code({ q, per_page: 10 });
      return formatSuccess(res.data.items.map(i => ({ name: i.name, path: i.path, repo: i.repository.full_name, url: i.html_url })));
    } catch (err) { return formatError(err); }
  });

  /** 2. GET REPO TREE */
  server.registerTool('get_repo_tree', {
    description: 'Look up the full recursive directory hierarchy map of a repository',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      tree_sha: z.string().describe('Branch name or commit SHA to map recursively')
    }
  }, async ({ owner, repo, tree_sha }) => {
    try {
      const res = await octokitClient.git.getTree({ owner, repo, tree_sha, recursive: 'true' });
      return formatSuccess(res.data.tree.map(t => ({ path: t.path, type: t.type, sha: t.sha })));
    } catch (err) { return formatError(err); }
  });

  /** 3. GET FILE CONTENTS */
  server.registerTool('get_file_contents', {
    description: 'Fetch the raw contents of a specific file',
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
      return formatSuccess(res.data);
    } catch (err) { return formatError(err); }
  });

  /** 4. CREATE OR UPDATE FILE */
  server.registerTool('create_or_update_file', {
    description: 'Write, append, or modify code content within a designated file path',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      content: z.string().describe('Full string value contents of the file'),
      message: z.string().describe('Commit message statement'),
      branch: z.string(),
      sha: z.string().optional().describe('Crucial if updating an existing file structure')
    }
  }, async ({ owner, repo, path, content, message, branch, sha }) => {
    try {
      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: Buffer.from(content).toString('base64'), branch, sha
      });
      return formatSuccess(`Commit successful. New blob SHA: ${res.data.commit.sha}`);
    } catch (err) { return formatError(err); }
  });

  /** 5. DELETE FILE */
  server.registerTool('delete_file', {
    description: 'Remove a file from a branch workspace context completely',
    inputSchema: {
      owner: z.string(), 
      repo: z.string(), 
      path: z.string(), 
      message: z.string(), 
      sha: z.string(), 
      branch: z.string()
    }
  }, async ({ owner, repo, path, message, sha, branch }) => {
    try {
      const res = await octokitClient.repos.deleteFile({ owner, repo, path, message, sha, branch });
      return formatSuccess(`Deleted ${path}. Commit transaction: ${res.data.commit.sha}`);
    } catch (err) { return formatError(err); }
  });

  /** 6. CREATE BRANCH */
  server.registerTool('create_branch', {
    description: 'Isolate agentic edits by creating a new reference branch off a base SHA',
    inputSchema: {
      owner: z.string(), 
      repo: z.string(), 
      branch: z.string(), 
      refSha: z.string().describe('The base target commit SHA hash')
    }
  }, async ({ owner, repo, branch, refSha }) => {
    try {
      await octokitClient.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: refSha });
      return formatSuccess(`Branch refs/heads/${branch} created accurately.`);
    } catch (err) { return formatError(err); }
  });

  /** 7. DELETE BRANCH */
  server.registerTool('delete_branch', {
    description: 'Wipe out an old or merged working branch reference key',
    inputSchema: {
      owner: z.string(), 
      repo: z.string(), 
      branch: z.string()
    }
  }, async ({ owner, repo, branch }) => {
    try {
      await octokitClient.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
      return formatSuccess(`Wiped branch 'heads/${branch}' cleanly.`);
    } catch (err) { return formatError(err); }
  });

  /** 8. CREATE PULL REQUEST */
  server.registerTool('create_pull_request', {
    description: 'Open a pull request for human review and integration tracking',
    inputSchema: {
      owner: z.string(), 
      repo: z.string(), 
      title: z.string(), 
      body: z.string().optional(), 
      head: z.string(), 
      base: z.string().default('main')
    }
  }, async ({ owner, repo, title, body, head, base }) => {
    try {
      const res = await octokitClient.pulls.create({ owner, repo, title, body, head, base });
      return formatSuccess(`PR open: ${res.data.html_url} [#${res.data.number}]`);
    } catch (err) { return formatError(err); }
  });

  /** 9. PATCH FILE CONTENTS (Line-Specific Targeting Optimization) */
  server.registerTool('patch_file_contents', {
    description: 'Surgically update specific lines in a file by replacing a targeted row block without rewriting the whole file.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      branch: z.string(),
      startLine: z.number().describe('The 1-indexed starting line number of the block to replace'),
      endLine: z.number().describe('The 1-indexed ending line number of the block to replace'),
      newContent: z.string().describe('The replacement string block containing the clean updated code'),
      message: z.string().describe('Descriptive commit message summary')
    }
  }, async ({ owner, repo, path, branch, startLine, endLine, newContent, message }) => {
    try {
      const fileData = await octokitClient.repos.getContent({ owner, repo, path, ref: branch });
      if (Array.isArray(fileData.data) || !('content' in fileData.data)) {
        throw new Error('Target path is not a valid code file.');
      }
      
      const fileSha = fileData.data.sha;
      const rawText = Buffer.from(fileData.data.content, 'base64').toString('utf-8');
      const lines = rawText.split('\n');
      
      const zeroIndexedStart = startLine - 1;
      const zeroIndexedEnd = endLine;
      
      if (zeroIndexedStart < 0 || zeroIndexedEnd > lines.length || zeroIndexedStart > zeroIndexedEnd) {
        throw new Error(`Invalid line range bounds. The target file currently has ${lines.length} total lines.`);
      }

      const replacementLines = newContent.split('\n');
      lines.splice(zeroIndexedStart, zeroIndexedEnd - zeroIndexedStart, ...replacementLines);
      const updatedText = lines.join('\n');

      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: Buffer.from(updatedText).toString('base64'), branch, sha: fileSha
      });

      return formatSuccess(`Line patch successfully committed to lines ${startLine}-${endLine}. New SHA: ${res.data.commit.sha}`);
    } catch (err) { return formatError(err); }
  });

  return server;
}

// ============================================================================
// 🔌 OFFICIAL COMPLIANT STREAMABLE HTTP TRANSPORT RUNTIME
// ============================================================================
const app = express();
app.use(express.json());

// FIXED: Using app.all to capture GET, POST, OPTIONS, and DELETE natively
app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  try {
    const customPat = req.headers['x-github-token'] as string;
    const activeToken = customPat || DEFAULT_GITHUB_PAT;
    const activeOctokit = new Octokit({ auth: activeToken });

    const activeServer = createMcpServer(activeOctokit);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined // Stateless mode
    });

    await activeServer.connect(transport);
    
    // FIXED: Explicitly pass req.body as the 3rd parameter!
    // Since express.json() consumed the raw stream, the SDK needs the parsed object directly.
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
  res.send('🚀 Stateless GitHub MCP Server is online and compliant.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Compliant Lean GitHub MCP Server active on port ${PORT}`);
});
        
