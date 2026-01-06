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

// Background colors for light and dark mode icons
const LIGHT_BG_COLOR = 'white';
const DARK_BG_COLOR = '#2d2d2d'; // Very dark grey - matches dark mode UIs

// Ensure directories exist
[iconsDir, trayDir, dmgDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Helper function to generate icon with solid background (Windows/Linux)
async function generateIconWithBackground(svgBuffer, size, outputPath, bgColor = 'white') {
  // Scale icon to 80% of size to add padding (10% margin on each side)
  const iconSize = Math.floor(size * 0.8);
  const padding = Math.floor((size - iconSize) / 2);
  
  // Resize SVG to fit with padding
  const svgResized = await sharp(svgBuffer)
    .resize(iconSize, iconSize)
    .png()
    .toBuffer();
  
  // Parse the background color
  const bg = parseColor(bgColor);
  
  // Create a background and composite SVG on top with padding
  // Use removeAlpha to ensure no transparency is preserved
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3, // RGB only, no alpha
      background: bg
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

// Helper to parse color string to RGB object
function parseColor(color) {
  if (color === 'white') return { r: 255, g: 255, b: 255 };
  if (color === 'black') return { r: 0, g: 0, b: 0 };
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }
  return { r: 255, g: 255, b: 255 }; // Default to white
}

// Helper function to generate macOS icon with rounded background
// macOS expects icons with rounded corners (squircle shape) for proper shadow rendering
async function generateIconWithRoundedBackground(svgBuffer, size, outputPath, iconScale = 0.8, bgColor = 'white') {
  // Scale icon to specified percentage of size (default 80% = 10% margin on each side)
  const iconSize = Math.floor(size * iconScale);
  const padding = Math.floor((size - iconSize) / 2);
  
  // macOS icon corner radius is approximately 22.37% of icon size (Big Sur style)
  const cornerRadius = Math.floor(size * 0.2237);
  
  // Create rounded rectangle mask SVG with specified background color
  const roundedRectSvg = `
    <svg width="${size}" height="${size}">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${cornerRadius}" ry="${cornerRadius}" fill="${bgColor}"/>
    </svg>
  `;
  
  // Resize SVG to fit with padding
  const svgResized = await sharp(svgBuffer)
    .resize(iconSize, iconSize)
    .png()
    .toBuffer();
  
  // Create the rounded background
  const roundedBg = await sharp(Buffer.from(roundedRectSvg))
    .png()
    .toBuffer();
  
  // Composite: rounded background + messenger icon on top
  return sharp(roundedBg)
    .composite([{ 
      input: svgResized, 
      blend: 'over',
      left: padding,
      top: padding
    }])
    .png()
    .toFile(outputPath);
}

// Helper function to generate macOS iconset icon with proper margins
// Apple's macOS icons have ~8% transparent margin around the rounded rect background
// This allows macOS to properly render shadows and match system icon sizing
// Based on analysis of Apple's Messages.app icon: ~82% content, ~8.6% margin
async function generateMacOSIcon(svgBuffer, size, outputPath, bgScale = 0.83, iconScale = 0.68, bgColor = 'white') {
  // bgScale: how much of the canvas the rounded rect covers (83% = ~8.5% margin on each side)
  // iconScale: how much of the canvas the messenger logo covers (68% sits nicely inside)
  
  const bgSize = Math.floor(size * bgScale);
  const bgPadding = Math.floor((size - bgSize) / 2);
  
  const logoSize = Math.floor(size * iconScale);
  const logoPadding = Math.floor((size - logoSize) / 2);
  
  // Corner radius relative to the background size (Big Sur squircle ~22.37%)
  const cornerRadius = Math.floor(bgSize * 0.2237);
  
  // Create transparent canvas with inset rounded rectangle
  const roundedRectSvg = `
    <svg width="${size}" height="${size}">
      <rect x="${bgPadding}" y="${bgPadding}" width="${bgSize}" height="${bgSize}" 
            rx="${cornerRadius}" ry="${cornerRadius}" fill="${bgColor}"/>
    </svg>
  `;
  
  // Resize messenger logo
  const svgResized = await sharp(svgBuffer)
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  
  // Create the background with transparent margins
  const background = await sharp(Buffer.from(roundedRectSvg))
    .png()
    .toBuffer();
  
  // Composite: background + messenger logo centered
  return sharp(background)
    .composite([{
      input: svgResized,
      blend: 'over',
      left: logoPadding,
      top: logoPadding
    }])
    .png()
    .toFile(outputPath);
}

// Backward-compatible wrapper for white background
async function generateIconWithRoundedWhiteBackground(svgBuffer, size, outputPath, iconScale = 0.8) {
  return generateIconWithRoundedBackground(svgBuffer, size, outputPath, iconScale, LIGHT_BG_COLOR);
}

// Helper function to generate Linux icon with smaller rounded background and transparent canvas
// Linux dash icons need smaller backgrounds to match system icons (which often have padding)
// The rounded rectangle is shrunk relative to the canvas, with transparent space around it
async function generateLinuxIcon(svgBuffer, size, outputPath, backgroundScale = 0.72, iconScale = 0.68, bgColor = 'white') {
  // backgroundScale controls how much of the canvas the rounded rect covers
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
      <rect x="${bgPadding}" y="${bgPadding}" width="${bgSize}" height="${bgSize}" rx="${cornerRadius}" ry="${cornerRadius}" fill="${bgColor}"/>
    </svg>
  `;
  
  // Resize messenger logo
  const svgResized = await sharp(svgBuffer)
    .resize(logoSize, logoSize)
    .png()
    .toBuffer();
  
  // Create transparent canvas with rounded background
  const roundedBg = await sharp(Buffer.from(roundedRectSvg))
    .png()
    .toBuffer();
  
  // Composite: transparent canvas with rounded bg + messenger logo centered
  return sharp(roundedBg)
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
  
  console.log('Generating icons from SVG...');
  
  try {
    // Generate macOS icon (ICNS requires multiple sizes, but we'll create PNG first)
    // For ICNS, you'll need to use iconutil or an online converter
    console.log('Generating PNG icons...');

    // Sizes for general use and ICO frames
    const generalPngSizes = [512, 256, 128, 64, 48, 32, 24, 16];
    const icoFrameSizes = [256, 128, 64, 48, 32, 24, 16];
    
    // macOS icon scaling parameters (used for iconsets and dock icon switching)
    // Based on Apple's Messages.app: ~83% background, ~68% logo content, ~8.5% margin
    const macOSBgScale = 0.83;    // Rounded rect is 83% of canvas (8.5% transparent margin)
    const macOSLogoScale = 0.68;  // Messenger logo is 68% of canvas (sits inside background)

    // Generate base PNGs (square, kept for reference)
    for (const size of generalPngSizes) {
      await generateIconWithBackground(svgBuffer, size, path.join(iconsDir, `icon-${size}.png`), LIGHT_BG_COLOR);
    }

    // Generate rounded 512px icon - used for:
    // - macOS dock icon switching (needs proper margins like ICNS)
    // - Linux fallback icon
    // Uses macOS-style margins for consistent sizing across platforms
    console.log('Generating rounded icon...');
    await generateMacOSIcon(svgBuffer, 512, path.join(iconsDir, 'icon.png'), macOSBgScale, macOSLogoScale, LIGHT_BG_COLOR);
    
    // Generate icon-rounded.png for README and docs page (same as icon.png)
    console.log('Generating icon-rounded.png for docs...');
    await generateMacOSIcon(svgBuffer, 512, path.join(iconsDir, 'icon-rounded.png'), macOSBgScale, macOSLogoScale, LIGHT_BG_COLOR);
    
    // Generate Linux icons directory with proper NxN.png naming for hicolor theme
    // Linux desktop environments (GNOME, KDE) need slight padding around the icon
    // for visual consistency with system icons, but not too much or it looks tiny
    // backgroundScale: rounded rect is 85% of canvas (slight padding)
    // iconScale: messenger logo is 68% of canvas (sits inside the background)
    console.log('Generating Linux icons directory...');
    const linuxIconsDir = path.join(iconsDir, 'linux');
    if (!fs.existsSync(linuxIconsDir)) {
      fs.mkdirSync(linuxIconsDir, { recursive: true });
    }
    const linuxIconSizes = [512, 256, 128, 96, 72, 64, 48, 32, 24, 22, 16];
    const linuxBgScale = 0.85;   // Background is 85% of canvas (15% transparent padding)
    const linuxLogoScale = 0.68; // Messenger logo is 68% of canvas (inside background)
    for (const size of linuxIconSizes) {
      await generateLinuxIcon(svgBuffer, size, path.join(linuxIconsDir, `${size}x${size}.png`), linuxBgScale, linuxLogoScale, LIGHT_BG_COLOR);
    }

    // Generate rounded PNGs for Windows ICO
    console.log('Generating rounded PNGs for Windows ICO...');
    const icoRoundedDir = path.join(iconsDir, 'ico-rounded');
    if (!fs.existsSync(icoRoundedDir)) {
      fs.mkdirSync(icoRoundedDir, { recursive: true });
    }
    for (const size of icoFrameSizes) {
      await generateIconWithRoundedBackground(svgBuffer, size, path.join(icoRoundedDir, `icon-${size}.png`), 0.8, LIGHT_BG_COLOR);
    }

    // Generate Windows ICO (multi-size, real .ico) from rounded PNGs
    console.log('Generating Windows ICO...');
    const icoPngPaths = icoFrameSizes.map(size => path.join(icoRoundedDir, `icon-${size}.png`));
    const icoBuffer = await pngToIco(icoPngPaths);
    await fs.promises.writeFile(path.join(iconsDir, 'icon.ico'), icoBuffer);
    
    // Tray icons (smaller sizes)
    console.log('Generating tray icons...');
    // Linux tray icon (square)
    await generateIconWithBackground(svgBuffer, 22, path.join(trayDir, 'icon.png'), LIGHT_BG_COLOR);
    // Linux tray icon (rounded - preferred)
    await generateIconWithRoundedBackground(svgBuffer, 22, path.join(trayDir, 'icon-rounded.png'), 0.85, LIGHT_BG_COLOR);
    // macOS tray icon (template)
    await generateIconWithBackground(svgBuffer, 22, path.join(trayDir, 'iconTemplate.png'), LIGHT_BG_COLOR);
    
    // Windows tray icon - generate proper ICO file with multiple sizes (rounded)
    console.log('Generating Windows tray ICO (rounded)...');
    const trayIcoSizes = [32, 24, 16];
    const trayIcoPngs = [];
    for (const size of trayIcoSizes) {
      const pngPath = path.join(trayDir, `icon-${size}.png`);
      await generateIconWithRoundedBackground(svgBuffer, size, pngPath, 0.8, LIGHT_BG_COLOR);
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
    
    // macOS Big Sur+ (including Sequoia) expects icons with transparent margins around
    // the rounded rect background. This allows macOS to properly render shadows and
    // ensures the icon matches the visual size of other system icons.
    // Uses macOSBgScale and macOSLogoScale defined earlier in this function
    for (const { name, size } of iconsetSizes) {
      // macOS icons need transparent margins for proper shadow rendering
      await generateMacOSIcon(svgBuffer, size, path.join(iconsetDir, name), macOSBgScale, macOSLogoScale, LIGHT_BG_COLOR);
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

    // ===== DARK MODE ICONS =====
    console.log('\n=== Generating Dark Mode Icons ===');
    
    // Dark mode directory structure
    const darkIconsDir = path.join(iconsDir, 'dark');
    const darkLinuxIconsDir = path.join(darkIconsDir, 'linux');
    const darkIcoRoundedDir = path.join(darkIconsDir, 'ico-rounded');
    const darkIconsetDir = path.join(darkIconsDir, 'icon.iconset');
    const darkTrayDir = path.join(__dirname, '../assets/tray/dark');
    
    [darkIconsDir, darkLinuxIconsDir, darkIcoRoundedDir, darkIconsetDir, darkTrayDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    // Generate dark mode base PNGs
    console.log('Generating dark mode PNG icons...');
    for (const size of generalPngSizes) {
      await generateIconWithBackground(svgBuffer, size, path.join(darkIconsDir, `icon-${size}.png`), DARK_BG_COLOR);
    }
    
    // Generate dark rounded 512px icon (same style as light)
    console.log('Generating dark rounded icon...');
    await generateMacOSIcon(svgBuffer, 512, path.join(darkIconsDir, 'icon.png'), macOSBgScale, macOSLogoScale, DARK_BG_COLOR);
    await generateMacOSIcon(svgBuffer, 512, path.join(darkIconsDir, 'icon-rounded.png'), macOSBgScale, macOSLogoScale, DARK_BG_COLOR);
    
    // Generate dark Linux icons
    console.log('Generating dark Linux icons...');
    for (const size of linuxIconSizes) {
      await generateLinuxIcon(svgBuffer, size, path.join(darkLinuxIconsDir, `${size}x${size}.png`), linuxBgScale, linuxLogoScale, DARK_BG_COLOR);
    }
    
    // Generate dark rounded PNGs for Windows ICO
    console.log('Generating dark rounded PNGs for Windows ICO...');
    for (const size of icoFrameSizes) {
      await generateIconWithRoundedBackground(svgBuffer, size, path.join(darkIcoRoundedDir, `icon-${size}.png`), 0.8, DARK_BG_COLOR);
    }
    
    // Generate dark Windows ICO
    console.log('Generating dark Windows ICO...');
    const darkIcoPngPaths = icoFrameSizes.map(size => path.join(darkIcoRoundedDir, `icon-${size}.png`));
    const darkIcoBuffer = await pngToIco(darkIcoPngPaths);
    await fs.promises.writeFile(path.join(darkIconsDir, 'icon.ico'), darkIcoBuffer);
    
    // Generate dark tray icons
    console.log('Generating dark tray icons...');
    await generateIconWithBackground(svgBuffer, 22, path.join(darkTrayDir, 'icon.png'), DARK_BG_COLOR);
    await generateIconWithRoundedBackground(svgBuffer, 22, path.join(darkTrayDir, 'icon-rounded.png'), 0.85, DARK_BG_COLOR);
    
    // Dark Windows tray ICO
    console.log('Generating dark Windows tray ICO...');
    const darkTrayIcoPngs = [];
    for (const size of trayIcoSizes) {
      const pngPath = path.join(darkTrayDir, `icon-${size}.png`);
      await generateIconWithRoundedBackground(svgBuffer, size, pngPath, 0.8, DARK_BG_COLOR);
      darkTrayIcoPngs.push(pngPath);
    }
    const darkTrayIcoBuffer = await pngToIco(darkTrayIcoPngs);
    await fs.promises.writeFile(path.join(darkTrayDir, 'icon.ico'), darkTrayIcoBuffer);
    // Clean up temporary PNGs
    for (const pngPath of darkTrayIcoPngs) {
      fs.unlinkSync(pngPath);
    }
    
    // Generate dark macOS iconset for ICNS
    console.log('Generating dark macOS iconset...');
    for (const { name, size } of iconsetSizes) {
      await generateMacOSIcon(svgBuffer, size, path.join(darkIconsetDir, name), macOSBgScale, macOSLogoScale, DARK_BG_COLOR);
    }
    
    // Generate dark ICNS file using iconutil (macOS only)
    if (process.platform === 'darwin') {
      console.log('Generating dark ICNS file...');
      try {
        execSync(`iconutil -c icns "${darkIconsetDir}" -o "${path.join(darkIconsDir, 'icon.icns')}"`, {
          stdio: 'inherit'
        });
        console.log('✓ Dark ICNS file generated successfully!');
      } catch (error) {
        console.warn('⚠ Could not generate dark ICNS file. You may need to run manually:');
        console.warn(`  iconutil -c icns "${darkIconsetDir}" -o "${path.join(darkIconsDir, 'icon.icns')}"`);
      }
    } else {
      console.log('⚠ Dark ICNS generation skipped (requires macOS). Use an online converter if needed.');
    }

    console.log('\n✓ All icons generated successfully!');
    
  } catch (error) {
    console.error('Error generating icons:', error);
    process.exit(1);
  }
}

generateIcons();
