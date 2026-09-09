#pragma once
#include <stdint.h>
#include <string.h>
#include "command_history.h"

class ReadinessLatch {
 public:
  void ready(uint32_t epoch, uint32_t now) {
    epoch_ = epoch; seenAt_ = now; seen_ = true; available_ = true;
  }
  void busy(uint32_t now) { seenAt_ = now; seen_ = true; available_ = false; }
  bool connected(uint32_t now) const { return seen_ && uint32_t(now - seenAt_) < 1500; }
  bool waitingForEpoch() const { return consumed_ && epoch_ == consumedEpoch_; }
  bool canOpen(uint32_t now) const { return connected(now) && available_ && !waitingForEpoch(); }
  bool needsResync() const { return available_ && waitingForEpoch(); }
  uint32_t epoch() const { return epoch_; }
  void consume(const char* id) {
    consumed_ = true; consumedEpoch_ = epoch_; available_ = false;
    strncpy(commandId_, id, 64); commandId_[64] = '\0';
  }
  bool reject(const char* id) {
    if (!consumed_ || strcmp(commandId_, id) != 0) return false;
    // Only proof that THIS frame was refused can release the latch. A timer never can.
    consumed_ = false; available_ = false; commandId_[0] = '\0';
    return true;
  }
 private:
  bool seen_ = false;
  bool available_ = false;
  bool consumed_ = false;
  uint32_t seenAt_ = 0, epoch_ = 0, consumedEpoch_ = 0;
  char commandId_[65] = {};
};

inline bool rejectCommand(CommandHistory& history, ReadinessLatch& readiness, const char* id) {
  CommandRecord* command = history.find(id);
  if (command == nullptr || command->completed || !readiness.reject(id)) return false;
  command->rejected = true;
  return true;
}
