/**
 * Team-based JSONL Transcript Scanner
 * Uses ~/.claude/teams/{teamName}/config.json as the source of truth for agent lists.
 * Correlates team members to their JSONL transcript files for live status tracking.
 *
 * Flow:
 *   1. Read team config → get authoritative member list with model, role, etc.
 *   2. Derive JSONL project directory from member cwd
 *   3. Scan JSONL files to find sessions belonging to each member
 *   4. Tail new lines incrementally for live status updates
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TAIL_INTERVAL_MS = 1000;
const SCAN_INTERVAL_MS = 3000;
const TEAMS_DIR = join(homedir(), ".claude", "teams");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamConfig {
  name: string;
  description?: string;
  leadAgentId?: string;
  leadSessionId?: string;
  members: TeamMember[];
}

interface TeamMember {
  agentId: string;
  name: string;
  agentType: string;
  model: string;
  isActive?: boolean;
  color?: string;
  cwd?: string;
  tmuxPaneId?: string;
  joinedAt?: number;
}

interface TrackedAgent {
  agentName: string;
  displayName: string; // shown in UI / agent_message.from (may differ from id)
  teamName: string;
  agentType: string;
  model: string;
  sessionId: string;
  filePath: string;
  fileOffset: number;
  lineBuffer: string;
  lastTool: string;
  lastActivity: number;
  status: "working" | "thinking" | "idle" | "blocked" | "reviewing";
  task: string;
  lastActiveTask: string; // Remember last working/thinking task for idle display
  color?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  lastContextUsed: number; // input tokens of last turn = current context size
  actualModel: string; // real model from JSONL (may differ from config)
  lastReplyText: string; // assistant text output to forward as chat reply
  hasTmux: boolean;
  needsYou?: boolean;
  waitingFor?: string;
}

export interface AgentMessage {
  from: string;
  to: string;
  text: string;
  time: string;
}

type StateCallback = (agentId: string, update: Record<string, unknown>) => void;
type ReplyCallback = (agentId: string, reply: string) => void;
type MessageCallback = (msg: AgentMessage) => void;

const NEEDS_YOU_STATUSES = new Set([
  "waiting",
  "blocked",
  "needs_user",
  "needs_trust",
]);

/** True when the session is waiting on a human. */
export function needsYou(status?: string, waitingFor?: string): boolean {
  if (typeof waitingFor === "string" && waitingFor.length > 0) return true;
  return typeof status === "string" && NEEDS_YOU_STATUSES.has(status);
}

/** Extract agent-to-agent SendMessage events from an assistant JSONL record. */
export function extractSendMessages(
  rec: Record<string, unknown>,
  from: string,
  time = new Date().toISOString(),
): AgentMessage[] {
  if (rec.type !== "assistant") return [];
  const msg = rec.message as Record<string, unknown> | undefined;
  if (!msg || !Array.isArray(msg.content)) return [];
  const events: AgentMessage[] = [];
  for (const block of msg.content as Record<string, unknown>[]) {
    if (block.type !== "tool_use" || block.name !== "SendMessage") continue;
    const input = (block.input as Record<string, unknown>) || {};
    const raw = String(input.message ?? "");
    const text = (raw.split("\n")[0] ?? "").slice(0, 200);
    const at = typeof rec.timestamp === "string" ? rec.timestamp : time;
    events.push({ from, to: String(input.to), text, time: at });
  }
  return events;
}

