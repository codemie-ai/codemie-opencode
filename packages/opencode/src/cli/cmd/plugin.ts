import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { Instance } from "../../project/instance"
import { PluginRegistry } from "../../plugin/registry"
import path from "path"
import fs from "fs/promises"

export const PluginCommand = cmd({
  command: "plugin",
  describe: "manage plugins",
  builder: (yargs) =>
    yargs.command(PluginListCommand).command(PluginInstallCommand).command(PluginRemoveCommand).demandCommand(),
  async handler() {},
})

const PluginListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list available plugins from configured sources",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Plugins")

        const config = await Config.get()
        const sources = config.pluginSources ?? []

        if (sources.length === 0) {
          prompts.log.warn("No plugin sources configured")
          prompts.log.info(`Add sources to opencode.json:\n  "pluginSources": ["anthropics/claude-plugins-official"]`)
          prompts.outro("Done")
          return
        }

        const opencodeDir = path.join(Instance.worktree, ".opencode")
        const installed = await PluginRegistry.listInstalled(opencodeDir)

        let total = 0
        for (const source of sources) {
          prompts.log.step(`Source: ${source}`)

          try {
            const plugins = await PluginRegistry.listRemote(source)
            if (plugins.length === 0) {
              prompts.log.warn("  No plugins found")
              continue
            }

            for (const plugin of plugins) {
              const isInstalled = installed.includes(plugin.name)
              const icon = isInstalled ? "✓" : "○"
              const status = isInstalled ? " (installed)" : ""
              prompts.log.info(
                `  ${icon} ${plugin.name}${UI.Style.TEXT_DIM}${status}\n    ${plugin.description}${UI.Style.TEXT_NORMAL}`,
              )
              total++
            }
          } catch (e) {
            prompts.log.error(`  Failed to fetch: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        prompts.outro(`${total} plugin(s) available`)
      },
    })
  },
})

const PluginInstallCommand = cmd({
  command: "install <name>",
  describe: "install a plugin from configured sources",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the plugin to install",
        type: "string",
        demandOption: true,
      })
      .option("source", {
        describe: "specific source repo (owner/repo) to install from",
        type: "string",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Install Plugin")

        const config = await Config.get()
        const sources = args.source ? [args.source] : (config.pluginSources ?? [])

        if (sources.length === 0) {
          prompts.log.error("No plugin sources configured")
          prompts.log.info(`Add sources to opencode.json:\n  "pluginSources": ["anthropics/claude-plugins-official"]`)
          prompts.outro("Done")
          return
        }

        const pluginName = args.name
        const opencodeDir = path.join(Instance.worktree, ".opencode")
        const targetDir = path.join(opencodeDir, "plugins", pluginName)

        // Check if already installed
        const installed = await PluginRegistry.listInstalled(opencodeDir)
        if (installed.includes(pluginName)) {
          const confirm = await prompts.confirm({
            message: `Plugin "${pluginName}" is already installed. Reinstall?`,
          })
          if (prompts.isCancel(confirm) || !confirm) {
            prompts.outro("Cancelled")
            return
          }
          await fs.rm(targetDir, { recursive: true, force: true })
        }

        // Search sources for the plugin
        const spinner = prompts.spinner()
        spinner.start(`Searching for plugin "${pluginName}"...`)

        let foundSource: string | undefined
        for (const source of sources) {
          try {
            const plugins = await PluginRegistry.listRemote(source)
            if (plugins.some((p) => p.name === pluginName)) {
              foundSource = source
              break
            }
          } catch {
            continue
          }
        }

        if (!foundSource) {
          spinner.stop(`Plugin "${pluginName}" not found in any configured source`, 1)
          prompts.outro("Done")
          return
        }

        spinner.message(`Installing "${pluginName}" from ${foundSource}...`)

        try {
          await PluginRegistry.install(foundSource, pluginName, targetDir)
          spinner.stop(`Plugin "${pluginName}" installed successfully`)
          prompts.log.info(`Location: ${targetDir}`)
        } catch (e) {
          spinner.stop(`Failed to install: ${e instanceof Error ? e.message : String(e)}`, 1)
        }

        prompts.outro("Done")
      },
    })
  },
})

const PluginRemoveCommand = cmd({
  command: "remove <name>",
  aliases: ["rm"],
  describe: "remove an installed plugin",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the plugin to remove",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Remove Plugin")

        const pluginName = args.name
        const pluginDir = path.join(Instance.worktree, ".opencode", "plugins", pluginName)

        const exists = await fs.access(pluginDir).then(
          () => true,
          () => false,
        )

        if (!exists) {
          prompts.log.error(`Plugin "${pluginName}" is not installed`)
          prompts.outro("Done")
          return
        }

        await fs.rm(pluginDir, { recursive: true, force: true })
        prompts.log.success(`Plugin "${pluginName}" removed`)
        prompts.outro("Done")
      },
    })
  },
})
