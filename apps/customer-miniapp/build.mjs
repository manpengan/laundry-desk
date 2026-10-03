import { mkdir, cp, writeFile, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { MiniappConfigSchema } from "./dist/config.js";

const publicInput = {
  apiOrigin: process.env.LAUNDRY_MINIAPP_API_ORIGIN ?? "",
};
const configured = Object.values(publicInput).some((value) => value.length > 0);
const publicConfig = configured ? MiniappConfigSchema.parse(publicInput) : null;
const appId = process.env.LAUNDRY_MINIAPP_APP_ID ?? "touristappid";
if (appId !== "touristappid" && !/^wx[A-Za-z0-9]{16}$/u.test(appId))
  throw new Error("Mini program AppID must match the registered application");
await mkdir("dist/miniprogram/pages/home", { recursive: true });
await build({
  entryPoints: ["src/page.ts"],
  outfile: "dist/miniprogram/pages/home/index.js",
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  minify: true,
  define: { MINIAPP_PUBLIC_CONFIG: JSON.stringify(publicConfig) },
});
await cp("ui", "dist/miniprogram", { recursive: true });
await writeFile("dist/miniprogram/app.js", "App({});\n");
const project = JSON.parse(await readFile("project.config.json", "utf8"));
await writeFile(
  "dist/project.config.json",
  JSON.stringify(
    {
      ...project,
      appid: appId,
      miniprogramRoot: "miniprogram/",
    },
    null,
    2,
  ) + "\n",
);
