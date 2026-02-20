import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal, onCleanup, type JSX } from "solid-js"
import { useTheme, tint } from "@tui/context/theme"
import { useKV } from "../context/kv"
import { logo, marks } from "@/cli/logo"

const SHADOW_MARKER = new RegExp(`[${marks}]`)
const SWEEP_WIDTH = 6
const PAUSE_FRAMES = 20
const FRAME_INTERVAL = 70

export function Logo() {
  const { theme } = useTheme()
  const kv = useKV()

  const logoWidth = Math.max(...logo.map((l) => l.length))
  const totalFrames = logoWidth + SWEEP_WIDTH + PAUSE_FRAMES

  const [frame, setFrame] = createSignal(0)

  const interval = setInterval(() => {
    if (!kv.get("animations_enabled", true)) return
    setFrame((f) => (f + 1) % totalFrames)
  }, FRAME_INTERVAL)
  onCleanup(() => clearInterval(interval))

  const lineChars = logo.map((line) => Array.from(line).map((char, col) => ({ char, col })))

  const renderLineStatic = (line: string): JSX.Element[] => {
    const shadow = tint(theme.background, theme.text, 0.25)
    const attrs = TextAttributes.BOLD
    const elements: JSX.Element[] = []
    let i = 0

    while (i < line.length) {
      const rest = line.slice(i)
      const markerIndex = rest.search(SHADOW_MARKER)

      if (markerIndex === -1) {
        elements.push(
          <text fg={theme.text} attributes={attrs} selectable={false}>
            {rest}
          </text>,
        )
        break
      }

      if (markerIndex > 0) {
        elements.push(
          <text fg={theme.text} attributes={attrs} selectable={false}>
            {rest.slice(0, markerIndex)}
          </text>,
        )
      }

      const marker = rest[markerIndex]
      switch (marker) {
        case "_":
          elements.push(
            <text fg={theme.text} bg={shadow} attributes={attrs} selectable={false}>
              {" "}
            </text>,
          )
          break
        case "^":
          elements.push(
            <text fg={theme.text} bg={shadow} attributes={attrs} selectable={false}>
              ▀
            </text>,
          )
          break
        case "~":
          elements.push(
            <text fg={shadow} attributes={attrs} selectable={false}>
              ▀
            </text>,
          )
          break
      }

      i += markerIndex + 1
    }

    return elements
  }

  return (
    <box>
      <Show
        when={kv.get("animations_enabled", true)}
        fallback={
          <For each={logo}>
            {(line) => (
              <box flexDirection="row">
                <box flexDirection="row">{renderLineStatic(line)}</box>
              </box>
            )}
          </For>
        }
      >
        <For each={lineChars}>
          {(chars) => (
            <box flexDirection="row">
              <box flexDirection="row">
                <For each={chars}>
                  {(info) => {
                    const charFg = () => {
                      const beamPos = frame()
                      if (beamPos >= logoWidth + SWEEP_WIDTH) return theme.text
                      const dist = beamPos - info.col
                      if (dist < 0 || dist > SWEEP_WIDTH) return theme.text
                      const intensity = (1 - dist / SWEEP_WIDTH) * 0.8
                      return tint(theme.text, theme.primary, intensity)
                    }
                    const charShadow = () => tint(theme.background, charFg(), 0.25)

                    if (info.char === "_") {
                      return (
                        <text fg={charFg()} bg={charShadow()} attributes={TextAttributes.BOLD} selectable={false}>
                          {" "}
                        </text>
                      )
                    }
                    if (info.char === "^") {
                      return (
                        <text fg={charFg()} bg={charShadow()} attributes={TextAttributes.BOLD} selectable={false}>
                          ▀
                        </text>
                      )
                    }
                    if (info.char === "~") {
                      return (
                        <text fg={charShadow()} attributes={TextAttributes.BOLD} selectable={false}>
                          ▀
                        </text>
                      )
                    }
                    return (
                      <text fg={charFg()} attributes={TextAttributes.BOLD} selectable={false}>
                        {info.char}
                      </text>
                    )
                  }}
                </For>
              </box>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
