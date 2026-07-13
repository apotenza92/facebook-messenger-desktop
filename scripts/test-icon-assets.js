#!/usr/bin/env node

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const packageJson = require(path.join(root, 'package.json'));
const isBeta = process.env.FORCE_BETA_BUILD === 'true' || /-(beta|alpha|rc)/.test(packageJson.version);
const variant = isBeta ? 'beta' : 'stable';
const legacyIcon = path.join(root, 'assets', 'icons', ...(isBeta ? ['beta', 'icon.icns'] : ['icon.icns']));
const expectedLayers = ['02-bubble.svg', '03-stroke.svg'];

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function plistValue(plistPath, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], { encoding: 'utf8' }).trim();
}

async function colouredBounds(input, core) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 4;
      const colourDistance = Math.abs(data[offset] - core[0])
        + Math.abs(data[offset + 1] - core[1])
        + Math.abs(data[offset + 2] - core[2]);
      if (data[offset + 3] <= 32 || colourDistance >= 16) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function alphaBounds(input, size = 1024) {
  const { data, info } = await sharp(input)
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] <= 32) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centreX: (minX + maxX) / 2,
    centreY: (minY + maxY) / 2,
  };
}

async function verifyRasterAssets(assetVariant) {
  const variantParts = assetVariant === 'beta' ? ['beta'] : [];
  const core = assetVariant === 'beta' ? [255, 101, 0] : [8, 102, 255];

  for (const appearanceParts of [[], ['dark']]) {
    const assetParts = [...variantParts, ...appearanceParts];
    const appearance = appearanceParts.length ? 'dark' : 'light';
    const ico = fs.readFileSync(path.join(root, 'assets', 'icons', ...assetParts, 'icon.ico'));
    assert.strictEqual(ico.readUInt16LE(0), 0, `${assetVariant} ${appearance} Windows ICO reserved header should be zero`);
    assert.strictEqual(ico.readUInt16LE(2), 1, `${assetVariant} ${appearance} Windows asset should be an ICO file`);
    assert(ico.readUInt16LE(4) >= 7, `${assetVariant} ${appearance} Windows ICO should contain multiple resolutions`);

    const windowsBounds = await colouredBounds(
      path.join(root, 'assets', 'icons', ...assetParts, 'ico-rounded', 'icon-256.png'),
      core,
    );
    assert.deepStrictEqual(
      windowsBounds,
      { width: 198, height: 198 },
      `${assetVariant} ${appearance} Windows bubble should preserve the shared circular footprint`,
    );

    const linuxBounds = await colouredBounds(
      path.join(root, 'assets', 'icons', ...assetParts, 'linux', '512x512.png'),
      core,
    );
    assert.deepStrictEqual(
      linuxBounds,
      { width: 396, height: 396 },
      `${assetVariant} ${appearance} Linux bubble should preserve the shared circular footprint`,
    );

    const legacyMacBounds = await colouredBounds(
      path.join(root, 'assets', 'icons', ...assetParts, 'icon.png'),
      core,
    );
    assert.deepStrictEqual(
      legacyMacBounds,
      { width: 396, height: 396 },
      `${assetVariant} ${appearance} legacy macOS fallback should preserve the shared circular footprint`,
    );
  }

  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    const file = path.join(root, 'assets', 'icons', ...variantParts, 'linux', `${size}x${size}.png`);
    const metadata = await sharp(file).metadata();
    assert.strictEqual(metadata.width, size, `${assetVariant} Linux ${size}px icon width`);
    assert.strictEqual(metadata.height, size, `${assetVariant} Linux ${size}px icon height`);
  }
}

