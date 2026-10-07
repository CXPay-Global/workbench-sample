import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The last `limit` verified webhook events, newest first, in one JSON file.
// A summary only: the full payload is not kept.
export function createEventLog(file, limit = 100) {
  let events = [];
  try {
    events = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    events = [];
  }

  function save() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(events, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  return {
    list: () => events,
    add(event) {
      if (events.some((e) => e.id === event.id)) return { duplicate: true };
      events = [event, ...events].slice(0, limit);
      save();
      return { duplicate: false };
    },
  };
}
