import path from "path"
import { Command } from "commander"
import {
  CodeBlockWriter,
  ImportDeclaration,
  IndentationText,
  JsxAttribute,
  JsxExpression,
  JsxOpeningElement,
  JsxSelfClosingElement,
  NewLineKind,
  Node,
  Project,
  QuoteKind,
  SourceFile,
  StructureKind,
  Symbol,
  SyntaxKind,
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

function inject(element: Node<ts.Node>) {
  if (element.isKind(SyntaxKind.ArrowFunction)) {
    const body = element.getBody()
    if (body.isKind(SyntaxKind.Block)) {
      body.insertStatements(0, `const styles: any = {}`)
    } else if (body.isKind(SyntaxKind.ParenthesizedExpression)) {
      body.replaceWithText((writer) => {
        writer.block(() => {
          writer.writeLine(`const styles: any = {}`)
          writer.writeLine(`return ${body.getText()}`)
        })
      })
    }
  }
}

function getParents(element: Node<ts.Node>): {
  ancestors: string[]
  root: Node<ts.Node> | null
} {
  let root: Node<ts.Node> | null = null
  if (element.isKind(SyntaxKind.ArrowFunction)) {
    root = element
  }
  const parent = element.getParent()
  if (!parent) {
    return { ancestors: [], root }
  }
  if (parent.isKind(SyntaxKind.JsxElement)) {
    const nodeName = parent.getOpeningElement().getTagNameNode().getText()
    if (nodeName.length > 0) {
      const result = getParents(parent)
      return {
        ancestors: [nodeName, ...result.ancestors],
        root: result.root ?? root,
      }
    }
  }
  if (parent.isKind(SyntaxKind.VariableDeclaration)) {
    const nodeName = parent.getName()
    if (nodeName.length > 0) {
      const result = getParents(parent)
      return {
        ancestors: [nodeName, ...result.ancestors],
        root: result.root ?? root,
      }
    }
  }
  const result = getParents(parent)
  return {
    ancestors: result.ancestors,
    root: result.root ?? root,
  }
}

interface Argument {
  destructure: string[]
  type: string
}

function findDependencies(
  expression: JsxExpression | VariableDeclaration,
  checkArgs: boolean = true
) {
  let imports: ImportDeclaration[] = []
  let variables: VariableDeclaration[] = []
  let args: Argument[] = []
  expression.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((node) => {
    if (checkArgs) {
      node.getArguments().forEach((arg, i) => {
        if (arg.isKind(SyntaxKind.ObjectLiteralExpression)) {
          const functionArg: Argument = {
            type: `Parameters<typeof ${node
              .getExpression()
              .getText()}>[${i}] = {}`,
            destructure: [],
          }

          functionArg.destructure = functionArg.destructure.concat(
            arg.getProperties().map((p) => p.getText())
          )

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
      imports = imports.concat(nestedDecl.imports)
      variables = variables.concat(nestedDecl.variables)
      args = args.concat(nestedDecl.args)
    }
  })
  return {
    imports,
    variables,
    args,
  }
}

function parseAttribute(jsxAttribute: JsxAttribute) {
  const initializer = jsxAttribute.getInitializer()

  if (initializer) {
    if (initializer.isKind(SyntaxKind.JsxExpression)) {
      const declarations = findDependencies(initializer)
      return {
        imports: declarations.imports,
        variablesToMove: declarations.variables,
        valueText: initializer.getText(),
        args: declarations.args,
        name: jsxAttribute.getName(),
      }
    }
  }
  return null
}

interface ObjectProp {
  propertyName: string
  value: string
}

interface WriteableObject {
  [key: string]:
    | {
        type: "object"
        object: WriteableObject
      }
    | {
        type: "function"
        props: ObjectProp[]
        args: Argument[]
      }
}

function writeObject(writer: CodeBlockWriter, data: WriteableObject) {
  for (const [key, value] of Object.entries(data)) {
    if (value.type === "function") {
      const args = value.args
        .map((a) => `{${a.destructure.join(", ")}}: ${a.type}`)
        .join(", ")
      writer.writeLine(`${key}(${args}){`)
      writer.indent(() => {
        writer.write(`return { `)
        value.props.forEach((prop) => {
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
        writer.write(" };")
      })
      writer.writeLine("},")
    } else {
      writer.write(`"${key}": {`)
      writer.indent(() => {
        writeObject(writer, value.object)
      })
      writer.writeLine("},")
    }
  }
}

function createObject(
  source: SourceFile,
  object: WriteableObject,
  destructures: string[],
  functionTypes: string[]
) {
  source.addVariableStatement({
    declarationKind: VariableDeclarationKind.Const,
    isExported: true,
    declarations: [
      {
        name: "styles",
        initializer: (writer) => {
          writer.writeLine("{")
          writeObject(writer, object)
          writer.writeLine("}")
        },
      },
    ],
  })
}

function createProject() {
  return new Project({
    // these are the defaults
    manipulationSettings: {
      // TwoSpaces, FourSpaces, EightSpaces, or Tab
      indentationText: IndentationText.Tab,
      // LineFeed or CarriageReturnLineFeed
      newLineKind: NewLineKind.LineFeed,
      // Single or Double
      quoteKind: QuoteKind.Double,
      // Whether to change shorthand property assignments to property assignments
      // and add aliases to import & export specifiers (see more information in
      // the renaming section of the documentation).
      usePrefixAndSuffixTextForRename: false,
      // Whether to use trailing commas in multi-line scenarios where trailing
      // commas would be used.
      useTrailingCommas: true,
    },
  })
}

function getPropertyName(tagName: string, component: string) {
  tagName = `${tagName[0].toLowerCase()}${tagName.substring(1)}`
  if (tagName.startsWith(component) && tagName !== component) {
    tagName = tagName.substring(component.length)
  }
  return `${tagName[0].toLowerCase()}${tagName.substring(1)}`
}

function addGetStyleProps(
  object: WriteableObject,
  component: string,
  parents: string[],
  props: ObjectProp[],
  args: Argument[]
) {
  let stylePath = "styles"
  let current = object
  for (let i = parents.length - 1; i >= 0; i--) {
    const propName = getPropertyName(parents[i], component)
    if (!(propName in current)) {
      current[propName] = {
        type: "object",
        object: {},
      }
    }
    if (current[propName].type === "object") {
      current = current[propName].object
      stylePath += `["${propName}"]`
    } else {
      throw Error("Unable to add getStyleProps")
    }
  }

  current["getStyleProps"] = {
    type: "function",
    props,
    args,
  }
  return stylePath
}

const iconPackages = ["lucide", "icon"]
const styleAttributes = ["className", "style"]

export const extractStyles = new Command()
  .name("extract")
  .description("extract styles from components")
  .option(
    "-c, --cwd <cwd>",
    "the working directory. defaults to the current directory.",
    process.cwd()
  )
  .action(async (opts) => {
    const styles = ["new-york"]
    const extractIcons: any = {}
    const components = ["button", "accordion"]
    const project = createProject()
    for (const component of components) {
      for (const style of styles) {
        const extractedStyle: WriteableObject = {}
        const source = project.addSourceFileAtPath(
          path.join(opts.cwd, "registry", style, "ui", `${component}.tsx`)
        )
        const componentStylePath = path.join(
          opts.cwd,
          "registry",
          "styles",
          style,
          `${component}.tsx`
        )
        const styleSource = project.createSourceFile(componentStylePath, "", {
          overwrite: true,
        })
        let jsxElements: JsxElement[] = source.getDescendantsOfKind(
          SyntaxKind.JsxSelfClosingElement
        )
        jsxElements = jsxElements.concat(
          source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
        )
        const rootElements: Node<ts.Node>[] = []
        let imports: ImportDeclaration[] = []
        let variablesToMove: VariableDeclaration[] = []
        jsxElements.forEach((jsxElement) => {
          const { importDeclaration } = analyzeDeclarations(
            jsxElement.getTagNameNode().getSymbol()
          )
          if (
            importDeclaration &&
            iconPackages.some((pkg) =>
              importDeclaration.getModuleSpecifierValue().includes(pkg)
            )
          ) {
            console.log(`${jsxElement.getTagNameNode().getText()} is an icon`)
          }

          const props: ObjectProp[] = []
          let args: Argument[] = []

          const { ancestors, root: rootElement } = jsxElement.isKind(
            SyntaxKind.JsxOpeningElement
          )
            ? getParents(jsxElement.getParent())
            : getParents(jsxElement)
          if (rootElement) {
            rootElements.push(rootElement)
          }

          styleAttributes.forEach((styleAttribute) => {
            const classNameAttribute = jsxElement.getAttribute(styleAttribute)
            if (classNameAttribute?.isKind(SyntaxKind.JsxAttribute)) {
              const attr = parseAttribute(classNameAttribute)
              if (attr) {
                imports = imports.concat(attr.imports)
                variablesToMove = variablesToMove.concat(attr.variablesToMove)
                props.push({
                  propertyName: attr.name,
                  value: attr.valueText,
                })
                args = args.concat(attr.args)
              }
              classNameAttribute.remove()
            }
          })
          const stylePath = addGetStyleProps(
            extractedStyle,
            component,
            ancestors,
            props,
            args
          )

          jsxElement.insertAttribute(0, {
            kind: StructureKind.JsxSpreadAttribute,
            expression: stylePath,
          })
        })
        distinct(rootElements).forEach((rootElement) => {
          inject(rootElement)
        })
        distinct(imports).forEach((importDeclaration) => {
          styleSource.addImportDeclaration({
            moduleSpecifier: importDeclaration.getModuleSpecifierValue(),
            namedImports: importDeclaration
              .getNamedImports()
              .map((i) => i.getName()),
          })
        })
        source.addImportDeclaration({
          namedImports: distinct(variablesToMove)
            .map((v) => v.getName())
            .concat(["styles"]),
          moduleSpecifier: `@/registry/styles/${style}/${component}`,
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

        const copiedFile = source.copy(
          path.join(opts.cwd, "registry", "ui", `${component}.tsx`),
          { overwrite: true }
        )

        createObject(styleSource, extractedStyle, [], [])
        await Promise.all([copiedFile.save(), styleSource.save()])
      }
    }
  })

function distinct<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}
