"""Execute the actual MicroPython firmware functions with hardware stubs (no motor attached).

Rewritten 2026-09-12 for the USB/MicroPython firmware. Same seven behaviours the MakeCode
version pinned, plus the two things that changed: serial is USB (nothing redirected to edge
pins) and the buzzer lives on P16, not P0.
"""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'microbit/main.py'


class Pin:
    def __init__(self, name, events):
        self.name = name
        self.events = events
    def write_digital(self, value):
        self.events.append(('pin', self.name, value))


def load(*, busy=False, epoch=7, radio_inbox=None):
    tree = ast.parse(SOURCE.read_text())
    functions = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef)], type_ignores=[])
    events = []
    chunks = []
    inbox = list(radio_inbox or [])
    pins = {n: Pin(n, events) for n in ('p0', 'p1', 'p2', 'p8', 'p12', 'p13', 'p14', 'p15')}
    ns = dict(
        uart=SimpleNamespace(write=lambda s: events.append(s.strip()) if isinstance(s, str) else events.append(s),
                             read=lambda n: chunks.pop(0) if chunks else None),
        music=SimpleNamespace(pitch=lambda *a, **k: events.append('sound-on'),
                              stop=lambda *a, **k: events.append('sound-off')),
        display=SimpleNamespace(show=lambda _: None),
        Image=SimpleNamespace(ARROW_S=1, ARROW_N=2, YES=3, SKULL=4),
        radio=SimpleNamespace(receive=lambda: inbox.pop(0) if inbox else None,
                              send=lambda m: events.append('radio:' + m)),
        running_time=lambda: 1000,
        sleep=lambda _: None,
        pin16=Pin('p16', events),
        RADIO_GROUP=91, RADIO_PREFIX='SFAB1:SOS:', last_sos_seq='',
        SOS_ACK='SFAB1:OK', BUZZ_ON='SFAB1:B1', BUZZ_OFF='SFAB1:B0', BEACON_MS=400, last_beacon=0,
        DISPENSE_STEPS=200, STEP_MS=5, HEARTBEAT_MS=500, BUZZ_MAX_MS=5000, buzz_until=0,
        ID_CHARS='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-',
        MOTORS={1: [pins['p12'], pins['p14'], pins['p13'], pins['p15']],
                2: [pins['p0'], pins['p2'], pins['p1'], pins['p8']]},
        busy=busy, ready_epoch=epoch, last_heartbeat=0, line=b'', overflow=False,
    )
    exec(compile(functions, str(SOURCE), 'exec'), ns)
    ns['_actual_motor_run'] = ns['motor_run']
    ns['motor_run'] = lambda *args: events.append('motor-finished')
    return ns, events, chunks


