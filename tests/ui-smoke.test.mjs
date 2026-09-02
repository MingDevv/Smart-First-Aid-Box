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
const studentResponsiveCss = await readFile(path.join(rootDir, 'css', 'student-responsive.css'), 'utf8');
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
assert.match(
    landingHtml,
    /href=["']css\/home\.css["']/i,
    'Landing page must load the shared Care Kit home styling'
);
assert.match(
    landingHtml,
    /เจ็บตรงไหน\?<br>สแกนแผลได้เลย/,
    'Landing page must use the Claude Design Care Kit hero copy'
);
assert.match(
    landingHtml,
    /class=["'][^"']*home-action[^"']*primary-action[^"']*["'][^>]*href=["']student\/wound-scan["']/i,
    'Landing page must make AI wound scanning the primary Care Kit action'
);
assert.match(
    landingHtml,
    /href=["']css\/student-responsive\.css["']/i,
    'Landing page must load the wide Care Kit compositions for desktop'
);
for (const relativePath of [
    'student/index.html',
    'student/kiosk.html',
    'student/wound-select.html',
    'student/wound-scan.html',
    'student/first-aid-guide.html',
    'student/about.html',
    'student/history.html'
]) {
    const html = await readFile(path.join(rootDir, relativePath), 'utf8');
    assert.match(
        html,
        /href=["']\.\.\/css\/student-responsive\.css["']/i,
        `${relativePath} must load the shared desktop Care Kit compositions`
    );
}
assert.match(
    studentResponsiveCss,
    /@media\s*\(min-width:\s*900px\)[\s\S]*?\.home-app\s*\{[\s\S]*?grid-template-columns:/,
    'Desktop home must recompose into columns instead of retaining a centered phone shell'
);
for (const selector of [
    '.picker-app',
    '.scan-main',
    '.guide-container.is-visible',
    '.steps-view.is-visible',
    '.about-app',
    'body.history-body .container'
]) {
    assert.ok(
        studentResponsiveCss.includes(selector),
        `Responsive Care Kit CSS must cover ${selector}`
    );
}

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
assert.doesNotMatch(
    kioskHtml,
    /background:\s*#0F172A/i,
    'Kiosk must not regress to the discarded dark redesign'
);

const scannerHtml = await readFile(path.join(rootDir, 'student', 'wound-scan.html'), 'utf8');
assert.match(
    scannerHtml,
    /class=["']scan-frame["']/i,
    'AI scanner must expose the Care Kit camera targeting frame'
);
assert.match(
    scannerHtml,
    /<section\b(?=[^>]*id=["']result-section["'])(?=[^>]*class=["'][^"']*result-container[^"']*["'])/i,
    'AI scanner must include the designed result state'
);
assert.match(
    scannerHtml,
    /classList\.add\(['"]is-visible['"]\)/,
    'AI scanner result must expose a responsive visible state that can become a desktop grid'
);

const guideHtml = await readFile(path.join(rootDir, 'student', 'first-aid-guide.html'), 'utf8');
assert.match(
    guideHtml,
    /id=["']unlock-view["']/i,
    'First-aid flow must include the full-screen unlock confirmation from Claude Design'
);
assert.match(
    guideHtml,
    /onclick=["']startTreatment\(\)["']/i,
    'Compartment opening must wait for the explicit Care Kit start action'
);
assert.doesNotMatch(
    guideHtml,
    /setTimeout\(\(\)\s*=>\s*openConfirmModal/,
    'First-aid flow must not auto-open the old confirmation modal on page load'
);
assert.match(
    guideHtml,
    /class=["']guide-overview["'][\s\S]*class=["']step-copy-panel["']/,
    'First-aid flow must include the desktop wound overview and instruction panel'
);

const dashboardHtml = await readFile(path.join(rootDir, 'dashboard', 'index.html'), 'utf8');
const medicineManagementHtml = await readFile(path.join(rootDir, 'dashboard', 'medicine-management.html'), 'utf8');
const statisticsHtml = await readFile(path.join(rootDir, 'dashboard', 'statistics.html'), 'utf8');
const dashboardCss = await readFile(path.join(rootDir, 'css', 'dashboard.css'), 'utf8');
assert.match(
    dashboardHtml,
    /class=["']dashboard-shell["']/i,
    'Nurse dashboard must use the Care Kit sidebar workspace layout'
);
assert.match(
    dashboardCss,
    /--db-sidebar:\s*oklch\(0\.49 0\.10 195\)/,
    'Nurse dashboard must keep the Claude Design teal sidebar token'
);
assert.doesNotMatch(
    dashboardCss,
    /--db-dark-bg/,
    'Nurse dashboard must not keep the discarded dark-theme token'
);
for (const [name, html] of [
    ['medicine management', medicineManagementHtml],
    ['statistics', statisticsHtml]
]) {
    assert.match(
        html,
        /class=["']dashboard-shell["']/i,
        `${name} must remain inside the Claude Design dashboard shell`
    );
    assert.doesNotMatch(
        html,
        /class=["']dashboard-nav["']/i,
        `${name} must not fall back to the legacy top-tab dashboard layout`
    );
}
assert.match(
    medicineManagementHtml,
    /class=["']med-item-image["']/,
    'Medicine management must carry the Care Kit product imagery into its generated stock rows'
);

const historyHtml = await readFile(path.join(rootDir, 'student', 'history.html'), 'utf8');
assert.match(
    historyHtml,
    /class=["']material-symbols-rounded["'][^>]*>history</i,
    'Student history empty state must use the Care Kit icon system'
);
assert.doesNotMatch(
    historyHtml,
    /[📋🗑📁]/u,
    'Student history must not fall back to emoji UI icons'
);

const notificationSource = await readFile(path.join(rootDir, 'js', 'notification.js'), 'utf8');
assert.match(
    notificationSource,
    /themes\s*=\s*\{[\s\S]*check_circle[\s\S]*warning/,
    'In-app toasts must use Material Symbols from the Care Kit icon system'
);
assert.doesNotMatch(
    notificationSource,
    /backgroundColor\s*=\s*['"]#0F172A/i,
    'LINE simulation overlay must not regress to the discarded dark card'
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