function sanitizeAgentId(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

const tracked = new Map<string, TrackedAgent>();
let scanTimer: ReturnType<typeof setInterval> | null = null;
let tailTimer: ReturnType<typeof setInterval> | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/** List all available teams from ~/.claude/teams/ */
export function listTeams(): {
  name: string;
  description?: string;
  memberCount: number;
}[] {
  if (!existsSync(TEAMS_DIR)) return [];
  const teams: { name: string; description?: string; memberCount: number }[] =
    [];
  try {
    const dirs = readdirSync(TEAMS_DIR);
    for (const dir of dirs) {
      const configPath = join(TEAMS_DIR, dir, "config.json");
      if (!existsSync(configPath)) continue;
      try {
        const config: TeamConfig = JSON.parse(readFileSync(configPath, "utf8"));
        if (!isLeadAlive(config)) continue;
        teams.push({
          name: config.name || dir,
          description: config.description,
          memberCount: config.members?.length || 0,
        });
      } catch {}
    }
  } catch {}
  return teams;
}

/** Check if a team's lead session process is still running */
export function isLeadAlive(
  config: TeamConfig,
  sessionsDir = SESSIONS_DIR,
): boolean {
  if (!config.leadSessionId) return false;
  // Claude Code keeps one sessions/<pid>.json per live session; the session id
  // is not on the command line of a plain `claude` launch.
  try {
    for (const f of readdirSync(sessionsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(readFileSync(join(sessionsDir, f), "utf8"));
        if (s.sessionId !== config.leadSessionId) continue;
        process.kill(s.pid, 0); // throws if the process is gone
        return true;
      } catch {}
    }
  } catch {}
  // Older Claude Code: session id passed on the command line
  try {
    const result = Bun.spawnSync({
      cmd: ["pgrep", "-f", config.leadSessionId],
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Read team config from ~/.claude/teams/{teamName}/config.json */
export function getTeamConfig(teamName: string): TeamConfig | null {
  const configPath = join(TEAMS_DIR, teamName, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Start scanning for a specific team.
 * Reads team config for authoritative member list, then finds and tails JSONL files.
 */
export function startScanner(
  teamName: string,
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
  onMessage?: MessageCallback,
) {
  const config = getTeamConfig(teamName);
  if (!config) {
    console.error(`[SCANNER] Team not found: ${teamName}`);
    return;
  }

  console.log(
    `[SCANNER] Starting for team: ${teamName} (${config.members.length} members)`,
  );

  // Track known member names to detect new joiners
  const knownMembers = new Set<string>();
  let initialRegistrationDone = false;

  function registerMembers(cfg: TeamConfig) {
    for (const member of cfg.members) {
      if (knownMembers.has(member.name)) continue;
      knownMembers.add(member.name);
      const role = mapAgentType(member.agentType);
      onStateUpdate(member.name, {
        id: member.name,
        role,
        name: member.name,
        status: "idle",
        task: "Registered from team config",
        model: member.model || "unknown",
        color: member.color,
      });
      if (initialRegistrationDone) {
        console.log(`[SCANNER] New member joined: ${member.name} (${role})`);
      }
    }
  }

  // Register all current members
  registerMembers(config);
  initialRegistrationDone = true;

  // Initial JSONL correlation
  correlateAndTail(config, onStateUpdate, onReply, onMessage);

  // Periodic scan — re-read config to pick up new/removed members
  scanTimer = setInterval(() => {
    const freshConfig = getTeamConfig(teamName);
    if (!freshConfig) return;
    registerMembers(freshConfig);

    // Detect removed members (dismissed teammates)
    const currentNames = new Set(freshConfig.members.map((m) => m.name));
    for (const name of knownMembers) {
      if (!currentNames.has(name)) {
        knownMembers.delete(name);
        tracked.delete(name);
        console.log(`[SCANNER] Member left: ${name}`);
        onStateUpdate(name, {
          id: name,
          role: "removed",
          name,
          status: "idle",
          task: "__removed__",
        });
      }
    }

    correlateAndTail(freshConfig, onStateUpdate, onReply, onMessage);
  }, SCAN_INTERVAL_MS);

  // Periodic tail for live status
  tailTimer = setInterval(() => {
    for (const [, agent] of tracked) {
      readNewLines(agent, onStateUpdate, onReply, onMessage);
    }
  }, TAIL_INTERVAL_MS);
}

export function stopScanner() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (tailTimer) {
    clearInterval(tailTimer);
    tailTimer = null;
  }
  tracked.clear();
  console.log("[SCANNER] Stopped");
}

export function getTrackedAgents(): Map<string, TrackedAgent> {
  return tracked;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/** Derive the JSONL project directory from a member's cwd */
function cwdToProjectDir(cwd: string): string {
  // Claude Code stores JSONL at ~/.claude/projects/{dirName}/
  // where dirName is the cwd with all non-alphanumeric chars replaced by -
  const dirName = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(PROJECTS_DIR, dirName);
}

/** Find JSONL sessions for team members and set up tailing */
function correlateAndTail(
  config: TeamConfig,
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
  onMessage?: MessageCallback,
) {
  // Collect unique project dirs from member cwds
  const projectDirs = new Set<string>();
  for (const member of config.members) {
    if (member.cwd) {
      projectDirs.add(cwdToProjectDir(member.cwd));
    }
  }

  // Build a name→member lookup
  const memberByName = new Map<string, TeamMember>();
  for (const member of config.members) {
    memberByName.set(member.name, member);
  }

  // Handle lead session directly via leadSessionId (no teamName/agentName in JSONL)
  if (config.leadSessionId && !tracked.has(config.leadSessionId)) {
    const leadMember = config.members.find((m) => m.agentType === "team-lead");
    if (leadMember) {
      for (const projectDir of projectDirs) {
        const leadPath = join(projectDir, `${config.leadSessionId}.jsonl`);
        if (existsSync(leadPath)) {
          const stat = statSync(leadPath);
          const agent: TrackedAgent = {
            agentName: leadMember.name,
            displayName: leadMember.name,
            teamName: config.name,
            agentType: leadMember.agentType,
            model: leadMember.model,
            sessionId: config.leadSessionId,
            filePath: leadPath,
            fileOffset: Math.max(0, stat.size - 64 * 1024),
            lineBuffer: "",
            lastTool: "",
            lastActivity: Date.now(),
            status: "idle",
            task: "Lead session",
            lastActiveTask: "",
            color: leadMember.color,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            lastContextUsed: 0,
            actualModel: "",
            lastReplyText: "",
            hasTmux: true,
          };
          tracked.set(config.leadSessionId, agent);
          console.log(
            `[SCANNER] Linked ${leadMember.name} → lead session ${config.leadSessionId.slice(0, 8)}`,
          );
          readNewLines(agent, onStateUpdate, onReply, onMessage);
          break;
        }
      }
    }
  }

  // Scan each project dir for JSONL files (teammates)
  for (const projectDir of projectDirs) {
    if (!existsSync(projectDir)) continue;

    let files: string[];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      if (tracked.has(sessionId)) continue;

      const filePath = join(projectDir, file);
      const identity = identifyAgent(filePath);
      if (!identity) continue;
      if (identity.teamName !== config.name) continue;

      // Must be a known member
      const member = memberByName.get(identity.agentName);
      if (!member) continue;

      // Check if we already track this agent name (keep newest session)
      const existingEntry = [...tracked.values()].find(
        (a) => a.agentName === identity.agentName && a.teamName === config.name,
      );
      if (existingEntry) {
        try {
          const existingStat = statSync(existingEntry.filePath);
          const newStat = statSync(filePath);
          if (newStat.mtimeMs <= existingStat.mtimeMs) continue;
          tracked.delete(existingEntry.sessionId);
        } catch {
          continue;
        }
      }

      const stat = statSync(filePath);
      const agent: TrackedAgent = {
        agentName: identity.agentName,
        displayName: identity.agentName,
        teamName: config.name,
        agentType: member.agentType,
        model: member.model,
        sessionId,
        filePath,
        fileOffset: Math.max(0, stat.size - 64 * 1024),
        lineBuffer: "",
        lastTool: "",
        lastActivity: Date.now(),
        status: "idle",
        task: "Discovered from JSONL",
        lastActiveTask: "",
        color: member.color,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        lastContextUsed: 0,
        actualModel: "",
        lastReplyText: "",
        hasTmux: true,
      };

      tracked.set(sessionId, agent);
      console.log(
        `[SCANNER] Linked ${identity.agentName} → session ${sessionId.slice(0, 8)}`,
      );

      // Read recent lines immediately to get current status
      readNewLines(agent, onStateUpdate, onReply, onMessage);
    }
  }
}

function identifyAgent(
  filePath: string,
): { agentName: string; teamName: string } | null {
  try {
    const stat = statSync(filePath);
    const readSize = Math.min(stat.size, 16 * 1024);
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(readSize);
    const bytesRead = readSync(fd, buf, 0, readSize, 0);
    closeSync(fd);

    const text = buf.toString("utf-8", 0, bytesRead);
    const lines = text.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.teamName && rec.agentName) {
          return { agentName: rec.agentName, teamName: rec.teamName };
        }
      } catch {
        const teamMatch = line.match(/"teamName"\s*:\s*"([^"]+)"/);
        const agentMatch = line.match(/"agentName"\s*:\s*"([^"]+)"/);
        if (teamMatch && agentMatch) {
          return { agentName: agentMatch[1], teamName: teamMatch[1] };
        }
      }
    }
  } catch {}
  return null;
}

function readNewLines(
  agent: TrackedAgent,
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
  onMessage?: MessageCallback,
) {
  try {
    const stat = statSync(agent.filePath);
    if (stat.size <= agent.fileOffset) return;

    const readSize = Math.min(stat.size - agent.fileOffset, 512 * 1024);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(agent.filePath, "r");
    readSync(fd, buf, 0, readSize, agent.fileOffset);
    closeSync(fd);
    agent.fileOffset += readSize;

    const text = agent.lineBuffer + buf.toString("utf-8");
    const lines = text.split("\n");
    agent.lineBuffer = lines.pop() || "";

    let stateChanged = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const changed = processRecord(agent, rec, onMessage);
        if (changed) stateChanged = true;

        // Emit reply when assistant produces text output
        if (onReply && agent.lastReplyText) {
          onReply(agent.agentName, agent.lastReplyText);
          agent.lastReplyText = "";
        }
      } catch {}
    }

    if (stateChanged) {
      const totalTokens =
        agent.inputTokens +
        agent.outputTokens +
        agent.cacheReadTokens +
        agent.cacheCreateTokens;
      const update: Record<string, unknown> = {
        id: agent.agentName,
        role: mapAgentType(agent.agentType),
        name: agent.displayName,
        status: agent.status,
        task: agent.task,
        model: agent.actualModel || agent.model,
        color: agent.color,
        tokens: totalTokens > 0 ? totalTokens : undefined,
        contextUsed:
          agent.lastContextUsed > 0 ? agent.lastContextUsed : undefined,
        contextMax: getContextMax(agent.actualModel || agent.model),
        hasTmux: agent.hasTmux,
      };
      if (agent.agentType === "owner") {
        update.needsYou = !!agent.needsYou;
        update.waitingFor = agent.waitingFor;
      }
      onStateUpdate(agent.agentName, update);
    }
  } catch {}
}