async function verifyIconComposerSources(assetVariant) {
  const assetProductName = assetVariant === 'beta' ? 'Messenger Beta' : 'Messenger';
  const assetIconBundle = path.join(root, 'assets', 'icons', 'macos', `${assetProductName}.icon`);
  const assetLayerDir = path.join(root, 'assets', 'icons', 'macos-layers', assetVariant);
  const document = JSON.parse(fs.readFileSync(path.join(assetIconBundle, 'icon.json'), 'utf8'));
  const layers = document.groups.flatMap(group => group.layers);
  const names = layers.map(layer => layer['image-name']);
  assert.deepStrictEqual(names, [...expectedLayers].reverse(), 'Icon Composer layer order should be stroke above bubble');
  assert.deepStrictEqual(
    document['fill-specializations'],
    [{ value: 'system-light' }, { appearance: 'dark', value: 'system-dark' }],
    `${assetVariant} should use Icon Composer's full-bleed native light and dark backgrounds`,
  );

  for (const layer of layers) {
    const specializations = layer['fill-specializations'] || [];
    const preservesDefault = layer.fill === 'none' || specializations.some(fill => !fill.appearance && fill.value === 'none');
    const preservesDark = layer.fill === 'none' || specializations.some(fill => fill.appearance === 'dark' && fill.value === 'none');
    assert(preservesDefault, `${assetVariant} ${layer.name} should preserve its source color in the default appearance`);
    assert(preservesDark, `${assetVariant} ${layer.name} should preserve its source color in the dark appearance`);
  }

  for (const layer of expectedLayers) {
    const generated = path.join(assetLayerDir, layer);
    const embedded = path.join(assetIconBundle, 'Assets', layer);
    assert.strictEqual(hash(embedded), hash(generated), `${layer} in the Icon Composer document should match generated geometry`);
  }

  assert(!fs.existsSync(path.join(assetIconBundle, 'Assets', '01-background.svg')), `${assetVariant} should not import a background SVG`);

  const bubbleBounds = await alphaBounds(path.join(assetIconBundle, 'Assets', '02-bubble.svg'));
  assert.strictEqual(bubbleBounds.width, 792, `${assetVariant} macOS bubble should use the shared 396/512 width`);
  assert.strictEqual(bubbleBounds.height, 792, `${assetVariant} macOS bubble should preserve the shared circular footprint`);

  const strokeBounds = await alphaBounds(path.join(assetIconBundle, 'Assets', '03-stroke.svg'));
  assert.deepStrictEqual(
    { width: strokeBounds.width, height: strokeBounds.height },
    { width: 534, height: 290 },
    `${assetVariant} macOS stroke should preserve the approved broad-centre proportions`,
  );
  assert.strictEqual(
    strokeBounds.centreX - bubbleBounds.centreX,
    0,
    `${assetVariant} macOS stroke should remain horizontally centred`,
  );
  assert.strictEqual(
    strokeBounds.centreY,
    511.5,
    `${assetVariant} macOS stroke should remain vertically centred on the circular body`,
  );
}

function verifyPackagedApp(appPath) {
  if (!appPath) return;
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const resources = path.join(appPath, 'Contents', 'Resources');
  const assetsCar = path.join(resources, 'Assets.car');
  const helperIcon = path.join(resources, 'NotificationHelper.app', 'Contents', 'Resources', 'icon.icns');

  assert(fs.existsSync(assetsCar), 'Packaged macOS app should contain Assets.car');
  assert.strictEqual(plistValue(infoPlist, 'CFBundleIconName'), 'Icon', 'Bundle should reference the compiled icon stack');
  assert.strictEqual(hash(helperIcon), hash(legacyIcon), 'Notification helper should retain the matching legacy ICNS');

  const developerDir = process.env.DEVELOPER_DIR || '/Applications/Xcode-beta.app/Contents/Developer';
  const assetInfo = JSON.parse(execFileSync('xcrun', ['assetutil', '--info', assetsCar], {
    encoding: 'utf8',
    env: { ...process.env, DEVELOPER_DIR: developerDir },
  }));
  const assetTypes = new Set(assetInfo.map(asset => asset.AssetType));
  const appearances = new Set(assetInfo.map(asset => asset.Appearance).filter(Boolean));
  const vectorNames = new Set(assetInfo.filter(asset => asset.AssetType === 'Vector').map(asset => asset.Name));

  assert(assetTypes.has('IconImageStack'), 'Assets.car should contain a layered icon stack');
  assert(assetTypes.has('MultiSized Image'), 'Assets.car should contain a legacy fallback');
  assert(appearances.has('NSAppearanceNameAqua'), 'Assets.car should contain the default appearance');
  assert(appearances.has('NSAppearanceNameDarkAqua'), 'Assets.car should contain the dark appearance');
  assert(appearances.has('ISAppearanceTintable'), 'Assets.car should contain the tintable appearance');
  for (const layer of expectedLayers.map(name => `Icon_Assets/${path.basename(name, '.svg')}`)) {
    assert(vectorNames.has(layer), `Assets.car should contain ${layer}`);
  }
}

async function main() {
  const mainSource = fs.readFileSync(path.join(root, 'src', 'main', 'main.ts'), 'utf8');
  assert(!mainSource.includes('app.dock.setIcon(null'), 'macOS native mode must not override the bundle icon at runtime');

  for (const assetVariant of ['stable', 'beta']) {
    await verifyIconComposerSources(assetVariant);
    await verifyRasterAssets(assetVariant);
  }
  verifyPackagedApp(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`Stable and beta icon assets verified${process.argv[2] ? `; packaged ${variant} macOS app verified` : ''}.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
