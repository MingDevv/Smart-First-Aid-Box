// WEB/FACE-CHECK.JS — ทางเข้าของ esbuild ที่ยก lib/face-check.js ไปให้หน้าจอตู้ใช้
//
// **ทำไมต้องมีขั้นตอนนี้ แทนที่จะ <script src="../lib/face-check.js">**
// `edge/server.mjs` เสิร์ฟเฉพาะ /css /js /images /fonts (allowlist ที่มีเทสล็อกไว้ว่าห้าม
// เปิดออกนอกนั้น) ⇒ /lib/ เป็น 404 จากเบราว์เซอร์ และไฟล์ใน lib/ ก็เป็น ESM ฝั่งเซิร์ฟเวอร์
//
// **ทำไมไม่ก๊อปโค้ดมาไว้ใน js/ ตรงๆ**: เกณฑ์ (FACE_MIN_COVERAGE ฯลฯ) จะมีสองชุดทันที
// และ tests/face-photo.test.mjs ล็อกไว้แค่ชุดใน lib/ ⇒ วันที่ต้องจูนเกณฑ์กับแสงจริงหน้าตู้
// จะแก้ชุดที่ไม่มีใครเทส แล้วอีกชุดเงียบๆ ไม่ตรงกัน · bundle จากต้นฉบับเดียวแทน
//
// รูปแบบตาม web/qr-sdk.js: IIFE แขวนบน window เพราะหน้าตู้โหลดสคริปต์แบบคลาสสิกเรียงกัน
// ไม่ใช่โมดูล — โมดูลถูก defer ทำให้ลำดับกับสคริปต์ที่เหลือเพี้ยน

import { inspectFrame, FACE_MIN_COVERAGE, FACE_MIN_VARIANCE, FACE_MIN_MEAN, FACE_MAX_MEAN } from '../lib/face-check.js';

window.SfabFaceCheck = { inspectFrame, FACE_MIN_COVERAGE, FACE_MIN_VARIANCE, FACE_MIN_MEAN, FACE_MAX_MEAN };
