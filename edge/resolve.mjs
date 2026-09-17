// EDGE/RESOLVE.MJS — เครื่องมือของครู/ผู้ดูแล สำหรับเคลียร์คำสั่งที่ค้างโดยไม่รู้ผล
//
// คำสั่งที่ส่งไปแล้วแต่ตู้ไม่ยืนยันผล จะถูกบันทึกไว้เป็น state='uncertain' ในสมุดคำสั่ง
// ตราบใดที่มันยังค้าง ตู้จะปฏิเสธคำสั่งเปิดช่องใหม่ทุกใบ (edge/controller.mjs)
// เพราะเราไม่รู้ว่าลิ้นชักเปิดไปแล้วหรือยัง มอเตอร์ค้างกลางทางหรือเปล่า
//
// **ตั้งใจไม่ทำเป็น HTTP endpoint** — ผู้ใช้ HTTP เพียงรายเดียวของบริการนี้คือหน้าจอสัมผัส
// ที่นักเรียนกดอยู่ ถ้าเคลียร์ได้จากหน้าจอ มันก็ไม่ใช่เกตอีกต่อไป
// วิธีใช้ต้องผ่าน SSH เข้าเครื่องเท่านั้น:
//
//   node edge/resolve.mjs --list           ดูรายการที่ค้าง
//   node edge/resolve.mjs --check-cabinet <command-id>   ตรวจใบนั้นกับตู้
//
// ก่อนเคลียร์ **ต้องไปดูตู้ด้วยตาจริง**: ลิ้นชักปิดสนิทไหม ของหล่นค้างอยู่หรือเปล่า
// มอเตอร์อยู่ตำแหน่งไหน แล้วค่อยเคลียร์ ชื่อธงยาวแบบนี้ตั้งใจให้พิมพ์ผ่านโดยไม่คิดไม่ได้

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const database = process.env.SFAB_DATABASE ||
    join(homedir(), '.local/share/smart-first-aid-box/commands.sqlite');

const args = process.argv.slice(2);
const usage = `
เคลียร์คำสั่งที่ค้างไม่รู้ผลของตู้ปฐมพยาบาล

  node edge/resolve.mjs --list
      แสดงคำสั่งที่ยังค้างอยู่ ทำให้ตู้ปฏิเสธการเปิดช่องใหม่

  node edge/resolve.mjs --check-cabinet <command-id>
      ยืนยันว่าไปดูตู้ด้วยตาแล้ว และเคลียร์คำสั่งใบนั้น

ฐานข้อมูล: ${database}
(เปลี่ยนได้ด้วยตัวแปรแวดล้อม SFAB_DATABASE)
`;

if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(args.length ? 0 : 1);
}

let db;
try {
    db = new DatabaseSync(database, { readOnly: args[0] === '--list' });
} catch {
    // ไม่มีไฟล์สมุดคำสั่ง = บริการยังไม่เคยรันบนเครื่องนี้ ไม่ใช่ข้อผิดพลาดของผู้ใช้
    console.error(`เปิดสมุดคำสั่งไม่ได้: ${database}`);
    console.error('ถ้ายังไม่เคยรัน edge/server.mjs บนเครื่องนี้ แปลว่ายังไม่มีคำสั่งค้างให้เคลียร์');
    console.error('ถ้ามั่นใจว่ามีไฟล์อยู่ที่อื่น ให้ตั้ง SFAB_DATABASE ชี้ไปที่ไฟล์นั้น');
    process.exit(1);
}

if (args[0] === '--list') {
    const rows = db.prepare(`SELECT id, drawer, created_at FROM commands
        WHERE state = 'uncertain' ORDER BY rowid DESC`).all();
    if (!rows.length) {
        console.log('ไม่มีคำสั่งค้าง ตู้เปิดช่องใหม่ได้ตามปกติ');
    } else {
        console.log(`มีคำสั่งค้างอยู่ ${rows.length} ใบ — ตู้จะปฏิเสธการเปิดช่องใหม่จนกว่าจะเคลียร์`);
        for (const row of rows) {
            console.log(`  ${row.id}  ช่องที่ ${row.drawer}  ส่งเมื่อ ${row.created_at}`);
        }
        console.log('\nไปดูตู้ก่อน แล้วเคลียร์ด้วย:\n  node edge/resolve.mjs --check-cabinet <command-id>');
    }
    db.close();
    process.exit(0);
}

if (args[0] === '--check-cabinet' && args[1]) {
    const id = args[1];
    const row = db.prepare('SELECT id, drawer, state FROM commands WHERE id = ?').get(id);
    if (!row) {
        console.error(`ไม่พบคำสั่ง ${id} ในสมุดคำสั่ง`);
        db.close();
        process.exit(1);
    }
    if (row.state !== 'uncertain') {
        console.error(`คำสั่ง ${id} อยู่ในสถานะ '${row.state}' ไม่ใช่ 'uncertain' — ไม่มีอะไรให้เคลียร์`);
        db.close();
        process.exit(1);
    }
    // ไม่ลบแถวทิ้ง เก็บไว้เป็นประวัติว่าเคยเกิดอะไรขึ้นและใครเคลียร์เมื่อไร
    db.prepare("UPDATE commands SET state = 'resolved_by_operator', confirmed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    console.log(`เคลียร์คำสั่ง ${id} (ช่องที่ ${row.drawer}) แล้ว ตู้เปิดช่องใหม่ได้`);
    db.close();
    process.exit(0);
}

console.error('คำสั่งไม่ถูกต้อง');
console.log(usage);
db.close();
process.exit(1);
