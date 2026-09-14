// LIB/FACE-CHECK.JS — ตรวจว่ารูปที่ถ่ายมา "มีคนอยู่ตรงนั้นจริง" ก่อนปล่อยให้ใช้ตู้โดยไม่มีบัตร
//
// ทำไมต้องมี: คนไม่มีบัตรใช้ตู้ได้ แต่ต้องถ่ายรูปส่งครู เหตุผลคือกันคนมากดเล่น
// ถ้าไม่ตรวจอะไรเลย คนที่ตั้งใจกดเล่นก็แค่เอามือบังเลนส์หรือหันกล้องขึ้นเพดาน
// แล้วได้ของไปเหมือนเดิม การถ่ายรูปก็ไม่ได้ยับยั้งอะไร
//
// **ทำไมไม่ใช้ไลบรารีตรวจใบหน้า**: ตัวที่ลงได้จริงบน npm คือ face-api.js ซึ่ง 4.8MB และลาก
// tfjs มาด้วย — หนักเกินไปสำหรับจอตู้ที่ต้องโหลดเร็วบน Pi · pico.js ไม่มีบน npm ·
// และ `FaceDetector` ของเบราว์เซอร์พิสูจน์ไม่ได้ว่ามีบนตู้ (headless probe พังเพราะ mojo)
// ⇒ ตรวจด้วยสถิติของภาพเอง ไม่มี dependency ใหม่ ทำงานตอนเน็ตหลุดได้ และไม่ส่งหน้าเด็ก
// ออกไปให้บริการภายนอกรายใหม่
//
// **ขอบเขตที่ซื่อสัตย์**: นี่ไม่ใช่การจดจำใบหน้า และไม่ได้ยืนยันว่าเป็นใคร มันตอบคำถามเดียว
// คือ "กล้องเห็นอะไรที่เป็นคนอยู่ตรงหน้าไหม" ซึ่งเป็นสิ่งเดียวที่การยับยั้งต้องการ
// คนที่ตั้งใจหลบยังหลบได้ (เอารูปมาส่อง) แต่รูปที่ได้ก็ยังถึงครูอยู่ดี ซึ่งคือการยับยั้ง

export const FACE_MIN_COVERAGE = 0.04;   // ต้องมีพื้นที่โทนผิวอย่างน้อย 4% ของเฟรม
export const FACE_MIN_VARIANCE = 180;    // ความแปรปรวนความสว่าง กันภาพเรียบๆ อย่างผนังหรือเลนส์ถูกบัง
export const FACE_MIN_MEAN = 18;         // มืดกว่านี้คือถูกบัง ไม่ใช่ห้องมืด
export const FACE_MAX_MEAN = 245;        // สว่างจ้ากว่านี้คือส่องไฟใส่เลนส์

/** ผิวคนทุกสีอยู่ในช่วงแคบๆ ของ hue เมื่อมองแบบ chroma ต่างจากผนัง เสื้อผ้า และเพดาน
 *
 * เกณฑ์มาจากงาน skin-detection แบบคลาสสิกใน RGB (Kovac et al.) ซึ่งครอบผิวหลายเฉด
 * ไม่ใช่แค่ผิวขาว — สำคัญเพราะผู้ใช้คือเด็กไทยทั้งโรงเรียน
 */
function isSkin(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 15 && r > g && r > b;
}

/** รับพิกเซล RGBA ดิบ (เช่นจาก `ctx.getImageData().data`) แล้วบอกว่าปล่อยผ่านได้ไหม
 *
 * คืนเหตุผลกลับมาด้วยเสมอ เพราะจอตู้ต้องบอกเด็กว่าให้ทำอะไรต่อ ไม่ใช่แค่ปฏิเสธเฉยๆ
 */
export function inspectFrame(pixels, width, height) {
    const total = width * height;
    if (!pixels || pixels.length < total * 4 || total === 0) {
        return { ok: false, reason: 'no_image', message: 'ยังไม่เห็นภาพจากกล้อง' };
    }
    let skin = 0, sum = 0, sumSquares = 0;
    for (let i = 0; i < total; i++) {
        const o = i * 4, r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
        if (isSkin(r, g, b)) skin++;
        // ความสว่างแบบ Rec. 601 — ใกล้เคียงการรับรู้ของตามากกว่าค่าเฉลี่ย RGB ตรงๆ
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        sum += luma;
        sumSquares += luma * luma;
    }
    const mean = sum / total;
    const variance = sumSquares / total - mean * mean;
    const coverage = skin / total;
    if (mean < FACE_MIN_MEAN) return { ok: false, reason: 'too_dark', message: 'ภาพมืดเกินไป ขยับเข้ามาใกล้ๆ แล้วมองกล้อง', coverage, mean, variance };
    if (mean > FACE_MAX_MEAN) return { ok: false, reason: 'too_bright', message: 'แสงจ้าเกินไป ลองขยับหลบแสง', coverage, mean, variance };
    if (variance < FACE_MIN_VARIANCE) return { ok: false, reason: 'flat', message: 'ยังไม่เห็นหน้า ขยับเข้ามาใกล้ๆ แล้วมองกล้อง', coverage, mean, variance };
    if (coverage < FACE_MIN_COVERAGE) return { ok: false, reason: 'no_face', message: 'ยังไม่เห็นหน้า ขยับเข้ามาใกล้ๆ แล้วมองกล้อง', coverage, mean, variance };
    return { ok: true, reason: 'face', message: 'เห็นหน้าแล้ว', coverage, mean, variance };
}
