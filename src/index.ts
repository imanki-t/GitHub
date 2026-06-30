import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
if (!GITHUB_PAT) {
  console.warn("⚠️ Warning: GITHUB_PAT/GITHUB_PERSONAL_ACCESS_TOKEN env variable is missing.");
}

const octokit = new Octokit({ auth: GITHUB_PAT });

const server = new McpServer({
  name: 'github-lean-agent',
  version: '1.0.0',
});

// Response Format Helpers
const formatSuccess = (data: any) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
});

const formatError = (error: any) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error?.message || String(error) }]
});

// ============================================================================
// 🎯 THE CORE 9 AGENTIC TOOLS
// ============================================================================

/**
 * 1. SEARCH CODE
 */
server.registerTool('search_code', { 
  q: z.string().describe('Query strings like "functionName repo:owner/repo"') 
}, async ({ q }) => {
  try {
    const res = await octokit.search.code({ q, per_page: 10 });
    return formatSuccess(res.data.items.map(i => ({ name: i.name, path: i.path, repo: i.repository.full_name, url: i.html_url })));
  } catch (err) { return formatError(err); }
});

/**
 * 2. GET REPO TREE
 */
server.registerTool('get_repo_tree', {
  owner: z.string(),
  repo: z.string(),
  tree_sha: z.string().describe('Branch name or commit SHA to map recursively')
}, async ({ owner, repo, tree_sha }) => {
  try {
    const res = await octokit.git.getTree({ owner, repo, tree_sha, recursive: 'true' });
    return formatSuccess(res.data.tree.map(t => ({ path: t.path, type: t.type, sha: t.sha })));
  } catch (err) { return formatError(err); }
});

/**
 * 3. GET FILE CONTENTS
 */
server.registerTool('get_file_contents', {
  owner: z.string(),
  repo: z.string(),
  path: z.string(),
  ref: z.string().default('main').describe('Branch or target commit SHA')
}, async ({ owner, repo, path, ref }) => {
  try {
    const res = await octokit.repos.getContent({ owner, repo, path, ref });
    if ('content' in res.data && typeof res.data.content === 'string') {
      return formatSuccess(Buffer.from(res.data.content, 'base64').toString('utf-8'));
    }
    return formatSuccess(res.data);
  } catch (err) { return formatError(err); }
});

/**
 * 4. CREATE OR UPDATE FILE
 */
server.registerTool('create_or_update_file', {
  owner: z.string(),
  repo: z.string(),
  path: z.string(),
  content: z.string().describe('Full string value contents of the file'),
  message: z.string().describe('Commit message statement'),
  branch: z.string(),
  sha: z.string().optional().describe('Crucial if updating an existing file structure')
}, async ({ owner, repo, path, content, message, branch, sha }) => {
  try {
    const res = await octokit.repos.createOrUpdateFileContents({
      owner, repo, path, message, content: Buffer.from(content).toString('base64'), branch, sha
    });
    return formatSuccess(`Commit successful. New blob SHA: ${res.data.commit.sha}`);
  } catch (err) { return formatError(err); }
});

/**
 * 5. DELETE FILE
 */
server.registerTool('delete_file', {
  owner: z.string(), repo: z.string(), path: z.string(), message: z.string(), sha: z.string(), branch: z.string()
}, async ({ owner, repo, path, message, sha, branch }) => {
  try {
    const res = await octokit.repos.deleteFile({ owner, repo, path, message, sha, branch });
    return formatSuccess(`Deleted ${path}. Commit transaction: ${res.data.commit.sha}`);
  } catch (err) { return formatError(err); }
});

/**
 * 6. CREATE BRANCH
 */
server.registerTool('create_branch', {
  owner: z.string(), repo: z.string(), branch: z.string(), refSha: z.string().describe('The base target commit SHA hash')
}, async ({ owner, repo, branch, refSha }) => {
  try {
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: refSha });
    return formatSuccess(`Branch refs/heads/${branch} created accurately.`);
  } catch (err) { return formatError(err); }
});

/**
 * 7. DELETE BRANCH
 */
server.registerTool('delete_branch', { owner: z.string(), repo: z.string(), branch: z.string() }, async ({ owner, repo, branch }) => {
  try {
    await octokit.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    return formatSuccess(`Wiped branch 'heads/${branch}' cleanly.`);
  } catch (err) { return formatError(err); }
});

/**
 * 8. CREATE PULL REQUEST
 */
server.registerTool('create_pull_request', {
  owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), head: z.string(), base: z.string().default('main')
}, async ({ owner, repo, title, body, head, base }) => {
  try {
    const res = await octokit.pulls.create({ owner, repo, title, body, head, base });
    return formatSuccess(`PR open: ${res.data.html_url} [#${res.data.number}]`);
  } catch (err) { return formatError(err); }
});

/**
 * 9. GET COMMIT STATUS
 */
server.registerTool('get_commit_status', { owner: z.string(), repo: z.string(), ref: z.string() }, async ({ owner, repo, ref }) => {
  try {
    const res = await octokit.repos.getCombinedStatusForRef({ owner, repo, ref });
    return formatSuccess({ state: res.data.state, statuses: res.data.statuses.map(s => ({ context: s.context, state: s.state })) });
  } catch (err) { return formatError(err); }
});

// ============================================================================
// 🔌 STREAMABLE HTTP / SSE ENGINE FOR ALPIC
// ============================================================================
const app = express();
app.use(express.json());

const activeTransports = new Map<string, SSEServerTransport>();

app.post('/mcp', async (req, res) => {
  const sessionId = Math.random().toString(36).substring(7);
  
  const customPat = req.headers['x-github-token'] as string;
  if (customPat) {
    octokit.auth = customPat;
  }

  const transport = new SSEServerTransport(`/messages?id=${sessionId}`, res);
  activeTransports.set(sessionId, transport);
  
  req.on('close', () => { activeTransports.delete(sessionId); });
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.id as string;
  const transport = activeTransports.get(sessionId);
  
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send('Session expired.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Lean GitHub MCP Server operational on port ${PORT}`);
});
