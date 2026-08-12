// JS/NOTIFICATION.JS
const NotificationService = {
    // Show a beautiful, floating toast notification
    showToast(message, type = 'info') {
        // Create container if it doesn't exist
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.position = 'fixed';
            container.style.bottom = '20px';
            container.style.left = '50%';
            container.style.transform = 'translateX(-50%)';
            container.style.zIndex = '9999';
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = '10px';
            container.style.width = '90%';
            container.style.maxWidth = '360px';
            document.body.appendChild(container);
        }

        // Create toast element
        const toast = document.createElement('div');
        toast.style.padding = '12px 16px';
        toast.style.borderRadius = '8px';
        toast.style.fontSize = '14px';
        toast.style.fontWeight = '500';
        toast.style.color = '#FFFFFF';
        toast.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)';
        toast.style.display = 'flex';
        toast.style.alignItems = 'center';
        toast.style.gap = '8px';
        toast.style.animation = 'slideUpToast 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards';
        toast.style.fontFamily = 'Sarabun, sans-serif';

        // Add CSS keyframes dynamically if not present
        if (!document.getElementById('toast-animation-style')) {
            const style = document.createElement('style');
            style.id = 'toast-animation-style';
            style.innerHTML = `
                @keyframes slideUpToast {
                    from { transform: translateY(20px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                @keyframes fadeOutToast {
                    from { opacity: 1; }
                    to { opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        // Color theme mapping
        let icon = 'ℹ️';
        if (type === 'success') {
            toast.style.backgroundColor = '#059669'; // success (Emerald)
            icon = '✅';
        } else if (type === 'danger') {
            toast.style.backgroundColor = '#DC2626'; // danger (Crimson)
            icon = '🚨';
        } else if (type === 'warning') {
            toast.style.backgroundColor = '#D97706'; // warning (Amber)
            icon = '⚠️';
        } else {
            toast.style.backgroundColor = '#1E3A8A'; // info (Navy)
        }

        toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
        container.appendChild(toast);

        // Auto remove toast
        setTimeout(() => {
            toast.style.animation = 'fadeOutToast 0.3s ease-out forwards';
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 3000);
    },

    // Send LINE Notification (or simulate if token is empty)
    async sendLineNotification(message) {
        // 1. Try Vercel Serverless Function first (Most Secure — Token hidden on Server & Logs visible in Vercel)
        try {
            const serverlessResponse = await fetch('/api/notify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });

            if (serverlessResponse.ok) {
                const serverlessResult = await serverlessResponse.json();
                if (serverlessResult.success) {
                    console.log('[LINE Notify] Sent securely via Vercel Serverless Function!');
                    return serverlessResult;
                }
            }
        } catch (serverlessError) {
            console.log('[LINE Notify] Serverless endpoint not active, checking local storage settings...');
        }

        // 2. Client-side fallback if serverless endpoint is not configured
        let settings = { lineToken: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        // If no token configured, run in simulation mode
        if (!settings.lineToken || settings.lineToken.trim() === '') {
            console.log('[LINE Notify Simulation] Sending message:', message);
            
            // Create a notification preview modal
            this.showLineMockModal(message);

            return { success: true, mode: 'simulation' };
        }

        // If token exists, attempt to send
        try {
            const response = await fetch('https://cors-anywhere.herokuapp.com/https://notify-api.line.me/api/notify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Bearer ${settings.lineToken.trim()}`
                },
                body: new URLSearchParams({ message: message })
            });

            if (response.ok) {
                return { success: true, mode: 'production' };
            } else {
                console.error(`[LINE Notify Error] Response status: ${response.status}`);
                return { success: false, mode: 'production', error: `ส่ง LINE ไม่สำเร็จ (HTTP ${response.status})` };
            }
        } catch (error) {
            console.error('[LINE Notify Error] Error sending LINE Notification:', error);
            return { success: false, mode: 'error', error: 'ไม่สามารถส่งข้อความแจ้งเตือนผ่าน LINE ได้: ' + error.message };
        }
    },

    // Display a beautiful LINE notification simulation overlay
    showLineMockModal(message) {
        const modal = document.createElement('div');
        modal.style.position = 'fixed';
        modal.style.top = '20px';
        modal.style.right = '20px';
        modal.style.backgroundColor = '#25D366'; // LINE Green
        modal.style.color = '#FFFFFF';
        modal.style.padding = '16px';
        modal.style.borderRadius = '12px';
        modal.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
        modal.style.width = '320px';
        modal.style.zIndex = '10000';
        modal.style.fontFamily = 'Sarabun, Prompt, sans-serif';
        modal.style.border = '1px solid #1fa851';
        modal.style.animation = 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards';

        if (!document.getElementById('line-animation-style')) {
            const style = document.createElement('style');
            style.id = 'line-animation-style';
            style.innerHTML = `
                @keyframes slideInRight {
                    from { transform: translateX(110%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOutRight {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(110%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        modal.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:6px;">
                <span style="font-size:20px;">💬</span>
                <strong style="font-size:14px; font-weight:600;">LINE Notify (จำลอง)</strong>
                <span style="margin-left:auto; font-size:11px; opacity:0.8;">เมื่อสักครู่</span>
            </div>
            <div style="font-size:13px; line-height:1.4; white-space: pre-wrap;">${message}</div>
            <button onclick="this.parentElement.remove()" style="margin-top:10px; width:100%; padding:6px; background:rgba(255,255,255,0.2); border:none; border-radius:4px; color:white; font-size:12px; font-weight:600; cursor:pointer; font-family:Prompt;">ปิดการแสดงจำลอง</button>
        `;

        document.body.appendChild(modal);

        // Auto remove after 8 seconds
        setTimeout(() => {
            if (modal.parentElement) {
                modal.style.animation = 'slideOutRight 0.3s ease-in forwards';
                setTimeout(() => {
                    modal.remove();
                }, 300);
            }
        }, 8000);
    }
};

window.NotificationService = NotificationService;
