import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function loadSource(relative) {
  return import(await sourceUrl(new URL(relative, import.meta.url)));
}

async function sourceUrl(file) {
  const source = await readFile(file, "utf8");
  let code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const imports = [...code.matchAll(/from\s+["']([^"']+)["']/gu)];
  for (const match of imports) {
    const specifier = match[1];
    const target = specifier.startsWith(".")
      ? await sourceUrl(new URL(`${specifier}.ts`, file))
      : import.meta.resolve(specifier);
    code = code.replace(match[0], `from ${JSON.stringify(target)}`);
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
