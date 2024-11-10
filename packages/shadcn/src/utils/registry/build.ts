import { existsSync, promises as fs } from "fs"
import path from "path"
import vm from "vm"
import { Project } from "ts-morph"
import { z } from "zod"

import {
  RegistryItem,
  iconsSchema,
  registryBaseColorSchema,
  registryItemSchema,
  registryItemTypeSchema,
} from "./schema"

const REGISTRY_MODULE_PREFIX = "@/registry/"

async function writeObjToFile(destination: string, obj: object) {
  const dir = path.parse(destination).dir
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true })
  }
  await fs.writeFile(destination, JSON.stringify(obj, null, 2), "utf8")
}

function findDependencies(sourcePath: string) {
  const dependencies: string[] = []
  const registryDependencies: string[] = []
  const project = new Project()

  project.addSourceFileAtPath(sourcePath)
  const source = project.getSourceFile(sourcePath)
  if (source) {
    for (const declaration of source.getImportDeclarations()) {
      const moduleSpecifier = declaration.getModuleSpecifierValue()
      if (!moduleSpecifier.startsWith("@/") && moduleSpecifier !== "react") {
        dependencies.push(moduleSpecifier)
      } else if (moduleSpecifier.startsWith(REGISTRY_MODULE_PREFIX)) {
        registryDependencies.push(
          moduleSpecifier.substring(REGISTRY_MODULE_PREFIX.length)
        )
      } else {
        registryDependencies.push(moduleSpecifier)
      }
    }
  }
  return { dependencies, registryDependencies }
}

function runSourceFile(sourcePath: string) {
  const project = new Project()
  project.addSourceFileAtPath(sourcePath)
  const itemConfig = project.getSourceFile(sourcePath)
  if (itemConfig) {
    const configOutput = itemConfig.getEmitOutput()
    const context: vm.Context = {
      exports: {},
      module: { exports: {} },
    }
    const code = configOutput.getOutputFiles()[0].getText()
    vm.runInNewContext(code, context)
    return context.exports
  }
  return null
}

function updateItemConfig(item: RegistryItem, registryFilePath: string) {
  const exports = runSourceFile(registryFilePath)
  if (exports) {
    if (typeof exports.default === "function") {
      exports.default(item)
    } else if (typeof exports.default === "object") {
      item = {
        ...item,
        ...exports.default,
      }
    }
  }
  return item
}

function getRegistryFile(sourcePath: string) {
  const parsedPath = path.parse(sourcePath)
  return sourcePath.replace(parsedPath.ext, `.registry.${parsedPath.ext[1]}s`)
}

async function buildRegistryType(
  dir: string,
  type: string,
  registryType: typeof registryItemTypeSchema._type,
  outputDir: string
): Promise<RegistryItem[]> {
  const files = await fs.readdir(dir)
  const items: RegistryItem[] = []
  for (const file of files) {
    if (file.includes(".registry.")) {
      continue
    }
    const name = `${type === "ui" ? "" : `${type}/`}${path.parse(file).name}`
    const fullPath = path.resolve(dir, file)
    const { dependencies, registryDependencies } = findDependencies(fullPath)

    let item: RegistryItem = {
      name,
      type: registryType,
      dependencies,
      registryDependencies,

      files: [
        {
          path: `${type}/${file}`,
          type: registryType,
          content: await fs.readFile(fullPath, "utf8"),
        },
      ],
    }

    const registryFilePath = getRegistryFile(fullPath)
    if (existsSync(registryFilePath)) {
      item = updateItemConfig(item, registryFilePath)
    }

    await writeObjToFile(
      path.resolve(outputDir, `styles/default/${item.name}.json`),
      item
    )

    items.push({
      ...item,
      files: item.files?.map((file) => ({
        ...file,
        content: undefined,
      })),
    })
  }
  return items
}

function searchForFile(directory: string, fileName: string) {
  for (const ext of ["ts", "tsx", "js", "jsx"]) {
    const filePath = path.resolve(directory, `${fileName}.${ext}`)
    if (existsSync(filePath)) {
      return filePath
    }
  }
  return null
}

const styleWithEntrySchema = z.array(
  z.object({
    name: z.string(),
    label: z.string(),
    entry: registryItemSchema.optional(),
  })
)

async function writeStyleIndicies(
  outputDir: string,
  object: Object | undefined
) {
  const styles = object
    ? styleWithEntrySchema.parse(object)
    : [{ name: "default", label: "Default" }]
  for (const style of styles) {
    const item: RegistryItem = {
      name: style.name,
      type: "registry:style",
      ...style.entry,
    }
    await writeObjToFile(
      path.resolve(outputDir, `styles/${style.name}/index.json`),
      item
    )
  }
  await writeObjToFile(
    path.resolve(outputDir, `styles/index.json`),
    styles.map((s) => ({ name: s.name, label: s.label }))
  )
}

