import {
  PERMISSION_EMOJI,
  APPROVED_EMOJI,
  DENIED_EMOJI,
  TOOL_USE_EMOJI,
  RESULT_SUCCESS_EMOJI,
  RESULT_ERROR_EMOJI,
  STATUS_EMOJI,
  COST_EMOJI,
  MAX_OUTPUT_LINES,
  TRUNCATION_NOTICE,
  MAX_MESSAGE_LENGTH,
} from "./constants.js";

/** Escape HTML special chars for Matrix formatted_body. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Truncate text that exceeds line or character limits. */
function truncate(text: string): string {
  const lines = text.split("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    return lines.slice(0, MAX_OUTPUT_LINES).join("\n") + TRUNCATION_NOTICE;
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return text.slice(0, MAX_MESSAGE_LENGTH) + "\n\n--- (truncated) ---";
  }
  return text;
}

/** Format a permission request for Matrix. */
export function formatPermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
): { body: string; html: string } {
  const inputSummary = summarizeToolInput(toolName, input);
  const body = `${PERMISSION_EMOJI} PERMISSION REQUEST\nTool: ${toolName}\n${inputSummary}\n\nReply: y to approve, n to deny, or type a message to deny with reason.`;
  const html = `<b>${PERMISSION_EMOJI} PERMISSION REQUEST</b><br/>` +
    `<b>Tool:</b> <code>${escapeHtml(toolName)}</code><br/>` +
    `<pre>${escapeHtml(inputSummary)}</pre><br/>` +
    `Reply: <b>y</b> to approve, <b>n</b> to deny, or type a message to deny with reason.`;
  return { body, html };
}

/** Format a user-question from the agent for Matrix. */
export function formatUserQuestion(
  questions: Array<{ question: string; options: Array<{ label: string; description?: string }> }>,
): { body: string; html: string } {
  let body = `❓ AGENT QUESTION\n`;
  let html = `<b>❓ AGENT QUESTION</b><br/>`;

  for (const q of questions) {
    body += `\n${q.question}\n`;
    html += `<br/><b>${escapeHtml(q.question)}</b><br/>`;
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      body += `  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}\n`;
      html += `&nbsp;&nbsp;${i + 1}. <b>${escapeHtml(opt.label)}</b>${opt.description ? ` — ${escapeHtml(opt.description)}` : ""}<br/>`;
    }
  }
  body += `\nReply with the number or label of your choice.`;
  html += `<br/>Reply with the number or label of your choice.`;

  return { body, html };
}

/** Format a permission approval notification. */
export function formatPermissionApproved(toolName: string): { body: string; html: string } {
  const body = `${APPROVED_EMOJI} Approved: ${toolName}`;
  const html = `${APPROVED_EMOJI} <b>Approved:</b> <code>${escapeHtml(toolName)}</code>`;
  return { body, html };
}

/** Format a permission denial notification. */
export function formatPermissionDenied(toolName: string, reason?: string): { body: string; html: string } {
  const reasonText = reason ? ` — ${reason}` : "";
  const body = `${DENIED_EMOJI} Denied: ${toolName}${reasonText}`;
  const html = `${DENIED_EMOJI} <b>Denied:</b> <code>${escapeHtml(toolName)}</code>${reason ? ` — ${escapeHtml(reason)}` : ""}`;
  return { body, html };
}

/** Format a tool-use notification. */
export function formatToolUse(toolName: string, input: Record<string, unknown>): { body: string; html: string } {
  const summary = summarizeToolInput(toolName, input);
  const body = `${TOOL_USE_EMOJI} ${toolName}\n${summary}`;
  const html = `${TOOL_USE_EMOJI} <code>${escapeHtml(toolName)}</code><br/><pre>${escapeHtml(summary)}</pre>`;
  return { body, html };
}

/** Format assistant text output. */
export function formatAssistantText(text: string): { body: string; html: string } {
  const truncated = truncate(text);
  return { body: truncated, html: `<pre>${escapeHtml(truncated)}</pre>` };
}

/** Format a result (success or error). */
export function formatResult(result: {
  success: boolean;
  text?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  errors?: string[];
}): { body: string; html: string } {
  const emoji = result.success ? RESULT_SUCCESS_EMOJI : RESULT_ERROR_EMOJI;
  const status = result.success ? "Completed" : "Failed";

  let body = `${emoji} ${status}`;
  let html = `<b>${emoji} ${status}</b>`;

  if (result.costUsd !== undefined) {
    const cost = `$${result.costUsd.toFixed(4)}`;
    body += ` | ${COST_EMOJI} ${cost}`;
    html += ` | ${COST_EMOJI} ${cost}`;
  }
  if (result.numTurns !== undefined) {
    body += ` | ${result.numTurns} turns`;
    html += ` | ${result.numTurns} turns`;
  }
  if (result.durationMs !== undefined) {
    const secs = (result.durationMs / 1000).toFixed(1);
    body += ` | ${secs}s`;
    html += ` | ${secs}s`;
  }
  if (result.text) {
    const truncated = truncate(result.text);
    body += `\n\n${truncated}`;
    html += `<br/><br/><pre>${escapeHtml(truncated)}</pre>`;
  }
  if (result.errors?.length) {
    const errText = result.errors.join("\n");
    body += `\n\nErrors:\n${errText}`;
    html += `<br/><br/><b>Errors:</b><br/><pre>${escapeHtml(errText)}</pre>`;
  }

  return { body, html };
}

/** Format agent status. */
export function formatStatus(agent: {
  id: string;
  name: string;
  running: boolean;
  sessionId?: string;
  totalCostUsd?: number;
  totalTurns?: number;
}): { body: string; html: string } {
  const runState = agent.running ? "🟢 Running" : "⚫ Stopped";
  let body = `${STATUS_EMOJI} ${agent.name} (${agent.id})\nStatus: ${runState}`;
  let html = `<b>${STATUS_EMOJI} ${agent.name}</b> (<code>${escapeHtml(agent.id)}</code>)<br/>Status: ${runState}`;

  if (agent.sessionId) {
    body += `\nSession: ${agent.sessionId}`;
    html += `<br/>Session: <code>${escapeHtml(agent.sessionId)}</code>`;
  }
  if (agent.totalCostUsd !== undefined) {
    body += `\n${COST_EMOJI} Total cost: $${agent.totalCostUsd.toFixed(4)}`;
    html += `<br/>${COST_EMOJI} Total cost: $${agent.totalCostUsd.toFixed(4)}`;
  }

  return { body, html };
}

/** Extract the most relevant fields from tool input for a compact summary. */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  // Show the most informative fields depending on tool
  const lowerTool = toolName.toLowerCase();

  if (lowerTool.includes("bash") && input.command) {
    return `$ ${input.command}`;
  }
  if (lowerTool.includes("edit") && input.file_path) {
    return `File: ${input.file_path}`;
  }
  if (lowerTool.includes("write") && input.file_path) {
    return `File: ${input.file_path}`;
  }
  if (lowerTool.includes("read") && input.file_path) {
    return `File: ${input.file_path}`;
  }
  if (lowerTool.includes("glob") && input.pattern) {
    return `Pattern: ${input.pattern}`;
  }
  if (lowerTool.includes("grep") && input.pattern) {
    return `Pattern: ${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
  }

  // Generic: show first 3 keys
  const entries = Object.entries(input).slice(0, 3);
  return entries.map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    const truncVal = val.length > 200 ? val.slice(0, 200) + "..." : val;
    return `${k}: ${truncVal}`;
  }).join("\n");
}
