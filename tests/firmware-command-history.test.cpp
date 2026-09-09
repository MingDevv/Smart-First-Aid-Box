#include "../firmware/esp32_smart_box/readiness_latch.h"

#include <assert.h>
#include <stdio.h>

#include <string>
#include <vector>

static constexpr uint32_t ACK_TIMEOUT_MS = 15000;

struct FirmwareHarness {
  CommandHistory history;
  std::vector<std::string> uartCommands;
  std::vector<std::string> events;

  void expire(uint32_t now) {
    while (CommandRecord* record = history.expireNext(now, ACK_TIMEOUT_MS)) {
      events.push_back(std::string("ack_timeout:") + record->id);
    }
  }

  bool open(const char* id, uint8_t drawer, uint32_t now) {
    expire(now);
    CommandRecord* record = history.remember(id, drawer, false, now);
    if (record == nullptr) return false;
    uartCommands.push_back(std::string(drawer == 1 ? "OPEN1:" : "OPEN2:") + id);
    return true;
  }

  void acknowledge(const char* id) {
    CommandRecord* record = history.find(id);
    assert(record != nullptr);
    record->completed = true;
  }
};

int main() {
  CommandHistory rejectedHistory;
  ReadinessLatch rejectedLatch;
  rejectedLatch.ready(7, 100);
  rejectedHistory.remember("c-reject-wire-01", 1, false, 100);
  rejectedLatch.consume("c-reject-wire-01");
  // Actual helper called by the firmware REJECT branch: exact id -> rejected state -> READY recovery.
  assert(!rejectCommand(rejectedHistory, rejectedLatch, "c-unrelated-01"));
  assert(rejectCommand(rejectedHistory, rejectedLatch, "c-reject-wire-01"));
  assert(rejectedHistory.find("c-reject-wire-01")->rejected);
  assert(rejectedHistory.expireNext(30000, 15000) == nullptr);
  rejectedLatch.ready(7, 300);
  assert(rejectedLatch.canOpen(300));

  ReadinessLatch latch;
  latch.ready(5, 100);
  assert(latch.canOpen(100));
  latch.consume("c-refused-0001");
  latch.ready(5, 200);
  assert(!latch.canOpen(200));
  assert(latch.waitingForEpoch());
  assert(!latch.reject("c-unrelated-01"));
  assert(!latch.canOpen(200));
  assert(latch.reject("c-refused-0001"));
  assert(!latch.canOpen(200)); // a fresh READY must still follow the exact rejection
  latch.ready(5, 300);
  assert(latch.canOpen(300));
  latch.consume("c-wire-lost-01");
  latch.ready(5, 30000);
  assert(!latch.canOpen(30000)); // time alone must never release a possibly queued OPEN
  latch.ready(6, 30100);
  assert(latch.canOpen(30100)); // micro:bit invalidated the old epoch itself
  latch.consume("c-next-open-01");
  assert(!latch.reject("c-refused-0001")); // a late old rejection cannot release a new command

  // Literal regression: one command gets no UART OK, expires, and the next one is dispatched.
  FirmwareHarness singleTimeout;
  assert(singleTimeout.open("c-single-no-ack", 1, 0));
  singleTimeout.expire(ACK_TIMEOUT_MS);
  assert(singleTimeout.events.size() == 1);
  assert(singleTimeout.open("c-single-next-01", 1, ACK_TIMEOUT_MS));
  assert(singleTimeout.uartCommands.size() == 2);
  assert(singleTimeout.history.find("c-single-no-ack")->expired);

  // Repro: one missing ACK survives a ring wrap. Completed slots must still be reusable.
  FirmwareHarness wrapped;
  assert(wrapped.open("c-stuck-0001", 1, 0));
  for (int i = 1; i < COMMAND_HISTORY_SIZE; i++) {
    char id[32];
    snprintf(id, sizeof(id), "c-complete-%02d", i);
    assert(wrapped.open(id, 2, 1000 + i));
    wrapped.acknowledge(id);
  }
  assert(wrapped.open("c-follower-001", 2, ACK_TIMEOUT_MS - 1));
  assert(wrapped.uartCommands.size() == COMMAND_HISTORY_SIZE + 1);

  // If every slot is pending, 15 seconds without UART OK expires and reports each command.
  FirmwareHarness timedOut;
  for (int i = 0; i < COMMAND_HISTORY_SIZE; i++) {
    char id[32];
    snprintf(id, sizeof(id), "c-no-ack-%02d", i);
    assert(timedOut.open(id, (i % 2) + 1, 0));
  }
  assert(!timedOut.open("c-too-early-01", 1, ACK_TIMEOUT_MS - 1));

  timedOut.expire(ACK_TIMEOUT_MS);
  assert(timedOut.events.size() == COMMAND_HISTORY_SIZE);
  assert(timedOut.open("c-after-timeout", 1, ACK_TIMEOUT_MS));
  assert(timedOut.uartCommands.size() == COMMAND_HISTORY_SIZE + 1);

  return 0;
}