async function writeIconsIndex(outputDir: string, object: Object | undefined) {
  const icons: z.infer<typeof iconsSchema> = object
    ? iconsSchema.parse(object)
    : {}
  await writeObjToFile(path.resolve(outputDir, `icons/index.json`), icons)
}

type BaseColorJson = z.infer<typeof registryBaseColorSchema>

function themesToColorJson(
  themes: z.infer<typeof baseColorsSchema>[number]["themes"]
) {
  const cssVars: Record<string, Record<string, string>> = {}
  const inlineColors: Record<string, Record<string, string>> = {}
  for (const [themeName, theme] of Object.entries(themes)) {
    cssVars[themeName] = {}
    for (const [property, value] of Object.entries(theme)) {
      if (typeof value === "string") {
        cssVars[themeName][property] = value
      } else {
        cssVars[themeName][property] = value.cssVariable
        if (value.inlineColor) {
          inlineColors[themeName] ??= {}
          inlineColors[themeName][property] = value.inlineColor
        }
      }
    }
  }
  return { cssVars, inlineColors }
}

function cssVarThemeToTemplate(cssVars: BaseColorJson["cssVars"][string]) {
  return `${Object.keys(cssVars)
    .map((prop) => `    --${prop}: ${cssVars[prop]};`)
    .join("\n")}`
}

function cssVarsToTemplate(cssVars: BaseColorJson["cssVars"]) {
  return `  ${Object.keys(cssVars)
    .map(
      (theme) =>
        `${theme === "root" ? ":root" : `.${theme}`} {\n${cssVarThemeToTemplate(
          cssVars[theme]
        )}`
    )
    .join("\n  }\n\n  ")}\n  }`
}

async function writeColors(outputDir: string, object: Object | undefined) {
  const colors = baseColorsSchema.parse(object)
  for (const color of colors) {
    const { cssVars, inlineColors } = themesToColorJson(color.themes)
    await writeObjToFile(path.resolve(outputDir, `colors/${color.name}.json`), {
      inlineColors,
      cssVars,
      inlineColorsTemplate:
        "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
      cssVarsTemplate: `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n@layer base {\n${cssVarsToTemplate(
        cssVars
      )}\n}\n\n@layer base {\n  * {\n    @apply border-border;\n  }\n  body {\n    @apply bg-background text-foreground;\n  }\n}`,
    })
    const themeRegistryItem: RegistryItem = {
      name: `theme-${color.name}`,
      type: "registry:theme",
      cssVars,
    }
    await writeObjToFile(
      path.resolve(outputDir, `themes/${color.name}.json`),
      themeRegistryItem
    )
  }
  await writeObjToFile(path.resolve(outputDir, `themes/index.json`), {
    themes: colors.map((color) => ({
      name: color.name,
      label: color.label,
    })),
  })
}

const colorThemeSchema = z.record(
  z.string(),
  z
    .object({
      cssVariable: z.string(),
      inlineColor: z.string().optional(),
    })
    .or(z.string())
)
const baseColorsSchema = z.array(
  z.object({
    name: z.string(),
    label: z.string(),
    themes: z
      .object({
        root: colorThemeSchema,
      })
      .catchall(colorThemeSchema),
  })
)

export async function buildRegistry({
  cwd,
  outputDir,
}: {
  cwd: string
  outputDir: string
}) {
  let index: RegistryItem[] = []

  if (!existsSync(outputDir)) {
    await fs.mkdir(outputDir)
  }

  for (const registryType of registryItemTypeSchema.options) {
    const type = registryType.substring("registry:".length)
    const dir = path.resolve(cwd, type)
    if (existsSync(dir)) {
      const items = await buildRegistryType(dir, type, registryType, outputDir)
      index = index.concat(items)
    }
  }
  await writeObjToFile(path.resolve(outputDir, "index.json"), index)

  for (const type of ["styles", "icons", "colors"]) {
    const filePath = searchForFile(cwd, type)
    let exports: any = undefined
    if (filePath !== null) {
      exports = runSourceFile(filePath)
    }
    switch (type) {
      case "styles":
        await writeStyleIndicies(outputDir, exports?.default)
        break

      case "icons":
        await writeIconsIndex(outputDir, exports?.default)
        break

      case "colors":
        await writeColors(outputDir, exports?.default)
        break

      default:
        throw new Error(`Unknown type ${type}`)
    }
  }
}
