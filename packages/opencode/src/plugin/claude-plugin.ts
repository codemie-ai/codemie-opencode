import z from "zod"
import path from "path"
import type { Hooks } from "@opencode-ai/plugin"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"
import { ConfigMarkdown } from "../config/markdown"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import { Bus } from "../bus"

const log = Log.create({ service: "claude-plugin" })

export const CLAUDE_PLUGIN_PREFIX = "claude-plugin://"

// ── plugin.json manifest schema ──────────────────────────────────────────

const LspServerEntry = z.object({
  command: z.array(z.string()),
  args: z.array(z.string()).optional(),
  extensions: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  initialization: z.record(z.string(), z.any()).optional(),
  disabled: z.boolean().optional(),
})

const PluginManifest = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  commands: z.record(z.string(), z.string()).optional(),
  agents: z.record(z.string(), z.string()).optional(),
  skills: z.array(z.string()).optional(),
  hooks: z.record(z.string(), z.any()).optional(),
  lspServers: z.record(z.string(), LspServerEntry).optional(),
})

export type PluginManifest = z.infer<typeof PluginManifest>

// ── .mcp.json schema (Claude Code format) ────────────────────────────────

const McpJsonEntry = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
})

const McpJson = z.object({
  mcpServers: z.record(z.string(), McpJsonEntry).optional(),
})

// ── helpers ──────────────────────────────────────────────────────────────

function trimExt(file: string): string {
  const ext = path.extname(file)
  return ext.length ? file.slice(0, -ext.length) : file
}

async function loadMarkdownDir(
  dir: string,
  subdir: string,
): Promise<Array<{ name: string; data: Record<string, any>; content: string }>> {
  const results: Array<{ name: string; data: Record<string, any>; content: string }> = []
  const target = path.join(dir, subdir)
  if (!(await Filesystem.exists(target))) return results

  for (const item of await Glob.scan("**/*.md", {
    cwd: target,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch((err) => {
      log.error(`failed to parse ${subdir} markdown`, { path: item, err })
      return undefined
    })
    if (!md) continue

    const relativePath = path.relative(target, item)
    const name = trimExt(relativePath)
    results.push({ name, data: md.data, content: md.content.trim() })
  }
  return results
}

// ── main loader ──────────────────────────────────────────────────────────

/**
 * Load a `.claude-plugin` format plugin directory and return:
 * - hooks: a Hooks object (currently just system prompt transforms for skills)
 * - commands: command definitions to merge into config
 * - agents: agent definitions to merge into config
 * - mcp: MCP server definitions to merge into config
 * - lsp: LSP server definitions to merge into config
 */
export async function loadClaudePlugin(pluginDir: string): Promise<{
  hooks: Hooks
  commands: Record<string, Config.Command>
  agents: Record<string, Config.Agent>
  mcp: Record<string, Config.Mcp>
  lsp: Record<string, object>
}> {
  const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json")
  const raw = await Filesystem.readJson(manifestPath)
  const parsed = PluginManifest.safeParse(raw)
  if (!parsed.success) {
    throw new NamedError.Unknown({
      message: `Invalid .claude-plugin/plugin.json at ${manifestPath}: ${parsed.error.message}`,
    })
  }
  const manifest = parsed.data

  log.info("loading claude-plugin", { name: manifest.name, dir: pluginDir })

  // ── commands ───────────────────────────────────────────────────────
  const commands: Record<string, Config.Command> = {}
  const commandEntries = await loadMarkdownDir(pluginDir, "commands")
  for (const entry of commandEntries) {
    const config = {
      name: entry.name,
      ...entry.data,
      template: entry.content,
    }
    const result = Config.Command.safeParse(config)
    if (result.success) {
      commands[entry.name] = result.data
    } else {
      log.warn("skipping invalid command from claude-plugin", { name: entry.name, plugin: manifest.name })
    }
  }

  // ── agents ─────────────────────────────────────────────────────────
  const agents: Record<string, Config.Agent> = {}
  const agentEntries = await loadMarkdownDir(pluginDir, "agents")
  for (const entry of agentEntries) {
    const config = {
      name: entry.name,
      ...entry.data,
      prompt: entry.content,
    }
    const result = Config.Agent.safeParse(config)
    if (result.success) {
      agents[entry.name] = result.data
    } else {
      log.warn("skipping invalid agent from claude-plugin", { name: entry.name, plugin: manifest.name })
    }
  }

  // ── skills (system prompt additions) ───────────────────────────────
  const skillTexts: string[] = []
  const skillsDir = path.join(pluginDir, "skills")
  if (await Filesystem.exists(skillsDir)) {
    for (const item of await Glob.scan("**/*.md", {
      cwd: skillsDir,
      absolute: true,
      dot: true,
      symlink: true,
    })) {
      const text = await Filesystem.readText(item).catch(() => "")
      if (text.trim()) skillTexts.push(text.trim())
    }
  }
  // Also handle skills declared in the manifest
  if (manifest.skills) {
    for (const skillPath of manifest.skills) {
      const resolved = path.resolve(pluginDir, skillPath)
      const text = await Filesystem.readText(resolved).catch(() => "")
      if (text.trim()) skillTexts.push(text.trim())
    }
  }

  // ── MCP servers from .mcp.json ─────────────────────────────────────
  const mcp: Record<string, Config.Mcp> = {}
  const mcpJsonPath = path.join(pluginDir, ".mcp.json")
  if (await Filesystem.exists(mcpJsonPath)) {
    const mcpRaw = await Filesystem.readJson(mcpJsonPath).catch(() => ({}))
    const mcpParsed = McpJson.safeParse(mcpRaw)
    if (mcpParsed.success && mcpParsed.data.mcpServers) {
      for (const [name, server] of Object.entries(mcpParsed.data.mcpServers)) {
        if (server.disabled) continue
        mcp[name] = {
          type: "local" as const,
          command: [server.command, ...(server.args ?? [])],
          environment: server.env,
        }
      }
    } else {
      log.warn("failed to parse .mcp.json in claude-plugin", { plugin: manifest.name, path: mcpJsonPath })
    }
  }

  // ── LSP servers from manifest ──────────────────────────────────────
  const lsp: Record<string, object> = {}
  if (manifest.lspServers) {
    for (const [name, server] of Object.entries(manifest.lspServers)) {
      if (server.disabled) continue
      lsp[name] = {
        command: [...server.command, ...(server.args ?? [])],
        extensions: server.extensions,
        env: server.env,
        initialization: server.initialization,
      }
    }
  }

  // ── build hooks ────────────────────────────────────────────────────
  const hooks: Hooks = {}

  if (skillTexts.length > 0) {
    hooks["experimental.chat.system.transform"] = async (_input, output) => {
      for (const text of skillTexts) {
        output.system.push(text)
      }
    }
  }

  return { hooks, commands, agents, mcp, lsp }
}
