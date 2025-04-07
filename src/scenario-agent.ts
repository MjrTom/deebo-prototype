import { log } from './util/logger.js';
import { connectRequiredTools } from './util/mcp.js';
import { writeReport } from './util/reports.js';  // System infrastructure for capturing output
// import OpenAI from 'openai'; // Removed
import { ChatCompletionMessageParam, ChatCompletionMessage } from 'openai/resources/chat/completions';
import { writeObservation, getAgentObservations } from './util/observations.js';
import { callLlm } from './util/agent-utils.js'; // Added

const MAX_RUNTIME = 15 * 60 * 1000; // 15 minutes

// Define LlmConfig interface (can be moved to a shared types file later if needed)
interface LlmConfig {
  provider?: string;
  model?: string;
  maxTokens?: number;
  apiKey?: string; // Generic key, specific keys passed within (used for OpenRouter)
  // baseURL?: string; // Removed - OpenRouter URL is hardcoded in agent-utils
  geminiApiKey?: string;
  anthropicApiKey?: string;
}

interface ScenarioArgs {
  id: string;
  session: string;
  error: string;
  context: string;
  hypothesis: string;
  language: string;
  repoPath: string;
  filePath?: string;
  branch: string;
}

function parseArgs(args: string[]): ScenarioArgs {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
      result[key] = value;
      if (value) i++;
    }
  }

  const repoPath = result.repo;
  if (!repoPath) {
    throw new Error('Required argument missing: --repo');
  }

  return {
    id: result.id || '',
    session: result.session || '',
    error: result.error || '',
    context: result.context || '',
    hypothesis: result.hypothesis || '',
    language: result.language || 'typescript',
    repoPath,
    filePath: result.file || undefined,
    branch: result.branch || '' 
  };
}

