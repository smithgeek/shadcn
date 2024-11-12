import path from "path"
import { Worker, parentPort, workerData } from "worker_threads"
import {
  ArrowFunction,
  CodeBlockWriter,
  FunctionDeclaration,
  ImportDeclaration,
  JsxAttribute,
  JsxExpression,
  JsxOpeningElement,
  JsxSelfClosingElement,
  Node,
  Project,
  SourceFile,
  StructureKind,
  Symbol,
  SyntaxKind,
  Type,
  VariableDeclaration,
  VariableDeclarationKind,
  ts,
} from "ts-morph"

type JsxElement = JsxSelfClosingElement | JsxOpeningElement

function analyzeDeclarations(symbol: Symbol | undefined): {
  importDeclaration?: ImportDeclaration
  variableDeclaration?: VariableDeclaration
} {
  if (symbol) {
    // Get the symbol's declaration, which points to the import
    const declarations = symbol.getDeclarations()
    if (declarations.length > 0) {
      const declaration = declarations[0]

      // Check if the declaration is imported from another file
      const importDeclaration = declaration.getFirstAncestorByKind(
        SyntaxKind.ImportDeclaration
      )
      if (importDeclaration) {
        // Get the module specifier (e.g., 'react', './Component')
        return { importDeclaration }
      }
      if (declaration.isKind(SyntaxKind.VariableDeclaration)) {
        return { variableDeclaration: declaration }
      }
    }
  }
  return {}
}

function inject(element: Node<ts.Node>, name: string, variables: string[]) {
  variables = distinct(variables)
  const argList = variables.length > 0 ? `{ ${variables.join(", ")} }` : ""
  const stylesCode = `const styles = styling.get${name[0].toUpperCase()}${name.slice(
    1
  )}Styles(${argList})`
  if (element.isKind(SyntaxKind.ArrowFunction)) {
    const body = element.getBody()
    if (body.isKind(SyntaxKind.Block)) {
      body.insertStatements(0, stylesCode)
    } else if (body.isKind(SyntaxKind.ParenthesizedExpression)) {
      body.replaceWithText((writer) => {
        writer.block(() => {
          writer.writeLine(stylesCode)
          writer.writeLine(`return ${body.getText()}`)
        })
      })
    }
  } else if (element.isKind(SyntaxKind.FunctionDeclaration)) {
    element.insertStatements(0, stylesCode)
  }
}

function getParents(element: Node<ts.Node>): {
  ancestors: string[]
  rootFunction: ArrowFunction | FunctionDeclaration | null
} {
  let rootFunction: ArrowFunction | FunctionDeclaration | null = null
  if (element.isKind(SyntaxKind.ArrowFunction)) {
    rootFunction = element
  }
  if (
    element.isKind(SyntaxKind.FunctionDeclaration) &&
    element.getParent().isKind(SyntaxKind.SourceFile)
  ) {
    return {
      ancestors: [element.getName() ?? ""],
      rootFunction: element,
    }
  }

  const parent = element.getParent()
  if (!parent) {
    return { ancestors: [], rootFunction }
  }
  if (parent.isKind(SyntaxKind.JsxElement)) {
    const nodeName = parent.getOpeningElement().getTagNameNode().getText()
    if (nodeName.length > 0) {
      const result = getParents(parent)
      return {
        ancestors: [nodeName, ...result.ancestors],
        rootFunction: result.rootFunction ?? rootFunction,
      }
    }
  }
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const nodeName = parent.getName()
    if (nodeName.length > 0) {
      const result = getParents(parent)
      return {
        ancestors: [nodeName, ...result.ancestors],
        rootFunction: result.rootFunction ?? rootFunction,
      }
    }
  }
  const result = getParents(parent)
  return {
    ancestors: result.ancestors,
    rootFunction: result.rootFunction ?? rootFunction,
  }
}

interface Argument {
  variables: string[]
  types: string[]
}

function getResolvedTypeName(type: Type<ts.Type>) {
  const symbol = type.getSymbol()
  if (symbol) {
    const aliasedSymbol = symbol.getAliasedSymbol()
    return aliasedSymbol ? aliasedSymbol.getName() : symbol.getName()
  }
  return type.getText() // fallback to getText() if no symbol is found
}

function getTypeStringAtNode(symbol: Symbol | undefined, node: Node) {
  if (!symbol) {
    return ""
  }
  let str = ""
  if (symbol.hasFlags(ts.SymbolFlags.Optional)) {
    str += "?: "
  } else {
    str += ": "
  }
  const type = symbol.getTypeAtLocation(node)
  str += getResolvedTypeName(type)
  if (isPossiblyUndefined(type)) {
    str += " | undefined"
  }
  if (isPossiblyNull(type)) {
    str += " | null"
  }
  return str
}