function processRecord(
  agent: TrackedAgent,
  rec: Record<string, unknown>,
  onMessage?: MessageCallback,
): boolean {
  const type = rec.type as string;
  agent.lastActivity = Date.now();

  if (type === "assistant") {
    const msg = rec.message as Record<string, unknown>;
    if (!msg) return false;

    // Extract real model from JSONL
    const msgModel = msg.model as string;
    if (msgModel) {
      agent.actualModel = msgModel;
    }

    // Extract token usage from assistant message
    const usage = msg.usage as Record<string, unknown>;
    if (usage) {
      const inputThis = (usage.input_tokens as number) || 0;
      const cacheRead = (usage.cache_read_input_tokens as number) || 0;
      const cacheCreate = (usage.cache_creation_input_tokens as number) || 0;
      const outputThis = (usage.output_tokens as number) || 0;

      agent.inputTokens += inputThis;
      agent.outputTokens += outputThis;
      agent.cacheReadTokens += cacheRead;
      agent.cacheCreateTokens += cacheCreate;

      // Last turn's total input = current context window usage
      agent.lastContextUsed = inputThis + cacheRead + cacheCreate;
    }

    const content = msg.content;
    if (!Array.isArray(content)) return false;

    if (onMessage) {
      for (const event of extractSendMessages(rec, agent.displayName)) {
        onMessage(event);
      }
    }

    // Extract text blocks first (for reply emission)
    const texts = content.filter(
      (b: Record<string, unknown>) => b.type === "text",
    );
    if (texts.length > 0) {
      const text = ((texts[0] as Record<string, unknown>).text as string) || "";
      if (text.trim()) {
        agent.lastReplyText = text;
      }
    }

    const tools = content.filter(
      (b: Record<string, unknown>) => b.type === "tool_use",
    );
    if (tools.length > 0) {
      const toolName =
        ((tools[0] as Record<string, unknown>).name as string) || "tool";
      const input =
        ((tools[0] as Record<string, unknown>).input as Record<
          string,
          unknown
        >) || {};
      agent.lastTool = toolName;
      agent.status = "working";
      agent.task = formatToolTask(toolName, input);
      agent.lastActiveTask = agent.task;
      return true;
    }

    if (texts.length > 0) {
      const text = ((texts[0] as Record<string, unknown>).text as string) || "";
      agent.status = "thinking";
      agent.task = text.slice(0, 80).replace(/\n/g, " ") || "Thinking...";
      agent.lastActiveTask = agent.task;
      return true;
    }
  }

  // Tool results are intermediate artifacts — skip entirely.
  // Only actual assistant text blocks should appear as replies.
  if (type === "user") {
    return false;
  }

  if (type === "progress") {
    const data = rec.data as Record<string, unknown>;
    if (typeof data === "object" && data !== null) {
      const progressType = data.type as string;
      if (progressType === "bash_progress" || progressType === "mcp_progress") {
        agent.status = "working";
        return false;
      }
    }
  }

  if (type === "system") {
    const subtype = rec.subtype as string;
    if (subtype === "turn_duration" || subtype === "stop_hook_summary") {
      agent.status = "idle";
      // Keep last meaningful task instead of generic "Waiting for input"
      agent.task = agent.lastActiveTask
        ? `Idle — ${agent.lastActiveTask}`
        : "Waiting for input";
      return true;
    }
  }

  return false;
}

