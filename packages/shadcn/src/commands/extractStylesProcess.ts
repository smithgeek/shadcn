import path from "path";
import {
	ArrowFunction,
	FunctionDeclaration,
	Identifier,
	ImportDeclaration,
	ImportSpecifier,
	JsxAttribute,
	JsxAttributeLike,
	JsxOpeningElement,
	JsxSelfClosingElement,
	Node,
	Project,
	ReferenceEntry,
	ReferencedSymbol,
	SourceFile,
	StructureKind,
	SyntaxKind,
	Type,
	VariableDeclaration,
	VariableDeclarationKind,
	ts,
} from "ts-morph";
import { Worker, parentPort, workerData } from "worker_threads";

type JsxBeginElement = JsxSelfClosingElement | JsxOpeningElement;

function toPropertyAssignment(variable: VariableDefinition) {
	if (!variable.destinationName || variable.destinationName === variable.sourceName) {
		return `${variable.sourceName}`;
	}
	return `${variable.destinationName}: ${variable.sourceName}`;
}

function callGetStyles(functionBuilder: StyleFunctionBuilder) {
	const args = distinctBy(functionBuilder.parameters, (p) => p.sourceName).map(toPropertyAssignment);
	const argList = args.length > 0 ? `{ ${args.join(", ")} }` : "";
	return `styling.get${functionBuilder.name}(${argList})`;
}

function createStyleObject(source: SourceFile, styleBuilder: StyleFileBuilder) {
	styleBuilder.style.functions
		.filter((f) => f.parameters.length > 0)
		.forEach((fb) => {
			const properties = distinctBy(
				fb.parameters
					.filter((p) => p.type !== null)
					.map((p) => ({
						name: `${p.destinationName ?? p.sourceName}${p.type!.isOptional ? "?" : ""}`,
						type: p.type!.text,
					})),
				(p) => p.name
			);
			source.addStatements((writer) => {
				writer.writeLine("");
				writer.writeLine(`export interface ${fb.name}Props{`);
				writer.indent(() => {
					properties.forEach((p) => writer.writeLine(`${p.name}: ${p.type};`));
				});
				writer.writeLine(`}`);
			});
		});

	styleBuilder.style.variables.forEach((v) => {
		source.addVariableStatement({
			declarationKind: VariableDeclarationKind.Const,
			kind: StructureKind.VariableStatement,
			isExported: v.export,
			declarations: [
				{
					kind: StructureKind.VariableDeclaration,
					name: v.declaration.getName(),
					initializer: v.declaration.getInitializer()?.getText(),
					hasExclamationToken: v.declaration.hasExclamationToken(),
					type: v.declaration.getTypeNode()?.getText(),
				},
			],
		});
	});

	source.addVariableStatement({
		declarationKind: VariableDeclarationKind.Const,
		isExported: true,
		declarations: [
			{
				name: "styling",
				initializer: (writer) => {
					writer.block(() => {
						styleBuilder.style.functions.forEach((fb) => {
							const args =
								fb.parameters.length === 0
									? ""
									: `{${distinct(fb.parameters.map((p) => p.destinationName ?? p.sourceName)).join(", ")}}: ${
											fb.name
									  }Props`;
							const addDefault = fb.parameters.length > 0 && fb.parameters.every((p) => p.type === null || p.type.isOptional);
							writer.write(`get${fb.name}(${args}${addDefault ? " = {}" : ""}) {`);
							writer.indent(() => {
								writer.write("return ");
								writer.block(() => {
									Object.entries(fb.properties).forEach(([prop, getValue]) => {
										writer.write(`${prop}: `);
										const value = getValue();
										if (value.startsWith(`"`) || value.startsWith(`'`) || value.startsWith("`")) {
											writer.write(`${value},`);
										} else {
											writer.write(`${value.substring(1, value.length - 1)},`);
										}
									});
								});
							});
							writer.writeLine("},");
						});
					});
				},
			},
		],
	});
}

const iconPackages = ["lucide", "icon"];
const styleAttributes = ["className", "style", "classNames"];

let startTime: number = 0;

interface Manipulation {
	action: () => void;
	pass: ManipulationPass;
}

enum ManipulationPass {
	BeforeStyleGeneration,
	AfterStyleGeneration,
}

