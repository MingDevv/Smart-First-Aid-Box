// JS/NOTIFICATION.JS
const NotificationService = {
    // Helper function to escape HTML special characters to prevent XSS (SEC-01, SEC-02)
    escapeHtml(str) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    },

    // Show a beautiful, floating toast notification
    showToast(message, type = 'info') {
        const safeMessage = this.escapeHtml(String(message));
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

        toast.innerHTML = `<span>${icon}</span> <span>${safeMessage}</span>`;
        container.appendChild(toast);

        // Auto remove toast
        setTimeout(() => {
            toast.style.animation = 'fadeOutToast 0.3s ease-out forwards';
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 3000);
    },

    // Send LINE Notification (supports plain text string OR Flex Message payload object)
    async sendLineNotification(payload) {
        let requestBody = {};
        if (typeof payload === 'string') {
            requestBody = { message: payload };
        } else if (payload && (payload.flexMessage || payload.type === 'flex' || payload.contents)) {
            const flexObj = payload.flexMessage || (payload.type === 'flex' ? payload : { type: 'flex', altText: payload.altText || 'การแจ้งเตือน Smart First Aid Box', contents: payload.contents || payload });
            requestBody = {
                flexMessage: flexObj,
                message: flexObj.altText || 'การแจ้งเตือน Smart First Aid Box'
            };
        } else {
            requestBody = { message: JSON.stringify(payload) };
        }

        try {
            const serverlessResponse = await fetch('/api/notify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (serverlessResponse.ok) {
                const serverlessResult = await serverlessResponse.json();
                if (serverlessResult.success) {
                    console.log('[LINE Notify] Sent securely via Vercel Serverless Function!');
                    return serverlessResult;
                }
            } else {
                const errJson = await serverlessResponse.json().catch(() => ({}));
                console.warn('[LINE Notify] Serverless notification error:', errJson.error);
            }
        } catch (serverlessError) {
            console.log('[LINE Notify] Backend endpoint inactive/offline, running in local simulation mode...');
        }

        // Simulation overlay when offline or backend not active
        this.showLineMockModal(requestBody.flexMessage || requestBody.message || payload);
        return { success: true, mode: 'simulation' };
    },

    // Builder: SOS Emergency Flex Message (Clean, High Contrast, Prominent Student Profile)
    buildSosFlexMessage(studentName, timeStr) {
        const timeVal = timeStr || new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        return {
            type: 'flex',
            altText: `🚨 [SOS ฉุกเฉิน!] ขอความช่วยเหลือ: ${studentName}`,
            contents: {
                type: 'bubble',
                size: 'mega',
                header: {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#DC2626',
                    paddingAll: '18px',
                    contents: [
                        {
                            type: 'box',
                            layout: 'baseline',
                            contents: [
                                { type: 'text', text: '🚨 SOS EMERGENCY', weight: 'bold', color: '#FEE2E2', size: 'xs', flex: 0 },
                                { type: 'text', text: `${timeVal} น.`, color: '#FECACA', size: 'xs', align: 'end' }
                            ]
                        },
                        { type: 'text', text: 'ขอความช่วยเหลือฉุกเฉิน!', weight: 'bold', color: '#FFFFFF', size: 'xl', margin: 'xs' }
                    ]
                },
                body: {
                    type: 'box',
                    layout: 'vertical',
                    paddingAll: '18px',
                    spacing: 'md',
                    contents: [
                        // Prominent Student Identification Card
                        {
                            type: 'box',
                            layout: 'vertical',
                            backgroundColor: '#FEF2F2',
                            paddingAll: '14px',
                            cornerRadius: '10px',
                            borderColor: '#FCA5A5',
                            borderWidth: '1px',
                            contents: [
                                { type: 'text', text: '👤 ผู้ขอความช่วยเหลือ (นักเรียน)', size: 'xs', color: '#991B1B', weight: 'bold' },
                                { type: 'text', text: studentName || 'นักเรียนทั่วไป', size: 'lg', color: '#7F1D1D', weight: 'bold', margin: 'xs', wrap: true }
                            ]
                        },
                        {
                            type: 'box',
                            layout: 'vertical',
                            spacing: 'sm',
                            margin: 'md',
                            contents: [
                                {
                                    type: 'box',
                                    layout: 'baseline',
                                    contents: [
                                        { type: 'text', text: '📍 จุดเกิดเหตุ:', color: '#64748B', size: 'xs', flex: 2 },
                                        { type: 'text', text: 'ตู้ปฐมพยาบาล (Smart First Aid Box)', color: '#1E293B', weight: 'bold', size: 'xs', flex: 5, wrap: true }
                                    ]
                                },
                                {
                                    type: 'box',
                                    layout: 'baseline',
                                    contents: [
                                        { type: 'text', text: '⚡ สถานะ:', color: '#64748B', size: 'xs', flex: 2 },
                                        { type: 'text', text: 'กดปุ่ม SOS ฉุกเฉินที่ตู้', color: '#DC2626', weight: 'bold', size: 'xs', flex: 5 }
                                    ]
                                }
                            ]
                        }
                    ]
                },
                footer: {
                    type: 'box',
                    layout: 'vertical',
                    paddingAll: '14px',
                    contents: [
                        {
                            type: 'button',
                            style: 'primary',
                            color: '#DC2626',
                            action: { type: 'uri', label: '🚨 เข้าช่วยเหลือทันที', uri: 'https://line.me' }
                        }
                    ]
                }
            }
        };
    },

    // Builder: First Aid Usage Flex Message (Clean, Clean Layout, Prominent Student Profile)
    buildFirstAidFlexMessage({ studentId, name, studentClass, woundNameTh, woundNameEn, items, method, timeStr }) {
        const timeVal = timeStr || new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        const itemsStr = Array.isArray(items) ? items.join(', ') : (items || 'ชุดทำแผลเบื้องต้น');
        const displayStudentName = name || 'นักเรียนทั่วไป';
        const displayClass = studentClass ? `ชั้น ${studentClass}` : '';
        const displayId = studentId ? `รหัสประจำตัว: ${studentId}` : '';

        return {
            type: 'flex',
            altText: `🏥 [เบิกเวชภัณฑ์] ${displayStudentName} (${displayClass})`,
            contents: {
                type: 'bubble',
                size: 'mega',
                header: {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#059669',
                    paddingAll: '18px',
                    contents: [
                        {
                            type: 'box',
                            layout: 'baseline',
                            contents: [
                                { type: 'text', text: '🏥 SMART FIRST AID BOX', weight: 'bold', color: '#A7F3D0', size: 'xs', flex: 0 },
                                { type: 'text', text: `${timeVal} น.`, color: '#D1FAE5', size: 'xs', align: 'end' }
                            ]
                        },
                        { type: 'text', text: 'รายงานการเบิกเวชภัณฑ์', weight: 'bold', color: '#FFFFFF', size: 'lg', margin: 'xs' }
                    ]
                },
                body: {
                    type: 'box',
                    layout: 'vertical',
                    paddingAll: '18px',
                    spacing: 'md',
                    contents: [
                        // Clear Student Profile Header Card
                        {
                            type: 'box',
                            layout: 'vertical',
                            backgroundColor: '#ECFDF5',
                            paddingAll: '14px',
                            cornerRadius: '10px',
                            borderColor: '#A7F3D0',
                            borderWidth: '1px',
                            contents: [
                                { type: 'text', text: '👤 ผู้ใช้บริการตู้ปฐมพยาบาล', size: 'xs', color: '#047857', weight: 'bold' },
                                { type: 'text', text: displayStudentName, size: 'md', color: '#064E3B', weight: 'bold', margin: 'xs' },
                                {
                                    type: 'box',
                                    layout: 'baseline',
                                    margin: 'xs',
                                    contents: [
                                        { type: 'text', text: displayClass, size: 'xs', color: '#059669', weight: 'bold', flex: 0 },
                                        { type: 'text', text: displayId ? ` | ${displayId}` : '', size: 'xs', color: '#047857', flex: 0 }
                                    ]
                                }
                            ]
                        },
                        // Separator line
                        { type: 'separator', margin: 'md', color: '#E2E8F0' },
                        // Clean Medical Details Section
                        {
                            type: 'box',
                            layout: 'vertical',
                            spacing: 'sm',
                            margin: 'md',
                            contents: [
                                {
                                    type: 'box',
                                    layout: 'baseline',
                                    contents: [
                                        { type: 'text', text: '🩹 บาดแผล:', color: '#64748B', size: 'xs', flex: 2 },
                                        { type: 'text', text: `${woundNameTh || 'แผลทั่วไป'} ${woundNameEn ? '(' + woundNameEn + ')' : ''}`, weight: 'bold', color: '#1E293B', size: 'xs', flex: 5, wrap: true }
                                    ]
                                },
                                {
                                    type: 'box',
                                    layout: 'baseline',
                                    contents: [
                                        { type: 'text', text: '💊 ยาที่เบิก:', color: '#64748B', size: 'xs', flex: 2 },
                                        { type: 'text', text: itemsStr, color: '#059669', weight: 'bold', size: 'xs', flex: 5, wrap: true }
                                    ]
                                },
                                {
                                    type: 'box',
                                    layout: 'baseline',
                                    contents: [
                                        { type: 'text', text: '🔍 วิธีเลือก:', color: '#64748B', size: 'xs', flex: 2 },
                                        { type: 'text', text: method || 'เลือกรายการเอง', color: '#334155', size: 'xs', flex: 5 }
                                    ]
                                }
                            ]
                        }
                    ]
                },
                footer: {
                    type: 'box',
                    layout: 'vertical',
                    paddingAll: '14px',
                    contents: [
                        {
                            type: 'button',
                            style: 'secondary',
                            action: { type: 'uri', label: '📋 ดูประวัติพยาบาลโรงเรียน', uri: 'https://line.me' }
                        }
                    ]
                }
            }
        };
    },

    // Display a clean, highly readable LINE notification simulation overlay
    showLineMockModal(payload) {
        const modal = document.createElement('div');
        modal.style.position = 'fixed';
        modal.style.top = '20px';
        modal.style.right = '20px';
        modal.style.backgroundColor = '#0F172A'; // Deep Slate background
        modal.style.color = '#FFFFFF';
        modal.style.padding = '0';
        modal.style.borderRadius = '16px';
        modal.style.boxShadow = '0 25px 40px -10px rgba(0,0,0,0.4), 0 10px 15px -5px rgba(0,0,0,0.2)';
        modal.style.width = '350px';
        modal.style.zIndex = '10000';
        modal.style.fontFamily = 'Sarabun, Prompt, sans-serif';
        modal.style.border = '1px solid rgba(255,255,255,0.15)';
        modal.style.overflow = 'hidden';
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

        let innerContentHtml = '';

        // Check if payload is LINE Flex Message format
        if (typeof payload === 'object' && payload !== null && (payload.contents || payload.type === 'flex')) {
            const bubble = payload.contents?.type === 'bubble' ? payload.contents : payload;
            const header = bubble.header || {};
            const headerBg = header.backgroundColor || '#059669';
            const headerTexts = header.contents || [];
            
            let headerTag = 'LINE FLEX MESSAGE';
            let headerTitleText = 'แจ้งเตือนระบบ';
            let headerTimeText = 'เมื่อสักครู่';

            if (headerTexts.length > 0) {
                if (headerTexts[0].type === 'box') {
                    const topRow = headerTexts[0].contents || [];
                    headerTag = topRow[0]?.text || headerTag;
                    headerTimeText = topRow[1]?.text || headerTimeText;
                    headerTitleText = headerTexts[1]?.text || headerTitleText;
                } else {
                    headerTitleText = headerTexts.map(t => this.escapeHtml(t.text)).join(' ');
                }
            }

            // Parse body contents with clean highlights
            let bodyContentBlocks = '';
            const bodyContents = bubble.body?.contents || [];
            bodyContents.forEach(item => {
                if (item.type === 'box' && item.backgroundColor) {
                    // Highlight Profile Box
                    const texts = item.contents || [];
                    const tagLabel = this.escapeHtml(texts[0]?.text || '');
                    const nameText = this.escapeHtml(texts[1]?.text || '');
                    let extraText = '';
                    if (texts[2]?.type === 'box') {
                        extraText = (texts[2].contents || []).map(t => this.escapeHtml(t.text)).join('');
                    } else if (texts[2]?.text) {
                        extraText = this.escapeHtml(texts[2].text);
                    }

                    bodyContentBlocks += `
                        <div style="background:${item.backgroundColor}; border:1px solid ${item.borderColor || 'transparent'}; padding:12px 14px; border-radius:10px; margin-bottom:12px;">
                            <div style="font-size:11px; font-weight:700; color:${texts[0]?.color || '#047857'}; text-transform:uppercase; letter-spacing:0.5px;">${tagLabel}</div>
                            <div style="font-size:16px; font-weight:700; color:${texts[1]?.color || '#064E3B'}; margin-top:2px;">${nameText}</div>
                            ${extraText ? `<div style="font-size:12px; color:${texts[0]?.color || '#059669'}; margin-top:3px; font-weight:500;">${extraText}</div>` : ''}
                        </div>
                    `;
                } else if (item.type === 'box' && item.layout === 'vertical' && item.contents) {
                    // Key-Value rows group
                    item.contents.forEach(row => {
                        if (row.type === 'box' && row.layout === 'baseline') {
                            const label = this.escapeHtml(row.contents[0]?.text || '');
                            const value = this.escapeHtml(row.contents[1]?.text || '');
                            const valColor = row.contents[1]?.color || '#1E293B';
                            const valWeight = row.contents[1]?.weight === 'bold' ? '700' : '500';
                            bodyContentBlocks += `
                                <div style="display:flex; align-items:flex-start; margin-bottom:8px; font-size:13px; line-height:1.4;">
                                    <span style="color:#64748B; min-width:85px; font-size:12px; padding-top:1px;">${label}</span>
                                    <span style="color:${valColor}; font-weight:${valWeight}; flex:1; word-break:break-word;">${value}</span>
                                </div>
                            `;
                        }
                    });
                } else if (item.type === 'separator') {
                    bodyContentBlocks += `<hr style="border:0; border-top:1px solid #E2E8F0; margin:12px 0;">`;
                }
            });

            // Action button
            const footerBtn = bubble.footer?.contents?.[0];
            const btnLabel = this.escapeHtml(footerBtn?.action?.label || 'ตรวจสอบข้อมูล');
            const btnBg = footerBtn?.color || headerBg;

            innerContentHtml = `
                <div style="background:${headerBg}; padding:16px; color:white;">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
                        <span style="background:rgba(255,255,255,0.22); padding:2px 8px; border-radius:12px; font-size:10px; font-weight:700; letter-spacing:0.5px;">${this.escapeHtml(headerTag)}</span>
                        <span style="font-size:11px; opacity:0.85;">${this.escapeHtml(headerTimeText)}</span>
                    </div>
                    <div style="font-weight:700; font-size:17px; margin-top:2px;">${this.escapeHtml(headerTitleText)}</div>
                </div>
                <div style="padding:16px; background:#FFFFFF; color:#1E293B;">
                    ${bodyContentBlocks}
                    <button style="width:100%; margin-top:10px; padding:10px; background:${btnBg}; color:white; border:none; border-radius:8px; font-weight:600; font-size:13px; cursor:pointer; font-family:Prompt; transition:opacity 0.2s;">
                        ${btnLabel}
                    </button>
                </div>
            `;
        } else {
            // Text Message Fallback
            const safeMsg = this.escapeHtml(typeof payload === 'string' ? payload : JSON.stringify(payload));
            innerContentHtml = `
                <div style="background:#06C755; padding:14px 16px; color:white; display:flex; align-items:center; gap:8px;">
                    <span style="font-size:18px;">💬</span>
                    <strong style="font-size:14px; font-weight:600;">LINE Notification (จำลอง)</strong>
                    <span style="margin-left:auto; font-size:11px; opacity:0.85;">เมื่อสักครู่</span>
                </div>
                <div style="padding:16px; background:#FFFFFF; color:#1E293B; font-size:13px; line-height:1.5; white-space:pre-wrap;">${safeMsg}</div>
            `;
        }

        modal.innerHTML = `
            ${innerContentHtml}
            <div style="background:#0F172A; padding:10px 14px; display:flex; align-items:center; justify-content:space-between; border-top:1px solid rgba(255,255,255,0.1);">
                <span style="font-size:11px; color:#94A3B8;">✨ LINE Flex Message (ดูง่าย เด่นชัด)</span>
                <button onclick="this.parentElement.parentElement.remove()" style="background:rgba(255,255,255,0.15); border:none; border-radius:6px; color:#F8FAFC; padding:4px 12px; font-size:11px; cursor:pointer; font-family:Prompt; font-weight:500;">ปิด</button>
            </div>
        `;

        document.body.appendChild(modal);

        // Auto remove after 12 seconds
        setTimeout(() => {
            if (modal.parentElement) {
                modal.style.animation = 'slideOutRight 0.3s ease-in forwards';
                setTimeout(() => {
                    modal.remove();
                }, 300);
            }
        }, 12000);
    }
};

window.NotificationService = NotificationService;
