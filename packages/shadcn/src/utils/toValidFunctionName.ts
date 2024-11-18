function toValidFunctionName(input: string) {
	if (typeof input !== "string" || !input.trim()) {
		throw new Error("Input must be a non-empty string.");
	}

	// Remove invalid characters and trim leading/trailing spaces
	let sanitized = input.trim().replace(/[^a-zA-Z0-9_$]/g, " ");

	// Convert to camelCase
	sanitized = sanitized
		.split(/\s+/)
		.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
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