class ProtocolTests(unittest.TestCase):
    def test_ack_only_after_motor_finishes_and_epoch_bumps_first(self):
        for drawer in (1, 2):
            ns, events, _ = load(epoch=7)
            ns['dispense'](drawer, 'c-motor-test-01')
            self.assertEqual(events, ['BUSY', 'motor-finished', f'DONE{drawer}:c-motor-test-01'])
            self.assertEqual(ns['ready_epoch'], 8, 'epoch must change before the motor moves')
            self.assertFalse(ns['busy'])

    def test_buzzer_ack_follows_setting_with_exact_id_on_p16(self):
        for state in ('1', '0'):
            ns, events, _ = load()
            ns['handle_serial_frame']('BUZZ' + state + ':c-sound-test-01')
            self.assertEqual(events[0], 'sound-on' if state == '1' else 'sound-off')
            self.assertEqual(events[-1], 'BUZZ_DONE' + state + ':c-sound-test-01')
        source = SOURCE.read_text()
        self.assertIn('pin=pin16', source, 'music defaults to P0, which is now a motor coil')

    # ออดต้องดับเองที่บอร์ด ไม่ใช่รอ Pi สั่ง — 2026-09-14 กดเรียกครูแล้วดังไม่หยุด เพราะปุ่มปิด
    # มีที่เดียวคือหน้าครูบน Vercel ที่ต้องล็อกอิน ⇒ ตัวจับเวลาต้องรอดแม้ Pi ดับทั้งเครื่อง
    def test_buzzer_stops_itself_when_the_window_expires(self):
        ns, events, _ = load()
        now = [1000]
        ns['running_time'] = lambda: now[0]
        ns['handle_serial_frame']('BUZZ1:c-sos-window-1')
        self.assertEqual(events, ['sound-on', 'BUZZ_DONE1:c-sos-window-1'])

        now[0] = 1000 + ns['BUZZ_MAX_MS'] - 1
        ns['service_buzzer']()
        self.assertNotIn('sound-off', events, 'ยังไม่ครบเวลา ห้ามดับก่อน')
        self.assertEqual(events[-1], 'radio:SFAB1:B1', 'ยังร้องอยู่ต้องบอกรีโมตให้ร้องตาม')

        now[0] = 1000 + ns['BUZZ_MAX_MS']
        ns['service_buzzer']()
        self.assertIn('sound-off', events)
        # รีโมตต้องดับพร้อมกัน ⇒ ยิงคำสั่งปิดซ้ำเผื่อแพ็กเก็ตหาย
        self.assertEqual(events[-3:], ['radio:SFAB1:B0'] * 3)

        # ดับแล้วต้องไม่ดับซ้ำทุกรอบของลูป ไม่งั้นมันจะยิง music.stop() 100 ครั้งต่อวินาที
        ns['service_buzzer']()
        self.assertEqual(events.count('sound-off'), 1)

    def test_buzz_off_clears_the_window_and_a_new_buzz_restarts_it(self):
        ns, events, _ = load()
        now = [1000]
        ns['running_time'] = lambda: now[0]
        ns['handle_serial_frame']('BUZZ1:c-sos-window-2')
        ns['handle_serial_frame']('BUZZ0:c-sos-window-3')
        now[0] = 1000 + ns['BUZZ_MAX_MS'] * 4
        ns['service_buzzer']()
        self.assertEqual(events.count('sound-off'), 1, 'สั่งปิดแล้ว ตัวจับเวลาต้องไม่ยิงซ้ำทีหลัง')

        # กดเรียกครูซ้ำระหว่างที่ยังดังอยู่ ต้องได้เวลาใหม่เต็ม ไม่ใช่ดับตามรอบเดิม
        ns['handle_serial_frame']('BUZZ1:c-sos-window-4')
        now[0] += ns['BUZZ_MAX_MS'] - 1
        ns['service_buzzer']()
        self.assertEqual(events.count('sound-off'), 1)
        now[0] += 1
        ns['service_buzzer']()
        self.assertEqual(events.count('sound-off'), 2)

    def test_motor_keeps_heartbeat_and_services_sos(self):
        ns, events, chunks = load(busy=True)
        now = [0]
        ns['running_time'] = lambda: now[0]
        ns['sleep'] = lambda ms: now.__setitem__(0, now[0] + ms)
        chunks.append(b'BUZZ1:c-sos-motor-01\n')
        ns['_actual_motor_run'](ns['MOTORS'][1], 512, 2)
        self.assertIn('BUSY', events)
        self.assertIn('BUZZ_DONE1:c-sos-motor-01', events)
        self.assertEqual(events[-4:], [('pin', n, 0) for n in ('p12', 'p14', 'p13', 'p15')], 'coils released at the end')

    def test_both_motors_rotate_in_reverse_and_release_coils(self):
        for drawer, cycle in ((1, ['p12', 'p15', 'p13', 'p14']),
                              (2, ['p0', 'p8', 'p1', 'p2'])):
            ns, events, _ = load()
            ns['_actual_motor_run'](ns['MOTORS'][drawer], 200, 5)
            active_pins = [e[1] for e in events if isinstance(e, tuple) and e[0] == 'pin' and e[2] == 1]
            self.assertEqual(active_pins, cycle * 50, '200 steps in the requested reverse phase order')
            self.assertEqual(events[-4:], [('pin', p.name, 0) for p in ns['MOTORS'][drawer]])

    # ปุ่ม SOS ไร้สาย: ออดต้องดังที่บอร์ดเองก่อน แล้วค่อยบอก Pi ให้ยิง LINE
    def test_radio_sos_sounds_the_buzzer_and_reports_once_per_press(self):
        press = ['SFAB1:SOS:7'] * 5          # ปุ่มยิงซ้ำ 5 ครั้งกันแพ็กเก็ตหาย
        ns, events, _ = load(radio_inbox=press)
        for _ in press:
            ns['check_radio']()
        self.assertEqual(len(events), 3, 'การกดหนึ่งครั้ง = ตอบรับครั้งเดียว ออดครั้งเดียว รายงานครั้งเดียว')
        self.assertEqual(events[:2], ['radio:SFAB1:OK', 'sound-on'], 'ต้องตอบรีโมตก่อนเริ่มออด')
        self.assertTrue(events[2].startswith('REMOTE_SOS:rsos-7-'))
        self.assertEqual(ns['buzz_until'], 1000 + 5000, 'ออดต้องมีเวลาดับของตัวเอง')

    def test_radio_ignores_other_teams_and_a_new_press_sounds_again(self):
        ns, events, _ = load(radio_inbox=['HELLO', 'SFAB1:PING:1', 'SFAB1:SOS:8'])
        for _ in range(3):
            ns['check_radio']()
        self.assertEqual(len(events), 3, 'เฉพาะ frame ที่ขึ้นต้นด้วย RADIO_PREFIX เท่านั้นที่สั่งออดได้')
        self.assertTrue(events[2].startswith('REMOTE_SOS:rsos-8-'))

    def test_radio_sos_id_passes_the_pi_side_id_rule(self):
        ns, events, _ = load(radio_inbox=['SFAB1:SOS:1'])
        ns['check_radio']()
        sent_id = events[2].split(':', 1)[1]
        self.assertTrue(ns['valid_id'](sent_id), 'Pi ทิ้ง frame ที่ id ไม่ผ่าน 8-64 ตัวอักษรเงียบๆ')

    def test_refusal_preserves_exact_id(self):
        ns, events, _ = load(busy=True)
        ns['handle_serial_frame']('OPEN1:c-reject-wire-01:7')
        self.assertEqual(events, ['REJECT:c-reject-wire-01'])

    def test_stale_epoch_is_refused_with_the_id(self):
        ns, events, _ = load(epoch=7)
        ns['dispense'] = lambda *a: self.fail('stale epoch actuated motor')
        ns['handle_serial_frame']('OPEN1:c-stale-0001:6')
        self.assertEqual(events, ['REJECT:c-stale-0001'])

    def test_usb_serial_and_full_128_byte_frame(self):
        source = SOURCE.read_text()
        self.assertNotIn('serial.redirect', source)
        self.assertNotIn('redirect(', source)
        self.assertIn('uart.init(baudrate=115200)', source)
        ns, events, chunks = load(epoch=4294967295)
        ns['dispense'] = lambda drawer, cid: events.append(('accepted', drawer, cid))
        full_id = 'c-' + 'x' * 62
        frame = 'OPEN1:' + full_id + ':4294967295\n'
        self.assertLess(len(frame), 128)
        chunks.append(frame.encode())
        ns['check_serial_commands']()
        self.assertEqual(events, [('accepted', 1, full_id)])

    def test_fragmented_command_and_exact_identity(self):
        ns, events, chunks = load()
        ns['dispense'] = lambda drawer, cid: events.append(('accepted', drawer, cid))
        chunks.extend([b'OPEN2:c-proto-', b'test-01:7\r\n'])
        ns['check_serial_commands']()
        ns['check_serial_commands']()
        self.assertEqual(events, [('accepted', 2, 'c-proto-test-01')])

    def test_busy_and_malformed_never_actuate(self):
        for busy, line in [(True, 'OPEN1:c-busy-0001:7'), (False, 'junkOPEN1:c-inject-001:7'),
                           (False, 'OPEN1'), (False, 'OPEN1:x:7'), (False, 'OPEN1:' + 'a' * 140 + ':7'),
                           (False, 'OPEN3:c-no-such-drawer-1:7')]:
            ns, events, chunks = load(busy=busy)
            ns['dispense'] = lambda *a: self.fail('invalid frame actuated motor: ' + line[:40])
            chunks.append((line + '\n').encode())
            ns['check_serial_commands']()
            self.assertFalse(any(isinstance(e, tuple) for e in events))

    def test_no_button_dispensing_and_no_local_done(self):
        # Identifiers, not prose: the header comment is allowed to explain why buttons went away.
        tree = ast.parse(SOURCE.read_text())
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | \
                {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        for forbidden in ('button_a', 'button_b', 'PIN_START', 'PIN_ABRASION', 'PIN_INSECT', 'read_digital', 'is_pressed'):
            self.assertNotIn(forbidden, names)
        self.assertNotIn('LOCAL_DONE', SOURCE.read_text())


if __name__ == '__main__':
    unittest.main()


REMOTE = Path(__file__).resolve().parents[1] / 'microbit/remote.py'


def load_remote(*, radio_inbox=None):
    tree = ast.parse(REMOTE.read_text())
    functions = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef)], type_ignores=[])
    events = []
    inbox = list(radio_inbox or [])
    ns = dict(
        music=SimpleNamespace(pitch=lambda *a, **k: events.append('sound-on'),
                              stop=lambda *a, **k: events.append('sound-off')),
        radio=SimpleNamespace(receive=lambda: inbox.pop(0) if inbox else None,
                              send=lambda m: events.append('radio:' + m)),
        display=SimpleNamespace(off=lambda: None, on=lambda: None),
        pin3=Pin('p3', events),
        running_time=lambda: 1000,
        sleep=lambda _: None,
        SOS_PREFIX='SFAB1:SOS:', SOS_ACK='SFAB1:OK', BUZZ_ON='SFAB1:B1', BUZZ_OFF='SFAB1:B0',
        ACK_WAIT_MS=1200, print=lambda *a: None,
        BURST=5, BURST_GAP_MS=60, HOLD_MS=1500, COOLDOWN_MS=10000,
        seq=0, last_sent=-10000, buzzing=False, last_beacon=0,
    )
    exec(compile(functions, str(REMOTE), 'exec'), ns)
    return ns, events


