import { firebaseEnvironment, firebaseServices } from '../lib/firebase-admin.js';
if (!firebaseEnvironment().emulator) throw new Error('This helper only runs against local demo emulators.');
const [email, role] = process.argv.slice(2);
if (!/^[^@\s]+@tesaban6\.ac\.th$/.test(email || '') || !['student', 'nurse', 'teacher', 'admin'].includes(role)) {
    throw new Error('Usage: emulator-role.mjs synthetic-user@tesaban6.ac.th student|nurse|teacher|admin');
}
const { auth, db } = firebaseServices();
const user = await auth.getUserByEmail(email);
const doc = db.doc(`roles/${user.uid}`);
if (role === 'student') await doc.delete();
else await doc.set({ role });
console.log(`Synthetic emulator role set to ${role}; refresh the browser.`);
