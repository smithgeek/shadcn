import { existsSync, promises as fs } from "fs"
import path from "path"
import vm from "vm"
import { Project } from "ts-morph"

import { RegistryItem, registryItemTypeSchema } from "./schema"

const REGISTRY_MODULE_PREFIX = "@/registry/"

async function writeFile(destination: string, content: string) {
  const dir = path.parse(destination).dir
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true })
  }
  await fs.writeFile(destination, content, "utf8")
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

function updateItemConfig(item: RegistryItem, registryFilePath: string) {
  const project = new Project()
  project.addSourceFileAtPath(registryFilePath)
  const itemConfig = project.getSourceFile(registryFilePath)
  if (itemConfig) {
    const configOutput = itemConfig.getEmitOutput()
    const context: vm.Context = {
      exports: {},
      module: { exports: {} },
    }
    const code = configOutput.getOutputFiles()[0].getText()
    vm.runInNewContext(code, context)
    if (typeof context.exports.default === "function") {
      context.exports.default(item)
    } else if (typeof context.exports.default === "object") {
      item = {
        ...item,
        ...context.exports.default,
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

    await writeFile(
      path.resolve(outputDir, `styles/default/${item.name}.json`),
      JSON.stringify(item, null, 2)
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
  await writeFile(
    path.resolve(outputDir, "index.json"),
    JSON.stringify(index, null, 2)
  )
}