function formatToolTask(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Read":
      return `Reading: ${shortenPath((input.file_path as string) || "")}`;
    case "Write":
      return `Writing: ${shortenPath((input.file_path as string) || "")}`;
    case "Edit":
      return `Editing: ${shortenPath((input.file_path as string) || "")}`;
    case "Bash":
      return `Running: ${((input.command as string) || "").slice(0, 40)}`;
    case "Grep":
      return `Searching: ${((input.pattern as string) || "").slice(0, 30)}`;
    case "Glob":
      return `Finding: ${((input.pattern as string) || "").slice(0, 30)}`;
    case "Agent":
      return `Delegating: ${((input.description as string) || "").slice(0, 40)}`;
    case "SendMessage":
      return "Messaging teammate";
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return "Managing tasks";
    case "TodoWrite":
      return "Updating TODO list";
    default:
      return `Using ${toolName}`;
  }
}

function shortenPath(p: string): string {
  if (!p) return "...";
  const parts = p.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : p;
}

/** Get context window max tokens for a model */
function getContextMax(model: string): number {
  if (model.includes("haiku")) return 200000;
  if (model.includes("sonnet")) return 200000;
  if (model.includes("opus")) return 200000;
  return 200000;
}

/** Map team config agentType to UI role (keyword-based matching) */
function mapAgentType(agentType: string): string {
  const t = agentType.toLowerCase();
  if (t.includes("lead")) return "lead";
  if (t.includes("owner")) return "owner";
  if (t.includes("security")) return "security";
  if (t.includes("architect")) return "architect";
  if (t.includes("explor")) return "explorer";
  if (t.includes("qa")) return "qa";
  if (t.includes("pm")) return "pm";
  if (t.includes("dev")) return "dev";
  return "dev";
}

