import { readFileSync, writeFileSync, existsSync } from "node:fs";
const htmlPath = "out/renderer/index.html";
if (!existsSync(htmlPath)) { console.error(`未找到 ${htmlPath}`); process.exit(1); }
let html = readFileSync(htmlPath, "utf8");
html = html.replace(/\s*<script[^>]*src="\.\/src\/main\.tsx"[^>]*><\/script>/g, "");
html = html.replace(/\s+http:\/\/localhost:\*\s+ws:\/\/localhost:\*/g, "");
writeFileSync(htmlPath, html);
console.log("[fix-web-html] done");
