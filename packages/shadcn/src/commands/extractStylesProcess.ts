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

function inject(functionBuilder: StyleFunctionBuilder) {
	const args = distinctBy(functionBuilder.parameters, (p) => p.sourceName).map(toPropertyAssignment);
	const argList = args.length > 0 ? `{ ${args.join(", ")} }` : "";
	const stylesCode = `const styles = styling.get${functionBuilder.name}(${argList})`;
	const { rootFunction } = functionBuilder;
	if (rootFunction.isKind(SyntaxKind.ArrowFunction)) {
		const body = rootFunction.getBody();
		if (body.isKind(SyntaxKind.Block)) {
			body.insertStatements(functionBuilder.injectLocation, stylesCode);
		} else if (body.isKind(SyntaxKind.ParenthesizedExpression)) {
			body.replaceWithText((writer) => {
				writer.block(() => {
					writer.writeLine(stylesCode);
					writer.writeLine(`return ${body.getText()}`);
				});
			});
		}
	} else if (rootFunction.isKind(SyntaxKind.FunctionDeclaration)) {
		rootFunction.insertStatements(functionBuilder.injectLocation, stylesCode);
	}
}

function createStyleObject(source: SourceFile, styleBuilder: StyleFileBuilder) {
	styleBuilder.style.functions.forEach((fb) => {
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
			const intersectionTypes = distinct(fb.intersectionTypes);
			writer.writeLine(`}${intersectionTypes.length > 0 ? ` & ${intersectionTypes.join(" & ")}` : ""}`);
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
							const args = `{${distinct(fb.parameters.map((p) => p.destinationName ?? p.sourceName)).join(", ")}}: ${
								fb.name
							}Props`;
							const addDefault = fb.parameters.every((p) => p.type === null || p.type.isOptional);
							writer.write(`get${fb.name}(${args}${addDefault ? " = {}" : ""}) {`);
							writer.indent(() => {
								writer.write("return ");
								writer.block(() => {
									for (const group of fb.groups) {
										writer.write(`"${group.name}": {`);
										writer.indent(() => {
											Object.entries(group.properties).forEach(([prop, getValue]) => {
												writer.write(`${prop}: `);
												const value = getValue();
												if (value.startsWith(`"`) || value.startsWith(`'`) || value.startsWith("`")) {
													writer.write(`${value},`);
												} else {
													writer.write(`${value.substring(1, value.length - 1)},`);
												}
											});
										});
										writer.writeLine("},");
									}
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

interface StyleGroup {
	name: string;
	properties: Record<string, () => string>;
}

interface StyleFunctionBuilder {
	name: string;
	parameters: VariableDefinition[];
	groups: StyleGroup[];
	getGroup(name: string): StyleGroup;
	createGroup(jsxElement: JsxBeginElement): StyleGroup;
	rootFunction: ArrowFunction | FunctionDeclaration;
	injectLocation: number;
	injectAfter(node: Node): void;
	intersectionTypes: string[];
}

interface StyleFileBuilder {
	style: {
		functions: StyleFunctionBuilder[];
		getFunction(name: string, rootFunction: ArrowFunction | FunctionDeclaration): StyleFunctionBuilder;
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
			getFunction(name: string, rootFunction) {
				let func = this.functions.find((f) => f.name === name);
				if (!func) {
					func = {
						name,
						parameters: [],
						groups: [],
						getGroup(name) {
							let group = this.groups.find((g) => g.name === name);
							if (!group) {
								group = { name, properties: {} };
								this.groups.push(group);
							}
							return group;
						},
						createGroup(jsxElement: JsxBeginElement) {
							const originalName = getGroupName(jsxElement);
							let name = originalName;
							let i = 2;
							while (this.groups.find((g) => g.name === name)) {
								name = `${originalName}${i}`;
								i++;
							}
							return this.getGroup(name);
						},
						rootFunction,
						injectLocation: 0,
						intersectionTypes: [],
						injectAfter(node: Node) {
							const tree = [node];
							let current = node.getParent();
							while (current && current != this.rootFunction) {
								tree.push(current);
								current = current.getParent();
							}
							if (current === this.rootFunction) {
								if (tree[tree.length - 1].isKind(SyntaxKind.Block)) {
									this.injectLocation = Math.max(this.injectLocation, tree[tree.length - 2].getChildIndex() + 1);
								} else {
									this.injectLocation = Math.max(this.injectLocation, tree[tree.length - 1].getChildIndex() + 1);
								}
							}
						},
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

function findParentType(node: Node) {
	const declarations = node.getSymbol()?.getDeclarations() ?? [];
	for (const declaration of declarations) {
		let currentNode: Node | undefined = declaration;
		while (currentNode) {
			if (currentNode.isKind(SyntaxKind.Parameter)) {
				return currentNode.getTypeNode()?.getText();
			} else {
				currentNode = currentNode.getParent();
			}
		}
	}
	return undefined;
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

function getNullAndUndefinedTypes(node: Node) {
	const type = node.getType();
	const resultType: string[] = [];
	if (type.isUndefined() || (type.isUnion() && type.getUnionTypes().some((t) => t.isUndefined()))) {
		resultType.push("undefined");
	}
	if (type.isNull() || (type.isUnion() && type.getUnionTypes().some((t) => t.isNull()))) {
		resultType.push("null");
	}
	return resultType;
}

function getTypeFromImport(node: Node<ts.Node>, typeInfo: TypeInfo) {
	const name = findParentType(node);
	if (name) {
		let typeAlias: Node | undefined = undefined;
		let current: Node | undefined = node;
		while (typeAlias === undefined && current !== undefined) {
			if (Node.isStatemented(current)) {
				typeAlias = current.getTypeAlias(name);
				if (typeAlias !== undefined) {
					break;
				}
			}
			current = current.getParent();
		}
		if (typeAlias) {
			typeAlias.getDescendantsOfKind(SyntaxKind.TypeReference).forEach((typeRef) => {
				const actualType = typeRef.getType().getProperty(node.getText());
				typeInfo.text = [`${typeRef.getText()}["${node.getText()}"]`].concat(getNullAndUndefinedTypes(node)).join(" | ");
				typeRef.getDescendantsOfKind(SyntaxKind.Identifier).forEach((identifier) => {
					identifier
						.getSymbol()
						?.getDeclarations()
						.forEach((decl) => {
							const importDeclaration = decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
							if (importDeclaration) {
								const imp = getImportInfo(importDeclaration, identifier.getText());
								if (imp) {
									typeInfo.imports.push(imp);
								}
							}
						});
				});
			});
		}
	}
}

function getTypeInfo(node: Node<ts.Node>, type: Type | undefined = undefined): TypeInfo {
	type ??= node.getType();

	const typeInfo: TypeInfo = {
		text: type.getText(),
		imports: [],
		isOptional: type.isUndefined() || (type.isUnion() && type.getUnionTypes().some((t) => t.isUndefined())),
	};

	if (typeInfo.text.includes("import(")) {
		getTypeFromImport(node, typeInfo);
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

	const declarations = identifier.getSymbol()?.getDeclarations();
	declarations
		?.filter((d) => d.isKind(SyntaxKind.BindingElement) || d.isKind(SyntaxKind.ShorthandPropertyAssignment))
		.forEach((declaration) => {
			const parent = identifier.getParent();
			if (parent.isKind(SyntaxKind.PropertyAccessExpression)) {
				const destinationName = parent.getDescendantsOfKind(SyntaxKind.Identifier).reverse()[0].getText();
				functionBuilder.parameters.push({
					sourceName: parent.getText(),
					type: getTypeInfo(parent),
					destinationName,
				});
				context.styleBuilder.manipulations.push({
					action: () => parent.replaceWithText(destinationName),
					pass: ManipulationPass.BeforeStyleGeneration,
				});
			} else {
				functionBuilder.parameters.push({
					sourceName: identifier.getText(),
					type: getTypeInfo(identifier),
				});
				functionBuilder.injectAfter(declaration);
			}
		});
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
				functionBuilder.injectAfter(declaration);
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
	const childIdentifiers = attribute.getDescendantsOfKind(SyntaxKind.Identifier);
	analyzers.forEach((analyzer) => {
		childIdentifiers.forEach((identifier) => {
			const nodeContext: NodeContext = { attribute, identifier };
			analyzer(nodeContext, functionBuilder, context);
		});
	});
}

function getStyleFunctionName(jsxElement: JsxBeginElement): { name: string; rootFunction: ArrowFunction | FunctionDeclaration } {
	const rootFunction = jsxElement
		.getAncestors()
		.filter((a) => a.isKind(SyntaxKind.ArrowFunction) || a.isKind(SyntaxKind.FunctionDeclaration))
		.reverse()[0];
	if (rootFunction.isKind(SyntaxKind.FunctionDeclaration)) {
		return { name: `${rootFunction.getName()}Styles`, rootFunction };
	}
	const variableDeclaration = rootFunction.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
	if (variableDeclaration) {
		return { name: `${variableDeclaration.getName()}Styles`, rootFunction };
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
		.join(":");
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
		const { name: styleFunctionName, rootFunction } = getStyleFunctionName(jsxElement);
		const functionBuilder = styleBuilder.style.getFunction(styleFunctionName, rootFunction);
		const styleGroup = functionBuilder.createGroup(jsxElement);

		console.log(`${style} - ${componentName} - ${jsxElement.getTagNameNode().getText()} attr`);

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
							styleGroup.properties[attribute.getName()] = () => initializer.getText();
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
						expression: `styles["${styleGroup.name}"]`,
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
			functions: styleBuilder.style.functions
				.map((f) => {
					const modifiedFunc = {
						...f,
						groups: f.groups.filter((g) => {
							if (Object.entries(g.properties).length === 0) {
								return false;
							}
							return true;
						}),
					};
					if (modifiedFunc.groups.length === 0) {
						return null;
					}
					return modifiedFunc;
				})
				.filter((f) => f !== null),
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
	styleBuilder.style.functions.forEach((functionBuilder) => {
		inject(functionBuilder);
	});

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