// ─── Owner Session Discovery ──────────────────────────────────────────────────

export interface OwnerSession {
  pid: number;
  cwd: string;
  projectName: string;
  tty: string;
  sessionId: string;
  tmuxPane?: string;
  jsonlPath?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
}

let ownerScanTimer: ReturnType<typeof setInterval> | null = null;
let ownerTailTimer: ReturnType<typeof setInterval> | null = null;
const ownerTracked = new Map<string, TrackedAgent>();
const ownerPaneMap = new Map<string, string>(); // agentName → tmuxPaneId

/** Look up the tmux pane for an owner agent by name */
export function getOwnerPane(agentName: string): string | null {
  return ownerPaneMap.get(agentName) || null;
}

function ownerDisplayName(session: OwnerSession): string {
  return session.name || session.projectName;
}

function ownerAgentId(session: OwnerSession): string {
  return `owner-${sanitizeAgentId(ownerDisplayName(session))}`;
}

/** Resolve JSONL path: prefer registry path, else newest non-team .jsonl by mtime. */
function resolveOwnerJsonl(session: OwnerSession): string | null {
  if (session.jsonlPath && existsSync(session.jsonlPath))
    return session.jsonlPath;
  const projectDir = cwdToProjectDir(session.cwd);
  if (!existsSync(projectDir)) return null;
  try {
    const files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        mtime: statSync(join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      const filePath = join(projectDir, file.name);
      const identity = identifyAgent(filePath);
      if (identity?.teamName) continue;
      return filePath;
    }
  } catch {}
  return null;
}

