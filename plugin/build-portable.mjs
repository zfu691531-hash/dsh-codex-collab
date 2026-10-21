// TypeScript-only build for environments where esbuild cannot traverse parent
// directories. Keep the package's ESM, CommonJS and declaration entry points.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, "dist");
if (path.dirname(output) !== root || path.basename(output) !== "dist") throw new Error("Invalid output path");
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, {
  noEmit: false, declaration: true, declarationMap: true, sourceMap: true,
  outDir: output, rootDir: path.join(root, "src"),
});
const program = ts.createProgram(parsed.fileNames, parsed.options);
const errors = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
  getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => "\n",
}));
await rm(output, { recursive: true, force: true });
const result = program.emit();
if (result.emitSkipped || result.diagnostics.length) throw new Error("TypeScript emit failed");

function withExtension(text, extension) {
  return text.replace(/(from\s*|import\s*\(\s*|require\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/gu,
    (_match, prefix, quote, specifier) => `${prefix}${quote}${specifier}${path.extname(specifier) ? "" : extension}${quote}`);
}
for (const sourceFile of parsed.fileNames) {
  const relative = path.relative(path.join(root, "src"), sourceFile).replace(/\.ts$/u, "");
  const target = path.join(output, relative);
  const source = await readFile(sourceFile, "utf8");
  const esmFile = `${target}.js`;
  await writeFile(esmFile, withExtension(await readFile(esmFile, "utf8"), ".js"));
  const declaration = await readFile(`${target}.d.ts`, "utf8");
  await writeFile(`${target}.d.ts`, withExtension(declaration, ".js"));
  await writeFile(`${target}.d.cts`, withExtension(declaration.replace(/\.d\.ts\.map/gu, ".d.cts.map"), ".cjs"));
  const declarationMap = JSON.parse(await readFile(`${target}.d.ts.map`, "utf8"));
  declarationMap.file = `${path.basename(relative)}.d.cts`;
  await writeFile(`${target}.d.cts.map`, JSON.stringify(declarationMap));
  const cjs = ts.transpileModule(source, {
    fileName: sourceFile,
    compilerOptions: { ...parsed.options, module: ts.ModuleKind.CommonJS, declaration: false, sourceMap: true },
  });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.cjs`, withExtension(cjs.outputText.replace(/sourceMappingURL=([^\n]+)\.js\.map/u, "sourceMappingURL=$1.cjs.map"), ".cjs"));
  const map = JSON.parse(cjs.sourceMapText);
  map.file = `${path.basename(relative)}.cjs`;
  map.sources = [path.relative(path.dirname(target), sourceFile).replaceAll("\\", "/")];
  await writeFile(`${target}.cjs.map`, JSON.stringify(map));
}
console.log(`PORTABLE_BUILD_OK ${parsed.fileNames.length} modules; ESM + CJS + declarations`);
