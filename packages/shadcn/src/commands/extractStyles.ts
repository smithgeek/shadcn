import { Command } from "commander";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { CompilerOptions, IndentationText, ManipulationSettings, NewLineKind, Project, QuoteKind } from "ts-morph";

import { processSource } from "./extractStylesProcess";

const manipulationSettings: Partial<ManipulationSettings> = {
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
};

const compilerOptions: CompilerOptions = {
	strict: true,
	allowSyntheticDefaultImports: true,
	esModuleInterop: true,
	incremental: true,
	resolveJsonModule: true,
	isolatedModules: true,
	jsx: 1,
};

function createProject(tsConfigFilePath: string | null) {
	if (tsConfigFilePath) {
		return new Project({
			manipulationSettings,
			tsConfigFilePath,
			skipAddingFilesFromTsConfig: true,
		});
	}
	return new Project({
		manipulationSettings,
		compilerOptions,
	});
}

function searchForTsConfig(cwd: string) {
	while (cwd) {
		const tsConfigPath = path.join(cwd, "tsconfig.json");
		if (existsSync(tsConfigPath)) {
			return tsConfigPath;
		}
		cwd = path.dirname(cwd);
	}
	return null;
}

export const extractStyles = new Command()
	.name("extract")
	.description("extract styles from components")
	.option("-c, --cwd <cwd>", "the working directory. defaults to the current directory.", process.cwd())
	.action(async (opts) => {
		const styles = ["new-york", "default"];
		const extractIcons: any = {};
		console.log("loading components");
		const components = await getComponents(path.join(opts.cwd, "registry", "default", "ui"));
		//const components = ["chart"];
		const project = createProject(searchForTsConfig(opts.cwd));

		const tasks: Promise<void>[] = [];
		for (const style of styles) {
			console.log(`${style}`);
			project.addSourceFilesAtPaths(path.join(opts.cwd, "registry", style, "ui", "*.tsx"));
			components.forEach((componentName) => {
				project.createSourceFile(path.join(opts.cwd, "registry", "styles", style, `${componentName}.tsx`), "", { overwrite: true });
			});
			for (const componentName of components) {
				console.log(`${style} - ${componentName}`);
				const result = await processSource({
					componentName,
					project,
					style,
					cwd: opts.cwd,
				});
				tasks.push(result.task);
			}
		}

		await Promise.all(tasks);
	});

async function getComponents(componentDir: string) {
	const components = await fs.readdir(componentDir);
	return components.filter((c) => c.endsWith(".tsx")).map((c) => path.parse(c).name);
}