/** Build tmux tty→paneId and pid→paneId mappings */
function buildTmuxMaps(): {
  ttyMap: Map<string, string>;
  pidMap: Map<number, string>;
} {
  const ttyMap = new Map<string, string>();
  const pidMap = new Map<number, string>();
  try {
    const tmuxResult = Bun.spawnSync({
      cmd: [
        "tmux",
        "list-panes",
        "-a",
        "-F",
        "#{pane_tty} #{pane_id} #{pane_pid}",
      ],
    });
    if (tmuxResult.exitCode === 0) {
      for (const line of tmuxResult.stdout.toString().trim().split("\n")) {
        const parts = line.split(" ");
        if (parts.length >= 3) {
          const [tty, paneId, panePid] = parts;
          if (tty && paneId) ttyMap.set(tty, paneId);
          if (panePid && paneId)
            pidMap.set(Number.parseInt(panePid, 10), paneId);
        }
      }
    }
  } catch {}
  return { ttyMap, pidMap };
}

/** Walk up the process tree to find if PID is a descendant of any tmux pane */
function findTmuxPaneByAncestry(
  pid: number,
  pidMap: Map<number, string>,
): string | undefined {
  let current = pid;
  const visited = new Set<number>();
  for (let i = 0; i < 10; i++) {
    if (visited.has(current) || current <= 1) break;
    visited.add(current);
    const pane = pidMap.get(current);
    if (pane) return pane;
    // Walk to parent
    try {
      const r = Bun.spawnSync({
        cmd: ["ps", "-o", "ppid=", "-p", String(current)],
      });
      const ppid = Number.parseInt(r.stdout.toString().trim(), 10);
      if (Number.isNaN(ppid) || ppid <= 1) break;
      current = ppid;
    } catch {
      break;
    }
  }
  return undefined;
}

/** Discover standalone Claude Code sessions (not part of a team) */
export function discoverOwnerSessions(): OwnerSession[] {
  const sessions: OwnerSession[] = [];
  if (!existsSync(SESSIONS_DIR)) return sessions;

  const { ttyMap, pidMap } = buildTmuxMaps();

  try {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const { pid, sessionId, cwd, kind, name, status, waitingFor } =
          JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8"));
        if (kind !== undefined && kind !== "interactive") continue;
        if (!sessionId) continue;
        try {
          process.kill(pid, 0);
        } catch {
          continue;
        }

        const ttyRaw = Bun.spawnSync({
          cmd: ["ps", "-o", "tty=", "-p", String(pid)],
        })
          .stdout.toString()
          .trim();
        const tty = !ttyRaw || ttyRaw === "?" ? "" : `/dev/${ttyRaw}`;

        const projectName = cwd.split("/").pop() || cwd;
        const tmuxPane = ttyMap.get(tty) || findTmuxPaneByAncestry(pid, pidMap);

        const candidate = join(cwdToProjectDir(cwd), `${sessionId}.jsonl`);
        const session: OwnerSession = {
          pid,
          cwd,
          projectName,
          tty,
          sessionId,
          tmuxPane,
        };
        if (typeof name === "string" && name) session.name = name;
        if (typeof status === "string") session.status = status;
        if (typeof waitingFor === "string") session.waitingFor = waitingFor;
        if (existsSync(candidate)) session.jsonlPath = candidate;
        sessions.push(session);
      } catch {}
    }
  } catch {}
  return sessions;
}

