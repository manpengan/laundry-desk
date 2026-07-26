import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ELECTRON_IMPORT = 'import { contextBridge, ipcRenderer } from "electron";';
const CHANNELS_IMPORT = 'import { DESKTOP_IPC_CHANNELS } from "./lib/security-prefs.js";';
const ELECTRON_REQUIRE = 'const { contextBridge, ipcRenderer } = require("electron");';

function replaceExactlyOnce(source, expected, replacement) {
  const parts = source.split(expected);
  if (parts.length !== 2) {
    throw new Error("compiled preload imports do not match the sandbox bundle boundary");
  }
  return `${parts[0]}${replacement}${parts[1]}`;
}

function frozenLiteral(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("desktop IPC channels must contain only nested string records");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error("desktop IPC channel records must not be empty");
  }
  const fields = entries.map(([key, child]) => `${JSON.stringify(key)}:${frozenLiteral(child)}`);
  return `Object.freeze({${fields.join(",")}})`;
}

function isObjectFreezeCall(expression) {
  return (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Object" &&
    expression.expression.name.text === "freeze"
  );
}

function readPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  throw new Error("desktop IPC channel keys must be static identifiers or strings");
}

function readFrozenRecord(expression) {
  if (!isObjectFreezeCall(expression)) {
    throw new Error("desktop IPC channel records must use Object.freeze");
  }
  const [recordExpression] = expression.arguments;
  if (!ts.isObjectLiteralExpression(recordExpression)) {
    throw new Error("desktop IPC channel records must freeze object literals");
  }

  const record = {};
  for (const property of recordExpression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("desktop IPC channel records must use property assignments");
    }
    const key = readPropertyName(property.name);
    if (Object.hasOwn(record, key)) {
      throw new Error("desktop IPC channel records must not contain duplicate keys");
    }
    record[key] = ts.isStringLiteral(property.initializer)
      ? property.initializer.text
      : readFrozenRecord(property.initializer);
  }
  return Object.freeze(record);
}

async function loadDesktopChannels(compiledSecurityPrefsPath) {
  const source = await readFile(compiledSecurityPrefsPath, "utf8");
  const sourceFile = ts.createSourceFile(
    compiledSecurityPrefsPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const matches = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "DESKTOP_IPC_CHANNELS" &&
        declaration.initializer !== undefined
      ) {
        matches.push(declaration.initializer);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error("compiled security preferences must declare DESKTOP_IPC_CHANNELS exactly once");
  }
  return readFrozenRecord(matches[0]);
}

export async function buildPreloadBundle(options) {
  const { compiledPreloadPath, compiledSecurityPrefsPath, outputPath } = options;
  const [compiledPreload, desktopChannels] = await Promise.all([
    readFile(compiledPreloadPath, "utf8"),
    loadDesktopChannels(compiledSecurityPrefsPath),
  ]);

  let bundle = replaceExactlyOnce(compiledPreload, ELECTRON_IMPORT, ELECTRON_REQUIRE);
  bundle = replaceExactlyOnce(
    bundle,
    CHANNELS_IMPORT,
    `const DESKTOP_IPC_CHANNELS = ${frozenLiteral(desktopChannels)};`,
  );
  bundle = `"use strict";\n${bundle.replace(/^\s*\/\/# sourceMappingURL=.*$/gmu, "")}`;
  if (/^\s*(?:import|export)\s/mu.test(bundle)) {
    throw new Error("sandbox preload bundle contains an ESM declaration");
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bundle, { mode: 0o644 });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function runCli() {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  await buildPreloadBundle({
    compiledPreloadPath: join(packageRoot, "dist", "preload.js"),
    compiledSecurityPrefsPath: join(packageRoot, "dist", "lib", "security-prefs.js"),
    outputPath: join(packageRoot, "dist", "preload.cjs"),
  });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown preload build error";
    console.error(`[preload:bundle] ${message}`);
    process.exitCode = 1;
  });
}