function isPossiblyUndefined(type: Type) {
  if (type.isUndefined()) return true
  if (type.isUnion()) {
    return type.getUnionTypes().some((t) => t.isUndefined())
  }
  return false
}

function isPossiblyNull(type: Type) {
  if (type.isNullable()) return true
  if (type.isUnion()) {
    return type.getUnionTypes().some((t) => t.isNullable())
  }
  return false
}

function getComponentProps(
  rootFunction: ArrowFunction | FunctionDeclaration,
  propNames: string[]
) {
  const propsParam = rootFunction.getParameter("props")
  const typeNode = propsParam?.getTypeNode()
  let propTypeName: string | null = null
  let importType: string | null = null
  if (typeNode) {
    propTypeName = typeNode.getText()
    importType = propTypeName
  } else if (rootFunction.isKind(SyntaxKind.ArrowFunction)) {
    let element: Node | undefined = rootFunction
    while (element && !element.isKind(SyntaxKind.VariableDeclaration)) {
      element = element.getParent()
    }
    if (element) {
      propTypeName = `Parameters<typeof ${element.getName()}>[0]`
      importType = element.getName()
    }
  }
  if (propTypeName !== null) {
    return {
      type: `Pick<${propTypeName}, ${propNames
        .map((p) => `"${p}"`)
        .join(" | ")}>`,
      importType,
    }
  }
  // const props: string[] = []
  // if (propsParam) {
  //   const resolved = getResolvedTypeName(propsParam.getType())
  //   propNames.forEach((propName) => {
  //     const propsType = propsParam.getType()
  //     const classNameProperty = propsType.getProperty(propName)
  //     props.push(
  //       `${propName}${getTypeStringAtNode(classNameProperty, propsParam)}`
  //     )
  //   })
  // }
  // return props
  return {
    type: "any",
    importType: null,
  }
}

function findDependencies(
  expression: JsxExpression | VariableDeclaration,
  checkArgs: boolean = true
) {
  const imports: ImportDeclaration[] = []
  const variables: VariableDeclaration[] = []
  const args: Argument[] = []
  expression.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((node) => {
    if (checkArgs) {
      node.getArguments().forEach((arg, i) => {
        if (arg.isKind(SyntaxKind.ObjectLiteralExpression)) {
          const functionArg: Argument = {
            variables: [],
            types: [],
          }

          arg.getProperties().forEach((p) => {
            if (p.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
              functionArg.variables.push(p.getText())
            }
          })

          args.push(functionArg)
        }
      })
    }
    const declaration = analyzeDeclarations(node.getExpression().getSymbol())
    if (declaration.importDeclaration) {
      imports.push(declaration.importDeclaration)
    } else if (declaration.variableDeclaration) {
      variables.push(declaration.variableDeclaration)
      const nestedDecl = findDependencies(
        declaration.variableDeclaration,
        false
      )
      imports.push(...nestedDecl.imports)
      variables.push(...nestedDecl.variables)
      args.push(...nestedDecl.args)
    }
  })
  return {
    imports,
    variables,
    args,
  }
}

function toObjectTypeDecl(
  name: string,
  type: Type<ts.Type> | null | undefined
) {
  if (!type) {
    return `${name}?: any`
  }
  return `${name}${
    type.isUndefined() ? " | undefined" : ""
  }: ${type.getText()}${type.isNullable() ? " | null" : ""}`
}

function getAttributeType(
  jsxAttribute: JsxAttribute,
  component: VariableDeclaration | undefined
) {
  if (component) {
    const propsType = component
      .getType()
      .getApparentProperties()
      .find((p) => p.getName() == jsxAttribute.getName())
      ?.getTypeAtLocation(component)
    if (propsType) {
      return propsType
        .getProperty(jsxAttribute.getName())
        ?.getTypeAtLocation(jsxAttribute)
    }
  }
  return null
}

function parseAttribute(
  jsxAttribute: JsxAttribute,
  component: VariableDeclaration | undefined
) {
  const initializer = jsxAttribute.getInitializer()

  if (initializer) {
    //const maybeProps = initializer.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)[0];
    //maybeProps.getType().getdecl
    if (initializer.isKind(SyntaxKind.JsxExpression)) {
      const declarations = findDependencies(initializer)
      return {
        imports: declarations.imports,
        variablesToMove: declarations.variables,
        valueText: initializer.getText(),
        args: declarations.args,
        name: jsxAttribute.getName(),
        type: getAttributeType(jsxAttribute, component),
      }
    }
  }
  return null
}

