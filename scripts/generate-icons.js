#!/usr/bin/env node

/**
 * Script to generate app icons from SVG
 * Sharp will be auto-installed if missing
 * 
 * Run: node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Check if icons already exist (skip generation if they do)
const iconsDir = path.join(__dirname, '../assets/icons');
const requiredIcons = ['icon.ico', 'icon.png'];
const iconsExist = requiredIcons.every(icon => 
  fs.existsSync(path.join(iconsDir, icon))
);

// Allow force regeneration with --force flag
const forceRegenerate = process.argv.includes('--force');

if (iconsExist && !forceRegenerate) {
  console.log('Icons already exist. Use --force to regenerate.');
  process.exit(0);
}

// Try to load sharp, auto-install if missing
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.log('Sharp not found, attempting to install...');
  try {
    execSync('npm install sharp@0.33.5 --save-dev', { 
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    // Clear require cache and try again
    delete require.cache[require.resolve('sharp')];
    sharp = require('sharp');
    console.log('Sharp installed successfully!');
  } catch (installError) {
    console.error('Failed to auto-install sharp.');
    console.error('Please install manually: npm install sharp --save-dev');
    console.error('');
    console.error('On Windows, you may need to install build tools first:');
    console.error('  npm install -g windows-build-tools');
    console.error('Or install Visual Studio Build Tools with C++ workload.');
    process.exit(1);
  }
}

// Try to load png-to-ico, auto-install if missing
let pngToIco;
try {
  pngToIco = require('png-to-ico');
} catch (e) {
  console.log('png-to-ico not found, attempting to install...');
  try {
    execSync('npm install png-to-ico@2.1.8 --save-dev', { 
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    pngToIco = require('png-to-ico');
    console.log('png-to-ico installed successfully!');
  } catch (installError) {
    console.error('Failed to auto-install png-to-ico.');
    console.error('Please install manually: npm install png-to-ico --save-dev');
    process.exit(1);
  }
}

const svgPath = path.join(__dirname, '../assets/icons/messenger-icon.svg');
const trayDir = path.join(__dirname, '../assets/tray');
const dmgDir = path.join(__dirname, '../assets/dmg');

const DMG_WINDOW_WIDTH = 680;
const DMG_WINDOW_HEIGHT = 420;

// Ensure directories exist
[iconsDir, trayDir, dmgDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Helper function to generate icon with white background (Windows/Linux)
async function generateIconWithWhiteBackground(svgBuffer, size, outputPath) {
  // Scale icon to 80% of size to add padding (10% margin on each side)
  const iconSize = Math.floor(size * 0.8);
  const padding = Math.floor((size - iconSize) / 2);
  
  // Resize SVG to fit with padding
  const svgResized = await sharp(svgBuffer)
    .resize(iconSize, iconSize)
    .png()
    .toBuffer();
  
  // Create a white background and composite SVG on top with padding
  // Use removeAlpha to ensure no transparency is preserved
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3, // RGB only, no alpha
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .composite([{ 
      input: svgResized, 
      blend: 'over',
      left: padding,
      top: padding
    }])
    .removeAlpha() // Remove any alpha channel
    .png()
    .toFile(outputPath);
}

// Helper function to generate macOS icon with rounded white background
// macOS expects icons with rounded corners (squircle shape) for proper shadow rendering
async function generateIconWithRoundedWhiteBackground(svgBuffer, size, outputPath, iconScale = 0.8) {
  // Scale icon to specified percentage of size (default 80% = 10% margin on each side)
  const iconSize = Math.floor(size * iconScale);
  const padding = Math.floor((size - iconSize) / 2);
  
  // macOS icon corner radius is approximately 22.37% of icon size (Big Sur style)
  const cornerRadius = Math.floor(size * 0.2237);
  
  // Create rounded rectangle mask SVG
  const roundedRectSvg = `
    <svg width="${size}" height="${size}">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/>
    </svg>
  `;
  
  // Resize SVG to fit with padding
  const svgResized = await sharp(svgBuffer)
    .resize(iconSize, iconSize)
    .png()
    .toBuffer();
  
  // Create the rounded white background
  const roundedWhiteBg = await sharp(Buffer.from(roundedRectSvg))
    .png()
    .toBuffer();
  
  // Composite: rounded white background + messenger icon on top
  return sharp(roundedWhiteBg)
    .composite([{ 
      input: svgResized, 
      blend: 'over',
      left: padding,
      top: padding
    }])
    .png()
    .toFile(outputPath);
}

// Helper function to generate Linux icon with smaller rounded background and transparent canvas
// Linux dash icons need smaller backgrounds to match system icons (which often have padding)
// The white rounded rectangle is shrunk relative to the canvas, with transparent space around it
async function generateLinuxIcon(svgBuffer, size, outputPath, backgroundScale = 0.72, iconScale = 0.68) {
  // backgroundScale controls how much of the canvas the white rounded rect covers
  // iconScale controls how much of the canvas the messenger logo covers
  // Both are scaled relative to the full canvas size
  
  const bgSize = Math.floor(size * backgroundScale);
  const bgPadding = Math.floor((size - bgSize) / 2);
  
  const logoSize = Math.floor(size * iconScale);
  const logoPadding = Math.floor((size - logoSize) / 2);
  
  // Corner radius relative to the background size (Big Sur style)
  const cornerRadius = Math.floor(bgSize * 0.2237);
  
  // Create rounded rectangle background SVG (centered in canvas)
  const roundedRectSvg = `
    <svg width="${size}" height="${size}">
      <rect x="${bgPadding}" y="${bgPadding}" width="${bgSize}" height="${bgSize}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/>
    </svg>
  `;
  
  // Resize messenger logo
  const svgResized = await sharp(svgBuffer)
    .resize(logoSize, logoSize)
    .png()
    .toBuffer();
  
  // Create transparent canvas with rounded white background
  const roundedWhiteBg = await sharp(Buffer.from(roundedRectSvg))
    .png()
    .toBuffer();
  
  // Composite: transparent canvas with white rounded bg + messenger logo centered
  return sharp(roundedWhiteBg)
    .composite([{ 
      input: svgResized, 
      blend: 'over',
      left: logoPadding,
      top: logoPadding
    }])
    .png()
    .toFile(outputPath);
}

// Helper for transparent-background icons (used for DMG volume icon)
async function generateIconWithTransparentBackground(svgBuffer, size, outputPath) {
  return sharp(svgBuffer)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outputPath);
}

function buildDmgBackgroundSvg(width, height, scale = 1) {
  // Super simple: white background with just an arrow between icons
  const s = (v) => v * scale;
  
  const centerY = s(220);
  // Arrow centered between icons at x=180 and x=500
  const arrowStartX = s(260);
  const arrowEndX = s(420);
  const arrowSize = s(18);
  const strokeWidth = s(3);

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
  <defs>
    <marker id="arrowhead" markerWidth="${arrowSize}" markerHeight="${arrowSize}" refX="${arrowSize * 0.9}" refY="${arrowSize / 2}" orient="auto">
      <path d="M0,${arrowSize * 0.1} L${arrowSize * 0.9},${arrowSize / 2} L0,${arrowSize * 0.9} z" fill="#c7c7cc"/>
    </marker>
  </defs>
  <path d="M ${arrowStartX} ${centerY} L ${arrowEndX} ${centerY}" stroke="#c7c7cc" stroke-width="${strokeWidth}" marker-end="url(#arrowhead)" stroke-linecap="round"/>
</svg>
`;
}

async function generateDmgBackground() {
  // Generate at 2x resolution for Retina displays
  const scale = 2;
  const svg = buildDmgBackgroundSvg(DMG_WINDOW_WIDTH * scale, DMG_WINDOW_HEIGHT * scale, scale);
  await sharp(Buffer.from(svg))
    .png()
    .toFile(path.join(dmgDir, 'dmg-background.png'));
}

async function generateIcons() {
  const svgBuffer = fs.readFileSync(svgPath);
  
  console.log('Generating icons from SVG with white background...');
  
  try {
    // Generate macOS icon (ICNS requires multiple sizes, but we'll create PNG first)
    // For ICNS, you'll need to use iconutil or an online converter
    console.log('Generating PNG icons...');

    // Sizes for general use and ICO frames
    const generalPngSizes = [512, 256, 128, 64, 48, 32, 24, 16];
    const icoFrameSizes = [256, 128, 64, 48, 32, 24, 16];

    // Generate base PNGs (square, kept for reference)
    for (const size of generalPngSizes) {
      await generateIconWithWhiteBackground(svgBuffer, size, path.join(iconsDir, `icon-${size}.png`));
    }

    // Generate rounded 512px icon for Linux (fallback)
    console.log('Generating rounded Linux icon...');
    await generateIconWithRoundedWhiteBackground(svgBuffer, 512, path.join(iconsDir, 'icon.png'));
    
    // Generate Linux icons directory with proper NxN.png naming for hicolor theme
    // Linux desktop environments (GNOME, KDE) need slight padding around the icon
    // for visual consistency with system icons, but not too much or it looks tiny
    // backgroundScale: white rounded rect is 85% of canvas (slight padding)
    // iconScale: messenger logo is 68% of canvas (sits inside the background)
    console.log('Generating Linux icons directory...');
    const linuxIconsDir = path.join(iconsDir, 'linux');
    if (!fs.existsSync(linuxIconsDir)) {
      fs.mkdirSync(linuxIconsDir, { recursive: true });
    }
    const linuxIconSizes = [512, 256, 128, 96, 72, 64, 48, 32, 24, 22, 16];
    const linuxBgScale = 0.85;   // White background is 85% of canvas (15% transparent padding)
    const linuxLogoScale = 0.68; // Messenger logo is 68% of canvas (inside background)
    for (const size of linuxIconSizes) {
      await generateLinuxIcon(svgBuffer, size, path.join(linuxIconsDir, `${size}x${size}.png`), linuxBgScale, linuxLogoScale);
    }

    // Generate rounded PNGs for Windows ICO
    console.log('Generating rounded PNGs for Windows ICO...');
    const icoRoundedDir = path.join(iconsDir, 'ico-rounded');
    if (!fs.existsSync(icoRoundedDir)) {
      fs.mkdirSync(icoRoundedDir, { recursive: true });
    }
    for (const size of icoFrameSizes) {
      await generateIconWithRoundedWhiteBackground(svgBuffer, size, path.join(icoRoundedDir, `icon-${size}.png`));
    }

    // Generate Windows ICO (multi-size, real .ico) from rounded PNGs
    console.log('Generating Windows ICO...');
    const icoPngPaths = icoFrameSizes.map(size => path.join(icoRoundedDir, `icon-${size}.png`));
    const icoBuffer = await pngToIco(icoPngPaths);
    await fs.promises.writeFile(path.join(iconsDir, 'icon.ico'), icoBuffer);
    
    // Tray icons (smaller sizes)
    console.log('Generating tray icons...');
    // Linux tray icon (square)
    await generateIconWithWhiteBackground(svgBuffer, 22, path.join(trayDir, 'icon.png'));
    // Linux tray icon (rounded - preferred)
    await generateIconWithRoundedWhiteBackground(svgBuffer, 22, path.join(trayDir, 'icon-rounded.png'), 0.85);
    // macOS tray icon (template)
    await generateIconWithWhiteBackground(svgBuffer, 22, path.join(trayDir, 'iconTemplate.png'));
    
    // Windows tray icon - generate proper ICO file with multiple sizes (rounded)
    console.log('Generating Windows tray ICO (rounded)...');
    const trayIcoSizes = [32, 24, 16];
    const trayIcoPngs = [];
    for (const size of trayIcoSizes) {
      const pngPath = path.join(trayDir, `icon-${size}.png`);
      await generateIconWithRoundedWhiteBackground(svgBuffer, size, pngPath);
      trayIcoPngs.push(pngPath);
    }
    const trayIcoBuffer = await pngToIco(trayIcoPngs);
    await fs.promises.writeFile(path.join(trayDir, 'icon.ico'), trayIcoBuffer);
    // Clean up temporary PNGs
    for (const pngPath of trayIcoPngs) {
      fs.unlinkSync(pngPath);
    }
    
    // Generate macOS iconset for ICNS
    console.log('Generating macOS iconset...');
    const iconsetDir = path.join(iconsDir, 'icon.iconset');
    if (!fs.existsSync(iconsetDir)) {
      fs.mkdirSync(iconsetDir, { recursive: true });
    }
    
    // macOS iconset requires specific sizes with @2x variants
    const iconsetSizes = [
      { name: 'icon_16x16.png', size: 16 },
      { name: 'icon_16x16@2x.png', size: 32 },
      { name: 'icon_32x32.png', size: 32 },
      { name: 'icon_32x32@2x.png', size: 64 },
      { name: 'icon_128x128.png', size: 128 },
      { name: 'icon_128x128@2x.png', size: 256 },
      { name: 'icon_256x256.png', size: 256 },
      { name: 'icon_256x256@2x.png', size: 512 },
      { name: 'icon_512x512.png', size: 512 },
      { name: 'icon_512x512@2x.png', size: 1024 },
    ];
    
    for (const { name, size } of iconsetSizes) {
      // macOS icons need rounded corners so the system can apply proper shadows
      await generateIconWithRoundedWhiteBackground(svgBuffer, size, path.join(iconsetDir, name));
    }
    
    // Generate ICNS file using iconutil (macOS only)
    if (process.platform === 'darwin') {
      console.log('Generating ICNS file...');
      try {
        execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(iconsDir, 'icon.icns')}"`, {
          stdio: 'inherit'
        });
        console.log('✓ ICNS file generated successfully!');
      } catch (error) {
        console.warn('⚠ Could not generate ICNS file. You may need to run manually:');
        console.warn(`  iconutil -c icns "${iconsetDir}" -o "${path.join(iconsDir, 'icon.icns')}"`);
      }
    } else {
      console.log('⚠ ICNS generation skipped (requires macOS). Use an online converter if needed.');
    }

    console.log('Generating DMG volume icon (transparent)...');
    const dmgIconsetDir = path.join(iconsDir, 'dmg-icon.iconset');
    if (!fs.existsSync(dmgIconsetDir)) {
      fs.mkdirSync(dmgIconsetDir, { recursive: true });
    }

    for (const { name, size } of iconsetSizes) {
      await generateIconWithTransparentBackground(svgBuffer, size, path.join(dmgIconsetDir, name));
    }

    if (process.platform === 'darwin') {
      console.log('Generating DMG ICNS file...');
      try {
        execSync(`iconutil -c icns "${dmgIconsetDir}" -o "${path.join(iconsDir, 'dmg-icon.icns')}"`, {
          stdio: 'inherit'
        });
        console.log('✓ DMG ICNS file generated successfully!');
      } catch (error) {
        console.warn('⚠ Could not generate DMG ICNS file. You may need to run manually:');
        console.warn(`  iconutil -c icns "${dmgIconsetDir}" -o "${path.join(iconsDir, 'dmg-icon.icns')}"`);
      }
    } else {
      console.log('⚠ DMG ICNS generation skipped (requires macOS). Use an online converter if needed.');
    }

    console.log('Generating DMG background...');
    await generateDmgBackground();

    console.log('✓ Icons generated successfully!');
    
  } catch (error) {
    console.error('Error generating icons:', error);
    process.exit(1);
  }
}

generateIcons();
