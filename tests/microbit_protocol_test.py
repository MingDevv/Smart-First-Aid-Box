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
    ns['motor_run'] = lambda *args: events.append('motor-finished')
    ns['wait_for_button_again'] = lambda *args: None
    return ns, events


class ProtocolTests(unittest.TestCase):
    def test_ack_only_after_motor_finishes(self):
        for name, drawer in [('dispense_abrasion', 1), ('dispense_insect', 2)]:
            ns, events = load()
            ns[name]()
            self.assertEqual(events[0], 'motor-finished', 'ACK must follow motor completion')
            self.assertEqual(events[1:], [f'DONE{drawer}:c-motor-test-01'])

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
