"""Execute the actual MakeCode Python functions with hardware stubs (no motor attached)."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'microbit/main.py'


def load():
    tree = ast.parse(SOURCE.read_text())
    functions = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef)], type_ignores=[])
    events = []
    ns = dict(number=int, any=object, List=list, DigitalPin=object,
              serial=SimpleNamespace(write_line=lambda s: events.append(s),
                                     write_string=lambda s: events.append(s.strip()), read_string=lambda: ''),
              basic=SimpleNamespace(pause=lambda _: None),
              music=SimpleNamespace(ring_tone=lambda _: events.append('sound-on'),
                                    stop_all_sounds=lambda: events.append('sound-off')),
              input=SimpleNamespace(running_time=lambda: 1000),
              remoteCommandId='c-motor-test-01', readyEpoch=7, serialBuffer='', serialOverflow=False,
              state=0, STATE_WELCOME=0, STATE_MENU=1, STATE_ABRASION=2, STATE_INSECT=3, STATE_SLEEP=4,
              lastAction=0, lastHeartbeat=0, MOTOR1_PINS=[], MOTOR2_PINS=[],
              DISPENSE_STEPS=2048, STEP_DELAY_MS=2, SYMPTOM_DISPLAY_MS=2500,
              CARE_DONE_MS=3000, PIN_ABRASION=8, PIN_INSECT=12)
    exec(compile(functions, str(SOURCE), 'exec'), ns)
    for name in ['show_running', 'show_abrasion_care1', 'show_abrasion_care2',
                 'show_insect_care1', 'show_insect_care2', 'show_care_done', 'reset_to_welcome']:
        ns[name] = lambda: None
    ns['_actual_motor_run'] = ns['motor_run']
    ns['motor_run'] = lambda *args: events.append('motor-finished')
    ns['wait_for_button_again'] = lambda *args: None
    ns['pause_with_service'] = lambda *args: None
    return ns, events


class ProtocolTests(unittest.TestCase):
    def test_ack_only_after_motor_finishes(self):
        for name, drawer in [('dispense_abrasion', 1), ('dispense_insect', 2)]:
            ns, events = load()
            ns[name]()
            self.assertEqual(events[0], 'motor-finished', 'ACK must follow motor completion')
            self.assertEqual(events[1:], [f'DONE{drawer}:c-motor-test-01'])

    def test_buzzer_ack_follows_setting_with_exact_id(self):
        for state in ['1', '0']:
            ns, events = load()
            ns['handle_serial_frame']('BUZZ' + state + ':c-sound-test-01')
            self.assertEqual(events, ['sound-on' if state == '1' else 'sound-off',
                                      'BUZZ_DONE' + state + ':c-sound-test-01'])

    def test_motor_keeps_heartbeat_and_services_sos(self):
        ns, events = load()
        now = [0]
        chunks = ['BUZZ1:c-sos-motor-01\n']
        ns['state'] = ns['STATE_ABRASION']
        ns['input'].running_time = lambda: now[0]
        ns['basic'].pause = lambda ms: now.__setitem__(0, now[0] + ms)
        ns['serial'].read_string = lambda: chunks.pop(0) if chunks else ''
        ns['pins'] = SimpleNamespace(digital_write_pin=lambda *args: None)
        ns['STEP_SEQUENCE'] = [[1, 0, 0, 0]]
        ns['motor_stop'] = lambda _: None
        ns['_actual_motor_run']([4, 5, 6, 7], 512, 2)
        self.assertIn('BUSY', events)
        self.assertIn('BUZZ_DONE1:c-sos-motor-01', events)

    def test_refusal_preserves_exact_id_for_esp32(self):
        ns, events = load()
        ns['state'] = ns['STATE_ABRASION']
        ns['handle_serial_frame']('OPEN1:c-reject-wire-01:7')
        self.assertEqual(events, ['REJECT:c-reject-wire-01'])

    def test_rx_buffer_configuration_after_redirect_and_full_frame(self):
        tree = ast.parse(SOURCE.read_text())
        calls = [n.value for n in tree.body if isinstance(n, ast.Expr)
                 and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute)
                 and isinstance(n.value.func.value, ast.Name) and n.value.func.value.id == 'serial']
        self.assertEqual([c.func.attr for c in calls], ['redirect', 'set_rx_buffer_size'])
        self.assertEqual(calls[1].args[0].value, 128)
        ns, events = load()
        ns['readyEpoch'] = 4294967295
        ns['go_to_state'] = lambda state: events.append(('accepted', ns['remoteCommandId']))
        full_id = 'c-' + 'x' * 62
        frame = 'OPEN1:' + full_id + ':4294967295\n'
        self.assertLess(len(frame), 128)
        ns['serial'].read_string = lambda: frame
        ns['check_serial_commands']()
        self.assertEqual(events, [('accepted', full_id)])

    def test_fragmented_command_and_exact_identity(self):
        ns, events = load()
        ns['remoteCommandId'] = ''
        ns['go_to_state'] = lambda state: events.append(('state', state, ns['remoteCommandId']))
        for chunk in ['OPEN1:c-proto-', 'test-01:7\n']:
            ns['serial'].read_string = lambda: chunk
            ns['check_serial_commands']()
        self.assertEqual(events, [('state', 2, 'c-proto-test-01')])

    def test_stale_epoch_busy_and_malformed_never_actuate(self):
        for state, line in [(0, 'OPEN1:c-stale-0001:6'), (2, 'OPEN1:c-busy-0001:7'),
                            (0, 'junkOPEN1:c-inject-001:7'), (0, 'OPEN1'),
                            (0, 'OPEN1:x:7'), (0, 'OPEN1:' + 'a' * 140 + ':7')]:
            ns, events = load()
            ns['state'] = state
            ns['go_to_state'] = lambda _: self.fail('invalid frame actuated motor')
            ns['serial'].read_string = lambda: line + '\n'
            ns['check_serial_commands']()
            self.assertFalse(any(isinstance(e, tuple) for e in events))


if __name__ == '__main__':
    unittest.main()