export async function runScenarioAgent(args: ScenarioArgs) {
  await log(args.session, `scenario-${args.id}`, 'info', 'Scenario agent started', { repoPath: args.repoPath, hypothesis: args.hypothesis });

  try {
    // Set up tools
    await log(args.session, `scenario-${args.id}`, 'info', 'Connecting to tools...', { repoPath: args.repoPath });
  const { gitClient, filesystemClient } = await connectRequiredTools(
    `scenario-${args.id}`, 
    args.session,
    args.repoPath
  );
  await log(args.session, `scenario-${args.id}`, 'info', 'Connected to tools successfully', { repoPath: args.repoPath });

    // Branch creation is handled by system infrastructure before this agent is spawned.

    // Start LLM conversation with initial context
    const startTime = Date.now();
    // Initial conversation context
    const messages: ChatCompletionMessageParam[] = [{
      role: 'assistant',
      content: `You are a scenario agent investigating a bug based on a specific hypothesis.
A dedicated Git branch '${args.branch}' has been created for your investigation.

Your hypothesis: "${args.hypothesis}"
Your job is to either validate the hypothesis, falsify it, or propose alternative directions if stuck. You do not need to fix the entire bug — your focus is the truth of the SPECIFIC hypothesis you are assigned to.
That being said, don't be too hasty to report a conclusion. If you see something potentially useful/interesting, investigate it further. Debugging is a complicated, nonlinear process, and subtle clues could be useful.
IMPORTANT:
- READ THE CONTEXT CAREFULLY: "${args.context}"
- This contains what approaches have failed and why
- Don't waste time repeating failed attempts
- These are instructions, not suggestions. Do not retry any approach listed here as ‘already attempted’.
- Mother agent is counting on you to explore NEW approaches
- When you're reasonably confident, wrap up with <report> tags

TOOL USAGE:
Always use this exact format for tools:
<use_mcp_tool>
  <server_name>git-mcp</server_name>
  <tool_name>git_status</tool_name>
  <arguments>
    {
      "repo_path": "${args.repoPath}"
    }
  </arguments>
</use_mcp_tool>

Available Tools:
git-mcp (use for ALL git operations):
- git_status: Show working tree status
  Example: { "repo_path": "${args.repoPath}" }
- git_diff_unstaged: Show changes in working directory not yet staged
  Example: { "repo_path": "${args.repoPath}" }
- git_diff_staged: Show changes that are staged for commit
  Example: { "repo_path": "${args.repoPath}" }
- git_diff: Compare current state with a branch or commit
  Example: { "repo_path": "${args.repoPath}", "target": "main" }
- git_add: Stage file changes
  Example: { "repo_path": "${args.repoPath}", "files": ["file1.ts", "file2.ts"] }
- git_commit: Commit staged changes
  Example: { "repo_path": "${args.repoPath}", "message": "commit message" }
- git_reset: Unstage all changes
  Example: { "repo_path": "${args.repoPath}" }
- git_log: Show recent commit history
  Example: { "repo_path": "${args.repoPath}" }
- git_checkout: Switch to a different branch
  Example: { "repo_path": "${args.repoPath}", "branch_name": "${args.branch}" }
- git_show: Show contents of a specific commit
  Example: { "repo_path": "${args.repoPath}", "revision": "HEAD" }

desktop-commander (use ONLY for non-git operations):

Terminal Tools:
- execute_command: Run terminal commands with timeout
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>execute_command</tool_name>
    <arguments>
      {
        "command": "npm run build",
        "timeout_ms": 5000
      }
    </arguments>
  </use_mcp_tool>

- read_output: Get output from running commands
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>read_output</tool_name>
    <arguments>
      {
        "pid": 12345
      }
    </arguments>
  </use_mcp_tool>

- force_terminate: Stop running command sessions
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>force_terminate</tool_name>
    <arguments>
      {
        "pid": 12345
      }
    </arguments>
  </use_mcp_tool>

- list_sessions: View active command sessions
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>list_sessions</tool_name>
    <arguments>
      {}
    </arguments>
  </use_mcp_tool>

- list_processes: List system processes
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>list_processes</tool_name>
    <arguments>
      {}
    </arguments>
  </use_mcp_tool>

- kill_process: Terminate processes by PID
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>kill_process</tool_name>
    <arguments>
      {
        "pid": 12345
      }
    </arguments>
  </use_mcp_tool>

- block_command: Block a command from execution
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>block_command</tool_name>
    <arguments>
      {
        "command": "rm -rf /"
      }
    </arguments>
  </use_mcp_tool>

- unblock_command: Unblock a command
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>unblock_command</tool_name>
    <arguments>
      {
        "command": "rm -rf /"
      }
    </arguments>
  </use_mcp_tool>

Filesystem Tools:
- read_file: Read file contents
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>read_file</tool_name>
    <arguments>
      {
        "path": "${args.repoPath}/file.ts"
      }
    </arguments>
  </use_mcp_tool>

- read_multiple_files: Read multiple files at once
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>read_multiple_files</tool_name>
    <arguments>
      {
        "paths": ["file1.ts", "file2.ts"]
      }
    </arguments>
  </use_mcp_tool>

- write_file: Write content to files
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>write_file</tool_name>
    <arguments>
      {
        "path": "file.ts",
        "content": "console.log('hello');"
      }
    </arguments>
  </use_mcp_tool>

- edit_file: Apply surgical text replacements
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>edit_file</tool_name>
    <arguments>
      {
        "path": "file.ts",
        "diff": "<<<<<<< SEARCH\nold code\n=======\nnew code\n>>>>>>> REPLACE"
      }
    </arguments>
  </use_mcp_tool>

- list_directory: List directory contents
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>list_directory</tool_name>
    <arguments>
      {
        "path": "${args.repoPath}"
      }
    </arguments>
  </use_mcp_tool>

- search_files: Search files with pattern
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>search_files</tool_name>
    <arguments>
      {
        "path": "${args.repoPath}",
        "pattern": "error",
        "file_pattern": "*.ts"
      }
    </arguments>
  </use_mcp_tool>

- create_directory: Create a new directory
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>create_directory</tool_name>
    <arguments>
      {
        "path": "new-dir"
      }
    </arguments>
  </use_mcp_tool>

- move_file: Move or rename a file
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>move_file</tool_name>
    <arguments>
      {
        "source": "old.ts",
        "destination": "new.ts"
      }
    </arguments>
  </use_mcp_tool>

- get_file_info: Get file metadata
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>get_file_info</tool_name>
    <arguments>
      {
        "path": "file.ts"
      }
    </arguments>
  </use_mcp_tool>

- search_code: Recursive code search
  Example:
  <use_mcp_tool>
    <server_name>desktop-commander</server_name>
    <tool_name>search_code</tool_name>
    <arguments>
      {
        "path": "${args.repoPath}",
        "pattern": "function",
        "filePattern": "*.ts",
        "contextLines": 2,
        "ignoreCase": true
      }
    </arguments>
  </use_mcp_tool>

REPORT FORMAT:
When you've completed your investigation, use:
<report>
HYPOTHESIS: [Original hypothesis]
CONFIRMED: [Yes/No/Partially]
INVESTIGATION:
[Briefly explain what context you took into account and how this differed]
[Summary of what you tried]
[Key findings]
[Why this confirms/refutes hypothesis]

CHANGES MADE:
[List any file changes]
[Why each change was needed]

CONFIDENCE: [High/Medium/Low]
[Explanation of confidence level]
</report>`
    }, {
      role: 'user',
      content: `Error: ${args.error}
Context: ${args.context}
Language: ${args.language}
File: ${args.filePath}
Repo: ${args.repoPath}
Hypothesis: ${args.hypothesis}`
    }];

    // Check for observations
    const observations = await getAgentObservations(args.repoPath, args.session, `scenario-${args.id}`);
    if (observations.length > 0) {
      messages.push(...observations.map((obs: string) => ({
        role: 'user' as const,
        content: `Scientific observation: ${obs}`
      })));
    }

    // Read LLM configuration from environment variables
    const scenarioProvider = process.env.SCENARIO_HOST; // Read provider name from SCENARIO_HOST
    const scenarioModel = process.env.SCENARIO_MODEL;
    const openrouterApiKey = process.env.OPENROUTER_API_KEY; // Still needed if provider is 'openrouter'
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    // const scenarioHost = process.env.SCENARIO_HOST; // No longer needed as separate URL

    // Create the config object to pass to callLlm
    const llmConfig: LlmConfig = {
      provider: scenarioProvider, // Use the provider name from SCENARIO_HOST
      model: scenarioModel,
      apiKey: openrouterApiKey, // Pass the OpenRouter key (used only if provider is 'openrouter')
      // baseURL: scenarioHost, // Removed - OpenRouter URL is hardcoded in agent-utils
      geminiApiKey: geminiApiKey,
      anthropicApiKey: anthropicApiKey
    };

    await log(args.session, `scenario-${args.id}`, 'debug', 'Sending to LLM', { model: llmConfig.model, provider: llmConfig.provider, messages, repoPath: args.repoPath });
    let replyText = await callLlm(messages, llmConfig);
    if (!replyText) {
      await log(args.session, `scenario-${args.id}`, 'warn', 'Received empty/malformed response from LLM', { repoPath: args.repoPath });
      // Exit if the first call fails, as there's no response to process
      await writeReport(args.repoPath, args.session, args.id, 'Initial LLM call returned empty response.');
      console.log('Initial LLM call returned empty response.');
      process.exit(1); 
    } else {
      messages.push({ role: 'assistant', content: replyText });
      await log(args.session, `scenario-${args.id}`, 'debug', 'Received from LLM', { response: { content: replyText }, repoPath: args.repoPath });
    }

    // Check for report in initial response
    const initialResponseText = replyText;
    const initialReportMatch = initialResponseText.match(/<report>\s*([\s\S]*?)\s*<\/report>/i);
    if (initialReportMatch) {
      const reportText = initialReportMatch[1].trim();
      await writeReport(args.repoPath, args.session, args.id, reportText);
      console.log(reportText);
      process.exit(0);
    }

    while (true) {
      if (Date.now() - startTime > MAX_RUNTIME) {
        await writeReport(args.repoPath, args.session, args.id, 'Investigation exceeded maximum runtime');
        console.log('Investigation exceeded maximum runtime');
        process.exit(1);
      }

      // The assistant's response (replyText) is already added to messages history
      const responseText = replyText; // Use the latest replyText


      // Handle MULTIPLE MCP tools (if any) - Parsing from responseText
      const toolCalls = responseText.match(/<use_mcp_tool>[\s\S]*?<\/use_mcp_tool>/g) || [];

      const parsedCalls = toolCalls.map((tc: string) => {
        try {
          const server = tc.includes('git-mcp') ? gitClient! : filesystemClient!;
          const toolMatch = tc.match(/<tool_name>(.*?)<\/tool_name>/);
          if (!toolMatch || !toolMatch[1]) throw new Error('Missing tool');
          const tool = toolMatch[1]!;

          const argsMatch = tc.match(/<arguments>(.*?)<\/arguments>/s);
          if (!argsMatch || !argsMatch[1]) throw new Error('Missing arguments');
          const args = JSON.parse(argsMatch[1]!);

          return { server, tool, args };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      });

      // Abort if *any* call fails to parse
      const invalid = parsedCalls.find(p => 'error' in p);
      if (invalid) {
        messages.push({
          role: 'user',
          content: `One of your tool calls was malformed and none were run. Error: ${invalid.error}`
        });
        // No need to clear assistantResponse here, just continue the loop
        continue;
      }
      
      const validCalls = parsedCalls as { server: NonNullable<typeof gitClient>, tool: string, args: any }[];

      // Only now, execute each one
      for (const { server, tool, args } of validCalls) {
        if (tool === 'git_create_branch') {
          messages.push({
            role: 'user',
            content: 'git_create_branch is not allowed — the branch was already created by the mother agent.'
          });
          continue;
        }

        try {
            const result = await server.callTool({ name: tool, arguments: args });
            messages.push({
              role: 'user',
              content: JSON.stringify(result)
            });
        } catch (toolErr) {
            messages.push({
              role: 'user',
              content: `Tool call failed: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`
            });
        }
      }

      // Extract report if present - Parsing from responseText
      const reportMatch = responseText.match(/<report>\s*([\s\S]*?)\s*<\/report>/i);
      if (reportMatch) {
        const reportText = reportMatch[1].trim();
        await writeReport(args.repoPath, args.session, args.id, reportText);
        console.log(reportText);
        process.exit(0);
      }

      // Continue the conversation
      // Check for new observations before each Claude call
      const newObservations = await getAgentObservations(args.repoPath, args.session, `scenario-${args.id}`);
      if (newObservations.length > observations.length) {
        const latestObservations = newObservations.slice(observations.length);
        messages.push(...latestObservations.map((obs: string): ChatCompletionMessageParam => ({
          role: 'user', // No 'as const' needed here
          content: `Scientific observation: ${obs}`
        })));
        // Update the baseline observations count after processing
        // This was the bug in the previous attempt - it needs to be updated *outside* the if block
        // observations = newObservations; // Let's remove this line as it wasn't in the original and might be incorrect logic introduced by me. The original logic only checked length difference.
      }

      // Make next LLM call
      await log(args.session, `scenario-${args.id}`, 'debug', 'Sending to LLM', { model: llmConfig.model, provider: llmConfig.provider, messages, repoPath: args.repoPath });
      replyText = await callLlm(messages, llmConfig); // Update replyText
      if (!replyText) {
        await log(args.session, `scenario-${args.id}`, 'warn', 'Received empty/malformed response from LLM', { provider: llmConfig.provider, model: llmConfig.model, repoPath: args.repoPath });
        // If the LLM fails mid-conversation, write a report and exit
        await writeReport(args.repoPath, args.session, args.id, 'LLM returned empty response mid-investigation.');
        console.log('LLM returned empty response mid-investigation.');
        process.exit(1);
      } else {
        messages.push({ role: 'assistant', content: replyText });
        await log(args.session, `scenario-${args.id}`, 'debug', 'Received from LLM', { response: { content: replyText }, provider: llmConfig.provider, model: llmConfig.model, repoPath: args.repoPath });
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    await writeReport(args.repoPath, args.session, args.id, `SCENARIO ERROR: ${errorText}`);
    console.log(`SCENARIO ERROR: ${errorText}`);
    process.exit(1);
  }
}

// Parse args and run
const args = parseArgs(process.argv);
runScenarioAgent(args).catch(err => {
  const errorText = err instanceof Error ? err.message : String(err);
  console.log(`SCENARIO ERROR: ${errorText}`);
  process.exit(1);
});
