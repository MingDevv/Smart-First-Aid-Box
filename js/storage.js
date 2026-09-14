// Compatibility surface for guide pages. Shared application data belongs to the server
// and physical journal; legacy browser records and settings are deliberately ignored.
const StorageService = {
    getCurrentStudent() {
        const user = window.AuthService?.state?.user;
        return user ? { uid: user.uid, name: user.name || user.email, class: '', allergies: [] } : null;
    },
    getStudents() { return []; },
    loginStudent() { return { success: false, error: 'Use school Google sign-in.' }; },
    logoutStudent() { return window.AuthService?.signOut(); },
    getHistory() { return []; },
    addHistoryEntry() { return { success: false, error: 'Physical events are recorded by the cabinet.' }; },
    getMedicines() { return []; },
    getSettings() {
        try {
            const prefs = JSON.parse(localStorage.getItem('sfab_ui_preferences') || '{}');
            return { largeText: prefs.largeText === true };
        } catch { return { largeText: false }; }
    },
    saveSettings(prefs) {
        localStorage.setItem('sfab_ui_preferences', JSON.stringify({ largeText: prefs.largeText === true }));
    },
    modeSource() { return window.SFAB_RUNTIME?.transport === 'pi-local' ? 'device' : 'server'; },
    getOperatingMode() {
        const mode = window.SFAB_RUNTIME?.mode;
        return window.SFAB_RUNTIME?.transport === 'pi-local' && ['demo', 'real', 'unset'].includes(mode) ? mode : 'unset';
    }
};
window.StorageService = StorageService;