interface StyleFunctionBuilder {
	name: string;
	parameters: VariableDefinition[];
	rootFunction: ArrowFunction | FunctionDeclaration;
	properties: Record<string, () => string>;
}

interface StyleFileBuilder {
	style: {
		functions: StyleFunctionBuilder[];
		getFunction(name: string, rootFunction: ArrowFunction | FunctionDeclaration, forceCreate?: boolean): StyleFunctionBuilder;
		variables: {
			declaration: VariableDeclaration;
			export: boolean;
		}[];
		imports: ImportInfo[];
	};
	component: {
		imports: ImportInfo[];
	};
	manipulations: Manipulation[];
	runManipulations(pass: ManipulationPass): void;
}

function createStyleFileBuilder(): StyleFileBuilder {
	return {
		style: {
			functions: [],
			variables: [],
			imports: [],
			getFunction(name: string, rootFunction, forceCreate: boolean = false) {
				const originalName = name;
				let func = this.functions.find((f) => f.name === name);
				let i = 2;
				while (forceCreate && func) {
					name = `${originalName}${i}`;
					i++;
					func = this.functions.find((f) => f.name === name);
				}
				if (!func) {
					func = {
						name,
						parameters: [],
						rootFunction,
						properties: {},
					};
					this.functions.push(func);
				}
				return func;
			},
		},
		component: {
			imports: [],
		},
		manipulations: [],
		runManipulations(pass) {
			const actions = this.manipulations.filter((m) => m.pass === pass).map((m) => m.action);

			actions.forEach((action) => action());
		},
	};
}

interface VariableDefinition {
	sourceName: string;
	destinationName?: string;
	type: TypeInfo | null;
}

type ImportInfo =
	| {
			clause?: never;
			name: string;
			from: string;
	  }
	| {
			clause: string;
			from: string;
			name?: never;
	  };

interface TypeInfo {
	text: string;
	imports: ImportInfo[];
	isOptional: boolean;
}

