// JS/MQTT-BRIDGE.JS — ทางขาขึ้น: ฟังสถานะและเหตุการณ์จากตู้ยาแบบเรียลไทม์
//
// ทำไมต้องแยกไฟล์กับ api-bridge.js:
//   ขาลง (สั่งเปิดลิ้นชัก) วิ่งผ่าน /api/command บนเซิร์ฟเวอร์ เพราะรหัสที่ publish ได้
//   ต้องไม่หลุดออกมาอยู่ในเบราว์เซอร์ ส่วนไฟล์นี้ทำหน้าที่ "ฟัง" อย่างเดียว
//   รหัสที่ใส่ในนี้จึงตั้งสิทธิ์บน broker ให้ subscribe ได้เท่านั้น
//   ถ้าหลุด คนที่ได้ไปจะแอบดูได้ แต่สั่งเปิดตู้ยาไม่ได้
//
// ใช้ mqtt.js ผ่าน CDN (ตัวแปร global ชื่อ mqtt) — ต้องเป็น wss:// เท่านั้น
// เพราะหน้าเว็บเสิร์ฟด้วย https ถ้าใช้ ws:// เบราว์เซอร์จะบล็อกแบบเดียวกับ http://
const MqttBridge = {
    client: null,
    lastStatus: { online: false, receivedAt: 0, payload: null },
    eventHandlers: [],
    statusHandlers: [],

    getConfig() {
        const settings = window.StorageService ? window.StorageService.getSettings() : {};
        return {
            wsUrl: (settings.mqttWsUrl || '').trim(),
            username: (settings.mqttUsername || '').trim(),
            password: (settings.mqttPassword || '').trim(),
            baseTopic: (settings.mqttBaseTopic || 'crms6/firstaidbox/box1').trim().replace(/\/+$/, '')
        };
    },

    isConfigured() {
        return this.getConfig().wsUrl !== '';
    },

    // สถานะที่เชื่อถือได้ต้องครบสองอย่าง: เราต่อ broker อยู่ และ broker บอกว่ากล่องออนไลน์
    // ถ้าเราหลุดจาก broker เราไม่รู้อะไรเลยเกี่ยวกับกล่อง จึงต้องถือว่าออฟไลน์ ไม่ใช่ค้างค่าเดิมไว้
    isOnline() {
        return !!(this.client && this.client.connected && this.lastStatus.online);
    },

    onEvent(handler) {
        if (typeof handler === 'function') this.eventHandlers.push(handler);
    },

    onStatus(handler) {
        if (typeof handler === 'function') this.statusHandlers.push(handler);
    },

    connect() {
        if (this.client) return this.client;
        if (!this.isConfigured()) {
            console.log('[MqttBridge] ยังไม่ได้ตั้งค่า MQTT WebSocket URL — ข้ามการเชื่อมต่อ');
            return null;
        }
        if (typeof mqtt === 'undefined') {
            console.warn('[MqttBridge] ไม่พบไลบรารี mqtt.js (ตรวจสอบ <script> CDN ในหน้านี้)');
            return null;
        }

        const cfg = this.getConfig();

        this.client = mqtt.connect(cfg.wsUrl, {
            username: cfg.username || undefined,
            password: cfg.password || undefined,
            // clientId ต้องไม่ซ้ำกัน ถ้าซ้ำ broker จะเตะตัวเก่าออกทุกครั้งที่ตัวใหม่ต่อเข้ามา
            // เปิดสองแท็บแล้วจะเห็นอาการต่อ ๆ หลุด ๆ วนไม่จบ
            clientId: 'sfab-web-' + Math.random().toString(16).slice(2, 10),
            clean: true,
            reconnectPeriod: 5000,
            connectTimeout: 8000
        });

        this.client.on('connect', () => {
            console.log('[MqttBridge] เชื่อมต่อ broker สำเร็จ');
            this.client.subscribe([`${cfg.baseTopic}/status`, `${cfg.baseTopic}/evt`], { qos: 1 }, (err) => {
                if (err) console.error('[MqttBridge] subscribe ไม่สำเร็จ:', err.message);
            });
        });

        this.client.on('message', (topic, payload) => {
            let data;
            try {
                data = JSON.parse(payload.toString());
            } catch (e) {
                console.warn('[MqttBridge] ข้อความไม่ใช่ JSON:', payload.toString());
                return;
            }

            if (topic === `${cfg.baseTopic}/status`) {
                this.lastStatus = { online: data.online === true, receivedAt: Date.now(), payload: data };
                this.statusHandlers.forEach(h => h(this.lastStatus));
            } else if (topic === `${cfg.baseTopic}/evt`) {
                this.eventHandlers.forEach(h => h(data));
            }
        });

        this.client.on('error', (err) => {
            console.error('[MqttBridge] error:', err.message);
        });

        this.client.on('close', () => {
            this.lastStatus = { online: false, receivedAt: Date.now(), payload: null };
            this.statusHandlers.forEach(h => h(this.lastStatus));
        });

        return this.client;
    },

    disconnect() {
        if (this.client) {
            this.client.end(true);
            this.client = null;
            this.lastStatus = { online: false, receivedAt: 0, payload: null };
        }
    }
};

// ข้อความภาษาไทยสำหรับ event ที่กล่องส่งขึ้นมา ใช้ร่วมกันทุกหน้า
MqttBridge.EVENT_LABELS = {
    door_open: 'ตู้ยาถูกเปิด',
    confirm_a: 'ผู้ใช้กดยืนยัน (ปุ่ม A)',
    cancel_b: 'ผู้ใช้กดยกเลิก (ปุ่ม B)',
    drawer_opened: 'ลิ้นชักเปิดสำเร็จ',
    cmd_rejected: 'ตู้ยาปฏิเสธคำสั่ง (คำสั่งเก่าเกินไป)',
    boot: 'บอร์ดควบคุมเริ่มทำงานใหม่'
};

window.MqttBridge = MqttBridge;
