import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, collection, query, where, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
let env;
const claims = (overrides = {}) => ({ email:'rules@tesaban6.ac.th',email_verified:true,...overrides });
const client = (uid, overrides) => env.authenticatedContext(uid, claims(overrides));
before(async () => {
    env=await initializeTestEnvironment({projectId:'demo-sfab',
        firestore:{host:'127.0.0.1',port:8080,rules:await readFile('firestore.rules','utf8')}});
    await env.withSecurityRulesDisabled(async ctx => {
        const db=ctx.firestore();
        // `rules-retired` ถือค่า 'nurse' ที่ยังค้างอยู่ในเอกสารเก่า — หลัง 2026-09-14 มันต้องไม่ใช่ staff อีกต่อไป
        for (const [id,role] of [['rules-retired','nurse'],['rules-admin','admin'],['rules-teacher','teacher'],['rules-invalid','owner']]) {
            await setDoc(doc(db,'roles',id),{role});
        }
        await setDoc(doc(db,'students','rules-student'),{active:true,allergyFlags:{drawer2:true},studentNo:'private'});
        for(const uid of ['rules-student','rules-other']) await setDoc(doc(db,'dispenses',uid),{uid,drawer:1});
        await setDoc(doc(db,'inventory','box1'),{counts:{drawer1:1}});
        await setDoc(doc(db,'photos','rules-photo'),{jpegBase64:'AQID',expiresAt:new Date(Date.now()+86400000)});
    });
});
after(async()=>env?.cleanup());

test('students can get/query own events, never others or unfiltered lists', async()=>{
    const db=client('rules-student').firestore();
    await assertSucceeds(getDoc(doc(db,'dispenses','rules-student')));
    await assertSucceeds(getDocs(query(collection(db,'dispenses'),where('uid','==','rules-student'))));
    await assertFails(getDoc(doc(db,'dispenses','rules-other')));
    await assertFails(getDocs(collection(db,'dispenses')));
    await assertFails(getDocs(query(collection(db,'dispenses'),where('uid','==','rules-other'))));
    await assertFails(getDoc(doc(db,'students','rules-student')));
    await assertFails(getDoc(doc(db,'roles','rules-student')));
    await assertFails(getDocs(collection(db,'roles')));
    await assertFails(getDoc(doc(db,'inventory','box1')));
});

test('all staff share history and inventory visibility, while student payloads stay server-only',async()=>{
    for(const uid of ['rules-admin','rules-teacher']) {
        const db=client(uid).firestore();
        await assertFails(getDoc(doc(db,'students','rules-student')));
        await assertFails(getDocs(collection(db,'students')));
        await assertSucceeds(getDocs(collection(db,'dispenses')));
        await assertSucceeds(getDoc(doc(db,'inventory','box1')));
        await assertSucceeds(getDocs(collection(db,'inventory')));
        await assertSucceeds(getDocs(collection(db,'sos')));
    }
    // `rules-retired` อยู่ในรายการนี้โดยตั้งใจ: เอกสารที่ยังเขียนว่า nurse ต้องอ่านอะไรไม่ได้เลย
    // ไม่ใช่ค้างสิทธิ์เดิมไว้เงียบๆ — นี่คือเส้นที่ทำให้การยกเลิกบทบาทมีผลจริง ไม่ใช่แค่เปลี่ยนคำในโค้ด
    const contexts=[env.unauthenticatedContext(),client('rules-invalid'),client('rules-retired'),
        client('rules-teacher',{email_verified:false}),client('rules-teacher',{email:'teacher@elsewhere.test'}),
        client('rules-admin',{email:'teacher@tesaban6.ac.th.evil.test'})];
    for(const ctx of contexts) {
        await assertFails(getDocs(collection(ctx.firestore(),'inventory')));
        await assertFails(getDocs(collection(ctx.firestore(),'dispenses')));
    }
});

test('every client role is denied writes to server-owned data and unknown paths',async()=>{
    for(const uid of ['rules-student','rules-retired','rules-admin','rules-teacher']) {
        const db=client(uid).firestore();
        for(const path of ['roles/'+uid,'students/'+uid,'dispenses/new-event','sos/new-event','inventory/box1','cabinets/box1','badges/badge','keys/key','revocations/rev','sessions/session','photos/rules-photo','unknown/document']) {
            await assertFails(setDoc(doc(db,path),{role:'admin',uid}));
        }
        await assertFails(updateDoc(doc(db,'roles','rules-retired'),{role:'admin'}));
        await assertFails(deleteDoc(doc(db,'students','rules-student')));
        await assertFails(getDoc(doc(db,'unknown','document')));
    }
});

test('student and photo documents cannot be read directly by any client role', async()=>{
    for(const ctx of [env.unauthenticatedContext(),client('rules-student'),client('rules-teacher'),
        client('rules-retired'),client('rules-admin'),client('rules-teacher',{email_verified:false})]) {
        for(const [collectionName,id] of [['photos','rules-photo'],['students','rules-student']]) {
            await assertFails(getDoc(doc(ctx.firestore(),collectionName,id)));
            await assertFails(getDocs(collection(ctx.firestore(),collectionName)));
        }
    }
});
