import { registryBaseColorSchema } from "@/src/utils/registry/schema"
import { Transformer } from "@/src/utils/transformers"
import { SyntaxKind } from "ts-morph"
import { z } from "zod"

export const transformCssVars: Transformer = async ({
  sourceFile,
  config,
  inlineColors,
}) => {
  // No transform if using css variables.
  if (config.tailwind?.cssVariables || !inlineColors) {
    return sourceFile
  }

  sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral).forEach((node) => {
    const value = node.getText()
    if (value) {
      const valueWithColorMapping = applyColorMapping(
        value.replace(/"/g, ""),
        inlineColors
      )
      node.replaceWithText(`"${valueWithColorMapping.trim()}"`)
    }
  })

  return sourceFile
}

// Splits a className into variant-name-alpha.
// eg. hover:bg-primary-100 -> [hover, bg-primary, 100]
export function splitClassName(className: string): (string | null)[] {
  if (!className.includes("/") && !className.includes(":")) {
    return [null, className, null]
  }

  const parts: (string | null)[] = []
  // First we split to find the alpha.
  let [rest, alpha] = className.split("/")

  // Check if rest has a colon.
  if (!rest.includes(":")) {
    return [null, rest, alpha]
  }

  // Next we split the rest by the colon.
  const split = rest.split(":")

  // We take the last item from the split as the name.
  const name = split.pop()

  // We glue back the rest of the split.
  const variant = split.join(":")

  // Finally we push the variant, name and alpha.
  parts.push(variant ?? null, name ?? null, alpha ?? null)

  return parts
}

const PREFIXES = ["bg-", "text-", "border-", "ring-offset-", "ring-"]

export function applyColorMapping(
  input: string,
  mapping: Required<z.infer<typeof registryBaseColorSchema>>["inlineColors"]
) {
  // Handle border classes.
  if (input.includes(" border ")) {
    input = input.replace(" border ", " border border-border ")
  }

  const themes = Object.keys(mapping)
  const defaultTheme = themes.includes("root") ? "root" : "light"

  // Build color mappings.
  const classNames = input.split(" ")
  const modes = Object.fromEntries(
    themes.map((theme) => [theme, new Set<string>()])
  )

  for (let className of classNames) {
    const [variant, value, modifier] = splitClassName(className)
    const prefix = PREFIXES.find((prefix) => value?.startsWith(prefix))
    if (!prefix) {
      if (!modes[defaultTheme].has(className)) {
        modes[defaultTheme].add(className)
      }
      continue
    }

    const needle = value?.replace(prefix, "")
    if (needle) {
      for (const theme of themes) {
        if (needle in mapping[theme]) {
          modes[theme].add(
            [
              theme === defaultTheme ? null : theme,
              variant,
              `${prefix}${mapping[theme][needle]}`,
            ]
              .filter(Boolean)
              .join(":") + (modifier ? `/${modifier}` : "")
          )
        }
      }

      continue
    }

    if (!modes[defaultTheme].has(className)) {
      modes[defaultTheme].add(className)
    }
  }

  return Object.values(modes)
    .flatMap((v) => Array.from(v))
    .join(" ")
    .trim()
}
