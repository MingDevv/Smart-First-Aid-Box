// การให้สิทธิ์ครูพยาบาลต้องเป็นของ admin เท่านั้น และต้องล็อกตัวเองออกไม่ได้
//
// เทสชุดนี้ปักกฎไว้ที่ฝั่งเซิร์ฟเวอร์ เพราะ UI โกหกได้
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRolesHandler } from '../api/roles.js';
import { AccessError } from '../lib/auth.js';

const ADMIN = { uid: 'u-admin', email: 'admin@tesaban6.ac.th' };
const TEACHER = { uid: 'u-teacher', email: 'teacher@tesaban6.ac.th' };

function harness({ actorRole = 'admin', users = [ADMIN, TEACHER], docs = {} } = {}) {
    const written = [], deleted = [];
    const byEmail = new Map(users.map(u => [u.email, { ...u, emailVerified: u.emailVerified !== false }]));
    const db = {
        doc: path => ({
            set: async value => { written.push({ path, value }); },
            delete: async () => { deleted.push(path); }
        }),
        collection: () => ({ get: async () => ({ docs: Object.entries(docs).map(([uid, data]) => ({ id: uid, data: () => data })) }) })
    };
    const handler = createRolesHandler({
        authorizeRequest: async () => {
            if (!actorRole) throw new AccessError(401, 'sign_in_required');
            return { token: ADMIN, role: actorRole, db };
        },
        services: () => ({ db, auth: { getUserByEmail: async email => {
            if (!byEmail.has(email)) throw new Error('not found');
            return byEmail.get(email);
        } } })
    });
    return { handler, written, deleted };
}

const invoke = async (handler, method, body) => {
    let status = 0, payload;
    const res = { setHeader() {}, status(code) { status = code; return res; },
        json(value) { payload = value; return res; }, end() { return res; } };
    await handler({ method, body }, res);
    return { status, payload };
};

test('only an admin may read or change who has access', async () => {
    // ครูทำทุกอย่างได้เหมือน admin **ยกเว้น** การตั้งสิทธิ์บัญชี
    for (const role of ['student', 'teacher']) {
        const { handler, written } = harness({ actorRole: role });
        assert.equal((await invoke(handler, 'GET')).status, 403, role);
        const post = await invoke(handler, 'POST', { email: TEACHER.email, role: 'teacher' });
        assert.equal(post.status, 403, role);
        assert.equal(post.payload.error, 'admin_role_required');
        assert.equal(written.length, 0, `${role} ต้องเขียนอะไรไม่ได้เลย`);
    }
    const signedOut = harness({ actorRole: null });
    assert.equal((await invoke(signedOut.handler, 'GET')).status, 401);
});

test('granting requires a verified school account that has signed in at least once', async () => {
    const { handler, written } = harness();
    for (const [body, expected] of [
        [{ email: 'someone@gmail.com', role: 'teacher' }, 'school_email_required'],
        [{ email: TEACHER.email, role: 'superuser' }, 'unknown_role'],
        // `nurse` ถูกยกเลิกแล้ว — ต้องถูกปฏิเสธเหมือนบทบาทที่ไม่มีอยู่จริง ไม่ใช่ยอมรับเงียบๆ
        [{ email: TEACHER.email, role: 'nurse' }, 'unknown_role'],
        [{ email: 'ghost@tesaban6.ac.th', role: 'teacher' }, 'never_signed_in']
    ]) {
        const result = await invoke(handler, 'POST', body);
        assert.notEqual(result.status, 200, JSON.stringify(body));
        assert.equal(result.payload.error, expected);
    }
    assert.equal(written.length, 0);

    const unverified = harness({ users: [ADMIN, { ...TEACHER, emailVerified: false }] });
    const result = await invoke(unverified.handler, 'POST', { email: TEACHER.email, role: 'teacher' });
    assert.equal(result.payload.error, 'email_not_verified');
    assert.equal(unverified.written.length, 0);
});

test('a granted role records who granted it, so access is auditable', async () => {
    const { handler, written } = harness();
    const result = await invoke(handler, 'POST', { email: '  TEACHER@Tesaban6.AC.TH ', role: 'teacher' });
    assert.equal(result.status, 200);
    assert.equal(result.payload.email, TEACHER.email, 'อีเมลต้องถูกทำให้เป็นตัวพิมพ์เล็กและตัดช่องว่าง');
    assert.equal(written.length, 1);
    assert.equal(written[0].path, `roles/${TEACHER.uid}`);
    assert.equal(written[0].value.role, 'teacher');
    assert.equal(written[0].value.grantedBy, ADMIN.email, 'ต้องรู้ว่าใครเป็นคนให้สิทธิ์');
    assert.ok('grantedAt' in written[0].value);
});

// `student` ไม่ใช่บทบาทที่เก็บ มันคือค่าโดยปริยายของคนที่ไม่มีเอกสาร ⇒ ถอดสิทธิ์ = ลบเอกสาร
// ถ้าเขียนคำว่า student ลงไปแทน `roles` จะกลายเป็นรายชื่อทุกคนในโรงเรียนแทนที่จะเป็นรายชื่อคนมีสิทธิ์
test('revoking deletes the document instead of storing the word student', async () => {
    const { handler, written, deleted } = harness();
    const result = await invoke(handler, 'POST', { email: TEACHER.email, role: 'student' });
    assert.equal(result.status, 200);
    assert.deepEqual(deleted, [`roles/${TEACHER.uid}`]);
    assert.equal(written.length, 0);
});

// ถ้าถอดสิทธิ์ admin คนสุดท้ายได้ จะไม่เหลือใครตั้งสิทธิ์ให้ใครอีก — ต้องกลับไปแก้ `roles/` ด้วย Admin SDK เท่านั้น
test('an admin cannot demote themselves and lock everyone out', async () => {
    const { handler, written, deleted } = harness();
    for (const role of ['student', 'teacher']) {
        const result = await invoke(handler, 'POST', { email: ADMIN.email, role });
        assert.equal(result.status, 409, role);
        assert.equal(result.payload.error, 'cannot_demote_self');
    }
    assert.equal(written.length + deleted.length, 0);
    // ตั้งตัวเองเป็น admin ซ้ำยังทำได้ เพราะไม่ได้ลดสิทธิ์ใคร
    assert.equal((await invoke(handler, 'POST', { email: ADMIN.email, role: 'admin' })).status, 200);
});

test('the list names everyone who can reach the back office, sorted and without surprises', async () => {
    const { handler } = harness({ docs: {
        'u-teacher': { role: 'teacher', email: TEACHER.email, grantedBy: ADMIN.email },
        'u-admin': { role: 'admin', email: ADMIN.email, grantedBy: 'khai/admin-sdk' }
    } });
    const result = await invoke(handler, 'GET');
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.staff.map(p => p.email), [ADMIN.email, TEACHER.email]);
    assert.equal(result.payload.staff[1].grantedBy, ADMIN.email);
    assert.equal(result.payload.staff[0].grantedAt, null, 'เอกสารเก่าที่ไม่มี timestamp ต้องไม่ทำให้พัง');
});
