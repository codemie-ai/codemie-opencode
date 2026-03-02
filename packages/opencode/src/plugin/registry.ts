import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"

const log = Log.create({ service: "plugin-registry" })

export namespace PluginRegistry {
  export type RemotePlugin = {
    name: string
    description: string
    source: string
    sourcePath: string
  }

  function parseSource(source: string): {
    owner: string
    repo: string
    basePaths: string[]
  } {
    const parts = source.split("/")
    if (parts.length < 2) {
      throw new Error(`Invalid source format: "${source}". Expected "owner/repo" or "owner/repo/path"`)
    }
    const owner = parts[0]
    const repo = parts[1]
    if (parts.length > 2) {
      return { owner, repo, basePaths: [parts.slice(2).join("/")] }
    }
    // For the official repo, scan both known directories
    if (owner === "anthropics" && repo === "claude-plugins-official") {
      return { owner, repo, basePaths: ["plugins", "external_plugins"] }
    }
    return { owner, repo, basePaths: ["plugins"] }
  }

  function githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "opencode-plugin-registry",
    }
    const token = process.env.GITHUB_TOKEN
    if (token) {
      headers["Authorization"] = `Bearer ${token}`
    }
    return headers
  }

  async function fetchJson(url: string): Promise<any> {
    const response = await fetch(url, { headers: githubHeaders() })
    if (response.status === 403) {
      const remaining = response.headers.get("X-RateLimit-Remaining")
      if (remaining === "0") {
        throw new Error("GitHub API rate limit exceeded. Set GITHUB_TOKEN to increase the limit.")
      }
    }
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} for ${url}`)
    }
    return response.json()
  }

  export async function listRemote(source: string): Promise<RemotePlugin[]> {
    const { owner, repo, basePaths } = parseSource(source)
    const plugins: RemotePlugin[] = []

    for (const basePath of basePaths) {
      const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${basePath}`
      let entries: any[]
      try {
        entries = await fetchJson(contentsUrl)
      } catch (e) {
        log.warn("failed to list source directory", {
          source,
          path: basePath,
          error: e instanceof Error ? e.message : String(e),
        })
        continue
      }

      if (!Array.isArray(entries)) continue

      const dirs = entries.filter((e: any) => e.type === "dir")

      const results = await Promise.allSettled(
        dirs.map(async (dir: any) => {
          const manifestUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${basePath}/${dir.name}/.claude-plugin/plugin.json`
          try {
            const response = await fetch(manifestUrl, {
              headers: {
                "User-Agent": "opencode-plugin-registry",
                ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
              },
            })
            if (!response.ok) {
              log.debug("no plugin.json found", { plugin: dir.name, status: response.status })
              return null
            }
            const manifest = await response.json()
            return {
              name: manifest.name || dir.name,
              description: manifest.description || "",
              source,
              sourcePath: `${basePath}/${dir.name}`,
            } as RemotePlugin
          } catch {
            return null
          }
        }),
      )

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          plugins.push(result.value)
        }
      }
    }

    return plugins
  }

  export async function install(source: string, pluginName: string, targetDir: string): Promise<void> {
    const { owner, repo, basePaths } = parseSource(source)

    // Find the plugin in the source
    let pluginPath: string | undefined
    for (const basePath of basePaths) {
      const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${basePath}`
      try {
        const entries = await fetchJson(contentsUrl)
        if (!Array.isArray(entries)) continue
        const match = entries.find((e: any) => e.type === "dir" && e.name === pluginName)
        if (match) {
          pluginPath = `${basePath}/${pluginName}`
          break
        }
      } catch {
        continue
      }
    }

    if (!pluginPath) {
      throw new Error(`Plugin "${pluginName}" not found in source "${source}"`)
    }

    await downloadDir(owner, repo, pluginPath, targetDir)
  }

  async function downloadDir(owner: string, repo: string, remotePath: string, localDir: string): Promise<void> {
    const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${remotePath}`
    const entries = await fetchJson(contentsUrl)

    if (!Array.isArray(entries)) {
      throw new Error(`Expected directory listing for ${remotePath}`)
    }

    await fs.mkdir(localDir, { recursive: true })

    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name)
      if (entry.type === "file" && entry.download_url) {
        const response = await fetch(entry.download_url, {
          headers: {
            "User-Agent": "opencode-plugin-registry",
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
          },
        })
        if (!response.ok) {
          log.warn("failed to download file", { path: entry.path, status: response.status })
          continue
        }
        const content = await response.arrayBuffer()
        await fs.writeFile(localPath, Buffer.from(content))
      } else if (entry.type === "dir") {
        await downloadDir(owner, repo, entry.path, localPath)
      }
    }
  }

  export async function listInstalled(opencodeDir: string): Promise<string[]> {
    const pluginsDir = path.join(opencodeDir, "plugins")
    if (!(await Filesystem.exists(pluginsDir))) return []

    const entries = await fs.readdir(pluginsDir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  }
}
