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


def load(*, busy=False, epoch=7):
    tree = ast.parse(SOURCE.read_text())
    functions = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef)], type_ignores=[])
    events = []
    chunks = []
    pins = {n: Pin(n, events) for n in ('p0', 'p1', 'p2', 'p8', 'p12', 'p13', 'p14', 'p15')}
    ns = dict(
        uart=SimpleNamespace(write=lambda s: events.append(s.strip()) if isinstance(s, str) else events.append(s),
                             read=lambda n: chunks.pop(0) if chunks else None),
        music=SimpleNamespace(pitch=lambda *a, **k: events.append('sound-on'),
                              stop=lambda *a, **k: events.append('sound-off')),
        display=SimpleNamespace(show=lambda _: None),
        Image=SimpleNamespace(ARROW_S=1, ARROW_N=2, YES=3),
        running_time=lambda: 1000,
        sleep=lambda _: None,
        pin16=Pin('p16', events),
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
            self.assertEqual(events, ['sound-on' if state == '1' else 'sound-off',
                                      'BUZZ_DONE' + state + ':c-sound-test-01'])
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
        self.assertEqual(events[-1], 'BUZZ_DONE1:c-sos-window-1', 'ยังไม่ครบเวลา ห้ามดับก่อน')

        now[0] = 1000 + ns['BUZZ_MAX_MS']
        ns['service_buzzer']()
        self.assertEqual(events[-1], 'sound-off')

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