interface ObjectProp {
  propertyName: string
  value: string
}

type WriteableObject = Record<string, ObjectProp[]>

interface ExtractedStyling {
  [key: string]: {
    args: Argument
    obj: WriteableObject
    types: string[]
  }
}

function writeObject(writer: CodeBlockWriter, data: WriteableObject) {
  for (const [key, props] of Object.entries(data)) {
    writer.write(`"${key}": {`)
    writer.indent(() => {
      props.forEach((prop) => {
        writer.writeLine(`${prop.propertyName}: `)
        if (
          prop.value.startsWith(`"`) ||
          prop.value.startsWith(`'`) ||
          prop.value.startsWith("`")
        ) {
          writer.write(`${prop.value},`)
        } else {
          writer.write(`${prop.value.substring(1, prop.value.length - 1)},`)
        }
      })
    })
    writer.writeLine("},")
  }
}

function createObject(source: SourceFile, object: ExtractedStyling) {
  source.addVariableStatement({
    declarationKind: VariableDeclarationKind.Const,
    isExported: true,
    declarations: [
      {
        name: "styling",
        initializer: (writer) => {
          writer.block(() => {
            Object.entries(object).forEach(([key, value]) => {
              const args = `{${distinct(value.args.variables).join(
                ", "
              )}}: ${distinct(value.args.types).join(", ")}`
              writer.write(
                `get${key[0].toUpperCase()}${key.substring(1)}Styles(${args}) {`
              )
              writer.indent(() => {
                writer.write("return ")
                writer.block(() => {
                  writeObject(writer, value.obj)
                })
              })
              writer.writeLine("},")
            })
          })
        },
      },
    ],
  })
}

function getPropertyName(tagName: string | undefined, component: string) {
  tagName =
    !tagName || tagName.length === 0
      ? "component"
      : `${tagName[0].toLowerCase()}${tagName.substring(1)}`
  if (tagName.startsWith(component) && tagName !== component) {
    tagName = tagName.substring(component.length)
  }
  return `${tagName[0].toLowerCase()}${tagName.substring(1)}`
}

function addGetStyleProps(
  object: ExtractedStyling,
  component: string,
  parents: string[],
  props: ObjectProp[],
  args: Argument
) {
  parents = parents.reverse()
  const topLevelName = getPropertyName(parents[0], component)
  if (!(topLevelName in object)) {
    object[topLevelName] = {
      args,
      obj: {},
      types: [],
    }
  } else {
    object[topLevelName].args.variables.push(...args.variables)
  }

  const propName = parents.slice(1).join(":")
  object[topLevelName].obj[propName] = props
  return `styles["${propName}"]`
}

const iconPackages = ["lucide", "icon"]
const styleAttributes = ["className", "style", "classNames"]

