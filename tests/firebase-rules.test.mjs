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
        for (const [id,role] of [['rules-nurse','nurse'],['rules-admin','admin'],['rules-teacher','teacher'],['rules-invalid','owner']]) {
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

test('clinical access is role + verified exact school domain, for get and list',async()=>{
    for(const uid of ['rules-nurse','rules-admin']) {
        const db=client(uid).firestore();
        await assertSucceeds(getDoc(doc(db,'students','rules-student')));
        await assertSucceeds(getDocs(collection(db,'students')));
        await assertSucceeds(getDocs(collection(db,'dispenses')));
    }
    const contexts=[env.unauthenticatedContext(),client('rules-teacher'),client('rules-invalid'),
        client('rules-nurse',{email_verified:false}),client('rules-nurse',{email:'nurse@elsewhere.test'}),
        client('rules-admin',{email:'nurse@tesaban6.ac.th.evil.test'})];
    for(const ctx of contexts) {
        await assertFails(getDoc(doc(ctx.firestore(),'students','rules-student')));
        await assertFails(getDocs(collection(ctx.firestore(),'students')));
    }
});

test('every client role is denied writes to server-owned data and unknown paths',async()=>{
    for(const uid of ['rules-student','rules-nurse','rules-admin','rules-teacher']) {
        const db=client(uid).firestore();
        for(const path of ['roles/'+uid,'students/'+uid,'dispenses/new-event','sos/new-event','inventory/box1','cabinets/box1','badges/badge','keys/key','revocations/rev','sessions/session','photos/rules-photo','unknown/document']) {
            await assertFails(setDoc(doc(db,path),{role:'admin',uid}));
        }
        await assertFails(updateDoc(doc(db,'roles','rules-nurse'),{role:'admin'}));
        await assertFails(deleteDoc(doc(db,'students','rules-student')));
        await assertFails(getDoc(doc(db,'unknown','document')));
    }
});

test('Firestore evidence photos require verified nurse/admin access for get and list', async()=>{
    for(const uid of ['rules-nurse','rules-admin']) {
        const db=client(uid).firestore();
        await assertSucceeds(getDoc(doc(db,'photos','rules-photo')));
        await assertSucceeds(getDocs(collection(db,'photos')));
    }
    for(const ctx of [env.unauthenticatedContext(),client('rules-student'),client('rules-teacher'),
        client('rules-nurse',{email_verified:false}),client('rules-nurse',{email:'x@other.test'})]) {
        await assertFails(getDoc(doc(ctx.firestore(),'photos','rules-photo')));
        await assertFails(getDocs(collection(ctx.firestore(),'photos')));
    }
});
