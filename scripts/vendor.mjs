// 把前端執行期依賴打包成本地 ESM（src/vendor/），取代 esm.sh CDN。
// 好處：不依賴第三方 CDN、版本鎖定（package-lock）、內網/離線環境也能載入。
// 執行：npm run vendor（升級依賴版本後重跑並 commit 產物）
import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";

const entries = {
  "supabase-js": `export { createClient } from "@supabase/supabase-js";`,
  "qrcode-generator": `import q from "qrcode-generator"; export default q;`,
};

await mkdir("src/vendor", { recursive: true });
for (const [name, src] of Object.entries(entries)) {
  const entry = `src/vendor/.entry-${name}.js`;
  await writeFile(entry, src);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    minify: true,
    outfile: `src/vendor/${name}.js`,
    logLevel: "info",
  });
  await rm(entry);
}