export async function processSource({
  project,
  style,
  componentName,
  cwd,
}: {
  project: Project
  style: string
  componentName: string
  cwd: string
}): Promise<{ task: Promise<void> }> {
  const extractedStyle: ExtractedStyling = {}
  const source = project.getSourceFileOrThrow(
    path.join(cwd, "registry", style, "ui", `${componentName}.tsx`)
  )
  console.log(`${style} - ${componentName} - style file`)
  const styleSource = project.getSourceFileOrThrow(
    path.join(cwd, "registry", "styles", style, `${componentName}.tsx`)
  )
  console.log(`${style} - ${componentName} - descendants`)
  let jsxElements: JsxElement[] = source.getDescendantsOfKind(
    SyntaxKind.JsxSelfClosingElement
  )
  jsxElements = jsxElements.concat(
    source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
  )
  const rootElements: {
    name: string
    rootFunction: ArrowFunction | FunctionDeclaration
  }[] = []
  let imports: ImportDeclaration[] = []
  let variablesToMove: VariableDeclaration[] = []
  jsxElements.forEach((jsxElement) => {
    // const { importDeclaration } = analyzeDeclarations(
    //   jsxElement.getTagNameNode().getSymbol()
    // )
    // if (
    //   importDeclaration &&
    //   iconPackages.some((pkg) =>
    //     importDeclaration.getModuleSpecifierValue().includes(pkg)
    //   )
    // ) {
    //   console.log(`${jsxElement.getTagNameNode().getText()} is an icon`)
    // }

    const props: ObjectProp[] = []
    let args: Argument = {
      variables: [],
      types: [],
    }

    const { ancestors, rootFunction } = jsxElement.isKind(
      SyntaxKind.JsxOpeningElement
    )
      ? getParents(jsxElement.getParent())
      : getParents(jsxElement)
    if (rootFunction) {
      rootElements.push({
        rootFunction,
        name:
          ancestors.length > 0
            ? ancestors[ancestors.length - 1]
            : rootFunction.isKind(SyntaxKind.FunctionDeclaration)
            ? rootFunction.getName() ?? ""
            : "",
      })
    }

    console.log(
      `${style} - ${componentName} - ${jsxElement
        .getTagNameNode()
        .getText()} attr`
    )
    const component = source.getVariableDeclaration(
      jsxElement.getTagNameNode().getText()
    )
    const attributesToRemove: JsxAttribute[] = []
    styleAttributes.forEach((styleAttribute) => {
      const attribute = jsxElement.getAttribute(styleAttribute)
      if (attribute?.isKind(SyntaxKind.JsxAttribute)) {
        const attr = parseAttribute(attribute, component)
        if (attr) {
          imports = imports.concat(attr.imports)
          variablesToMove = variablesToMove.concat(attr.variablesToMove)
          props.push({
            propertyName: attr.name,
            value: attr.valueText,
          })
          attr.args.forEach((arg) => {
            args.variables = args.variables.concat(arg.variables)
          })
          args.variables.push(attr.name)
        }
        attributesToRemove.push(attribute)
      }
    })
    attributesToRemove.forEach((attribute) => attribute.remove())
    if (props.length > 0) {
      const stylePath = addGetStyleProps(
        extractedStyle,
        componentName,
        [jsxElement.getTagNameNode().getText(), ...ancestors],
        props,
        args
      )

      jsxElement.insertAttribute(0, {
        kind: StructureKind.JsxSpreadAttribute,
        expression: stylePath,
      })
    }
  })

  distinctBy(rootElements, (r) => r.name).forEach((rootElement) => {
    const stylePropName = getPropertyName(rootElement.name, componentName)
    const args = extractedStyle[stylePropName]?.args
    const variables = args?.variables ?? []
    if (args) {
      const componentProps = getComponentProps(
        rootElement.rootFunction,
        variables
      )
      args.types = [componentProps.type]
      if (componentProps.importType) {
        styleSource.addImportDeclaration({
          moduleSpecifier: `@/registry/ui/${componentName}`,
          namedImports: [componentProps.importType],
        })
      }
    }
    inject(
      rootElement.rootFunction,
      getPropertyName(rootElement.name, componentName),
      variables
    )
  })
  distinct(imports).forEach((importDeclaration) => {
    styleSource.addImportDeclaration({
      moduleSpecifier: importDeclaration.getModuleSpecifierValue(),
      namedImports: importDeclaration.getNamedImports().map((i) => i.getName()),
    })
  })
  source.addImportDeclaration({
    namedImports: distinct(variablesToMove)
      .map((v) => v.getName())
      .concat(["styling"]),
    moduleSpecifier: `@/registry/styles/${style}/${componentName}`,
  })
  distinct(variablesToMove).forEach((variableDeclaration) => {
    styleSource.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      kind: StructureKind.VariableStatement,
      isExported: true,
      declarations: [
        {
          kind: StructureKind.VariableDeclaration,
          name: variableDeclaration.getName(),
          initializer: variableDeclaration.getInitializer()?.getText(),
          hasExclamationToken: variableDeclaration.hasExclamationToken(),
          type: variableDeclaration.getTypeNode()?.getText(),
        },
      ],
    })
    variableDeclaration.remove()
  })

  const saveTask = saveResults({
    source,
    styleSource,
    extractedStyle,
    cwd,
    componentName,
  })
  return {
    task: saveTask,
  }
}

async function saveResults({
  source,
  styleSource,
  extractedStyle,
  cwd,
  componentName,
}: {
  source: SourceFile
  cwd: string
  componentName: string
  styleSource: SourceFile
  extractedStyle: ExtractedStyling
}) {
  const copiedFile = source.copy(
    path.join(cwd, "registry", "ui", `${componentName}.tsx`),
    { overwrite: true }
  )

  createObject(styleSource, extractedStyle)
  await Promise.all([copiedFile.save(), styleSource.save()])
}

function distinct<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

function distinctBy<T>(arr: T[], key: (t: T) => string): T[] {
  return Array.from(new Map(arr.map((t) => [key(t), t])).values())
}

export async function processSourceThread(
  data: Parameters<typeof processSource>[0]
) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: data })

    worker.on("message", (result) => {
      resolve(result)
    })

    worker.on("error", (err) => {
      reject(err)
    })

    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`))
      }
    })
  })
}

parentPort?.postMessage(processSource(workerData))