function getImportInfo(declaration: ImportDeclaration, name: string) {
	const importClause = declaration.getFirstDescendantByKind(SyntaxKind.ImportClause);
	const namedImport = declaration.getFirstDescendantByKind(SyntaxKind.NamedImports);
	if (namedImport) {
		return {
			name,
			from: declaration.getModuleSpecifier().getText().replace(/"/g, ""),
		};
	} else if (importClause) {
		return {
			clause: importClause.getText(),
			from: declaration.getModuleSpecifier().getText().replace(/"/g, ""),
		};
	}
	return null;
}

function removeFileExtension(fileName: string) {
	return fileName.substring(0, fileName.indexOf("."));
}

function resolveImportSpecifier(node: Node): string | null {
	const symbol = node.getType().getSymbol() ?? node.getType().getAliasSymbol();
	if (!symbol) return null;

	// Get the declaration of the symbol
	const declarations = symbol.getDeclarations();
	if (!declarations.length) return null;

	const declaration = declarations[0];
	const sourceFile = declaration.getSourceFile();

	// If the symbol comes from node_modules
	if (sourceFile.isInNodeModules()) {
		const importingFile = node.getSourceFile();
		for (const importDeclaration of importingFile.getImportDeclarations()) {
			const filePath = importDeclaration.getModuleSpecifierSourceFile()?.getFilePath();
			if (filePath) {
				const dir = path.dirname(filePath);
				const sourceFilePath = sourceFile.getFilePath();
				if (sourceFilePath.startsWith(dir)) {
					const module = importDeclaration.getModuleSpecifierValue();
					const lookup = `node_modules/${module}`;
					const index = sourceFilePath.indexOf(lookup);
					if (index !== -1) {
						return `${module}${removeFileExtension(sourceFilePath.substring(index + lookup.length))}`;
					}
				}
			}
		}
		return importingFile.getRelativePathAsModuleSpecifierTo(sourceFile);
	}

	// If the symbol is a local file
	const importDeclaration = declaration.getFirstAncestorByKind(ts.SyntaxKind.ImportDeclaration);
	if (importDeclaration) {
		return importDeclaration.getModuleSpecifierValue();
	}

	// Fallback: compute relative path for non-imported local declarations
	const relativePath = sourceFile.getRelativePathTo(sourceFile.getFilePath());
	return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function getTypeInfo(node: Node<ts.Node>, type: Type | undefined = undefined): TypeInfo {
	type ??= node.getType();

	const typeInfo: TypeInfo = {
		text: type.getText(),
		imports: [],
		isOptional: type.isUndefined() || (type.isUnion() && type.getUnionTypes().some((t) => t.isUndefined())),
	};

	if (typeInfo.text.includes("import(")) {
		const name = node.getType().getAliasSymbol()?.getEscapedName() ?? node.getType().getSymbol()?.getEscapedName();
		const module = resolveImportSpecifier(node);
		if (module && name) {
			typeInfo.text = name;
			typeInfo.imports.push({
				from: module,
				name,
			});
		}
	}
	return typeInfo;
}

interface FileContext {
	styleBuilder: StyleFileBuilder;
	style: string;
	component: string;
}

function addImports(node: Node, context: FileContext) {
	const declarations = node.getSymbol()?.getDeclarations();
	declarations
		?.filter((d) => d.isKind(SyntaxKind.ImportSpecifier))
		.forEach((i) => {
			const imp = getImportInfo(i.getImportDeclaration(), i.getText());
			if (imp) {
				context.styleBuilder.style.imports.push(imp);
			}
		});
}

interface NodeContext {
	attribute: JsxAttribute;
	identifier: Identifier;
}

function analyzeProperties(nodeContext: NodeContext, functionBuilder: StyleFunctionBuilder, context: FileContext) {
	const { identifier } = nodeContext;

	const parent = identifier.getParent();
	// if (parent.isKind(SyntaxKind.PropertyAccessExpression)) {
	// 	const destinationName = parent.getDescendantsOfKind(SyntaxKind.Identifier).reverse()[0].getText();
	// 	functionBuilder.parameters.push({
	// 		sourceName: parent.getText(),
	// 		type: getTypeInfo(parent),
	// 		destinationName,
	// 	});
	// 	// context.styleBuilder.manipulations.push({
	// 	// 	action: () => parent.replaceWithText(destinationName),
	// 	// 	pass: ManipulationPass.BeforeStyleGeneration,
	// 	// });
	// } else
	if (parent.isKind(SyntaxKind.PropertyAssignment)) {
		const propValue = parent.getChildAtIndex(2);
		if (propValue.isKind(SyntaxKind.PropertyAccessExpression)) {
			const firstId = propValue.getChildAtIndex(0);
			functionBuilder.parameters.push({
				sourceName: firstId.getText(),
				type: getTypeInfo(firstId, firstId.getSymbol()?.getTypeAtLocation(propValue)),
			});
		} else {
			functionBuilder.parameters.push({
				sourceName: parent.getChildAtIndex(2).getText(),
				type: getTypeInfo(parent, parent.getSymbol()?.getTypeAtLocation(parent.getParent())),
			});
		}
	} else if (
		parent.isKind(SyntaxKind.BinaryExpression) ||
		identifier
			.getSymbol()
			?.getDeclarations()
			.some((d) => d.isKind(SyntaxKind.BindingElement))
	) {
		functionBuilder.parameters.push({
			sourceName: identifier.getText(),
			type: getTypeInfo(identifier, identifier.getSymbol()?.getTypeAtLocation(identifier.getParent())),
		});
	}
}

function analyzeVariableDeclarations(nodeContext: NodeContext, functionBuilder: StyleFunctionBuilder, context: FileContext) {
	const { attribute, identifier } = nodeContext;
	const declarations = identifier.getSymbol()?.getDeclarations();
	declarations
		?.filter((d) => d.isKind(SyntaxKind.VariableDeclaration))
		.forEach((declaration) => {
			const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement);
			if (statement?.getParent().isKind(SyntaxKind.SourceFile)) {
				const shouldExport = identifier.findReferences().some((refNode) => {
					return refNode.getReferences().some((ref) =>
						ref
							.getNode()
							.getAncestors()
							.every((a) => a !== statement && a !== attribute)
					);
				});
				if (shouldExport) {
					context.styleBuilder.component.imports.push({
						from: `@/registry/styles/${context.style}/${context.component}`,
						name: identifier.getText(),
					});
				}
				const rhs = declaration.getChildAtIndex(2);
				if (rhs.isKind(SyntaxKind.CallExpression)) {
					rhs.getDescendantsOfKind(SyntaxKind.Identifier).forEach((id) => addImports(id, context));
				}
				context.styleBuilder.style.variables.push({
					declaration,
					export: shouldExport,
				});
				context.styleBuilder.manipulations.push({
					action: () => {
						statement.remove();
					},
					pass: ManipulationPass.AfterStyleGeneration,
				});
			} else {
				functionBuilder.parameters.push({
					sourceName: identifier.getText(),
					type: getTypeInfo(identifier),
				});
			}
		});
}

function analyzeClassVarianceAuthority(nodeContext: NodeContext, functionBuilder: StyleFunctionBuilder, context: FileContext) {
	const { identifier } = nodeContext;
	const declarations = identifier.getSymbol()?.getDeclarations();
	declarations
		?.filter((d) => d.isKind(SyntaxKind.VariableDeclaration))
		.forEach((declaration) => {
			const rhs = declaration.getChildAtIndex(2);
			if (rhs.getChildren().length > 0 && rhs.getChildAtIndex(0).getText() === "cva") {
				const cvaParams = identifier.getParent().getChildAtIndex(2).getChildren();
				if (cvaParams.length > 0) {
					const objParam = cvaParams[0];
					if (objParam.isKind(SyntaxKind.ObjectLiteralExpression)) {
						objParam.getProperties().forEach((prop) => {
							if (prop.isKind(SyntaxKind.PropertyAssignment) || prop.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
								const name = prop.isKind(SyntaxKind.ShorthandPropertyAssignment)
									? prop.getName()
									: prop.getInitializer()?.getText();
								if (name !== "className") {
									const exisitingParam = functionBuilder.parameters.find((p) => p.sourceName === name);
									if (exisitingParam) {
										exisitingParam.type = {
											text: `VariantProps<typeof ${identifier.getText()}>["${prop.getName()}"]`,
											imports: [],
											isOptional: true,
										};
									}
								}
							}
						});
					}
				}
				context.styleBuilder.style.imports.push({
					from: "class-variance-authority",
					name: "VariantProps",
				});
			}
		});
}

function analyzeImports(nodeContext: NodeContext, functionBuilder: StyleFunctionBuilder, context: FileContext) {
	addImports(nodeContext.identifier, context);
}

type IdentifierAnalyzer = (nodeContext: NodeContext, functionBuilder: StyleFunctionBuilder, context: FileContext) => void;
const analyzers: IdentifierAnalyzer[] = [analyzeImports, analyzeProperties, analyzeVariableDeclarations, analyzeClassVarianceAuthority];

function analyzeAttribute(attribute: JsxAttribute, functionBuilder: StyleFunctionBuilder, context: FileContext) {
	const childIdentifiers = attribute.getDescendantsOfKind(SyntaxKind.Identifier).slice(1);
	analyzers.forEach((analyzer) => {
		childIdentifiers.forEach((identifier) => {
			const nodeContext: NodeContext = { attribute, identifier };
			analyzer(nodeContext, functionBuilder, context);
		});
	});
}

function getRootFunction(jsxElement: JsxBeginElement): { name: string; rootFunction: ArrowFunction | FunctionDeclaration } {
	const rootFunction = jsxElement
		.getAncestors()
		.filter((a) => a.isKind(SyntaxKind.ArrowFunction) || a.isKind(SyntaxKind.FunctionDeclaration))
		.reverse()[0];
	if (rootFunction.isKind(SyntaxKind.FunctionDeclaration)) {
		return { name: `${rootFunction.getName()}`, rootFunction };
	}
	const variableDeclaration = rootFunction.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
	if (variableDeclaration) {
		return { name: `${variableDeclaration.getName()}`, rootFunction };
	}
	throw Error("Could not determine style function name.");
}

function getLiteralTextFromAttribute(attribute: JsxAttributeLike | undefined) {
	if (attribute) {
		const children = attribute.getChildren();
		if (children.length > 2) {
			if (children[2].isKind(SyntaxKind.StringLiteral)) {
				return children[2].getLiteralText();
			}
		}
	}
	return null;
}

function getGroupName(jsxElement: JsxBeginElement) {
	return jsxElement
		.getAncestors()
		.filter((a) => a.isKind(SyntaxKind.JsxElement))
		.map((e) => e.getOpeningElement())
		.map((element) => {
			const idAttr = getLiteralTextFromAttribute(element.getAttribute("id"));
			if (idAttr) {
				return idAttr;
			}
			const nameAttr = getLiteralTextFromAttribute(element.getAttribute("name"));
			if (nameAttr) {
				return nameAttr;
			}
			return element.getTagNameNode().getText();
		})
		.filter((n) => !n.endsWith("Provider"))
		.reverse()
		.join(" ");
}

export async function processSource({
	project,
	style,
	componentName,
	cwd,
}: {
	project: Project;
	style: string;
	componentName: string;
	cwd: string;
}): Promise<{ task: Promise<void> }> {
	startTime = Date.now();
	const styleBuilder = createStyleFileBuilder();
	const context: FileContext = {
		styleBuilder,
		style,
		component: componentName,
	};

	const source = project.getSourceFileOrThrow(path.join(cwd, "registry", style, "ui", `${componentName}.tsx`));
	console.log(`${style} - ${componentName} - style file`);
	const styleRelativePath = path.join("registry", "styles", style, `${componentName}.tsx`);
	const styleSource = project.getSourceFileOrThrow(path.join(cwd, styleRelativePath));
	console.log(`${style} - ${componentName} - descendants`);
	let jsxElements: JsxBeginElement[] = [
		...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
		...source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
	];

	jsxElements.forEach((jsxElement) => {
		const { name: rootFunctionName, rootFunction } = getRootFunction(jsxElement);
		const functionName = toValidFunctionName(`${rootFunctionName} ${getGroupName(jsxElement)} Styling`);
		const functionBuilder = styleBuilder.style.getFunction(functionName, rootFunction, true);

		let addStyleProp = false;
		styleAttributes.forEach((styleAttribute) => {
			const attribute = jsxElement.getAttribute(styleAttribute);
			if (attribute?.isKind(SyntaxKind.JsxAttribute)) {
				analyzeAttribute(attribute, functionBuilder, context);
				const initializer = attribute.getInitializer();
				if (initializer) {
					addStyleProp = true;
					context.styleBuilder.manipulations.push({
						action: () => {
							functionBuilder.properties[attribute.getName()] = () => initializer.getText();
						},
						pass: ManipulationPass.BeforeStyleGeneration,
					});
				}
				context.styleBuilder.manipulations.push({
					action: () => {
						attribute.remove();
					},
					pass: ManipulationPass.AfterStyleGeneration,
				});
			}
		});

		if (addStyleProp) {
			styleBuilder.manipulations.push({
				action: () => {
					jsxElement.insertAttribute(0, {
						kind: StructureKind.JsxSpreadAttribute,
						expression: callGetStyles(functionBuilder),
					});
				},
				pass: ManipulationPass.AfterStyleGeneration,
			});
		}
	});

	styleBuilder.runManipulations(ManipulationPass.BeforeStyleGeneration);

	const styleImports = styleBuilder.style.functions.flatMap((fb) =>
		fb.parameters.flatMap((p) => p.type?.imports ?? []).concat(styleBuilder.style.imports)
	);
	addImportsToSourceFile(styleImports, styleSource);

	styleBuilder.component.imports.push({
		from: `@/registry/styles/${style}/${componentName}`,
		name: "styling",
	});

	styleBuilder.manipulations.push({
		action: () => {
			addImportsToSourceFile(styleBuilder.component.imports, source);
		},
		pass: ManipulationPass.AfterStyleGeneration,
	});

	const saveTask = saveResults({
		source,
		styleSource,
		styleBuilder: cleanupBuilder(styleBuilder),
		cwd,
		componentName,
	});
	return {
		task: saveTask,
	};
}

function addImportsToSourceFile(imports: ImportInfo[], source: SourceFile) {
	Object.entries(groupBy(imports, (i) => i.from)).forEach(([moduleSpecifier, group]) => {
		const namedImports = distinct(group.filter((i) => i.name !== undefined).map((i) => i.name));
		const clauses = distinct(group.filter((i) => i.clause !== undefined).map((i) => i.clause));
		source.addImportDeclaration({
			moduleSpecifier: moduleSpecifier,
			namedImports: namedImports.length > 0 ? namedImports : undefined,
			defaultImport: clauses.length > 0 ? clauses.join(", ") : undefined,
		});
	});
}

function cleanupBuilder(styleBuilder: StyleFileBuilder): StyleFileBuilder {
	return {
		...styleBuilder,
		style: {
			...styleBuilder.style,
			functions: styleBuilder.style.functions.filter((f) => Object.entries(f.properties).length > 0),
		},
	};
}

async function saveResults({
	source,
	styleSource,
	styleBuilder,
	cwd,
	componentName,
}: {
	source: SourceFile;
	cwd: string;
	componentName: string;
	styleSource: SourceFile;
	styleBuilder: StyleFileBuilder;
}) {
	createStyleObject(styleSource, styleBuilder);

	styleBuilder.runManipulations(ManipulationPass.AfterStyleGeneration);
	removeUnusedImports(source);
	const copiedFile = source.copy(path.join(cwd, "registry", "ui", `${componentName}.tsx`), { overwrite: true });
	await Promise.all([copiedFile.save(), styleSource.save()]);
	console.log(Date.now() - startTime);
}

function isReferenceUsed(ref: ReferenceEntry) {
	const node = ref.getNode();
	if (node.getParentIfKind(SyntaxKind.ImportSpecifier)) {
		return false;
	}
	return true;
}

function getUsedReferences(references: ReferencedSymbol[]) {
	return references.flatMap((ref) => ref.getReferences()).filter(isReferenceUsed);
}

function removeUnusedImports(sourceFile: SourceFile) {
	const unusedImports: (ImportDeclaration | ImportSpecifier)[] = [];

	for (const importDeclaration of sourceFile.getImportDeclarations()) {
		let used = 0;
		for (const importSpecifier of importDeclaration.getNamedImports()) {
			const references = getUsedReferences(importSpecifier.getNameNode().findReferences());

			if (references.length === 0) {
				unusedImports.push(importSpecifier);
			} else {
				used += references.length;
			}
		}

		const defaultImport = importDeclaration.getDefaultImport();
		if (defaultImport && getUsedReferences(defaultImport.findReferences()).length > 0) {
			used++;
		}

		const namespaceImport = importDeclaration.getNamespaceImport();
		if (namespaceImport) {
			const references = getUsedReferences(namespaceImport.findReferences());
			if (references.length > 0) {
				used++;
			}
		}

		if (used === 0) {
			unusedImports.push(importDeclaration);
		}
	}
	unusedImports.forEach((i) => i.remove());
}

function distinct<T>(arr: T[]): T[] {
	return Array.from(new Set(arr));
}

function distinctBy<T>(arr: T[], key: (t: T) => string): T[] {
	return Array.from(new Map(arr.map((t) => [key(t), t])).values());
}

export async function processSourceThread(data: Parameters<typeof processSource>[0]) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(__filename, { workerData: data });

		worker.on("message", (result) => {
			resolve(result);
		});

		worker.on("error", (err) => {
			reject(err);
		});

		worker.on("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`Worker stopped with exit code ${code}`));
			}
		});
	});
}

