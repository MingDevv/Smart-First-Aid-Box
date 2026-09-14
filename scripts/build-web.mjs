import { build } from 'esbuild';
await build({ entryPoints: ['web/firebase-sdk.js'], outfile: 'js/firebase-sdk.js', bundle: true, format: 'esm', minify: true, target: ['safari15', 'chrome100'], legalComments: 'eof' });

await build({ entryPoints: ['web/qr-sdk.js'], outfile: 'js/qr-sdk.js', bundle: true, format: 'iife', minify: true, target: ['chrome100'], legalComments: 'eof' });

// หน้าจอตู้ตรวจว่า "เห็นคนอยู่ตรงหน้าไหม" ก่อนรับรูปของคนที่ไม่มีบัตร — ตรรกะเดียวกับที่
// เซิร์ฟเวอร์ใช้ ไม่ได้ก๊อปมาไว้อีกชุด (ดูคอมเมนต์ใน web/face-check.js)
await build({ entryPoints: ['web/face-check.js'], outfile: 'js/face-check.js', bundle: true, format: 'iife', minify: true, target: ['chrome100'], legalComments: 'eof' });
