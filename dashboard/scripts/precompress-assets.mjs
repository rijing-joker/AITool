import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const COMPRESSIBLE = /\.(?:html|js|mjs|css|json|svg|txt|xml|webmanifest)$/i;

export async function precompressAssets(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await precompressAssets(file);
    } else if (entry.isFile() && COMPRESSIBLE.test(entry.name)) {
      const source = await fs.readFile(file);
      // Small files rarely repay the extra variant and filesystem lookup.
      for (const [extension, compress] of [
        ["br", () => brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })],
        ["gz", () => gzipAsync(source, { level: 9 })],
      ]) {
        const encoded = source.length >= 1024 ? await compress() : null;
        if (encoded && encoded.length < source.length * 0.95) {
          await fs.writeFile(`${file}.${extension}`, encoded);
        } else {
          await fs.rm(`${file}.${extension}`, { force: true });
        }
      }
    }
  }
}

export function precompressAssetsPlugin() {
  let directory;
  return {
    name: "aitool-precompress-assets",
    apply: "build",
    configResolved(config) {
      directory = path.resolve(config.root, config.build.outDir);
    },
    // SEO pages are generated in another closeBundle hook. Compress only
    // after those writes finish, including copied public assets.
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() { await precompressAssets(directory); },
    },
  };
}
