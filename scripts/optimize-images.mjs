/**
 * Image optimization for SAIAR manual client build.
 * Run from repo root: npm run optimize-images
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const CWD = process.cwd();

const DEFAULT_INPUT = path.resolve(CWD, "src/images");
const DEFAULT_OUTPUT = path.resolve(CWD, "public/images");
const DEFAULT_LOGO_INPUT = path.resolve(
  CWD,
  "src/assets/logo.png"
);
const DEFAULT_LOGO_OUTPUT = path.resolve(CWD, "public/assets/logo.webp");
const DEFAULT_META_SCRIPT = path.resolve(CWD, "src/image-meta.js");

const WEBP_WIDTHS = [800, 1200, 1800];
const WEBP_QUALITY = 78;
const JPEG_FALLBACK_WIDTH = 1200;
const JPEG_QUALITY = 80;
const LOGO_MAX_WIDTH = 1000;
const LOGO_QUALITY = 82;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]);

function parseArgs(argv) {
  const out = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    logoInput: DEFAULT_LOGO_INPUT,
    logoOutput: DEFAULT_LOGO_OUTPUT,
    metaScript: DEFAULT_META_SCRIPT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") out.input = path.resolve(argv[++i] ?? "");
    else if (a === "--output") out.output = path.resolve(argv[++i] ?? "");
    else if (a === "--logo-input")
      out.logoInput = path.resolve(argv[++i] ?? "");
    else if (a === "--logo-output")
      out.logoOutput = path.resolve(argv[++i] ?? "");
    else if (a === "--meta-script")
      out.metaScript = path.resolve(argv[++i] ?? "");
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/optimize-images.mjs [options]

  --input <path>       Input images directory (default: src/images/)
  --output <path>      Output directory (default: public/images)
  --logo-input <path>  Logo PNG (default: src/assets/logo.png)
  --logo-output <path> Logo WebP out (default: public/assets/logo.webp)
  --meta-script <path> Image metadata JS (default: src/image-meta.js)`);
      process.exit(0);
    }
  }
  return out;
}

function normalizeBasename(filename) {
  const base = path.basename(filename, path.extname(filename));
  return base.toLowerCase();
}

function isGeneratedVariant(filename) {
  if (filename === "index.json") return true;
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".webp") && !lower.endsWith(".jpg")) return false;
  if (
    lower.endsWith("-800.webp") ||
    lower.endsWith("-1200.webp") ||
    lower.endsWith("-1800.webp")
  )
    return true;
  if (lower.endsWith("-1200.jpg")) return true;
  return false;
}

async function cleanGeneratedOutput(outputDir) {
  let entries;
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (e) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (isGeneratedVariant(ent.name)) {
      await fs.unlink(path.join(outputDir, ent.name));
    }
  }
}

function isRasterImage(filename) {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXT.has(ext);
}

async function optimizeLogo(logoInput, logoOutput) {
  try {
    await fs.access(logoInput);
  } catch {
    console.log(`Logo skip: not found (${logoInput})`);
    return { bytes: 0, skipped: true };
  }
  const dir = path.dirname(logoOutput);
  await fs.mkdir(dir, { recursive: true });
  const result = await sharp(logoInput)
    .rotate()
    .resize({
      width: LOGO_MAX_WIDTH,
      withoutEnlargement: true,
    })
    .webp({ quality: LOGO_QUALITY })
    .toFile(logoOutput);
  const bytes = result.size;
  console.log(`Logo: ${logoOutput} (${bytes} bytes)`);
  return { bytes, skipped: false };
}

async function main() {
  const { input, output, logoInput, logoOutput, metaScript } = parseArgs(
    process.argv.slice(2)
  );

  let hadError = false;
  let totalBytes = 0;
  let imageCount = 0;

  try {
    await fs.access(input);
  } catch {
    console.error(`Input directory not found: ${input}`);
    process.exit(1);
  }

  await fs.mkdir(output, { recursive: true });
  await cleanGeneratedOutput(output);

  const dirents = await fs.readdir(input, { withFileTypes: true });
  const files = dirents
    .filter((d) => d.isFile() && isRasterImage(d.name))
    .map((d) => d.name)
    .sort();

  const entries = {};
  const generatedAt = new Date().toISOString();
  for (const originalName of files) {
    const inputPath = path.join(input, originalName);
    const base = normalizeBasename(originalName);

    try {
      const meta = await sharp(inputPath).metadata();
      const sourceW = meta.width ?? null;
      const sourceH = meta.height ?? null;

      const variants = {};
      let entryBytes = 0;

      for (const w of WEBP_WIDTHS) {
        const outName = `${base}-${w}.webp`;
        const outPath = path.join(output, outName);
        const result = await sharp(inputPath)
          .rotate()
          .resize({ width: w, withoutEnlargement: true })
          .webp({ quality: WEBP_QUALITY })
          .toFile(outPath);
        entryBytes += result.size;
        variants[`${w}.webp`] = {
          file: outName,
          width: result.width,
          height: result.height,
        };
      }

      const jpgName = `${base}-${JPEG_FALLBACK_WIDTH}.jpg`;
      const jpgPath = path.join(output, jpgName);
      const jpgResult = await sharp(inputPath)
        .rotate()
        .resize({
          width: JPEG_FALLBACK_WIDTH,
          withoutEnlargement: true,
        })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toFile(jpgPath);
      entryBytes += jpgResult.size;
      variants[`${JPEG_FALLBACK_WIDTH}.jpg`] = {
        file: jpgName,
        width: jpgResult.width,
        height: jpgResult.height,
      };

      totalBytes += entryBytes;
      imageCount++;

      const entry = {
        normalizedBasename: base,
        originalFilename: originalName,
        source: {
          filename: originalName,
          width: sourceW,
          height: sourceH,
        },
        variants,
      };

      entries[originalName] = entry;
      entries[base] = entry;

      console.log(`OK ${originalName} -> ${entryBytes} bytes (variants)`);
    } catch (err) {
      hadError = true;
      console.error(`FAIL ${originalName}:`, err?.message ?? err);
    }
  }

  const logoResult = await optimizeLogo(logoInput, logoOutput);
  if (!logoResult.skipped) totalBytes += logoResult.bytes;

  const indexPayload = {
    generatedAt,
    outputDir: path.relative(CWD, output).replaceAll("\\", "/"),
    entries,
    logo:
      logoResult.skipped === false
        ? {
            output: path.relative(path.resolve(output, ".."), logoOutput).replaceAll("\\", "/"),
          }
        : null,
  };

  const indexPath = path.join(output, "index.json");
  await fs.writeFile(indexPath, JSON.stringify(indexPayload, null, 2), "utf8");
  totalBytes += Buffer.byteLength(JSON.stringify(indexPayload, null, 2), "utf8");

  await fs.mkdir(path.dirname(metaScript), { recursive: true });
  const metaScriptPayload = `// Generated by scripts/optimize-images.mjs.\nexport default ${JSON.stringify(entries, null, 2)};\n`;
  await fs.writeFile(metaScript, metaScriptPayload, "utf8");
  totalBytes += Buffer.byteLength(metaScriptPayload, "utf8");

  console.log("");
  console.log("--- Summary ---");
  console.log(`Raster images processed: ${imageCount}`);
  if (hadError) console.log("Some inputs failed (see errors above).");
  console.log(`Total output bytes (includes index.json${logoResult.skipped ? "" : ", logo"}): ${totalBytes}`);

  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
