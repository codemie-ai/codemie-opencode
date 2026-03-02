import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin.litellm-sanitizer" })

/**
 * Internal plugin that strips unsupported reasoning parameters before they
 * reach LiteLLM / Azure proxy endpoints.
 *
 * The AI SDK's transform layer injects `reasoningSummary: "auto"` for models
 * that advertise reasoning capability. LiteLLM and Azure OpenAI proxies reject
 * this with "Unknown parameter: 'reasoningSummary'".
 *
 * This plugin uses the `chat.params` hook to delete unsupported params from
 * `output.options` *before* the request is sent. `reasoningEffort` is left
 * intact because LiteLLM supports it natively.
 *
 * LiteLLM detection mirrors `llm.ts:158-161`:
 *   - provider ID contains "litellm", OR
 *   - model API ID contains "litellm", OR
 *   - provider option `litellmProxy: true`
 */
export async function LiteLLMSanitizerPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "chat.params": async (input, output) => {
      const provider = input.provider
      const isLiteLLM =
        provider.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      if (!isLiteLLM) return

      let stripped = false
      for (const key of ["reasoningSummary", "reasoning_summary", "reasoning"] as const) {
        if (key in output.options) {
          delete output.options[key]
          stripped = true
        }
      }

      if (stripped) {
        log.info("stripped unsupported reasoning params for litellm provider", {
          model: input.model.id,
          provider: input.model.providerID,
        })
      }
    },
  }
}
