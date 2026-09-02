import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, '..');

async function collectHtmlFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;

        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectHtmlFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
            files.push(fullPath);
        }
    }

    return files;
}

function resolveLocalResource(htmlPath, resourcePath) {
    const cleanPath = resourcePath.split(/[?#]/, 1)[0];
    if (
        !cleanPath ||
        cleanPath.includes('${') ||
        /^(?:[a-z]+:)?\/\//i.test(cleanPath) ||
        cleanPath.startsWith('data:')
    ) {
        return null;
    }

    if (cleanPath.startsWith('/')) {
        return path.join(rootDir, cleanPath.slice(1));
    }

    return path.resolve(path.dirname(htmlPath), cleanPath);
}

const htmlFiles = await collectHtmlFiles(rootDir);
const missingResources = [];

for (const htmlPath of htmlFiles) {
    const html = await readFile(htmlPath, 'utf8');
    const resourcePattern = /<(?:img|script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi;

    for (const match of html.matchAll(resourcePattern)) {
        const resourcePath = resolveLocalResource(htmlPath, match[1]);
        if (!resourcePath) continue;

        try {
            await access(resourcePath);
        } catch {
            missingResources.push(
                `${path.relative(rootDir, htmlPath)} -> ${match[1]}`
            );
        }
    }
}

assert.deepEqual(
    missingResources,
    [],
    `HTML pages reference missing local resources:\n${missingResources.join('\n')}`
);

const landingHtml = await readFile(path.join(rootDir, 'index.html'), 'utf8');
assert.doesNotMatch(
    landingHtml,
    /stat-med-count|stat-total-usage/,
    'Landing page must not execute the removed statistics UI'
);
assert.match(
    landingHtml,
    /<a\b[^>]*class=["'][^"']*menu-item-btn[^"']*["'][^>]*href=["']student\/kiosk["']/i,
    'Landing page must expose the existing touchscreen kiosk mode with a real link'
);

const kioskHtml = await readFile(path.join(rootDir, 'student', 'kiosk.html'), 'utf8');
assert.match(
    kioskHtml,
    /id=["']kiosk-mode-badge["'][^>]*role=["']status["']/i,
    'Kiosk must expose live, simulation, or offline state through an accessible status badge'
);
assert.match(
    kioskHtml,
    /ApiBridge\.getHardwareStatus\(\)/,
    'Kiosk status badge must come from the hardware connection state'
);
assert.match(
    kioskHtml,
    /notificationResult\.mode\s*===\s*['"]simulation['"]/,
    'Kiosk SOS feedback must distinguish a simulated notification from a real send'
);
assert.match(
    kioskHtml,
    /buzzerResult\.mode\s*===\s*['"]simulation['"]/,
    'Kiosk SOS feedback must distinguish a simulated buzzer from real hardware'
);

const woundDataSource = await readFile(path.join(rootDir, 'js', 'wound-data.js'), 'utf8');
const missingWoundAssets = [];
for (const match of woundDataSource.matchAll(/["']\.\.\/images\/([^"']+)["']/g)) {
    try {
        await access(path.join(rootDir, 'images', match[1]));
    } catch {
        missingWoundAssets.push(match[1]);
    }
}
assert.deepEqual(
    missingWoundAssets,
    [],
    `Wound guidance references missing image assets:\n${missingWoundAssets.join('\n')}`
);
assert.doesNotMatch(
    woundDataSource,
    /\.png["']/i,
    'Wound guidance should use the optimized WebP assets shipped for the student flow'
);

const aboutHtml = await readFile(path.join(rootDir, 'student', 'about.html'), 'utf8');
assert.doesNotMatch(
    aboutHtml,
    /LINE Notify/i,
    'Project explanation must not name the discontinued LINE Notify service'
);
assert.match(
    aboutHtml,
    /LINE Messaging API/i,
    'Project explanation must name the notification service currently used by the app'
);

console.log(`UI smoke checks passed for ${htmlFiles.length} HTML pages.`);
