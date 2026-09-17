import { existsSync } from 'node:fs';
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
// หน้าแรกต้องไม่มีลิงก์ที่ซ่อนไว้จนกดไม่ได้ — ลิงก์ที่เขียน `style="display:none;"` หรือ
// `aria-hidden="true"` ทำให้เกตที่ตรวจแค่ว่า "มีลิงก์ไหม" เขียวได้
// โดยที่ไม่มีผู้ใช้คนไหนเห็นหรือกดมันได้เลย ⇒ ต้องตรวจว่าลิงก์เข้าถึงได้จริง
assert.doesNotMatch(
    landingHtml,
    /<a\b[^>]*(?:aria-hidden=["']true["']|style=["'][^"']*display\s*:\s*none)/i,
    'Landing page must not carry links nobody can see or reach'
);
assert.match(
    landingHtml,
    /href=["']css\/home\.css["']/i,
    'Landing page must load the shared Care Kit home styling'
);
// หน้าแรกกับ /student ใช้การออกแบบชุดเดียวกัน ⇒ พาดหัวและภาพฮีโร่ต้องตรงกัน
// ตรวจเทียบกับไฟล์จริงของ /student ไม่ใช่ฝังสตริงไว้ที่นี่ ไม่งั้นแก้หน้าหนึ่งแล้วอีกหน้าค้าง
// โดยไม่มีอะไรร้อง
const studentHomeHtml = await readFile(path.join(rootDir, 'student', 'index.html'), 'utf8');
for (const pattern of [/<h1 class="home-title">([\s\S]*?)<\/h1>/, /<figure class="home-hero-mascot">[\s\S]*?<\/figure>/]) {
    const fromStudent = studentHomeHtml.match(pattern);
    assert.ok(fromStudent, `student/index.html must still contain ${pattern}`);
    assert.ok(
        landingHtml.includes(fromStudent[0].replace(/\.\.\/images\//g, 'images/')),
        'Landing page hero must stay identical to the student home hero'
    );
}
assert.match(
    landingHtml,
    /class=["'][^"']*home-action[^"']*primary-action[^"']*["'][^>]*href=["']\/?student\/wound-scan["']/i,
    'Landing page must make AI wound scanning the primary Care Kit action'
);
assert.match(
    landingHtml,
    /href=["']css\/student-responsive\.css["']/i,
    'Landing page must load the wide Care Kit compositions for desktop'
);
for (const relativePath of [
    'student/index.html',
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
    '.home-app',
    '.picker-app',
    '.scan-app',
    '.guide-container.is-visible',
    '.unlock-view.is-visible',
    '.steps-view.is-visible',
    '.about-app',
    'body.history-body .container'
]) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
        studentResponsiveCss,
        new RegExp(`${escapedSelector}\\s*\\{[^}]*width:\\s*100%;[^}]*min-height:\\s*[^;]*100dvh[^;]*;`),
        `Desktop Care Kit shell ${selector} must fill the viewport`
    );
}
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

// หน้าจอตู้ของจริงคือ kiosk/index.html ตรวจอยู่ในบล็อกข้างล่าง

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

// ─── หน้าจอตู้ ตรวจเฉพาะโครงสร้าง ────────────────────────────
// หน้าจอตู้เขียนข้อห้ามของตัวเองไว้ในคอมเมนต์ HTML ด้วย
// ข้อตรวจข้างล่างจึงต้องตัดคอมเมนต์ออกก่อน ไม่งั้นคอมเมนต์ที่เขียนว่า "ห้ามทำแบบนี้"
// จะทำให้เทสตกเอง กลายเป็นวัดข้อความแทนที่จะวัดโค้ด
const kioskPageHtml = await readFile(path.join(rootDir, 'kiosk', 'index.html'), 'utf8');
const kioskCssSource = await readFile(path.join(rootDir, 'css', 'kiosk.css'), 'utf8');
const kioskAppSource = await readFile(path.join(rootDir, 'js', 'kiosk-app.js'), 'utf8');
const kioskSessionSource = await readFile(path.join(rootDir, 'js', 'kiosk-session.js'), 'utf8');
const kioskMarkup = kioskPageHtml.replace(/<!--[\s\S]*?-->/g, '');
const kioskCssRules = kioskCssSource.replace(/\/\*[\s\S]*?\*\//g, '');
// ตัดเฉพาะบรรทัดที่เป็นคอมเมนต์ทั้งบรรทัด ข้อความในเครื่องหมายคำพูดไม่เคยกินทั้งบรรทัด
// จึงไม่มีทางตัดโค้ดจริงทิ้ง
const kioskAppCode = kioskAppSource
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

assert.match(
    kioskPageHtml,
    /<head>/,
    'Kiosk page must keep a bare <head>: edge/server.mjs injects window.SFAB_RUNTIME by replacing the literal string "<head>"'
);
assert.doesNotMatch(
    kioskPageHtml,
    /<head\s[^>]*>/i,
    'Kiosk <head> must carry no attributes — the Pi runtime injection matches the bare tag and fails open, so the cabinet would silently lose its pi-local transport with no error anywhere'
);

assert.doesNotMatch(
    kioskMarkup,
    /<input\b[^>]*type\s*=\s*["']?file/i,
    'Kiosk markup must never contain a file input: a hurt child cannot escape an OS file chooser on a 5-inch resistive panel with no keyboard'
);
assert.doesNotMatch(
    kioskAppCode,
    /type\s*[=:]\s*["']file["']/i,
    'Kiosk controller must not build a file input at runtime either — same OS file chooser, only created in script'
);
assert.doesNotMatch(
    kioskAppCode,
    /\.click\s*\(\s*\)/,
    'Kiosk controller must never fire a programmatic .click(): that is the one way to open a file chooser without markup'
);
assert.doesNotMatch(
    kioskAppCode,
    /FileReader/,
    'Kiosk controller must not read local files — the only image source at the cabinet is the live camera'
);

assert.doesNotMatch(
    kioskMarkup,
    /\/dashboard/i,
    'Kiosk page must not point at the nurse dashboard: the cabinet screen is unattended and must never reach teacher tools'
);
assert.doesNotMatch(
    kioskAppCode,
    /\/dashboard/i,
    'Kiosk controller must not navigate to the nurse dashboard for the same reason'
);
assert.doesNotMatch(
    kioskMarkup,
    /<a\b[^>]*href=/i,
    'Kiosk page must contain no anchor at all — every link is a way off the single page, and the cabinet has no browser chrome to come back with'
);
assert.doesNotMatch(
    kioskAppCode,
    /location\s*(?:\.href\s*)?=\s*["'`]|location\.(?:assign|replace)\s*\(|window\.open\s*\(/,
    'Kiosk controller must never change the URL: the flow is one page precisely so the round (photo, AI result, wound choice) is cleared in exactly one place'
);

const forbiddenKioskHosts = /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|code\.jquery\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/i;
assert.doesNotMatch(
    kioskMarkup,
    forbiddenKioskHosts,
    'Kiosk page must load nothing from a CDN or Google Fonts — the cabinet has to come up when the school internet is down'
);
assert.doesNotMatch(
    kioskCssRules,
    forbiddenKioskHosts,
    'css/kiosk.css must reference no remote host for the same offline reason'
);
assert.doesNotMatch(
    kioskMarkup,
    /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']https?:\/\//i,
    'No kiosk script or stylesheet may be fetched over the network at all'
);
assert.doesNotMatch(
    kioskCssRules,
    /url\(\s*["']?https?:\/\//i,
    'css/kiosk.css must not fetch any remote url() — a blocked font or image request stalls first paint on the cabinet'
);
assert.doesNotMatch(
    kioskMarkup,
    /cdn\.jsdelivr\.net\/npm\/mqtt/i,
    'Kiosk page must not load the mqtt CDN bundle: edge/server.mjs strips that tag on the Pi, so keeping it would mean the page only works because a regex rescued it'
);
assert.doesNotMatch(
    kioskCssRules,
    /@import/i,
    'css/kiosk.css must stand alone — css/global.css opens with @import url(https://fonts.googleapis.com/...), so importing it would put a render-blocking network fetch in front of the cabinet screen'
);

assert.match(
    kioskMarkup,
    /<link\b[^>]*href=["']\.\.\/css\/kiosk\.css["']/i,
    'Kiosk page must load its own standalone stylesheet'
);
assert.doesNotMatch(
    kioskMarkup,
    /css\/(?:global|home|student-responsive)\.css/i,
    'Kiosk deliberately replaces the phone stylesheets: they assume a scrolling portrait column, which pushes the dispense and call-teacher buttons off an 800x480 landscape panel'
);

const kioskFontRefs = [...kioskCssRules.matchAll(/url\(\s*['"]?(\.\.\/fonts\/[^'")]+\.woff2)['"]?\s*\)/g)].map(match => match[1]);
assert.ok(
    kioskFontRefs.length > 0,
    'css/kiosk.css must self-host its Thai webfont from ../fonts/ instead of pulling it from Google Fonts'
);
const missingKioskFonts = [];
for (const fontRef of kioskFontRefs) {
    try {
        await access(path.resolve(rootDir, 'css', fontRef));
    } catch {
        missingKioskFonts.push(fontRef);
    }
}
assert.deepEqual(
    missingKioskFonts,
    [],
    `css/kiosk.css points at font files that are not in the repo (resolveLocalResource above only walks img/script/link tags, never CSS url(), and font-display: swap hides the miss behind a system fallback):\n${missingKioskFonts.join('\n')}`
);

const kioskEmojiPattern = /\p{Extended_Pictographic}/u;
assert.doesNotMatch(
    kioskPageHtml,
    kioskEmojiPattern,
    'Kiosk page must not use emoji: the cabinet loads no emoji font, and the project rule is text or inline SVG everywhere in the UI'
);
assert.doesNotMatch(
    kioskAppSource,
    kioskEmojiPattern,
    'Kiosk controller must not inject emoji into the cabinet screen for the same reason'
);
assert.doesNotMatch(
    kioskAppCode,
    /\.icon\b/,
    'Kiosk controller must never read the icon field of js/wound-data.js — those fields hold emoji, so rendering one would put an emoji on the cabinet screen without any emoji appearing in kiosk source'
);

assert.doesNotMatch(
    kioskAppCode,
    /demoMode\s*=/,
    'The demo escape hatch from student/first-aid-guide.html (enableDemoAndProceed writes demoMode: true into smart_first_aid_settings) must never reach the cabinet: on a shared box it would turn real dispensing into simulation for every later student, silently'
);
assert.doesNotMatch(
    kioskAppCode,
    /localStorage\.setItem/,
    'Kiosk controller must not write persistent browser state of its own — anything it stored would outlive the round it belongs to and follow the next student'
);

assert.match(
    kioskCssRules,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'css/kiosk.css must force [hidden] to display:none — .btn, .notice and .overlay-actions declare their own display at the same specificity as the browser [hidden] rule and win on order, so without this the retry button would be visible while the dispatch outcome is still uncertain'
);
assert.match(
    kioskMarkup,
    /<button\b[^>]*id=["']problem-retry["'][^>]*\shidden\b/i,
    'The retry button must ship hidden and be revealed only for a rejected dispatch: a hardware command whose outcome is uncertain must never be offered for retry'
);

assert.doesNotMatch(
    kioskSessionSource,
    /\bdocument\b/,
    'js/kiosk-session.js must stay DOM-free so the dispatch and idle rules can be tested by calling them in Node, instead of regex-matching source the way this file has to'
);
const { default: vm } = await import('node:vm');
const kioskSessionModule = { exports: {} };
vm.runInNewContext(kioskSessionSource, {
    module: kioskSessionModule,
    setTimeout,
    clearTimeout,
    console
});
assert.equal(
    typeof kioskSessionModule.exports.create,
    'function',
    'js/kiosk-session.js must export create() through its UMD wrapper when no window exists; if that Node branch breaks, every behavioural kiosk test degrades to testing an empty object'
);
for (const exportName of ['IDLE_MS', 'WARNING_MS', 'DISPATCH_STATES']) {
    assert.ok(
        exportName in kioskSessionModule.exports,
        `js/kiosk-session.js must export ${exportName} so tests read the shipped value instead of restating a number the source can drift away from`
    );
}

const kioskScripts = [...kioskMarkup.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)].map(match => match[1]);
assert.ok(
    kioskScripts.includes('../js/kiosk-app.js'),
    'Kiosk page must load js/kiosk-app.js — nothing else drives the views'
);
for (const dependency of [
    '../js/wound-data.js',
    '../js/storage.js',
    '../js/notification.js',
    '../js/api-bridge.js',
    '../js/kiosk-session.js'
]) {
    assert.ok(
        kioskScripts.includes(dependency),
        `Kiosk page must load ${dependency}: js/kiosk-app.js dereferences WOUND_DATA, StorageService, NotificationService, ApiBridge and KioskSession with no fallback on at least one path`
    );
    assert.ok(
        kioskScripts.indexOf(dependency) < kioskScripts.indexOf('../js/kiosk-app.js'),
        `${dependency} must load before js/kiosk-app.js, which calls into it during init()`
    );
}

// หน้าแรกของนักเรียนต้องไม่มีการ์ดตายๆ ที่กดแล้วไม่เกิดอะไร และต้องมีทางเข้าสแกนแผลด้วย AI
//
// การ์ด <div> ที่กดแล้วเงียบจะกินช่องหลักที่ควรเป็นเมนู AI ทำให้ดูเหมือนเมนู AI หายไป
//
// บัตร QR ไม่ใช่เรื่องของเว็บ เพราะเว็บบังคับล็อกอิน @tesaban6.ac.th อยู่แล้ว และตัวตนจาก
// อีเมลที่ยืนยันแล้วแข็งแรงกว่าบัตรที่ถ่ายรูปไปใช้แทนกันได้ · บัตรมีหน้าที่เดียวคือสแกนที่ตู้
{
    const home = await readFile(new URL('../student/index.html', import.meta.url), 'utf8');
    const live = home.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(/class="home-action primary-action"[^>]*href="\/student\/wound-scan"/.test(live),
        'หน้าแรกของนักเรียนต้องมีเมนูสแกนแผลด้วย AI อยู่ในช่องหลัก');
    assert.ok(!/บัตรของฉัน/.test(live),
        'บัตร QR ไม่ใช่ทางเข้าของเว็บ ต้องไม่มีการ์ดบัตรบนหน้าแรกของนักเรียน');
    for (const dead of live.match(/<div class="home-action[^>]*>/g) || []) {
        assert.fail(`การ์ดเมนูต้องเป็นลิงก์หรือปุ่มที่กดแล้วเกิดอะไรขึ้น ไม่ใช่ <div> ตายๆ: ${dead}`);
    }
    for (const icon of live.match(/src="\/images\/menu-icons\/[^"]+"/g) || []) {
        const file = icon.slice(6, -1).replace(/^\//, '');
        assert.ok(existsSync(new URL('../' + file, import.meta.url)), `ไม่พบไฟล์ไอคอน ${file}`);
    }
}

console.log(`UI smoke checks passed for ${htmlFiles.length} HTML pages.`);

// ทุกรูปที่หน้าเว็บอ้างถึงต้องมีไฟล์จริง
//
// รูปที่หายไม่ทำให้เทสไหนแดงเลย มันแค่กลายเป็นกรอบว่างบนจอตู้ที่ไม่มีใครเฝ้า
{
    const pages = htmlFiles;
    for (const file of pages) {
        const html = await readFile(file, 'utf8');
        for (const match of html.matchAll(/src="([^"]*images\/[^"]+)"/g)) {
            const rel = match[1].replace(/^(\.\.\/|\/)/, '');
            assert.ok(existsSync(new URL('../' + rel, import.meta.url)),
                `${file} อ้างถึง ${rel} ซึ่งไม่มีไฟล์อยู่จริง`);
        }
    }
}