class RemoteTests(unittest.TestCase):
    # ทั้งสองสคริปต์ต้องคาไม่เกินเพดานของ V1 ไม่งั้น uflash ปฏิเสธตอน build (เจอจริง 2026-09-17)
    def test_both_scripts_fit_the_v1_script_limit(self):
        for path in (SOURCE, REMOTE):
            size = len(path.read_bytes())
            self.assertLess(size, 8188, '%s = %d bytes; คอมเมนต์ไทยกิน 3 ไบต์/ตัว' % (path.name, size))

    def test_remote_follows_the_cabinet_on_and_off(self):
        ns, events = load_remote(radio_inbox=['SFAB1:B1', 'SFAB1:B1', 'SFAB1:B0'])
        for _ in range(3):
            ns['follow_cabinet']()
        self.assertEqual([e for e in events if isinstance(e, str) and e.startswith('sound')], ['sound-on', 'sound-off'],
                         'beacon ซ้ำต้องไม่เริ่มเสียงใหม่ทุกครั้ง')

    # ถ้าแพ็กเก็ตปิดหาย หรือตู้ดับ หรือเดินออกนอกระยะ รีโมตต้องเงียบเอง ห้ามค้างร้อง
    def test_remote_goes_quiet_when_the_beacon_stops(self):
        ns, events = load_remote(radio_inbox=['SFAB1:B1'])
        now = [1000]
        ns['running_time'] = lambda: now[0]
        ns['follow_cabinet']()
        self.assertEqual(events[-1], 'sound-on')
        now[0] = 1000 + ns['HOLD_MS']
        ns['follow_cabinet']()
        self.assertNotIn('sound-off', events, 'ยังไม่เกิน HOLD_MS ห้ามดับ')
        now[0] = 1000 + ns['HOLD_MS'] + 1
        ns['follow_cabinet']()
        self.assertEqual(events[-2], 'sound-off')

    def test_remote_press_sends_a_burst_the_cabinet_can_dedupe(self):
        ns, events = load_remote()
        now = [1000]
        ns['running_time'] = lambda: now[0]
        ns['sleep'] = lambda ms: now.__setitem__(0, now[0] + ms)
        ns['send_sos']()
        sent = [e for e in events if isinstance(e, str) and e.startswith('radio:')]
        self.assertEqual(sent, ['radio:SFAB1:SOS:1'] * 5, 'ยิงซ้ำ 5 ครั้ง seq เดียวกัน')

    # เสียงตอบกลับคือเครื่องมือวัดระยะในมือ Bank ⇒ สองกรณีต้องแยกออกจากกันชัดเจน
    def test_remote_reports_whether_the_cabinet_answered(self):
        for inbox, tail in ((['SFAB1:OK'], 'ตู้ได้ยิน'), ([], 'ไม่มีใครตอบ')):
            ns, events = load_remote(radio_inbox=inbox)
            now = [1000]
            ns['running_time'] = lambda: now[0]
            ns['sleep'] = lambda ms: now.__setitem__(0, now[0] + ms)
            ns['send_sos']()
            beeps = [e for e in events if isinstance(e, str) and e == 'sound-on']
            self.assertEqual(len(beeps), 2 if inbox else 1, tail)

    def test_remote_gives_up_waiting_instead_of_hanging_forever(self):
        ns, events = load_remote()
        now = [1000]
        ns['running_time'] = lambda: now[0]
        ns['sleep'] = lambda ms: now.__setitem__(0, now[0] + ms)
        ns['send_sos']()
        elapsed = now[0] - 1000
        self.assertLess(elapsed, ns['ACK_WAIT_MS'] + 2000, 'ต้องไม่ค้างรอ ACK ตลอดกาล')