/** Register one owner session for tracking (shared by startup + periodic rescan). */
function registerOwnerSession(
  session: OwnerSession,
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
  onMessage?: MessageCallback,
): boolean {
  const jsonlPath = resolveOwnerJsonl(session);
  if (!jsonlPath) return false;
  session.jsonlPath = jsonlPath;

  const sessionId =
    session.sessionId ||
    jsonlPath.split("/").pop()?.replace(".jsonl", "") ||
    "";
  if (!sessionId || ownerTracked.has(sessionId)) return false;

  const agentName = ownerAgentId(session);
  const displayName = ownerDisplayName(session);
  const waiting = needsYou(session.status, session.waitingFor);
  const stat = statSync(jsonlPath);

  if (session.tmuxPane) {
    ownerPaneMap.set(agentName, session.tmuxPane);
  }

  onStateUpdate(agentName, {
    id: agentName,
    role: "owner",
    name: displayName,
    status: "idle",
    task: session.cwd,
    model: "unknown",
    hasTmux: !!session.tmuxPane,
    needsYou: waiting,
    waitingFor: session.waitingFor,
  });

  const agent: TrackedAgent = {
    agentName,
    displayName,
    teamName: "__owner__",
    agentType: "owner",
    model: "unknown",
    sessionId,
    filePath: jsonlPath,
    fileOffset: Math.max(0, stat.size - 64 * 1024),
    lineBuffer: "",
    lastTool: "",
    lastActivity: Date.now(),
    status: "idle",
    task: session.cwd,
    lastActiveTask: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    lastContextUsed: 0,
    actualModel: "",
    lastReplyText: "",
    hasTmux: !!session.tmuxPane,
    needsYou: waiting,
    waitingFor: session.waitingFor,
  };

  ownerTracked.set(sessionId, agent);
  console.log(
    `[SCANNER] Owner session: ${agentName} (${displayName}) → ${sessionId.slice(0, 8)}`,
  );
  readNewLines(agent, onStateUpdate, onReply, onMessage);
  return true;
}

/** Start scanning owner (standalone) sessions for live status */
export function startOwnerScanner(
  sessions: OwnerSession[],
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
  onMessage?: MessageCallback,
) {
  stopOwnerScanner();

  for (const session of sessions) {
    registerOwnerSession(session, onStateUpdate, onReply, onMessage);
  }

  // Tail timer for live updates
  ownerTailTimer = setInterval(() => {
    for (const [, agent] of ownerTracked) {
      readNewLines(agent, onStateUpdate, onReply, onMessage);
    }
  }, TAIL_INTERVAL_MS);

  // Periodic rescan for new/ended sessions + needsYou/name drift
  ownerScanTimer = setInterval(() => {
    const current = discoverOwnerSessions();
    const currentIds = new Set(current.map((s) => s.sessionId));

    // Update hasTmux / name / needsYou on already-tracked agents
    for (const session of current) {
      const agent = ownerTracked.get(session.sessionId);
      if (!agent) continue;

      if (session.tmuxPane && !agent.hasTmux) {
        agent.hasTmux = true;
        ownerPaneMap.set(agent.agentName, session.tmuxPane);
        onStateUpdate(agent.agentName, {
          id: agent.agentName,
          hasTmux: true,
        });
        console.log(
          `[SCANNER] Updated tmux pane for ${agent.agentName}: ${session.tmuxPane}`,
        );
      }

      const displayName = ownerDisplayName(session);
      const waiting = needsYou(session.status, session.waitingFor);
      const waitingFor = session.waitingFor;
      if (
        displayName !== agent.displayName ||
        waiting !== !!agent.needsYou ||
        waitingFor !== agent.waitingFor
      ) {
        agent.displayName = displayName;
        agent.needsYou = waiting;
        agent.waitingFor = waitingFor;
        onStateUpdate(agent.agentName, {
          id: agent.agentName,
          name: displayName,
          needsYou: waiting,
          waitingFor,
        });
      }
    }

    // Register newly discovered sessions
    for (const session of current) {
      if (ownerTracked.has(session.sessionId)) continue;
      registerOwnerSession(session, onStateUpdate, onReply, onMessage);
    }

    // Remove tracked agents whose sessions disappeared
    for (const [sid, agent] of ownerTracked) {
      if (currentIds.has(sid)) continue;
      ownerTracked.delete(sid);
      ownerPaneMap.delete(agent.agentName);
      console.log(`[SCANNER] Owner session left: ${agent.agentName}`);
      onStateUpdate(agent.agentName, {
        id: agent.agentName,
        role: "removed",
        name: agent.displayName,
        status: "idle",
        task: "__removed__",
      });
    }
  }, SCAN_INTERVAL_MS);
}

export function stopOwnerScanner() {
  if (ownerScanTimer) {
    clearInterval(ownerScanTimer);
    ownerScanTimer = null;
  }
  if (ownerTailTimer) {
    clearInterval(ownerTailTimer);
    ownerTailTimer = null;
  }
  ownerTracked.clear();
  ownerPaneMap.clear();
  console.log("[SCANNER] Owner scanner stopped");
}