parentPort?.postMessage(processSource(workerData));

function groupBy<T>(arr: T[], key: (t: T) => string): { [key: string]: T[] } {
	return arr.reduce((acc, t) => {
		const k = key(t);
		if (k in acc) {
			acc[k].push(t);
		} else {
			acc[k] = [t];
		}
		return acc;
	}, {} as { [key: string]: T[] });
}

function toValidFunctionName(input: string) {
	if (typeof input !== "string" || !input.trim()) {
		throw new Error("Input must be a non-empty string.");
	}

	// Remove invalid characters and trim leading/trailing spaces
	let sanitized = input.trim().replace(/[^a-zA-Z0-9_$]/g, " ");

	// Convert to camelCase
	sanitized = sanitized
		.split(/\s+/)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");

	// Ensure the first character is a valid identifier start
	if (!/^[a-zA-Z_$]/.test(sanitized)) {
		sanitized = "_" + sanitized;
	}

	// Check if it's a reserved keyword and append a suffix if necessary
	const reservedWords = new Set([
		"break",
		"case",
		"catch",
		"class",
		"const",
		"continue",
		"debugger",
		"default",
		"delete",
		"do",
		"else",
		"enum",
		"export",
		"extends",
		"false",
		"finally",
		"for",
		"function",
		"if",
		"import",
		"in",
		"instanceof",
		"new",
		"null",
		"return",
		"super",
		"switch",
		"this",
		"throw",
		"true",
		"try",
		"typeof",
		"var",
		"void",
		"while",
		"with",
		"yield",
	]);

	if (reservedWords.has(sanitized)) {
		sanitized += "_fn";
	}

	return sanitized;
}
