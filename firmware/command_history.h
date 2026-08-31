#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static constexpr uint8_t COMMAND_HISTORY_SIZE = 8;
static constexpr size_t MAX_COMMAND_ID_LENGTH = 64;

struct CommandRecord {
  bool used;
  char id[MAX_COMMAND_ID_LENGTH + 1];
  uint8_t drawer;
  bool completed;
  bool expired;
  uint32_t sequence;
  uint32_t createdAt;
};

class CommandHistory {
 public:
  CommandHistory() : next_(0), sequence_(0) {
    memset(records_, 0, sizeof(records_));
  }

  CommandRecord* find(const char* commandId) {
    for (uint8_t i = 0; i < COMMAND_HISTORY_SIZE; i++) {
      if (records_[i].used && strcmp(records_[i].id, commandId) == 0) {
        return &records_[i];
      }
    }
    return nullptr;
  }

  CommandRecord* remember(const char* commandId, uint8_t drawer, bool completed, uint32_t now) {
    CommandRecord* record = nullptr;
    uint8_t selected = next_;
    for (uint8_t offset = 0; offset < COMMAND_HISTORY_SIZE; offset++) {
      uint8_t index = (next_ + offset) % COMMAND_HISTORY_SIZE;
      CommandRecord* candidate = &records_[index];
      if (!candidate->used || candidate->completed || candidate->expired) {
        record = candidate;
        selected = index;
        break;
      }
    }
    if (record == nullptr) return nullptr;

    record->used = true;
    strncpy(record->id, commandId, MAX_COMMAND_ID_LENGTH);
    record->id[MAX_COMMAND_ID_LENGTH] = '\0';
    record->drawer = drawer;
    record->completed = completed;
    record->expired = false;
    record->sequence = ++sequence_;
    record->createdAt = now;
    next_ = (selected + 1) % COMMAND_HISTORY_SIZE;
    return record;
  }

  CommandRecord* findOldestPendingDrawer(uint8_t drawer) {
    CommandRecord* oldest = nullptr;
    for (uint8_t i = 0; i < COMMAND_HISTORY_SIZE; i++) {
      CommandRecord* record = &records_[i];
      if (!record->used || record->completed || record->expired || record->drawer != drawer) continue;
      if (oldest == nullptr || record->sequence < oldest->sequence) oldest = record;
    }
    return oldest;
  }

  CommandRecord* expireNext(uint32_t now, uint32_t timeoutMs) {
    for (uint8_t i = 0; i < COMMAND_HISTORY_SIZE; i++) {
      CommandRecord* record = &records_[i];
      if (!record->used || record->completed || record->expired) continue;
      // unsigned subtraction keeps working when millis() wraps around
      if ((uint32_t)(now - record->createdAt) < timeoutMs) continue;
      record->expired = true;
      return record;
    }
    return nullptr;
  }

 private:
  CommandRecord records_[COMMAND_HISTORY_SIZE];
  uint8_t next_;
  uint32_t sequence_;
};
