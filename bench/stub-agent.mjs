#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const prompt = process.argv.slice(1).join(" ");

if (prompt.includes("package.json")) {
	const pkg = JSON.parse(await readFile("package.json", "utf8"));
	console.log(pkg.name);
}

else if (prompt.includes("featureEnabled")) {
	const config = JSON.parse(await readFile("config.json", "utf8"));
	config.featureEnabled = true;
	await writeFile("config.json", `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	console.log("updated config.json");
}

else if (prompt.includes("fix the implementation")) {
	await writeFile(
		"math.js",
		"export function add(a, b) {\n\treturn a + b;\n}\n",
		"utf8",
	);
	console.log("fixed add");
}

else {
	console.error(`stub agent does not know how to handle: ${prompt}`);
	process.exitCode = 1;
}
